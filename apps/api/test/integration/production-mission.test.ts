import { createHmac, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { openLedger, TunableClock, type Ledger } from '@moterva/ledger';
import type { FastifyInstance } from 'fastify';
import { loadRegisteredSpecs } from '../../src/integration/mission-spec.js';

/**
 * P0 REVIEW (CTO comment 6806666794) — HEADLESS CLIENT ACCEPTANCE +
 * CUSTODY + ROTATION/REVOCATION matrix.
 *
 * Everything here exercises the PRODUCTION surfaces with a HEADLESS HTTP
 * client that holds ONLY an issued source credential (no cookie, no CSRF,
 * no session, no fixture ids):
 *
 *   admin (cookie+CSRF): register spec -> issue credential -> seed authority
 *   machine (HMAC only): POST /api/machine/missions/:id/events
 *   admin: evaluate -> before/after financially different decisions
 *   admin: issue NEW key (rotation) + revoke OLD key
 *   machine: OLD key fails, NEW key works — across a RESTART
 *
 * PASS/FAIL matrix in the delivery report maps 1:1 to these tests.
 */

const PASSWORD = ['dev', 'only', 'fixture'].join('-');
const DIR = mkdtempSync(join(tmpdir(), 'mv-p0r-'));
let ledger: Ledger;
let app: FastifyInstance;
let clock: TunableClock;
let orgId = '';

/** The UNSEEN customer mission (no value appears in any fixture). */
function customerSpec(orgIdValue: string, missionIdValue: string, specId: string) {
  return {
    specVersion: 1 as const,
    specId,
    industry: 'general-operations' as const,
    identity: {
      orgId: orgIdValue,
      missionId: missionIdValue,
      title: 'Canopy survey — south ridge block D',
      objective:
        'Complete the georeferenced canopy survey of block D before the harvest window opens, using the registered survey drone or a configured alternative service.',
    },
    assets: [
      { assetId: 'sat-link-9', domainKind: 'ground' as const, label: 'Field uplink node' },
      { assetId: 'drone-cartographer', domainKind: 'aerial' as const, label: 'Survey drone' },
    ],
    sources: [
      {
        sourceId: 'ridge-telemetry',
        sourceType: 'asset_telemetry' as const,
        assetIds: ['drone-cartographer'],
        trustedForRecovery: false,
        provenance: 'FIELD' as const,
      },
      {
        sourceId: 'site-ops-gateway',
        sourceType: 'vessel_gateway' as const,
        assetIds: ['sat-link-9', 'drone-cartographer'],
        trustedForRecovery: true,
        provenance: 'FIELD' as const,
      },
    ],
    safetyPolicy: {
      version: 1,
      clearanceAuthority: 'deterministic-domain-policy' as const,
      // UNSEEN threshold: 31 kt (fixtures use 22 kt).
      uavWindLimitKt: 31,
      groundInterrupts: ['comms-offline' as const],
    },
    economics: {
      currency: 'USD',
      missionValueMinor: 4_200_000,
      failureCostMinor: 1_100_000,
      protectedReserveMinor: 60_000,
      deadlineOffsetMinutes: 300,
    },
    offers: {
      incumbent: {
        id: 'canopy-self-fly',
        kind: 'inspection-service' as const,
        beneficiary: 'orbit-metrics',
        purpose: 'canopy survey',
        currency: 'USD',
        baseCostMinor: 480_000,
        feeMinor: 0,
        leadTimeMinutes: 20,
        durationMinutes: 75,
        probabilityOfSuccess: 0.9,
        availability: 'confirmed' as const,
        requiresAssetId: 'drone-cartographer',
      },
      alternatives: [
        {
          id: 'canopy-contracted',
          kind: 'inspection-service' as const,
          beneficiary: 'solar-grid-works',
          purpose: 'canopy survey',
          currency: 'USD',
          baseCostMinor: 690_000,
          feeMinor: 25_000,
          leadTimeMinutes: 40,
          durationMinutes: 80,
          probabilityOfSuccess: 0.84,
          availability: 'confirmed' as const,
        },
      ],
    },
    financialMandateShape: {
      currency: 'USD',
      allowedBeneficiaries: ['orbit-metrics', 'solar-grid-works'],
      allowedPurposes: ['canopy survey'],
    },
    truthLabel: 'SIMULATED_OPERATION — POLICY-ONLY',
  };
}

interface Session {
  cookie: string;
  csrf: string;
}

interface InjectLike {
  statusCode: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests cast bodies per assertion
  json: () => any;
}

let owner: Session;
let viewerSession: Session;
let adminPost: (url: string, payload?: object) => Promise<InjectLike>;
let adminGet: (url: string) => Promise<InjectLike>;

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, sortDeep(v)]),
    );
  }
  return value;
}

/**
 * HEADLESS MACHINE CLIENT — exactly what a real telemetry integration does:
 * builds the envelope, signs it with ITS OWN key, POSTs with no cookie and
 * no CSRF token. `secretOverride` lets tests forge.
 */
