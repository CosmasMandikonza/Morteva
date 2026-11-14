import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openLedger, TunableClock, type Ledger } from '@moterva/ledger';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { replayServiceFor } from '../../src/integration/source-credentials.js';
import { credentialEventKey, keyDigestOf } from '../../src/integration/source-credential-store.js';
import { parseKek } from '../../src/integration/source-key-custody.js';
import {
  asAdmin,
  customerSpec,
  devLogin,
  machineEvent,
  machineSubmit,
  refusalCode,
  runtimeKek,
  statusProof,
  DEV_PASSWORD,
  type EventSpec,
  type InjectLike,
  type Session,
} from './helpers/machine-harness.js';

/**
 * MACHINE-INGRESS ADVERSARIAL SUITE — CTO review PR #64, comment 6808560477:
 *
 *  P1 keyId cross-tenant ambiguity — the old resolver searched the whole
 *     journal with `payload_json LIKE '%keyId%' ORDER BY seq DESC LIMIT 1`, so a
 *     LATER record naming the same keyId — or merely CONTAINING it — shadowed
 *     the legitimate credential and let one tenant deny another's telemetry.
 *     Credentials now have no global identity: they resolve inside the
 *     (org, mission) the URL names, by exact indexed read.
 *  P1 unauthenticated key enumeration — the status route returned usability and
 *     the bound mission to anyone who named a keyId. It now demands a signed
 *     possession proof and answers every failure identically.
 *
 * Every scenario runs over a REAL app + ledger, then again across a RESTART.
 * Headless clients hold only an issued key: no cookie, no CSRF.
 */

const DIR = mkdtempSync(join(tmpdir(), 'mv-ingress-'));
const KEK = runtimeKek('machine-ingress-security');
const clock = new TunableClock(new Date('2026-11-11T09:00:00.000Z').toISOString());
let ledger: Ledger;
let app: FastifyInstance;

interface Tenant {
  key: 'a' | 'b' | 'c';
  orgId: string;
  missionId: string;
  owner: Session;
  admin: ReturnType<typeof asAdmin>;
  /** Next expected sequence on the ridge-telemetry / drone-cartographer stream. */
  next: number;
}
const tenants = {} as Record<'a' | 'b' | 'c', Tenant>;

/** Issued keys shared across the ordered scenarios below. */
const vault = new Map<string, string>();
function keyOf(name: string): string {
  const value = vault.get(name);
  if (value === undefined) throw new Error(`test key "${name}" was not issued`);
  return value;
}

function isoAt(minutesAgo: number): string {
  return new Date(clock.now().getTime() - minutesAgo * 60_000).toISOString();
}

async function boot(): Promise<void> {
  ledger = openLedger(join(DIR, 'ledger.sqlite'), clock);
  ledger.migrate();
  app = buildApp(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WEB_ORIGIN: 'http://localhost:5173',
      HOST: '127.0.0.1',
      MOTERVA_DEV_AUTH: '1',
      MOTERVA_SOURCE_KEY_KEK: KEK,
    }),
    undefined,
    ledger,
  );
  await app.ready();
}

async function restart(): Promise<void> {
  await app.close();
  ledger.close();
  await boot();
  for (const t of Object.values(tenants)) t.owner = await devLogin(app, `owner${t.key}`);
}

async function createTenant(key: 'a' | 'b' | 'c'): Promise<void> {
  const orgId = ledger.organizations.createOrganization(`Tenant ${key.toUpperCase()}`).id;
  ledger.authority.createHumanActor({
    orgId,
    username: `owner${key}`,
    displayName: `Owner ${key.toUpperCase()}`,
    role: 'owner',
    password: DEV_PASSWORD,
  });
  const tenant = {
    key,
    orgId,
    missionId: '',
    owner: await devLogin(app, `owner${key}`),
    next: 1,
  } as Tenant;
  tenant.admin = asAdmin(
    () => app,
    () => tenant.owner,
  );
  const mission = await tenant.admin.post('/api/missions', { title: `Survey ${key}` });
  tenant.missionId = (mission.json() as { id: string }).id;
  const spec = await tenant.admin.post(`/api/missions/${tenant.missionId}/mission-spec`, {
    spec: customerSpec(orgId, tenant.missionId, `spec-${key}`),
  });
  expect(spec.statusCode, JSON.stringify(spec.json())).toBe(200);
  tenants[key] = tenant;
}

