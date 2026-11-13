import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openLedger, TunableClock, type Ledger } from '@moterva/ledger';
import { buildApp } from '../../src/app.js';
import { loadConfig, StartupConfigError } from '../../src/config.js';
import type { OidcClient } from '../../src/identity/oidc-client.js';
import {
  credentialEventKey,
  establishSourceKeyCustody,
  keyDigestOf,
  verifySourceKeyCustody,
} from '../../src/integration/source-credential-store.js';
import {
  Kek,
  KekRing,
  SourceKeyCustodyError,
  isSealedKey,
  parseKek,
  parseSourceKeyCustodyEnv,
  resolveKekRing,
} from '../../src/integration/source-key-custody.js';
import {
  asAdmin,
  customerSpec,
  machineEvent,
  machineSubmit,
  refusalCode,
  runtimeKek,
  type Session,
} from './helpers/machine-harness.js';

/**
 * SOURCE-KEY CUSTODY — CTO review PR #64, comment 6808560477, P0:
 * "predictable LOCAL KEK is still used in production if no env is supplied".
 *
 *  - production (with the credential surface) must REFUSE to start without a
 *    valid 32-byte KEK, refuse the public derivation in every role, and never
 *    fall back to a predictable key;
 *  - the validated KEK must actually reach the runtime (config used to drop it);
 *  - ciphertext must stay decryptable across restart, and a KEK is never
 *    silently replaced under existing ciphertext — rotation and recovery are an
 *    explicit, tested protocol;
 *  - no key material ever reaches the journal, API, logs, errors or files.
 */