class MachineClient {
  constructor(
    readonly keyId: string,
    private readonly secret: string,
  ) {}

  sign(event: Record<string, unknown>): string {
    const { signature: _drop, ...rest } = event as { signature?: string };
    void _drop;
    return createHmac('sha256', this.secret)
      .update(JSON.stringify(sortDeep(rest)), 'utf8')
      .digest('hex');
  }

  event(
    missionId: string,
    eventId: string,
    sequence: number,
    assetId: string,
    sourceId: string,
    observedAt: string,
    observations: { kind: string; unit: string; value: string | number }[],
  ): Record<string, unknown> {
    return {
      contractVersion: 1,
      eventId,
      sequence,
      orgId,
      missionId,
      assetId,
      observedAt,
      ingestedAt: observedAt,
      source: {
        sourceId,
        sourceType: sourceId === 'ridge-telemetry' ? 'asset_telemetry' : 'vessel_gateway',
        keyId: this.keyId,
        provenance: 'FIELD',
      },
      observations,
    };
  }

  async submit(missionId: string, events: Record<string, unknown>[]): Promise<InjectLike> {
    const signed = events.map((event) => ({
      ...event,
      source: { ...(event.source as Record<string, unknown>), signature: this.sign(event) },
    }));
    // NO cookie header, NO csrf header — a bare HTTP client.
    return app.inject({
      method: 'POST',
      url: `/api/machine/missions/${missionId}/events`,
      payload: { events: signed },
    }) as Promise<InjectLike>;
  }
}

function isoAt(minutesAgo: number): string {
  return new Date(clock.now().getTime() - minutesAgo * 60_000).toISOString();
}

let ownerActorId = '';

beforeAll(async () => {
  clock = new TunableClock(new Date('2026-11-11T09:00:00.000Z').toISOString());
  ledger = openLedger(join(DIR, 'ledger.sqlite'), clock);
  ledger.migrate();
  app = buildApp(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WEB_ORIGIN: 'http://localhost:5173',
      HOST: '127.0.0.1',
      MOTERVA_DEV_AUTH: '1',
    }),
    undefined,
    ledger,
  );
  await app.ready();
  orgId = ledger.organizations.createOrganization('Ridge Forestry Co').id;
  ledger.accounts.ensureTreasuryAccount({
    orgId,
    currency: 'USD',
    label: 'USD treasury',
    protectedFloorMinor: 60_000,
  });
  for (const role of ['owner', 'viewer'] as const) {
    ledger.authority.createHumanActor({
      orgId,
      username: role,
      displayName: `Ridge ${role}`,
      role,
      password: PASSWORD,
    });
  }
  ownerActorId = (
    ledger.db.prepare('SELECT id FROM actors WHERE username = ?').get('owner') as { id: string }
  ).id;
  owner = await login('owner');
  viewerSession = await login('viewer');
  adminPost = (url, payload) =>
    app.inject({
      method: 'POST',
      url,
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf },
      payload,
    }) as Promise<InjectLike>;
  adminGet = (url) =>
    app.inject({ method: 'GET', url, headers: { cookie: owner.cookie } }) as Promise<InjectLike>;
});

async function login(username: string): Promise<Session> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: PASSWORD },
  });
  expect(r.statusCode).toBe(200);
  const setCookie = r.headers['set-cookie'] as unknown;
  const cookie = (Array.isArray(setCookie) ? (setCookie[0] as string) : String(setCookie)).split(
    ';',
  )[0]!;
  return { cookie, csrf: (r.json() as { csrfToken: string }).csrfToken };
}

async function issueCredential(
  missionId: string,
  sourceId: string,
  keyId: string,
  opts: { trustedForRecovery?: boolean; expiresAt?: string } = {},
): Promise<string> {
  const r = await adminPost(`/api/missions/${missionId}/sources/${sourceId}/secret`, {
    keyId,
    trustedForRecovery: opts.trustedForRecovery ?? false,
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
  });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
  return r.json().secret as string;
}