async function issue(
  t: Tenant,
  keyId: string,
  opts: { sourceId?: string; expiresAt?: string } = {},
): Promise<string> {
  const sourceId = opts.sourceId ?? 'ridge-telemetry';
  const r = await t.admin.post(`/api/missions/${t.missionId}/sources/${sourceId}/secret`, {
    keyId,
    trustedForRecovery: sourceId === 'site-ops-gateway',
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
  });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
  return r.json().secret as string;
}

/** An event for tenant `t` signed by `signingKey`; consumes a sequence number only when accepted. */
async function send(
  t: Tenant,
  keyId: string,
  signingKey: string,
  overrides: Partial<EventSpec> = {},
  urlMissionId: string = t.missionId,
): Promise<InjectLike> {
  const res = await machineSubmit(app, urlMissionId, signingKey, [
    machineEvent({
      orgId: t.orgId,
      missionId: t.missionId,
      eventId: `evt_${t.key}_${keyId}_${String(t.next)}_${String(Math.random()).slice(2, 8)}`,
      sequence: t.next,
      keyId,
      observedAt: isoAt(0),
      ...overrides,
    }),
  ]);
  if (res.statusCode === 200 && res.json().outcomes[0].status === 'accepted') t.next += 1;
  return res;
}

function admitted(t: Tenant): number {
  return replayServiceFor(ledger).replay(t.orgId, t.missionId).events.length;
}

function statusUrl(missionId: string, sourceId: string, keyId: string): string {
  return `/api/machine/missions/${missionId}/sources/${sourceId}/keys/${keyId}/status`;
}

/** A signed status request; `proofKey` is whatever key the caller signs with. */
async function postStatus(
  missionId: string,
  sourceId: string,
  keyId: string,
  proofKey: string,
  issuedAt: string = clock.iso(),
): Promise<InjectLike> {
  return app.inject({
    method: 'POST',
    url: statusUrl(missionId, sourceId, keyId),
    payload: {
      issuedAt,
      signature: statusProof(proofKey, { missionId, sourceId, keyId, issuedAt }),
    },
  }) as Promise<InjectLike>;
}

async function postRawStatus(
  missionId: string,
  sourceId: string,
  keyId: string,
  signature: string,
): Promise<InjectLike> {
  return app.inject({
    method: 'POST',
    url: statusUrl(missionId, sourceId, keyId),
    payload: { issuedAt: clock.iso(), signature },
  }) as Promise<InjectLike>;
}

beforeAll(async () => {
  await boot();
  for (const key of ['a', 'b', 'c'] as const) await createTenant(key);
});