const DIR = mkdtempSync(join(tmpdir(), 'mv-custody-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const KEK_A = runtimeKek('custody-A');
const KEK_B = runtimeKek('custody-B');
const KEK_C = runtimeKek('custody-C');
const idOf = (kek: string): string => parseKek(kek, 'test').id;
/** The public derivation, hex — the value production must refuse. */
const PUBLIC_HEX = createHash('sha256')
  .update('moterva-local-source-kek:v1:default-local-derivation')
  .digest('hex');

const ISSUER = 'https://idp.example.com';
const OIDC = {
  MOTERVA_OIDC_ISSUER: ISSUER,
  MOTERVA_OIDC_CLIENT_ID: 'moterva-prod',
  MOTERVA_OIDC_CLIENT_SECRET: 'a-real-server-side-secret-value',
  MOTERVA_OIDC_REDIRECT_URI: 'https://app.example.com/api/auth/oidc/callback',
};

/** Hermetic IdP stand-in (the buildApp test seam), as in the production-startup suite. */
let flowCounter = 0;
const STUB_CLIENT: OidcClient = {
  issuer: ISSUER,
  async beginFlow(redirectUri: string) {
    // A FRESH state per flow: the production flow layer remembers consumed
    // states and rejects a replay (OIDC_STATE_REPLAYED), even across restarts.
    flowCounter += 1;
    const state = `stub-state-${String(flowCounter)}`;
    const url = new URL('https://idp.example.com/auth');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return {
      authorizationUrl: url.href,
      state,
      nonce: `stub-nonce-${String(flowCounter)}`,
      codeVerifier: `stub-verifier-${String(flowCounter)}`,
    };
  },
  async completeFlow() {
    return {
      subject: 'owner-prod-sub',
      email: 'owner@prod.example',
      name: 'Prod Owner',
      issuer: ISSUER,
    };
  },
};

// =============================================================== A. parsing

describe('KEK parsing is strict: exactly 32 decoded bytes in a canonical encoding', () => {
  const bytes = createHash('sha256').update('kek-parse-fixture').digest();
  const hex = bytes.toString('hex');
  const b64url = bytes.toString('base64url');
  const b64 = bytes.toString('base64');

  it('accepts 64 hex (any case), 43-char base64url and 44-char base64 — all the SAME key', () => {
    const ids = new Set(
      [hex, hex.toUpperCase(), b64url, b64, `  ${hex}\n`].map((v) => parseKek(v, 'V').id),
    );
    expect(ids.size).toBe(1);
  });

  it('rejects every near-miss and never echoes the offending value', () => {
    const bad = [
      '',
      'tooshort',
      hex.slice(1), // 63 hex
      `${hex}0`, // 65 hex
      b64url.slice(1), // 42
      `${b64url}A`, // 44 base64url (no '=' → not base64 either)
      `!${b64url.slice(1)}`, // bad alphabet, right length
      `${b64url.slice(0, 20)}!!${b64url.slice(20)}`, // lenient decoders would skip these
      `${b64url.slice(0, 42)}B`, // non-canonical trailing bits
      `0x${hex.slice(2)}`, // looks hex-ish, is not
      '0'.repeat(64), // degenerate
      'ab'.repeat(32), // degenerate (one repeated byte)
    ];
    for (const value of bad) {
      let error: unknown;
      try {
        parseKek(value, 'MOTERVA_SOURCE_KEY_KEK');
      } catch (caught) {
        error = caught;
      }
      expect(error, `value ${JSON.stringify(value)} must be rejected`).toBeInstanceOf(
        SourceKeyCustodyError,
      );
      expect((error as SourceKeyCustodyError).code).toBe('SOURCE_KEK_INVALID');
      if (value.length >= 8) expect((error as Error).message).not.toContain(value);
    }
  });

  it('Kek is OPAQUE: JSON, inspect and diagnostic dumps expose only the fingerprint', () => {
    const kek = parseKek(hex, 'V');
    expect(JSON.stringify(kek)).toBe(JSON.stringify({ kekId: kek.id }));
    expect(inspect(kek, { depth: null, showHidden: true })).toBe(`Kek(${kek.id})`);
    const custody = parseSourceKeyCustodyEnv({
      MOTERVA_SOURCE_KEY_KEK: hex,
      MOTERVA_SOURCE_KEY_KEK_PREVIOUS: runtimeKek('opaque-prev'),
    });
    const dumps = [
      JSON.stringify(custody),
      inspect(custody, { depth: null, showHidden: true }),
      JSON.stringify(new KekRing(kek, [], new Set(), 'configured')),
    ].join('\n');
    expect(dumps).not.toContain(hex);
    expect(dumps).not.toContain(b64url);
    expect(dumps).not.toContain(runtimeKek('opaque-prev'));
  });

  it('seal/open round-trips, binds to its KEK, and rejects tampering and truncated tags', () => {
    const kek = parseKek(hex, 'V');
    const other = parseKek(runtimeKek('other-kek'), 'V');
    const sealed = kek.seal('plaintext-signing-material');
    expect(isSealedKey(sealed)).toBe(true);
    expect(kek.open(sealed)).toBe('plaintext-signing-material');
    expect(JSON.stringify(sealed)).not.toContain('plaintext-signing-material');
    // Wrong KEK: refused by fingerprint, and a forged fingerprint fails authentication.
    expect(() => other.open(sealed)).toThrow(/SOURCE_KEY_SEAL_MISMATCH/);
    expect(() => other.open({ ...sealed, kekId: other.id })).toThrow(/SOURCE_KEY_SEAL_TAMPERED/);
    // Bit-flip in the ciphertext.
    const ct = Buffer.from(sealed.ct, 'base64url');
    ct[0] = (ct[0] ?? 0) ^ 0x01;
    expect(() => kek.open({ ...sealed, ct: ct.toString('base64url') })).toThrow(
      /SOURCE_KEY_SEAL_TAMPERED/,
    );
    // A truncated GCM tag must never be accepted.
    const shortTag = Buffer.from(sealed.tag, 'base64url').subarray(0, 4).toString('base64url');
    expect(isSealedKey({ ...sealed, tag: shortTag })).toBe(false);
    expect(() => kek.open({ ...sealed, tag: shortTag })).toThrow(/SOURCE_KEY_SEAL_TAMPERED/);
    // Foreign / legacy rows are not "sealed" at all.
    expect(isSealedKey(undefined)).toBe(false);
    expect(isSealedKey({ v: 1, kekId: 'nope', iv: 'x', ct: 'y', tag: 'z' })).toBe(false);
  });
});

// ================================================================ policy

describe('custody policy: the public derivation is refused in production and off loopback', () => {
  const ctx = (nodeEnv: 'development' | 'test' | 'production', host = '127.0.0.1') => ({
    nodeEnv,
    host,
  });

  it('production without a KEK is refused (no fallback of any kind)', () => {
    for (const custody of [undefined, parseSourceKeyCustodyEnv({})]) {
      expect(() => resolveKekRing(custody, ctx('production'))).toThrow(/SOURCE_KEK_REQUIRED/);
    }
    // Loopback does not soften production.
    expect(() => resolveKekRing(undefined, ctx('production', '127.0.0.1'))).toThrow(
      /SOURCE_KEK_REQUIRED/,
    );
  });

  it('production refuses the public derivation as current, as previous, and as a configured value', () => {
    const asCurrent = parseSourceKeyCustodyEnv({ MOTERVA_SOURCE_KEY_KEK: PUBLIC_HEX });
    expect(() => resolveKekRing(asCurrent, ctx('production'))).toThrow(
      /SOURCE_KEK_PUBLIC_DERIVATION_REFUSED/,
    );
    const asPrevious = parseSourceKeyCustodyEnv({
      MOTERVA_SOURCE_KEY_KEK: KEK_A,
      MOTERVA_SOURCE_KEY_KEK_PREVIOUS: PUBLIC_HEX,
    });
    expect(() => resolveKekRing(asPrevious, ctx('production'))).toThrow(
      /SOURCE_KEK_PUBLIC_DERIVATION_REFUSED/,
    );
    const local = Kek.localDerived();
    expect(local.publicDerivation).toBe(true);
    expect(local.id).toBe('local-derived');
  });

  it('production with a real KEK runs as CONFIGURED; non-production loopback may use the labelled public derivation', () => {
    const real = parseSourceKeyCustodyEnv({ MOTERVA_SOURCE_KEY_KEK: KEK_A });
    const ring = resolveKekRing(real, ctx('production'));
    expect(ring.posture).toBe('configured');
    expect(ring.current.id).toBe(idOf(KEK_A));
    expect(ring.current.publicDerivation).toBe(false);
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      const dev = resolveKekRing(undefined, ctx('development', host));
      expect(dev.posture).toBe('local-derived');
      expect(dev.current.id).toBe('local-derived');
    }
    expect(resolveKekRing(undefined, ctx('test')).posture).toBe('local-derived');
  });

  it('a NETWORK-REACHABLE non-production host (NODE_ENV left at development in a cloud preview) must provision a KEK too', () => {
    for (const host of ['0.0.0.0', '10.0.0.7', 'api.example.org']) {
      expect(() => resolveKekRing(undefined, ctx('development', host))).toThrow(
        /SOURCE_KEK_REQUIRED/,
      );
    }
    const ok = resolveKekRing(
      parseSourceKeyCustodyEnv({ MOTERVA_SOURCE_KEY_KEK: KEK_A }),
      ctx('development', '0.0.0.0'),
    );
    expect(ok.posture).toBe('configured');
  });

  it('rotation/recovery variables are validated: duplicates fold, contradictions and garbage refuse', () => {
    const folded = parseSourceKeyCustodyEnv({
      MOTERVA_SOURCE_KEY_KEK: KEK_B,
      MOTERVA_SOURCE_KEY_KEK_PREVIOUS: `${KEK_A}, ${KEK_A}\n${KEK_B}`,
    });
    expect(folded.previous.map((k) => k.id)).toEqual([idOf(KEK_A)]);
    expect(() =>
      parseSourceKeyCustodyEnv({
        MOTERVA_SOURCE_KEY_KEK: KEK_B,
        MOTERVA_SOURCE_KEY_KEK_RETIRED: idOf(KEK_B),
      }),
    ).toThrow(/also configured as a usable KEK/);
    expect(() => parseSourceKeyCustodyEnv({ MOTERVA_SOURCE_KEY_KEK_RETIRED: KEK_A })).toThrow(
      /fingerprints/,
    );
    expect(() =>
      parseSourceKeyCustodyEnv({ MOTERVA_SOURCE_KEY_KEK_PREVIOUS: 'not-a-key-at-all-xxxxxxxx' }),
    ).toThrow(/SOURCE_KEK_INVALID/);
    expect(parseSourceKeyCustodyEnv({ MOTERVA_SOURCE_KEY_KEK_RETIRED: 'local-derived' })).toEqual(
      expect.objectContaining({ retiredKekIds: ['local-derived'] }),
    );
  });
});

// ======================================================= B. loadConfig gate

describe('loadConfig: NODE_ENV=production + OIDC configured fails closed without a valid KEK', () => {
  const prod = (extra: Record<string, string | undefined> = {}) =>
    loadConfig({ NODE_ENV: 'production', LOG_LEVEL: 'silent', ...OIDC, ...extra });

  function issuesOf(run: () => unknown): string {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(StartupConfigError);
      return (error as StartupConfigError).message;
    }
    throw new Error('expected loadConfig to refuse');
  }

  it('ABSENT or blank KEK → refuses to start, naming the variable and the rule', () => {
    for (const value of [undefined, '', '   ']) {
      const message = issuesOf(() => prod({ MOTERVA_SOURCE_KEY_KEK: value }));
      expect(message).toContain('MOTERVA_SOURCE_KEY_KEK');
      expect(message).toContain('SOURCE_KEK_REQUIRED');
      expect(message).toMatch(/predictable local derivation is NEVER used in production/);
    }
  });

  it('MALFORMED KEK → refuses, and the message never contains the supplied value', () => {
    for (const value of [
      'not-a-key-but-long-enough-0123456789',
      hexOf('short').slice(0, 62),
      `${hexOf('x')}ff`,
      'z'.repeat(64),
    ]) {
      const message = issuesOf(() => prod({ MOTERVA_SOURCE_KEY_KEK: value }));
      expect(message).toContain('SOURCE_KEK_INVALID');
      expect(message).not.toContain(value);
    }
  });

  it('the PUBLIC derivation supplied as the KEK is refused in production', () => {
    const message = issuesOf(() => prod({ MOTERVA_SOURCE_KEY_KEK: PUBLIC_HEX }));
    expect(message).toContain('SOURCE_KEK_PUBLIC_DERIVATION_REFUSED');
    expect(message).not.toContain(PUBLIC_HEX);
  });

  it('a VALID KEK loads, reaches the runtime config, and stays opaque', () => {
    const config = prod({ MOTERVA_SOURCE_KEY_KEK: KEK_A });
    expect(config.sourceKeyCustody?.current?.id).toBe(idOf(KEK_A));
    expect(config.warnings.join('\n')).not.toMatch(/PUBLIC deterministic/);
    const dumped = `${JSON.stringify(config)}\n${inspect(config, { depth: null, showHidden: true })}`;
    expect(dumped).not.toContain(KEK_A);
    expect(dumped).not.toContain(Buffer.from(KEK_A, 'hex').toString('base64url'));
    // base64url and base64 encodings of the same 32 bytes are the same key.
    const raw = Buffer.from(KEK_A, 'hex');
    expect(
      prod({ MOTERVA_SOURCE_KEY_KEK: raw.toString('base64url') }).sourceKeyCustody?.current?.id,
    ).toBe(idOf(KEK_A));
    expect(
      prod({ MOTERVA_SOURCE_KEY_KEK: raw.toString('base64') }).sourceKeyCustody?.current?.id,
    ).toBe(idOf(KEK_A));
  });

  it('a malformed PREVIOUS key refuses startup even alongside a valid current key', () => {
    const message = issuesOf(() =>
      prod({
        MOTERVA_SOURCE_KEY_KEK: KEK_A,
        MOTERVA_SOURCE_KEY_KEK_PREVIOUS: 'garbage-garbage-garbage',
      }),
    );
    expect(message).toContain('MOTERVA_SOURCE_KEY_KEK_PREVIOUS');
  });

  it('production WITHOUT identity serves no credential surface and needs no KEK — but a malformed one is still refused', () => {
    expect(loadConfig({ NODE_ENV: 'production', LOG_LEVEL: 'silent' }).identity).toBeNull();
    const message = issuesOf(() =>
      loadConfig({
        NODE_ENV: 'production',
        MOTERVA_SOURCE_KEY_KEK: 'definitely-not-a-valid-kek-0123456789',
      }),
    );
    expect(message).toContain('SOURCE_KEK_INVALID');
  });

  it('non-production loopback with the credential surface loads with the PUBLIC-derivation warning; off loopback it refuses', () => {
    const local = loadConfig({
      NODE_ENV: 'development',
      LOG_LEVEL: 'silent',
      HOST: '127.0.0.1',
      MOTERVA_DEV_AUTH: '1',
    });
    expect(local.warnings.join('\n')).toMatch(/PUBLIC deterministic local derivation/);
    const offLoopback = issuesOf(() =>
      loadConfig({ NODE_ENV: 'development', LOG_LEVEL: 'silent', HOST: '0.0.0.0', ...OIDC }),
    );
    expect(offLoopback).toContain('SOURCE_KEK_REQUIRED');
    expect(offLoopback).toContain('0.0.0.0');
  });
});