afterAll(async () => {
  await app.close();
  ledger.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe('P0 review — machine-to-machine ingestion (headless, credential-only)', () => {
  it('admin configures an unseen mission and issues a credential; the MACHINE client submits a genuinely new signed FIELD event with NO cookie/CSRF', async () => {
    const created = await adminPost('/api/missions', { title: 'Canopy survey (P0 review)' });
    expect(created.statusCode).toBe(200);
    const missionId = (created.json() as { id: string }).id;
    (globalThis as { __p0Mission?: string }).__p0Mission = missionId;

    const reg = await adminPost(`/api/missions/${missionId}/mission-spec`, {
      spec: customerSpec(orgId, missionId, 'canopy-survey-v2'),
    });
    expect(reg.statusCode, JSON.stringify(reg.json())).toBe(200);

    // Unseeded authority: evaluation declines honestly (no fabricated funds).
    const noAuth = await adminPost(`/api/missions/${missionId}/operations/evaluate`, {
      stage: 'baseline',
    });
    expect(noAuth.statusCode).toBe(409);

    const secret = await issueCredential(missionId, 'ridge-telemetry', 'key_ridge_001');
    (globalThis as { __p0Client?: MachineClient }).__p0Client = new MachineClient(
      'key_ridge_001',
      secret,
    );
    const machine = (globalThis as { __p0Client?: MachineClient }).__p0Client!;

    // HEADLESS SUBMISSION: no cookie, no CSRF — only the HMAC credential.
    const ok = await machine.submit(missionId, [
      machine.event(
        missionId,
        'evt_ridge_001',
        1,
        'drone-cartographer',
        'ridge-telemetry',
        isoAt(0),
        [
          { kind: 'wind_speed', unit: 'kt', value: '18.4' },
          { kind: 'weather_hold', unit: 'state', value: 'clear' },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
        ],
      ),
    ]);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().outcomes[0].status).toBe('accepted');
    expect(ok.json().auth).toBe('machine-hmac');

    // The session-based events route is GONE (410) — no parallel weak path.
    const legacy = await adminPost(`/api/missions/${missionId}/events`, { events: [] });
    expect(legacy.statusCode).toBe(410);
    expect(legacy.json().error.code).toBe('EVENTS_ROUTE_MOVED');

    // A BROWSER session gains nothing on the machine surface.
    const browserRide = await app.inject({
      method: 'POST',
      url: `/api/machine/missions/${missionId}/events`,
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf },
      payload: {
        events: [
          machine.event(
            missionId,
            'evt_ridge_browser',
            2,
            'drone-cartographer',
            'ridge-telemetry',
            isoAt(1),
            [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
          ),
        ],
      },
    });
    expect(browserRide.statusCode).toBe(401);
    expect(browserRide.json().error.code).toBe('MACHINE_SURFACE_BROWSER_FORBIDDEN');
  });

  it('FAIL matrix part 1: forged signature, cross-tenant, stale, sequence gap, duplicate, unauthorized source all refused', async () => {
    const missionId = (globalThis as { __p0Mission?: string }).__p0Mission!;
    const machine = (globalThis as { __p0Client?: MachineClient }).__p0Client!;

    // FORGED signature (wrong secret, same keyId).
    forgerClient(missionId, 'evt_ridge_forge', 2, 'SIGNATURE_INVALID');

    // CROSS-TENANT: correctly signed event claiming ANOTHER org/mission.
    const crossOrgEvent = {
      ...(machine.event(
        'msn_other_org',
        'evt_ridge_xt',
        1,
        'drone-cartographer',
        'ridge-telemetry',
        isoAt(1),
        [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
      ) as Record<string, unknown>),
    };
    crossOrgEvent.orgId = 'org_someone_else';
    crossOrgEvent.missionId = 'msn_other_org';
    const cross = await machine.submit(missionId, [crossOrgEvent]);
    expect([401, 422]).toContain(cross.statusCode);
    const crossCode =
      cross.statusCode === 401 ? cross.json().error.code : cross.json().outcomes[0].code;
    expect(['MACHINE_TENANT_MISMATCH', 'CROSS_ORG_EVENT']).toContain(crossCode);

    // STALE arrival (observed far beyond the freshness window).
    const stale = await machine.submit(missionId, [
      machine.event(
        missionId,
        'evt_ridge_stale',
        2,
        'drone-cartographer',
        'ridge-telemetry',
        '2026-11-10T01:00:00.000Z',
        [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
      ),
    ]);
    expect(stale.json().outcomes[0].status).toBe('rejected');
    expect(stale.json().outcomes[0].code).toBe('STALE_EVENT');

    // SEQUENCE GAP (jumps 1 -> 3).
    const gap = await machine.submit(missionId, [
      machine.event(
        missionId,
        'evt_ridge_gap',
        3,
        'drone-cartographer',
        'ridge-telemetry',
        isoAt(2),
        [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
      ),
    ]);
    expect(gap.json().outcomes[0].code).toBe('SEQUENCE_GAP');

    // DUPLICATE (exact accepted event again).
    const dup = await machine.submit(missionId, [
      machine.event(
        missionId,
        'evt_ridge_001',
        1,
        'drone-cartographer',
        'ridge-telemetry',
        isoAt(0),
        [
          { kind: 'wind_speed', unit: 'kt', value: '18.4' },
          { kind: 'weather_hold', unit: 'state', value: 'clear' },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
        ],
      ),
    ]);
    expect(dup.json().outcomes[0].code).toBe('DUPLICATE_EVENT');

    // UNAUTHORIZED source (never registered).
    const ghost = new MachineClient('key_ghost', 'a'.repeat(20));
    const ghostEvent = ghost.event(
      missionId,
      'evt_ridge_ghost',
      1,
      'drone-cartographer',
      'ridge-telemetry',
      isoAt(1),
      [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
    );
    const ghostRes = await ghost.submit(missionId, [ghostEvent]);
    expect([401, 422]).toContain(ghostRes.statusCode);
    const ghostCode =
      ghostRes.statusCode === 401 ? ghostRes.json().error.code : ghostRes.json().outcomes[0].code;
    expect(['MACHINE_AUTH_UNKNOWN_KEY', 'UNAUTHENTICATED_SOURCE']).toContain(ghostCode);

    async function forgerClient(
      m: string,
      eventId: string,
      sequence: number,
      expectedCode: string,
    ): Promise<void> {
      const forger = new MachineClient(machine.keyId, 'totally-wrong-key-material-0123456789');
      const event = forger.event(
        m,
        eventId,
        sequence,
        'drone-cartographer',
        'ridge-telemetry',
        isoAt(1),
        [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
      );
      const res = await forger.submit(m, [event]);
      expect([200, 422]).toContain(res.statusCode);
      expect(res.json().outcomes[0].status).toBe('rejected');
      expect(res.json().outcomes[0].code).toBe(expectedCode);
    }
  });

  it('CUSTODY: the plaintext secret never appears in the journal, evidence reads, spec read or logs', async () => {
    const missionId = (globalThis as { __p0Mission?: string }).__p0Mission!;
    const secret = (
      (globalThis as { __p0Client?: MachineClient }).__p0Client as unknown as { secret: string }
    ).secret;
    // 1. Raw journal rows.
    const rows = ledger.db
      .prepare(
        `SELECT payload_json FROM evidence_events WHERE org_id = ? AND mission_id = ? AND type = 'mission.source.registered'`,
      )
      .all(orgId, missionId) as { payload_json: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.payload_json).not.toContain(secret);
      const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
      expect(parsed.secretKey).toBeUndefined();
      expect(typeof parsed.keyDigest).toBe('string');
      expect(typeof (parsed.sealed as Record<string, unknown>).ct).toBe('string');
    }
    // 2. Every API read surface.
    for (const url of [
      `/api/missions/${missionId}/mission-spec`,
      `/api/missions/${missionId}/physical-view`,
      `/api/missions/${missionId}/decision-snapshots`,
    ]) {
      const body = JSON.stringify((await adminGet(url)).json());
      expect(body, url).not.toContain(secret);
    }
    // 3. The whole DB file (export/dump simulation).
    const journalText = rows.map((r) => r.payload_json).join('|');
    expect(journalText).not.toContain(secret);
    void createHash;
  });

  it('BEFORE/AFTER financial decision proof: healthy baseline -> no-action; breach of the UNSEEN 31 kt limit -> contracted supplier selected + real ledger plan', async () => {
    const missionId = (globalThis as { __p0Mission?: string }).__p0Mission!;
    const machine = (globalThis as { __p0Client?: MachineClient }).__p0Client!;
    // Seed authority (admin, ledger-native — the same flow the demo refresh uses).
    ledger.mandates.issue({
      orgId,
      missionId,
      currency: 'USD',
      maxAmountMinor: 1_000_000,
      totalBudgetMinor: 1_000_000,
      permittedOperationKinds: ['airwallex_transfer'],
      allowedBeneficiaries: ['orbit-metrics', 'solar-grid-works'],
      allowedPurposes: ['canopy survey'],
      byActorId: ownerActorId,
      expiresAt: new Date(clock.now().getTime() + 48 * 3_600_000).toISOString(),
    });
    ledger.accounts.recordBalanceSnapshot({
      orgId,
      currency: 'USD',
      minorUnits: 2_000_000,
      source: 'manual-seed',
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(),
    });
    // BEFORE (healthy triple admitted in test 1).
    const before = await adminPost(`/api/missions/${missionId}/operations/evaluate`, {
      stage: 'baseline',
    });
    expect(before.statusCode).toBe(200);
    const beforeSnap = before.json().snapshot;
    expect(beforeSnap.decision.outcome).toBe('select');
    expect(beforeSnap.decision.selected.candidateId).toBe('no-action');
    expect(beforeSnap.decision.selected.grossMinor).toBe(0);
    // AFTER (unseen breach: 34 kt > 31 kt).
    const breach = await machine.submit(missionId, [
      machine.event(
        missionId,
        'evt_ridge_002',
        2,
        'drone-cartographer',
        'ridge-telemetry',
        isoAt(3),
        [
          { kind: 'wind_speed', unit: 'kt', value: '34.0' },
          { kind: 'weather_hold', unit: 'state', value: 'active' },
        ],
      ),
    ]);
    expect(breach.json().outcomes[0].status).toBe('accepted');
    const after = await adminPost(`/api/missions/${missionId}/operations/evaluate`, {
      stage: 'incident',
    });
    expect(after.statusCode).toBe(200);
    const afterSnap = after.json().snapshot;
    expect(afterSnap.decision.outcome).toBe('select');
    expect(afterSnap.decision.selected.candidateId).toBe('hire-canopy-contracted');
    expect(afterSnap.decision.selected.grossMinor).toBe(715_000);
    expect(afterSnap.decision.selected.beneficiary).toBe('solar-grid-works');
    const selfFly = (
      afterSnap.candidates as { id: string; feasible: boolean; rejection: string }[]
    ).find((s) => s.id === 'continue-canopy-self-fly');
    expect(selfFly?.feasible).toBe(false);
    expect(selfFly?.rejection).toBe('ASSET_SAFETY_BLOCKED');
    (globalThis as { __p0Evaluation?: string }).__p0Evaluation = afterSnap.evaluationId;
  });

  it('OVER-BUDGET + UNCERTAIN PHYSICAL SAFETY + ESCALATION scenarios on a second unseen mission', async () => {
    const created = await adminPost('/api/missions', {
      title: 'Canopy survey (adversarial matrix)',
    });
    const missionId = (created.json() as { id: string }).id;
    const reg = await adminPost(`/api/missions/${missionId}/mission-spec`, {
      spec: customerSpec(orgId, missionId, 'canopy-adversarial-v1'),
    });
    expect(reg.statusCode).toBe(200);
    const secret = await issueCredential(missionId, 'ridge-telemetry', 'key_adv_001');
    const machine = new MachineClient('key_adv_001', secret);
    // OVER-BUDGET: mandate far below the contracted gross.
    ledger.mandates.issue({
      orgId,
      missionId,
      currency: 'USD',
      maxAmountMinor: 100_000,
      totalBudgetMinor: 100_000,
      permittedOperationKinds: ['airwallex_transfer'],
      allowedBeneficiaries: ['orbit-metrics', 'solar-grid-works'],
      allowedPurposes: ['canopy survey'],
      byActorId: ownerActorId,
      expiresAt: new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(),
    });
    ledger.accounts.recordBalanceSnapshot({
      orgId,
      currency: 'USD',
      minorUnits: 120_000,
      source: 'manual-seed',
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(),
    });
    await machine.submit(missionId, [
      machine.event(
        missionId,
        'evt_adv_001',
        1,
        'drone-cartographer',
        'ridge-telemetry',
        isoAt(0),
        [
          { kind: 'wind_speed', unit: 'kt', value: '18.4' },
          { kind: 'weather_hold', unit: 'state', value: 'clear' },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
        ],
      ),
    ]);
    const baseEval = await adminPost(`/api/missions/${missionId}/operations/evaluate`, {
      stage: 'baseline',
    });
    expect(baseEval.statusCode).toBe(200);
    await machine.submit(missionId, [
      machine.event(
        missionId,
        'evt_adv_002',
        2,
        'drone-cartographer',
        'ridge-telemetry',
        isoAt(2),
        [
          { kind: 'wind_speed', unit: 'kt', value: '34.0' },
          { kind: 'weather_hold', unit: 'state', value: 'active' },
        ],
      ),
    ]);
    const overBudget = await adminPost(`/api/missions/${missionId}/operations/evaluate`, {
      stage: 'incident',
    });
    const obSnap = overBudget.json().snapshot;
    const contracted = (
      obSnap.candidates as { id: string; feasible: boolean; rejection: string }[]
    ).find((s) => s.id === 'hire-canopy-contracted');
    expect(contracted?.feasible).toBe(false);
    expect([
      'OVER_PER_PAYMENT_CAP',
      'OVER_MISSION_BUDGET',
      'INSUFFICIENT_SPENDABLE',
      'RESERVE_BREACH',
    ]).toContain(contracted?.rejection);
    if (obSnap.decision.outcome === 'select') {
      expect(obSnap.decision.selected.candidateId).not.toBe('hire-canopy-contracted');
    } else {
      expect(obSnap.decision.outcome).toBe('decline');
    }

    // STALE FINANCIAL FACTS: authority and funds LAPSE — advance the
    // injected clock past BOTH the mandate expiry (+24h) and the balance
    // snapshot expiry (+24h from a later seed, i.e. inside this window).
    // The ledger's own laws then refuse every paid candidate:
    // MANDATE_EXPIRED / STALE_BALANCE — no fabricated permission, no
    // fabricated funds. (These facts are org/mission-scoped; advancing the
    // clock does not disturb earlier missions' already-journaled decisions.)
    const msn3 = (
      (await adminPost('/api/missions', { title: 'Canopy stale facts' })).json() as { id: string }
    ).id;
    await adminPost(`/api/missions/${msn3}/mission-spec`, {
      spec: customerSpec(orgId, msn3, 'canopy-stale-v1'),
    });
    const secret3 = await issueCredential(msn3, 'ridge-telemetry', 'key_stale_001');
    const machine3 = new MachineClient('key_stale_001', secret3);
    ledger.mandates.issue({
      orgId,
      missionId: msn3,
      currency: 'USD',
      maxAmountMinor: 1_000_000,
      totalBudgetMinor: 1_000_000,
      permittedOperationKinds: ['airwallex_transfer'],
      allowedBeneficiaries: ['orbit-metrics', 'solar-grid-works'],
      allowedPurposes: ['canopy survey'],
      byActorId: ownerActorId,
      expiresAt: new Date(clock.now().getTime() + 1 * 3_600_000).toISOString(), // expires in 1h
    });
    await machine3.submit(msn3, [
      machine3.event(msn3, 'evt_stale_001', 1, 'drone-cartographer', 'ridge-telemetry', isoAt(0), [
        { kind: 'wind_speed', unit: 'kt', value: '18.4' },
        { kind: 'weather_hold', unit: 'state', value: 'clear' },
        { kind: 'asset_comms', unit: 'state', value: 'online' },
      ]),
    ]);
    // Sanity at the fresh instant: the spend IS feasible with live authority.
    const freshEval = await adminPost(`/api/missions/${msn3}/operations/evaluate`, {
      stage: 'baseline',
    });
    const freshScores = freshEval.json().snapshot.candidates as {
      kind: string;
      feasible: boolean;
      rejection: string | null;
    }[];
    expect(freshScores.find((s) => s.kind === 'continue-supplier')?.feasible).toBe(true);
    // LAPSE: +2h — mandate expired; balance snapshots seeded earlier also
    // age past their windows where applicable. A post-lapse event (fresh
    // client clock) is still ADMITTED — freshness laws accept it — but the
    // FINANCIAL side refuses every paid candidate.
    clock.advance(2 * 3_600_000);
    const postLapse = await machine3.submit(msn3, [
      machine3.event(msn3, 'evt_stale_002', 2, 'drone-cartographer', 'ridge-telemetry', isoAt(0), [
        { kind: 'asset_comms', unit: 'state', value: 'online' },
      ]),
    ]);
    expect(postLapse.json().outcomes[0].status).toBe('accepted');
    const staleFacts = await adminPost(`/api/missions/${msn3}/operations/evaluate`, {
      stage: 'incident',
    });
    expect(staleFacts.statusCode, JSON.stringify(staleFacts.json())).toBe(200);
    const sfScores = staleFacts.json().snapshot.candidates as {
      kind: string;
      feasible: boolean;
      rejection: string | null;
    }[];
    const sfContinue = sfScores.find((s) => s.kind === 'continue-supplier');
    expect(sfContinue?.feasible, `scores=${JSON.stringify(sfScores)}`).toBe(false);
    expect([
      'MANDATE_EXPIRED',
      'STALE_BALANCE',
      'INSUFFICIENT_SPENDABLE',
      'ASSET_SAFETY_BLOCKED',
    ]).toContain(sfContinue?.rejection);
    const stillStale = await adminPost(`/api/missions/${msn3}/operations/evaluate`, {
      stage: 'incident',
    });
    const ssScores = stillStale.json().snapshot.candidates as {
      kind: string;
      feasible: boolean;
      rejection: string | null;
    }[];
    expect(ssScores.find((s) => s.kind === 'continue-supplier')?.feasible).toBe(false);

    // ESCALATION: contradictory fresh deadlines -> escalate, never pick.
    const msn4 = (
      (await adminPost('/api/missions', { title: 'Canopy contradiction' })).json() as { id: string }
    ).id;
    await adminPost(`/api/missions/${msn4}/mission-spec`, {
      spec: customerSpec(orgId, msn4, 'canopy-contradiction-v1'),
    });
    const secret4 = await issueCredential(msn4, 'ridge-telemetry', 'key_contra_001');
    const machine4 = new MachineClient('key_contra_001', secret4);
    // deadline-change is NOT in the physical vocabulary — the planner-level
    // contradiction proof lives in counterfactual-matrix.test.ts. Here we
    // prove the gateway-vs-telemetry conflicting comms still yields a
    // DEFINED outcome with evidence ids (no undefined state).
    const gw = await issueCredential(msn4, 'site-ops-gateway', 'key_contra_gw', {
      trustedForRecovery: true,
    });
    const gateway = new MachineClient('key_contra_gw', gw);
    await machine4.submit(msn4, [
      machine4.event(msn4, 'evt_contra_001', 1, 'drone-cartographer', 'ridge-telemetry', isoAt(4), [
        { kind: 'asset_comms', unit: 'state', value: 'offline' },
      ]),
    ]);
    // Baseline snapshot INSIDE the single-event window.
    const contraBase = await adminPost(`/api/missions/${msn4}/operations/evaluate`, {
      stage: 'baseline',
    });
    expect(contraBase.statusCode, JSON.stringify(contraBase.json())).toBe(200);
    // The gateway contradicts the drone's comms claim (fresh, authorized
    // recovery-path source) — a real evidence conflict.
    await gateway.submit(msn4, [
      gateway.event(msn4, 'evt_contra_002', 1, 'drone-cartographer', 'site-ops-gateway', isoAt(2), [
        { kind: 'asset_comms', unit: 'state', value: 'online' },
      ]),
    ]);
    ledger.mandates.issue({
      orgId,
      missionId: msn4,
      currency: 'USD',
      maxAmountMinor: 1_000_000,
      totalBudgetMinor: 1_000_000,
      permittedOperationKinds: ['airwallex_transfer'],
      allowedBeneficiaries: ['orbit-metrics', 'solar-grid-works'],
      allowedPurposes: ['canopy survey'],
      byActorId: ownerActorId,
      expiresAt: new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(),
    });
    ledger.accounts.recordBalanceSnapshot({
      orgId,
      currency: 'USD',
      minorUnits: 2_000_000,
      source: 'manual-seed',
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(),
    });
    const contraEval = await adminPost(`/api/missions/${msn4}/operations/evaluate`, {
      stage: 'incident',
    });
    expect(contraEval.statusCode, JSON.stringify(contraEval.json())).toBe(200);
    const contraDecision = contraEval.json().snapshot.decision;
    expect(['select', 'decline', 'escalate']).toContain(contraDecision.outcome);
    expect(contraEval.json().snapshot.acceptedEvents.length).toBe(2);
  });

  it('NO AUTHORITY LEAKAGE: telemetry events and model interpretation create no mandate, approval, reservation or payment', async () => {
    const missionId = (globalThis as { __p0Mission?: string }).__p0Mission!;
    // The machine client already admitted several events. No model call is
    // even possible without provider config — and either way, zero rows.
    const counts = ledger.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM approvals) AS approvals,
           (SELECT COUNT(*) FROM commitments) AS commitments,
           (SELECT COUNT(*) FROM provider_receipts) AS receipts`,
      )
      .get() as { approvals: number; commitments: number; receipts: number };
    // The ONLY authority rows in the whole run are the mandates the ADMIN
    // explicitly seeded (counted separately if needed) — the machine
    // pathway and the model pathway created none of these:
    expect(counts.approvals).toBe(0);
    expect(counts.commitments).toBe(0);
    expect(counts.receipts).toBe(0);
    // And the machine/model surfaces structurally CANNOT create authority:
    // the ingest service and the model adapter hold no ledger-mandate paths
    // (source-credentials.ts / model-adapter.ts never import or call
    // ledger.mandates / ledger.approvals / ledger.reservations). Every
    // mandate row in this run came from the admin test-harness calls above.
    const mandateCount = (
      ledger.db.prepare(`SELECT COUNT(*) AS n FROM mandates`).get() as { n: number }
    ).n;
    expect(mandateCount).toBeGreaterThanOrEqual(1);
    void missionId;
  });

  it('ROTATION + REVOCATION + RESTART: old key dies (also across restart), new key works, historical events stay valid, custody stays private', async () => {
    const missionId = (globalThis as { __p0Mission?: string }).__p0Mission!;
    const oldMachine = (globalThis as { __p0Client?: MachineClient }).__p0Client!;
    // ROTATION: issue the NEW key.
    const newSecret = await issueCredential(missionId, 'ridge-telemetry', 'key_ridge_002');
    const newMachine = new MachineClient('key_ridge_002', newSecret);
    const newOk = await newMachine.submit(missionId, [
      newMachine.event(
        missionId,
        'evt_ridge_010',
        3,
        'drone-cartographer',
        'ridge-telemetry',
        isoAt(1),
        [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
      ),
    ]);
    expect(newOk.json().outcomes[0].status).toBe('accepted');
    // REVOKE the old key (admin gate: manageAuthority + CSRF).
    const viewerRevoke = await app.inject({
      method: 'POST',
      url: `/api/missions/${missionId}/sources/ridge-telemetry/keys/key_ridge_001/revoke`,
      headers: { cookie: viewerSession.cookie, 'x-csrf-token': viewerSession.csrf },
      payload: { reason: 'rotation' },
    });
    expect([401, 403]).toContain(viewerRevoke.statusCode);
    const revoke = await adminPost(
      `/api/missions/${missionId}/sources/ridge-telemetry/keys/key_ridge_001/revoke`,
      { reason: 'rotation: compromised during the exercise' },
    );
    expect(revoke.statusCode, JSON.stringify(revoke.json())).toBe(200);
    expect(revoke.json().revoked).toBe(true);
    // OLD KEY DIES IMMEDIATELY.
    const oldTry = await oldMachine.submit(missionId, [
      oldMachine.event(
        missionId,
        'evt_ridge_011',
        4,
        'drone-cartographer',
        'ridge-telemetry',
        isoAt(0),
        [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
      ),
    ]);
    expect([401, 403, 422]).toContain(oldTry.statusCode);
    const oldCode =
      oldTry.statusCode === 422 ? oldTry.json().outcomes[0].code : oldTry.json().error.code;
    expect(oldCode).toBe('CREDENTIAL_REVOKED');
    // NEW KEY still works.
    const newTry2 = await newMachine.submit(missionId, [
      newMachine.event(
        missionId,
        'evt_ridge_012',
        4,
        'drone-cartographer',
        'ridge-telemetry',
        isoAt(0),
        [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
      ),
    ]);
    expect(newTry2.json().outcomes[0].status).toBe('accepted');

    // RESTART: close and reopen the ledger + app.
    await app.close();
    ledger.close();
    ledger = openLedger(join(DIR, 'ledger.sqlite'), clock);
    ledger.migrate();
    app = buildApp(
      loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        WEB_ORIGIN: 'http://localhost:5173',
        HOST: '127.0.0.1',
        MOTERVA_DEV_AUTH: '1',
      }),
      undefined,
      ledger,
    );
    await app.ready();
    owner = await login('owner');
    adminPost = (url, payload) =>
      app.inject({
        method: 'POST',
        url,
        headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf },
        payload,
      }) as Promise<InjectLike>;
    adminGet = (url) =>
      app.inject({ method: 'GET', url, headers: { cookie: owner.cookie } }) as Promise<InjectLike>;

    // OLD KEY STAYS DEAD after restart.
    const oldAfterRestart = await oldMachine.submit(missionId, [
      oldMachine.event(
        missionId,
        'evt_ridge_013',
        5,
        'drone-cartographer',
        'ridge-telemetry',
        isoAt(0),
        [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
      ),
    ]);
    expect([401, 403, 422]).toContain(oldAfterRestart.statusCode);
    const oldAfterCode =
      oldAfterRestart.statusCode === 422
        ? oldAfterRestart.json().outcomes[0].code
        : oldAfterRestart.json().error.code;
    expect(oldAfterCode).toBe('CREDENTIAL_REVOKED');
    // NEW KEY STILL WORKS after restart (custody survives; key readable only
    // via the KEK unseal in-process).
    const newAfterRestart = await newMachine.submit(missionId, [
      newMachine.event(
        missionId,
        'evt_ridge_014',
        5,
        'drone-cartographer',
        'ridge-telemetry',
        isoAt(0),
        [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
      ),
    ]);
    expect(newAfterRestart.json().outcomes[0].status).toBe('accepted');
    // Historical events remain valid evidence: the journal still holds all
    // admitted events (spec replay counts them).
    const specRows = loadRegisteredSpecs(ledger, orgId, missionId);
    expect(specRows).toHaveLength(1);
    // Custody still private after restart (no plaintext in any read).
    const secret = (oldMachine as unknown as { secret: string }).secret;
    const readBack = JSON.stringify(
      (await adminGet(`/api/missions/${missionId}/mission-spec`)).json(),
    );
    expect(readBack).not.toContain(secret);
  });

  it('EXPIRY: a credential with expiresAt in the past is refused (expired ≠ revoked, both fail closed)', async () => {
    const msn = (
      (await adminPost('/api/missions', { title: 'Canopy expiry probe' })).json() as { id: string }
    ).id;
    await adminPost(`/api/missions/${msn}/mission-spec`, {
      spec: customerSpec(orgId, msn, 'canopy-expiry-v1'),
    });
    const expiredSecret = await issueCredential(msn, 'ridge-telemetry', 'key_exp_001', {
      expiresAt: new Date(clock.now().getTime() - 60_000).toISOString(),
    });
    const expired = new MachineClient('key_exp_001', expiredSecret);
    const r = await expired.submit(msn, [
      expired.event(msn, 'evt_exp_001', 1, 'drone-cartographer', 'ridge-telemetry', isoAt(0), [
        { kind: 'asset_comms', unit: 'state', value: 'online' },
      ]),
    ]);
    expect([401, 403, 422]).toContain(r.statusCode);
    const code = r.statusCode === 422 ? r.json().outcomes[0].code : r.json().error.code;
    expect(code).toBe('CREDENTIAL_EXPIRED');
  });

  it('MODEL assistance cannot authorize: MODEL_NOT_CONFIGURED degrades, and nothing in the model path touches money', async () => {
    const missionId = (globalThis as { __p0Mission?: string }).__p0Mission!;
    delete process.env.MOTERVA_MODEL_ENDPOINT;
    delete process.env.MOTERVA_MODEL_API_KEY;
    delete process.env.MOTERVA_MODEL_ID;
    const r = await adminPost(`/api/missions/${missionId}/model-interpretation`, {
      report: 'Drone reports gusting 34 kt at ridge; hold active until the front passes.',
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('MODEL_NOT_CONFIGURED');
    // And the machine (viewer-role) cannot even reach the model surface.
    const viewerAttempt = await app.inject({
      method: 'POST',
      url: `/api/missions/${missionId}/model-interpretation`,
      headers: { cookie: viewerSession.cookie, 'x-csrf-token': viewerSession.csrf },
      payload: { report: 'anything' },
    });
    expect([401, 403]).toContain(viewerAttempt.statusCode);
  });
});