afterAll(async () => {
  await app.close();
  ledger.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe('P1 keyId ambiguity — credentials resolve inside their tenant, never globally', () => {
  it('two tenants choosing the IDENTICAL keyId + sourceId both ingest; neither can deny the other', async () => {
    vault.set('a1', await issue(tenants.a, 'ridge-key-1'));
    const a1 = await send(tenants.a, 'ridge-key-1', keyOf('a1'));
    expect(a1.json().outcomes[0].status, JSON.stringify(a1.json())).toBe('accepted');

    // B registers the SAME keyId LATER (higher journal seq). The old
    // `ORDER BY seq DESC LIMIT 1` resolver would now bind the keyId to B and
    // refuse every event A sends.
    vault.set('b1', await issue(tenants.b, 'ridge-key-1'));
    expect(keyOf('b1')).not.toBe(keyOf('a1'));
    const b1 = await send(tenants.b, 'ridge-key-1', keyOf('b1'));
    expect(b1.json().outcomes[0].status, JSON.stringify(b1.json())).toBe('accepted');

    const a2 = await send(tenants.a, 'ridge-key-1', keyOf('a1'));
    expect(a2.statusCode, JSON.stringify(a2.json())).toBe(200);
    expect(a2.json().outcomes[0].status).toBe('accepted');

    expect(admitted(tenants.a)).toBe(2);
    expect(admitted(tenants.b)).toBe(1);
  });

  it('a LATER record that merely CONTAINS the keyId cannot shadow the legitimate credential (substring DoS)', async () => {
    // The old resolver matched `LIKE '%ridge-key-1%'`, took the newest row and
    // only THEN compared exactly — so this superstring keyId registered by a
    // hostile tenant after the fact made the victim's key resolve to nothing.
    vault.set('cEvil', await issue(tenants.c, 'ridge-key-1-evil'));
    // …and C also holds a key with the IDENTICAL text on the identical source.
    vault.set('cSame', await issue(tenants.c, 'ridge-key-1'));
    const c1 = await send(tenants.c, 'ridge-key-1-evil', keyOf('cEvil'));
    expect(c1.json().outcomes[0].status).toBe('accepted');

    const a3 = await send(tenants.a, 'ridge-key-1', keyOf('a1'));
    expect(a3.statusCode, JSON.stringify(a3.json())).toBe(200);
    expect(a3.json().outcomes[0].status).toBe('accepted');
    const b2 = await send(tenants.b, 'ridge-key-1', keyOf('b1'));
    expect(b2.statusCode, JSON.stringify(b2.json())).toBe(200);
    expect(admitted(tenants.a)).toBe(3);
    expect(admitted(tenants.b)).toBe(2);
    expect(admitted(tenants.c)).toBe(1);
  });

  it('REPRODUCTION — the legacy resolver (66e12e1), run verbatim against THIS journal, mis-binds these exact credentials', async () => {
    // The CTO-reviewed resolver, copied unchanged: a payload-text LIKE, newest
    // row only (LIMIT 1 is applied BEFORE the exact keyId comparison).
    const legacyResolve = (keyId: string): string | undefined => {
      const rows = ledger.db
        .prepare(
          `SELECT org_id, mission_id, payload_json FROM evidence_events
            WHERE type = ? AND payload_json LIKE ? ORDER BY seq DESC LIMIT 1`,
        )
        .all('mission.source.registered', `%${JSON.stringify(keyId).slice(1, -1)}%`) as {
        org_id: string;
        mission_id: string | null;
        payload_json: string;
      }[];
      for (const row of rows) {
        const payload = JSON.parse(row.payload_json) as { keyId?: string };
        if (payload.keyId === keyId && row.mission_id !== null) return row.org_id;
      }
      return undefined;
    };
    // Identical keyId in three tenants: the newest registration wins globally,
    // so A's and B's own key would be pinned to C — every A/B event refused.
    expect(legacyResolve('ridge-key-1')).toBe(tenants.c.orgId);
    expect(legacyResolve('ridge-key-1')).not.toBe(tenants.a.orgId);
    expect(legacyResolve('ridge-key-1')).not.toBe(tenants.b.orgId);

    // Pure substring shadow: no collision at all, yet a later superstring key
    // makes the victim's legitimate key resolve to NOTHING.
    vault.set('aShadow', await issue(tenants.a, 'shadow-key-a'));
    vault.set('cShadow', await issue(tenants.c, 'shadow-key-a-x'));
    expect(legacyResolve('shadow-key-a')).toBeUndefined();
    expect(legacyResolve('shadow-key-a-x')).toBe(tenants.c.orgId);

    // The fixed route admits the victim's event regardless.
    const admittedNow = await send(tenants.a, 'shadow-key-a', keyOf('aShadow'));
    expect(admittedNow.json().outcomes[0].status, JSON.stringify(admittedNow.json())).toBe(
      'accepted',
    );
  });

  it('SPOOFED TENANT: a hostile holder of a same-named key cannot write into, or learn about, another tenant', async () => {
    const before = { a: admitted(tenants.a), b: admitted(tenants.b), c: admitted(tenants.c) };

    // (a) C signs with C's own `ridge-key-1` but targets A's mission and
    //     claims A's tenant. The credential resolves inside A's scope to A's
    //     key; C's signature does not verify under it → refused, nothing written.
    const spoofA = await send(tenants.a, 'ridge-key-1', keyOf('cSame'));
    expect(spoofA.statusCode).toBe(422);
    expect(refusalCode(spoofA)).toBe('SIGNATURE_INVALID');

    // (b) A's key aimed at B's mission (same keyId text as B's key): resolves
    //     inside B's scope, the signature is A's → refused. A key cannot be
    //     re-pointed at a mission it was not issued for.
    const aAtB = await send(tenants.b, 'ridge-key-1', keyOf('a1'));
    expect(aAtB.statusCode).toBe(422);
    expect(refusalCode(aAtB)).toBe('SIGNATURE_INVALID');

    // (c) Declared tenant disagrees with the mission the URL names.
    const claimsA = machineEvent({
      orgId: tenants.a.orgId,
      missionId: tenants.a.missionId,
      eventId: 'evt_spoof_claim',
      sequence: 1,
      keyId: 'ridge-key-1-evil',
      observedAt: isoAt(0),
    });
    const onC = await machineSubmit(app, tenants.c.missionId, keyOf('cEvil'), [claimsA]);
    expect(onC.statusCode).toBe(401);
    expect(onC.json().error.code).toBe('MACHINE_TENANT_MISMATCH');

    // (d) A mission that does not exist is indistinguishable from a mismatch.
    const ghost = await machineSubmit(app, 'msn_does_not_exist', keyOf('cEvil'), [
      machineEvent({
        orgId: tenants.c.orgId,
        missionId: 'msn_does_not_exist',
        eventId: 'evt_ghost',
        sequence: 1,
        keyId: 'ridge-key-1-evil',
        observedAt: isoAt(0),
      }),
    ]);
    expect(ghost.statusCode).toBe(401);
    expect(ghost.json().error.code).toBe('MACHINE_TENANT_MISMATCH');

    // (e) A keyId nobody issued is simply unregistered (never a global hit).
    const unknown = await send(tenants.a, 'ridge-key-9-never', keyOf('cEvil'));
    expect(unknown.statusCode).toBe(422);
    expect(refusalCode(unknown)).toBe('UNAUTHENTICATED_SOURCE');

    expect({ a: admitted(tenants.a), b: admitted(tenants.b), c: admitted(tenants.c) }).toEqual(
      before,
    );
  });

  it('a hostile or legacy journal fails CLOSED: duplicate keyIds and plaintext-era rows never authenticate, and other credentials keep working', async () => {
    const kek = parseKek(KEK, 'test');
    const t = tenants.c;
    const sealedRecord = (sourceId: string, keyId: string, plaintext: string) => ({
      sourceId,
      sourceType: sourceId === 'ridge-telemetry' ? 'asset_telemetry' : 'vessel_gateway',
      keyId,
      keyDigest: keyDigestOf(plaintext),
      sealed: kek.seal(plaintext),
      assetIds: sourceId === 'ridge-telemetry' ? ['drone-cartographer'] : ['sat-link-9'],
      trustedForRecovery: sourceId === 'site-ops-gateway',
      provenance: 'FIELD',
      issuedBy: 'hostile-import',
      issuedAt: clock.iso(),
    });
    // The same keyId under TWO sources of one mission — issuance can never
    // produce this; a hostile/legacy journal can. Neither copy may win.
    vault.set('dupT', 'dup-material-telemetry-0123456789abcdef');
    vault.set('dupG', 'dup-material-gateway-0123456789abcdef');
    for (const sourceId of ['ridge-telemetry', 'site-ops-gateway']) {
      ledger.evidence.append({
        orgId: t.orgId,
        missionId: t.missionId,
        topic: 'operational',
        type: 'mission.source.registered',
        eventKey: credentialEventKey(t.missionId, sourceId, 'dup-key-1'),
        payload: sealedRecord(
          sourceId,
          'dup-key-1',
          keyOf(sourceId === 'ridge-telemetry' ? 'dupT' : 'dupG'),
        ),
      });
    }
    // A pre-custody row that carried the signing key in PLAINTEXT, no seal.
    vault.set('legacy', 'legacy-plaintext-0123456789abcdef');
    ledger.evidence.append({
      orgId: t.orgId,
      missionId: t.missionId,
      topic: 'operational',
      type: 'mission.source.registered',
      eventKey: credentialEventKey(t.missionId, 'ridge-telemetry', 'legacy-key-1'),
      payload: {
        sourceId: 'ridge-telemetry',
        sourceType: 'asset_telemetry',
        keyId: 'legacy-key-1',
        secretKey: keyOf('legacy'),
        assetIds: ['drone-cartographer'],
        trustedForRecovery: false,
        provenance: 'FIELD',
        issuedBy: 'legacy',
        issuedAt: clock.iso(),
      },
    });

    const attempts: [string, string, string][] = [
      ['dup-key-1', keyOf('dupT'), 'ridge-telemetry'],
      ['dup-key-1', keyOf('dupG'), 'site-ops-gateway'],
      ['legacy-key-1', keyOf('legacy'), 'ridge-telemetry'],
    ];
    for (const [keyId, signingKey, sourceId] of attempts) {
      const res = await send(t, keyId, signingKey, {
        sourceId,
        ...(sourceId === 'site-ops-gateway' ? { assetId: 'sat-link-9' } : {}),
      });
      expect(res.statusCode, `${keyId}/${sourceId}`).toBe(422);
      expect(refusalCode(res)).toBe('UNAUTHENTICATED_SOURCE');
    }
    // Their proofs are well-formed and correct, yet the credentials cannot
    // authenticate → the uniform 401.
    const dupStatus = await postStatus(t.missionId, 'ridge-telemetry', 'dup-key-1', keyOf('dupT'));
    expect(dupStatus.statusCode).toBe(401);
    const legacyStatus = await postStatus(
      t.missionId,
      'ridge-telemetry',
      'legacy-key-1',
      keyOf('legacy'),
    );
    expect(legacyStatus.statusCode).toBe(401);
    // Blast radius is one keyId, not the mission.
    const stillWorks = await send(t, 'ridge-key-1-evil', keyOf('cEvil'));
    expect(stillWorks.json().outcomes[0].status).toBe('accepted');
  });
});

describe('lifecycle is disclosed only to a PROVEN possessor', () => {
  it('revocation is scoped to the issuing tenant; the revoked key answers 403 only to its holder', async () => {
    const revoke = await tenants.a.admin.post(
      `/api/missions/${tenants.a.missionId}/sources/ridge-telemetry/keys/ridge-key-1/revoke`,
      { reason: 'rotation drill' },
    );
    expect(revoke.statusCode, JSON.stringify(revoke.json())).toBe(200);

    // Holder: the signature verifies under the (revoked) key → told exactly why.
    const holder = await send(tenants.a, 'ridge-key-1', keyOf('a1'));
    expect(holder.statusCode).toBe(403);
    expect(holder.json().error.code).toBe('CREDENTIAL_REVOKED');

    // A non-holder probing the SAME keyId, and a prober naming a key nobody
    // ever issued, get the IDENTICAL answer — there is no lifecycle oracle.
    const wrongKey = 'not-the-key-0123456789abcdef';
    const probeRevoked = await send(tenants.a, 'ridge-key-1', wrongKey);
    const probeUnknown = await send(tenants.a, 'ridge-key-77', wrongKey);
    expect(probeRevoked.statusCode).toBe(probeUnknown.statusCode);
    expect(probeRevoked.statusCode).not.toBe(403);
    expect(refusalCode(probeRevoked)).toBe('UNAUTHENTICATED_SOURCE');
    expect(refusalCode(probeUnknown)).toBe('UNAUTHENTICATED_SOURCE');

    // B's identically named key is a different credential and is untouched.
    const b3 = await send(tenants.b, 'ridge-key-1', keyOf('b1'));
    expect(b3.json().outcomes[0].status).toBe('accepted');
  });

  it('an EXPIRED key is likewise disclosed only to its holder', async () => {
    vault.set(
      'bExpired',
      await issue(tenants.b, 'ridge-key-exp', {
        expiresAt: new Date(clock.now().getTime() - 60_000).toISOString(),
      }),
    );
    const holder = await send(tenants.b, 'ridge-key-exp', keyOf('bExpired'));
    expect(holder.statusCode).toBe(403);
    expect(holder.json().error.code).toBe('CREDENTIAL_EXPIRED');
    const prober = await send(tenants.b, 'ridge-key-exp', 'not-the-key-0123456789abcdef');
    expect(refusalCode(prober)).toBe('UNAUTHENTICATED_SOURCE');
  });
});

describe('P1 unauthenticated key enumeration — status requires proof of possession', () => {
  it('the old unauthenticated GET status route no longer exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/machine/sources/ridge-key-1/status' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(tenants.a.missionId);
    expect(res.body).not.toContain('boundMissionId');
  });

  it('a remote UNAUTHENTICATED client cannot tell existing, revoked, expired, unknown or cross-tenant keys apart', async () => {
    const forged = 'f'.repeat(64);
    const stale = new Date(clock.now().getTime() - 10 * 60_000).toISOString();
    const future = new Date(clock.now().getTime() + 10 * 60_000).toISOString();
    const results = await Promise.all([
      // existing ACTIVE key, wrong proof
      postRawStatus(tenants.b.missionId, 'ridge-telemetry', 'ridge-key-1', forged),
      // REVOKED key, wrong proof
      postRawStatus(tenants.a.missionId, 'ridge-telemetry', 'ridge-key-1', forged),
      // EXPIRED key, wrong proof
      postRawStatus(tenants.b.missionId, 'ridge-telemetry', 'ridge-key-exp', forged),
      // never-issued key
      postRawStatus(tenants.b.missionId, 'ridge-telemetry', 'never-issued-9', forged),
      // unknown source
      postRawStatus(tenants.b.missionId, 'no-such-source', 'ridge-key-1', forged),
      // unknown mission
      postRawStatus('msn_does_not_exist', 'ridge-telemetry', 'ridge-key-1', forged),
      // A's GENUINE proof replayed against B's mission (same sourceId + keyId text)
      postStatus(tenants.b.missionId, 'ridge-telemetry', 'ridge-key-1', keyOf('a1')),
      // a genuine proof, but STALE or from the FUTURE (replay window)
      postStatus(tenants.b.missionId, 'ridge-telemetry', 'ridge-key-1', keyOf('b1'), stale),
      postStatus(tenants.b.missionId, 'ridge-telemetry', 'ridge-key-1', keyOf('b1'), future),
    ]);
    for (const [index, res] of results.entries()) {
      expect(res.statusCode, `attempt ${String(index)}`).toBe(401);
    }
    // Byte-identical bodies: nothing distinguishes the cases.
    const bodies = new Set(results.map((res) => res.body));
    expect(bodies.size).toBe(1);
    const only = [...bodies][0]!;
    expect(JSON.parse(only)).toEqual({
      error: { code: 'MACHINE_AUTH_FAILED', message: 'credential proof rejected' },
    });
    for (const leak of [tenants.a.missionId, tenants.b.missionId, 'revoked', 'expired', 'active']) {
      expect(only).not.toContain(leak);
    }
  });

  it('malformed proofs are refused as input errors before any lookup; browsers are refused outright', async () => {
    const url = statusUrl(tenants.b.missionId, 'ridge-telemetry', 'ridge-key-1');
    for (const payload of [
      {},
      { issuedAt: clock.iso() },
      { issuedAt: clock.iso(), signature: 'nothex' },
      { issuedAt: 'yesterday-ish', signature: 'a'.repeat(64) },
      { issuedAt: clock.iso(), signature: 'A'.repeat(64) },
    ]) {
      const res = (await app.inject({ method: 'POST', url, payload })) as InjectLike;
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('INVALID_INPUT');
    }
    const browser = (await app.inject({
      method: 'POST',
      url,
      headers: { cookie: tenants.b.owner.cookie },
      payload: {
        issuedAt: clock.iso(),
        signature: statusProof(keyOf('b1'), {
          missionId: tenants.b.missionId,
          sourceId: 'ridge-telemetry',
          keyId: 'ridge-key-1',
          issuedAt: clock.iso(),
        }),
      },
    })) as InjectLike;
    expect(browser.statusCode).toBe(401);
    expect(browser.json().error.code).toBe('MACHINE_SURFACE_BROWSER_FORBIDDEN');
  });

  it('a GENUINE signed status request works: active, revoked and expired report truthfully to their holder, no key ever returned', async () => {
    const active = await postStatus(
      tenants.b.missionId,
      'ridge-telemetry',
      'ridge-key-1',
      keyOf('b1'),
    );
    expect(active.statusCode, active.body).toBe(200);
    expect(active.json()).toMatchObject({
      missionId: tenants.b.missionId,
      sourceId: 'ridge-telemetry',
      keyId: 'ridge-key-1',
      status: 'active',
    });
    expect(String(active.headers['cache-control'])).toBe('no-store');
    expect(active.body).not.toContain(keyOf('b1'));
    expect(active.body).not.toContain('boundMissionId');

    const revoked = await postStatus(
      tenants.a.missionId,
      'ridge-telemetry',
      'ridge-key-1',
      keyOf('a1'),
    );
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().status).toBe('revoked');

    const expired = await postStatus(
      tenants.b.missionId,
      'ridge-telemetry',
      'ridge-key-exp',
      keyOf('bExpired'),
    );
    expect(expired.statusCode).toBe(200);
    expect(expired.json().status).toBe('expired');
    expect(typeof expired.json().expiresAt).toBe('string');
  });
});