function hexOf(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

// =============================================== C. buildApp defense in depth

describe('buildApp refuses independently of loadConfig (hand-built configs, future entry points)', () => {
  function freshLedger(): Ledger {
    const ledger = openLedger(join(DIR, `defense-${String(Math.random()).slice(2, 8)}.sqlite`));
    ledger.migrate();
    return ledger;
  }

  it('production + identity with NO custody on the config → SOURCE_KEK_REQUIRED, thrown synchronously', async () => {
    const valid = loadConfig({
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      ...OIDC,
      MOTERVA_SOURCE_KEY_KEK: KEK_A,
    });
    const ledger = freshLedger();
    try {
      const bare = { ...valid, sourceKeyCustody: undefined };
      expect(() => buildApp(bare, undefined, ledger, undefined, undefined, STUB_CLIENT)).toThrow(
        /SOURCE_KEK_REQUIRED/,
      );
      const publicOnly = {
        ...valid,
        sourceKeyCustody: parseSourceKeyCustodyEnv({ MOTERVA_SOURCE_KEY_KEK: PUBLIC_HEX }),
      };
      expect(() =>
        buildApp(publicOnly, undefined, ledger, undefined, undefined, STUB_CLIENT),
      ).toThrow(/SOURCE_KEK_PUBLIC_DERIVATION_REFUSED/);
      // Control: the validated config boots.
      const app = buildApp(valid, undefined, ledger, undefined, undefined, STUB_CLIENT);
      await app.ready();
      await app.close();
    } finally {
      ledger.close();
    }
  });

  it('network-reachable non-production host with no custody → refused too', () => {
    const dev = loadConfig({
      NODE_ENV: 'development',
      LOG_LEVEL: 'silent',
      HOST: '127.0.0.1',
      MOTERVA_DEV_AUTH: '1',
    });
    const ledger = freshLedger();
    try {
      expect(() => buildApp({ ...dev, host: '0.0.0.0' }, undefined, ledger)).toThrow(
        /SOURCE_KEK_REQUIRED/,
      );
    } finally {
      ledger.close();
    }
  });
});

// ================================================ D. production, end to end

describe('production boot with a real KEK: seal, decrypt after restart, rotate, roll back, recover', () => {
  const clock = new TunableClock(new Date('2026-11-11T09:00:00.000Z').toISOString());
  const DB = join(DIR, 'prod.sqlite');
  let cur: { app: FastifyInstance; ledger: Ledger } | undefined;
  let session: Session = { cookie: '', csrf: '' };
  let orgId = '';
  let missionId = '';
  let secretA = '';
  let nextSeq = 1;

  function tryBoot(db: string, extra: Record<string, string>): { error?: unknown } {
    const ledger = openLedger(db, clock);
    ledger.migrate();
    try {
      const app = buildApp(
        loadConfig({ NODE_ENV: 'production', LOG_LEVEL: 'silent', ...OIDC, ...extra }),
        undefined,
        ledger,
        undefined,
        undefined,
        STUB_CLIENT,
      );
      cur = { app, ledger };
      return {};
    } catch (error) {
      ledger.close();
      return { error };
    }
  }

  async function bootOk(extra: Record<string, string>, login = true): Promise<void> {
    const result = tryBoot(DB, extra);
    if (result.error !== undefined) throw result.error;
    await cur!.app.ready();
    if (login) session = await oidcLogin(cur!.app);
  }

  async function shutdown(): Promise<void> {
    if (cur === undefined) return;
    await cur.app.close();
    cur.ledger.close();
    cur = undefined;
  }

  async function oidcLogin(app: FastifyInstance): Promise<Session> {
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
    const state = new URL(String(start.headers.location)).searchParams.get('state');
    const done = await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?code=stub-code&state=${String(state)}`,
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(done.statusCode, done.body).toBe(303);
    const raw = done.headers['set-cookie'] as unknown;
    const all = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
    const sessionCookie = all.find((c) => c.startsWith('moterva_session='))!.split(';')[0]!;
    const csrfCookie = all.find((c) => c.startsWith('moterva_csrf='))!.split(';')[0]!;
    return { cookie: sessionCookie, csrf: csrfCookie.slice('moterva_csrf='.length) };
  }

  const admin = () =>
    asAdmin(
      () => cur!.app,
      () => session,
    );

  async function ingest(secret: string, keyId: string, sourceId = 'ridge-telemetry') {
    const res = await machineSubmit(cur!.app, missionId, secret, [
      machineEvent({
        orgId,
        missionId,
        eventId: `evt_custody_${String(nextSeq)}_${keyId}`,
        sequence: nextSeq,
        sourceId,
        keyId,
        observedAt: clock.iso(),
      }),
    ]);
    if (res.statusCode === 200 && res.json().outcomes[0].status === 'accepted') nextSeq += 1;
    return res;
  }

  function resealRows(): { payload_json: string }[] {
    return cur!.ledger.db
      .prepare(`SELECT payload_json FROM evidence_events WHERE type = 'mission.source.resealed'`)
      .all() as { payload_json: string }[];
  }

  function credentialRow(keyId: string): Record<string, unknown> {
    const rows = cur!.ledger.db
      .prepare(`SELECT payload_json FROM evidence_events WHERE type = 'mission.source.registered'`)
      .all() as { payload_json: string }[];
    return rows
      .map((r) => JSON.parse(r.payload_json) as Record<string, unknown>)
      .find((r) => r.keyId === keyId)!;
  }

  function errorOf(extra: Record<string, string>): SourceKeyCustodyError {
    const { error } = tryBoot(DB, extra);
    if (error === undefined) {
      void cur?.app.close();
      cur?.ledger.close();
      cur = undefined;
      throw new Error('expected the boot to be refused');
    }
    expect(error).toBeInstanceOf(SourceKeyCustodyError);
    return error as SourceKeyCustodyError;
  }

  const noKeyMaterial = (text: string): void => {
    for (const kek of [KEK_A, KEK_B, KEK_C]) {
      expect(text).not.toContain(kek);
      expect(text).not.toContain(Buffer.from(kek, 'hex').toString('base64url'));
    }
    expect(text).not.toContain(secretA);
  };

  it('boots with KEK A; issuance seals under A — never the public derivation — and a headless client ingests', async () => {
    await bootOk({ MOTERVA_SOURCE_KEY_KEK: KEK_A }, false);
    const provisioned = cur!.ledger.identity.provisionIdentityActor({
      orgTitle: 'Custody Org',
      username: 'owner@prod.example',
      displayName: 'Prod Owner',
      role: 'owner',
      provider: ISSUER,
      subject: 'owner-prod-sub',
    });
    orgId = provisioned.orgId;
    session = await oidcLogin(cur!.app);
    const mission = await admin().post('/api/missions', { title: 'Custody survey' });
    expect(mission.statusCode, mission.body).toBe(200);
    missionId = (mission.json() as { id: string }).id;
    const spec = await admin().post(`/api/missions/${missionId}/mission-spec`, {
      spec: customerSpec(orgId, missionId, 'custody-spec'),
    });
    expect(spec.statusCode, spec.body).toBe(200);

    const issued = await admin().post(`/api/missions/${missionId}/sources/ridge-telemetry/secret`, {
      keyId: 'ridge-key-1',
      trustedForRecovery: false,
    });
    expect(issued.statusCode, issued.body).toBe(200);
    secretA = issued.json().secret as string;
    expect(String(issued.headers['cache-control'])).toBe('no-store');
    expect(issued.json().custody).toMatch(/deployment key-encryption key/);
    expect(issued.json().custody).not.toMatch(/PUBLIC/);

    const row = credentialRow('ridge-key-1');
    const sealed = row.sealed as { kekId: string };
    expect(sealed.kekId).toBe(idOf(KEK_A));
    expect(sealed.kekId).not.toBe('local-derived');
    expect(row.keyDigest).toBe(keyDigestOf(secretA));
    expect(row.secretKey).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(secretA);

    const res = await ingest(secretA, 'ridge-key-1');
    expect(res.json().outcomes[0].status, JSON.stringify(res.json())).toBe('accepted');
  });

  it('no key material exists in the database file or any API read; ciphertext decrypts AFTER RESTART with the same KEK', async () => {
    const reads = [
      JSON.stringify((await admin().get(`/api/missions/${missionId}/mission-spec`)).json()),
      JSON.stringify((await admin().get(`/api/missions/${missionId}/physical-view`)).json()),
      JSON.stringify((await admin().get(`/api/missions/${missionId}/decision-snapshots`)).json()),
    ].join('\n');
    expect(reads).not.toContain(secretA);
    await shutdown();

    // Every byte on disk: main file plus any WAL/SHM sidecar.
    const needles = [
      secretA,
      KEK_A,
      KEK_A.toUpperCase(),
      Buffer.from(KEK_A, 'hex').toString('base64url'),
    ]
      .map((value) => Buffer.from(value, 'utf8'))
      .concat(Buffer.from(KEK_A, 'hex'));
    for (const file of [DB, `${DB}-wal`, `${DB}-shm`]) {
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file);
      for (const needle of needles) expect(bytes.indexOf(needle), file).toBe(-1);
    }

    await bootOk({ MOTERVA_SOURCE_KEY_KEK: KEK_A });
    const after = await ingest(secretA, 'ridge-key-1');
    expect(after.json().outcomes[0].status, JSON.stringify(after.json())).toBe('accepted');
  });

  it('a DIFFERENT KEK is refused at boot — never silently swapped — naming fingerprints and the recovery steps, no key material', async () => {
    await shutdown();
    const error = errorOf({ MOTERVA_SOURCE_KEY_KEK: KEK_B });
    expect(error.code).toBe('SOURCE_KEK_UNRECOVERABLE');
    expect(error.message).toContain(idOf(KEK_A));
    expect(error.message).toContain(idOf(KEK_B)); // the current KEK, by fingerprint
    expect(error.message).toContain('MOTERVA_SOURCE_KEY_KEK_PREVIOUS');
    expect(error.message).toContain(`MOTERVA_SOURCE_KEY_KEK_RETIRED=${idOf(KEK_A)}`);
    noKeyMaterial(`${error.message}\n${String(error.stack)}`);
  });

  it('ROTATION: new KEK current + old KEK previous re-seals at boot (metadata-only, idempotent) and the SAME key keeps working', async () => {
    await bootOk({ MOTERVA_SOURCE_KEY_KEK: KEK_B, MOTERVA_SOURCE_KEY_KEK_PREVIOUS: KEK_A });
    const rows = resealRows();
    expect(rows).toHaveLength(1);
    const reseal = JSON.parse(rows[0]!.payload_json) as {
      keyId: string;
      keyDigest: string;
      previousKekId: string;
      sealed: { kekId: string };
      reason: string;
    };
    expect(reseal.keyId).toBe('ridge-key-1');
    expect(reseal.sealed.kekId).toBe(idOf(KEK_B));
    expect(reseal.previousKekId).toBe(idOf(KEK_A));
    expect(reseal.keyDigest).toBe(keyDigestOf(secretA));
    expect(reseal.reason).toBe('kek-rotation');
    noKeyMaterial(rows[0]!.payload_json);
    const res = await ingest(secretA, 'ridge-key-1');
    expect(res.json().outcomes[0].status, JSON.stringify(res.json())).toBe('accepted');

    // Booting again with the same rotation env appends nothing.
    await shutdown();
    await bootOk({ MOTERVA_SOURCE_KEY_KEK: KEK_B, MOTERVA_SOURCE_KEY_KEK_PREVIOUS: KEK_A });
    expect(resealRows()).toHaveLength(1);
  });

  it('after rotation the OLD key can be dropped entirely; and a ROLLBACK to the old key alone still works (append-only seals)', async () => {
    await shutdown();
    await bootOk({ MOTERVA_SOURCE_KEY_KEK: KEK_B });
    const onB = await ingest(secretA, 'ridge-key-1');
    expect(onB.json().outcomes[0].status, JSON.stringify(onB.json())).toBe('accepted');
    await shutdown();

    await bootOk({ MOTERVA_SOURCE_KEY_KEK: KEK_A });
    const rolledBack = await ingest(secretA, 'ridge-key-1');
    expect(rolledBack.json().outcomes[0].status, JSON.stringify(rolledBack.json())).toBe(
      'accepted',
    );
  });

  it('RECOVERY: with every KEK lost, boot refuses until the operator explicitly retires the fingerprints; partial acknowledgement is not enough', async () => {
    await shutdown();
    const lost = errorOf({ MOTERVA_SOURCE_KEY_KEK: KEK_C });
    expect(lost.code).toBe('SOURCE_KEK_UNRECOVERABLE');
    expect(lost.message).toContain(idOf(KEK_A));
    expect(lost.message).toContain(idOf(KEK_B));
    expect(lost.message).toContain(
      `MOTERVA_SOURCE_KEY_KEK_RETIRED=${[idOf(KEK_A), idOf(KEK_B)].sort().join(',')}`,
    );
    noKeyMaterial(lost.message);

    const partial = errorOf({
      MOTERVA_SOURCE_KEY_KEK: KEK_C,
      MOTERVA_SOURCE_KEY_KEK_RETIRED: idOf(KEK_A),
    });
    expect(partial.message).toContain(`RETIRED=${idOf(KEK_B)}`);
    expect(partial.message).not.toContain(`RETIRED=${idOf(KEK_A)}`);

    await bootOk({
      MOTERVA_SOURCE_KEY_KEK: KEK_C,
      MOTERVA_SOURCE_KEY_KEK_RETIRED: `${idOf(KEK_A)}, ${idOf(KEK_B)}`,
    });
    // The retired credential is QUARANTINED: it can never authenticate again…
    const dead = await ingest(secretA, 'ridge-key-1');
    expect(dead.statusCode).toBe(422);
    expect(refusalCode(dead)).toBe('UNAUTHENTICATED_SOURCE');
    // …yet a NEW credential works, sealed under the new KEK.
    const reissued = await admin().post(
      `/api/missions/${missionId}/sources/ridge-telemetry/secret`,
      {
        keyId: 'ridge-key-2',
        trustedForRecovery: false,
      },
    );
    expect(reissued.statusCode, reissued.body).toBe(200);
    const secretC = reissued.json().secret as string;
    expect((credentialRow('ridge-key-2').sealed as { kekId: string }).kekId).toBe(idOf(KEK_C));
    const fresh = await ingest(secretC, 'ridge-key-2');
    expect(fresh.json().outcomes[0].status, JSON.stringify(fresh.json())).toBe('accepted');
    // Revoking the lost credential (a journal-only act) clears the acknowledgement
    // requirement: the next boot needs no RETIRED list.
    const revoke = await admin().post(
      `/api/missions/${missionId}/sources/ridge-telemetry/keys/ridge-key-1/revoke`,
      { reason: 'custody lost' },
    );
    expect(revoke.statusCode, revoke.body).toBe(200);
    await shutdown();
    await bootOk({ MOTERVA_SOURCE_KEY_KEK: KEK_C });
    const still = await ingest(secretC, 'ridge-key-2');
    expect(still.json().outcomes[0].status, JSON.stringify(still.json())).toBe('accepted');
    await shutdown();
  });
});

// =========================================== E. ledger-level custody scenarios

describe('boot verification over hostile / legacy ledgers', () => {
  const clock = new TunableClock(new Date('2026-11-11T09:00:00.000Z').toISOString());

  function seededLedger(name: string): {
    ledger: Ledger;
    db: string;
    orgId: string;
    missionId: string;
  } {
    const db = join(DIR, `${name}.sqlite`);
    const ledger = openLedger(db, clock);
    ledger.migrate();
    const orgId = ledger.organizations.createOrganization('Seeded Org').id;
    const missionId = ledger.organizations.createMission(orgId, 'Seeded mission').id;
    return { ledger, db, orgId, missionId };
  }

  function seed(
    ledger: Ledger,
    orgId: string,
    missionId: string,
    kek: Kek,
    keyId: string,
    plaintext: string,
  ): void {
    ledger.evidence.append({
      orgId,
      missionId,
      topic: 'operational',
      type: 'mission.source.registered',
      eventKey: credentialEventKey(missionId, 'ridge-telemetry', keyId),
      payload: {
        sourceId: 'ridge-telemetry',
        sourceType: 'asset_telemetry',
        keyId,
        keyDigest: keyDigestOf(plaintext),
        sealed: kek.seal(plaintext),
        assetIds: ['drone-cartographer'],
        trustedForRecovery: false,
        provenance: 'FIELD',
        issuedBy: 'seed',
        issuedAt: clock.iso(),
      },
    });
  }

  const production = { nodeEnv: 'production' as const, host: '0.0.0.0' };

  it('credentials sealed under the PUBLIC local derivation are refused by a production boot until explicitly retired', () => {
    const { ledger, orgId, missionId } = seededLedger('legacy-local');
    seed(
      ledger,
      orgId,
      missionId,
      Kek.localDerived(),
      'legacy-key-1',
      'legacy-secret-0123456789abcdef',
    );
    const log = { info: () => {}, warn: () => {} };
    const ring = resolveKekRing(
      parseSourceKeyCustodyEnv({ MOTERVA_SOURCE_KEY_KEK: KEK_A }),
      production,
    );
    try {
      verifySourceKeyCustody(ledger, ring, { production: true });
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(SourceKeyCustodyError);
      expect((error as SourceKeyCustodyError).code).toBe('SOURCE_KEK_UNRECOVERABLE');
      expect((error as Error).message).toContain('local-derived');
    }
    // Explicit acknowledgement: boots, credential quarantined (counted, not honoured).
    const acknowledged = establishSourceKeyCustody(
      ledger,
      {
        ...production,
        custody: parseSourceKeyCustodyEnv({
          MOTERVA_SOURCE_KEY_KEK: KEK_A,
          MOTERVA_SOURCE_KEY_KEK_RETIRED: 'local-derived',
        }),
      },
      log,
    );
    expect(acknowledged.current.id).toBe(idOf(KEK_A));
    ledger.close();
  });

  it('a credential row whose payload digest does not match (tampering) refuses the boot', () => {
    const { ledger, orgId, missionId } = seededLedger('tampered');
    seed(
      ledger,
      orgId,
      missionId,
      parseKek(KEK_A, 'test'),
      'ridge-key-1',
      'good-secret-0123456789abcdef',
    );
    // Forge a second row directly (the journal forbids UPDATE, not a hostile INSERT).
    ledger.db
      .prepare(
        `INSERT INTO evidence_events (id, org_id, mission_id, topic, type, event_key, payload_digest, payload_json, recorded_at)
         VALUES (?, ?, ?, 'operational', 'mission.source.registered', ?, ?, ?, ?)`,
      )
      .run(
        'evt_forged',
        orgId,
        missionId,
        credentialEventKey(missionId, 'ridge-telemetry', 'ridge-key-x'),
        'f'.repeat(64),
        JSON.stringify({ keyId: 'ridge-key-x', sourceId: 'ridge-telemetry' }),
        clock.iso(),
      );
    const ring = resolveKekRing(
      parseSourceKeyCustodyEnv({ MOTERVA_SOURCE_KEY_KEK: KEK_A }),
      production,
    );
    expect(() => verifySourceKeyCustody(ledger, ring, { production: true })).toThrow(
      /SOURCE_CREDENTIAL_INTEGRITY_VIOLATION/,
    );
    ledger.close();
  });

  it('NON-production never aborts on an unknown KEK: it quarantines (fails closed per credential) and reports', () => {
    const { ledger, orgId, missionId } = seededLedger('dev-mismatch');
    seed(
      ledger,
      orgId,
      missionId,
      parseKek(KEK_A, 'test'),
      'ridge-key-1',
      'dev-secret-0123456789abcdef',
    );
    const ring = resolveKekRing(parseSourceKeyCustodyEnv({ MOTERVA_SOURCE_KEY_KEK: KEK_B }), {
      nodeEnv: 'development',
      host: '127.0.0.1',
    });
    const report = verifySourceKeyCustody(ledger, ring, { production: false });
    expect(report.quarantinedUnacknowledged).toBe(1);
    expect(report.unrecoverableKekIds).toEqual([idOf(KEK_A)]);
    ledger.close();
  });

  it('LOGS and diagnostics carry fingerprints and counts — never key material', () => {
    const { ledger, orgId, missionId } = seededLedger('log-hygiene');
    seed(
      ledger,
      orgId,
      missionId,
      parseKek(KEK_A, 'test'),
      'ridge-key-1',
      'log-secret-0123456789abcdef',
    );
    const records: unknown[] = [];
    const log = {
      info: (object: object, message: string) => records.push({ object, message }),
      warn: (object: object, message: string) => records.push({ object, message }),
    };
    const ring = establishSourceKeyCustody(
      ledger,
      {
        ...production,
        custody: parseSourceKeyCustodyEnv({
          MOTERVA_SOURCE_KEY_KEK: KEK_B,
          MOTERVA_SOURCE_KEY_KEK_PREVIOUS: KEK_A,
        }),
      },
      log,
    );
    expect(ring.current.id).toBe(idOf(KEK_B));
    const text = JSON.stringify(records);
    expect(text).toContain(idOf(KEK_B));
    expect(text).toContain('"resealed":1');
    for (const material of [KEK_A, KEK_B, 'log-secret-0123456789abcdef']) {
      expect(text).not.toContain(material);
    }
    ledger.close();
  });
});

// ============================================== F. the REAL entrypoint boots

describe('the real server entrypoint refuses to start (negative boot integration)', () => {
  const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

  function runEntrypoint(env: Record<string, string>) {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (/^(MOTERVA_|NODE_ENV$|PORT$|HOST$|WEB_ORIGIN$|LOG_LEVEL$|AIRWALLEX_|METAL_)/.test(key))
        continue;
      clean[key] = value;
    }
    return spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: apiDir,
      env: { ...clean, ...env },
      encoding: 'utf8',
      timeout: 120_000,
    });
  }

  const base = (ledgerPath: string, extra: Record<string, string> = {}) => ({
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    MOTERVA_LEDGER_PATH: ledgerPath,
    ...OIDC,
    ...extra,
  });

  it('NODE_ENV=production + OIDC configured + KEK absent → exit 1, names the variable, starts nothing', () => {
    const result = runEntrypoint(base(join(DIR, 'boot-absent.sqlite')));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to start');
    expect(result.stderr).toContain('MOTERVA_SOURCE_KEY_KEK');
    expect(result.stderr).toContain('SOURCE_KEK_REQUIRED');
    expect(existsSync(join(DIR, 'boot-absent.sqlite'))).toBe(false); // refused BEFORE opening the ledger
  }, 120_000);

  it('MALFORMED KEK → exit 1 and the value is never printed', () => {
    const marker = 'malformed-kek-marker-0123456789abcdefABCDEF';
    const result = runEntrypoint(
      base(join(DIR, 'boot-bad.sqlite'), { MOTERVA_SOURCE_KEY_KEK: marker }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SOURCE_KEK_INVALID');
    expect(`${result.stdout}${result.stderr}`).not.toContain(marker);
  }, 120_000);

  it('the PUBLIC derivation as the KEK → exit 1', () => {
    const result = runEntrypoint(
      base(join(DIR, 'boot-public.sqlite'), { MOTERVA_SOURCE_KEY_KEK: PUBLIC_HEX }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SOURCE_KEK_PUBLIC_DERIVATION_REFUSED');
    expect(`${result.stdout}${result.stderr}`).not.toContain(PUBLIC_HEX);
  }, 120_000);

  it('a valid-but-DIFFERENT KEK against an existing ledger sealed under another key → exit 1 from the custody gate, no key material printed', () => {
    const db = join(DIR, 'boot-mismatch.sqlite');
    const ledger = openLedger(db);
    ledger.migrate();
    const orgId = ledger.organizations.createOrganization('Boot Org').id;
    const missionId = ledger.organizations.createMission(orgId, 'Boot mission').id;
    const plaintext = 'boot-mismatch-secret-0123456789abcdef';
    ledger.evidence.append({
      orgId,
      missionId,
      topic: 'operational',
      type: 'mission.source.registered',
      eventKey: credentialEventKey(missionId, 'ridge-telemetry', 'ridge-key-1'),
      payload: {
        sourceId: 'ridge-telemetry',
        sourceType: 'asset_telemetry',
        keyId: 'ridge-key-1',
        keyDigest: keyDigestOf(plaintext),
        sealed: parseKek(KEK_A, 'test').seal(plaintext),
        assetIds: ['drone-cartographer'],
        trustedForRecovery: false,
        provenance: 'FIELD',
        issuedBy: 'seed',
        issuedAt: new Date().toISOString(),
      },
    });
    ledger.close();

    const result = runEntrypoint(base(db, { MOTERVA_SOURCE_KEY_KEK: KEK_B }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to start');
    expect(result.stderr).toContain('SOURCE_KEK_UNRECOVERABLE');
    expect(result.stderr).toContain(idOf(KEK_A));
    const everything = `${result.stdout}${result.stderr}`;
    for (const material of [KEK_A, KEK_B, plaintext]) expect(everything).not.toContain(material);
  }, 120_000);
});