describe('the whole matrix holds across a RESTART', () => {
  it('same-named keys still resolve per tenant, revoked stays dead, hostile rows stay quarantined, status still needs proof', async () => {
    const before = { a: admitted(tenants.a), b: admitted(tenants.b), c: admitted(tenants.c) };
    await restart();

    // B's identically named key (issued AFTER A's, same text) still works…
    const b = await send(tenants.b, 'ridge-key-1', keyOf('b1'));
    expect(b.json().outcomes[0].status, JSON.stringify(b.json())).toBe('accepted');
    // …A's revoked key is still dead (and told so only to its holder)…
    const a = await send(tenants.a, 'ridge-key-1', keyOf('a1'));
    expect(a.statusCode).toBe(403);
    expect(a.json().error.code).toBe('CREDENTIAL_REVOKED');
    // …C's other credential still works while the ambiguous rows do not.
    const c = await send(tenants.c, 'ridge-key-1-evil', keyOf('cEvil'));
    expect(c.json().outcomes[0].status).toBe('accepted');
    const dup = await send(tenants.c, 'dup-key-1', keyOf('dupT'));
    expect(refusalCode(dup)).toBe('UNAUTHENTICATED_SOURCE');

    // Spoofs still fail, and status is still proof-gated, after the restart.
    const spoof = await send(tenants.b, 'ridge-key-1', keyOf('a1'));
    expect(refusalCode(spoof)).toBe('SIGNATURE_INVALID');
    const noProof = await postRawStatus(
      tenants.b.missionId,
      'ridge-telemetry',
      'ridge-key-1',
      'e'.repeat(64),
    );
    expect(noProof.statusCode).toBe(401);
    const proof = await postStatus(
      tenants.b.missionId,
      'ridge-telemetry',
      'ridge-key-1',
      keyOf('b1'),
    );
    expect(proof.json().status).toBe('active');

    expect(admitted(tenants.a)).toBe(before.a);
    expect(admitted(tenants.b)).toBe(before.b + 1);
    expect(admitted(tenants.c)).toBe(before.c + 1);
  });
});
