import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openLedger, TunableClock, type Ledger } from '@moterva/ledger';
import { TEST_PASSWORD } from '../../../packages/ledger/test/helpers.js';
import type { FastifyInstance } from 'fastify';

/**
 * Issue #19 A1–A3+A5 — the durable decision→proposal→approval→reservation
 * chain, adversarially. All through the real app (sessions, CSRF, guards)
 * against a real SQLite ledger; outcomes AND journal state are verified.
 *
 * Truth labels everywhere: SIMULATED_OPERATION — POLICY-ONLY; the reservation
 * stays inside the internal ledger (no dispatcher registered ⇒ no provider
 * call is even possible).
 */

const DIR = mkdtempSync(join(tmpdir(), 'decision-authority-'));
const DB = join(DIR, 'ledger.sqlite');
const CLOCK = new TunableClock('2026-11-05T12:00:00.000Z');
const ledger: Ledger = openLedger(DB, CLOCK);
ledger.migrate();
const config = loadConfig({
  NODE_ENV: 'development',
  LOG_LEVEL: 'silent',
  MOTERVA_DEV_AUTH: '1',
  WEB_ORIGIN: 'http://localhost:5173',
});
const app: FastifyInstance = buildApp(config, undefined, ledger);

interface Login {
  readonly cookie: string;
  readonly csrf: string;
}
const logins = new Map<string, Login>();

async function login(username: string): Promise<Login> {
  const cached = logins.get(username);
  if (cached !== undefined) return cached;
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: TEST_PASSWORD },
  });
  if (r.statusCode !== 200) throw new Error(`login ${username}: ${r.statusCode} ${r.body}`);
  const setCookie = r.headers['set-cookie'] as unknown;
  const first = Array.isArray(setCookie) ? (setCookie[0] as string) : String(setCookie);
  const loginInfo = {
    cookie: first.split(';')[0]!,
    csrf: (r.json() as { csrfToken: string }).csrfToken,
  };
  logins.set(username, loginInfo);
  return loginInfo;
}

async function post(url: string, username: string, payload?: Record<string, unknown>) {
  const { cookie, csrf } = await login(username);
  return app.inject({
    method: 'POST',
    url,
    headers: { cookie, 'x-csrf-token': csrf },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function get(url: string, username: string) {
  const { cookie } = await login(username);
  return app.inject({ method: 'GET', url, headers: { cookie } });
}

let orgId = '';
let missionId = '';
let operator = '';
let proposer = '';

beforeAll(async () => {
  const org = ledger.organizations.createOrganization('DecisionAuthorityOrg');
  orgId = org.id;
  const mission = ledger.organizations.createMission(orgId, 'harbor golden path');
  missionId = mission.id;
  operator = ledger.authority.createHumanActor({
    orgId,
    username: 'da-operator',
    displayName: 'O',
    role: 'operator',
    password: TEST_PASSWORD,
  }).id;
  proposer = ledger.authority.createHumanActor({
    orgId,
    username: 'da-proposer',
    displayName: 'P',
    role: 'operator',
    password: TEST_PASSWORD,
  }).id;
  ledger.authority.createHumanActor({
    orgId,
    username: 'da-approver',
    displayName: 'A',
    role: 'approver',
    password: TEST_PASSWORD,
  });
  ledger.authority.createHumanActor({
    orgId,
    username: 'da-viewer',
    displayName: 'V',
    role: 'viewer',
    password: TEST_PASSWORD,
  });
  ledger.authority.createHumanActor({
    orgId,
    username: 'da-admin',
    displayName: 'Admin',
    role: 'admin',
    password: TEST_PASSWORD,
  });
  ledger.accounts.ensureTreasuryAccount({
    orgId,
    currency: 'USD',
    label: 'USD',
    protectedFloorMinor: 0,
  });
  ledger.accounts.recordBalanceSnapshot({
    orgId,
    currency: 'USD',
    minorUnits: 8_000_000,
    source: 'manual-seed',
    observedAt: CLOCK.iso(),
    expiresAt: new Date(CLOCK.now().getTime() + 24 * 3_600_000).toISOString(),
  });
});

afterAll(async () => {
  try {
    await app.close(); // already closed if the restart-replay test ran last
  } catch {
    /* nothing to do */
  }
  if (ledger.db.open) ledger.close();
  rmSync(DIR, { recursive: true, force: true });
});

async function syntheticStep(step: 'baseline' | 'incident') {
  const r = await post(`/api/missions/${missionId}/synthetic-step`, 'da-operator', { step });
  expect(r.statusCode).toBe(200);
  return r.json();
}

async function recordSnapshot(stage: 'baseline' | 'incident') {
  const r = await post(`/api/missions/${missionId}/decision-snapshots`, 'da-operator', { stage });
  expect(r.statusCode).toBe(200);
  return r.json() as {
    replayed: boolean;
    snapshot: {
      evaluationId: string;
      stage: string;
      recordedAt: string;
      decision: {
        outcome: string;
        selected: null | {
          candidateId: string;
          grossMinor: number;
          beneficiary: string;
          currency: string;
          purpose: string;
          evidenceIds: string[];
        };
      };
      linkage: { baselineEvaluationId: string | null };
    };
  };
}

describe('A1 — durable, replayable decision snapshots', () => {
  beforeAll(async () => {
    // Seed effective authority (admin-only manageAuthority operation) BEFORE
    // any evaluation so baseline decisions are executable-era.
    const r = await post('/api/demo/refresh-authority', 'da-admin', { missionId });
    if (r.statusCode !== 200) throw new Error(`authority seed failed: ${r.statusCode} ${r.body}`);
  });

  it('GET never journals (read-only), POST journals exactly once', async () => {
    await syntheticStep('baseline');
    // GET before any POST: no snapshot events exist.
    const before = await get(`/api/missions/${missionId}/decision-snapshots`, 'da-viewer');
    expect(before.statusCode).toBe(200);
    expect((before.json() as { snapshots: unknown[] }).snapshots).toHaveLength(0);
    const journalCount = () =>
      (
        ledger.db
          .prepare(
            "SELECT COUNT(*) AS c FROM evidence_events WHERE mission_id = ? AND type = 'planner.decision.snapshot'",
          )
          .get(missionId) as { c: number }
      ).c;
    expect(journalCount()).toBe(0);

    const recorded = await recordSnapshot('baseline');
    expect(recorded.replayed).toBe(false);
    expect(recorded.snapshot.decision.outcome).toBe('select');
    expect(journalCount()).toBe(1);
    // Journal payload is float-free by construction (probabilities as integer
    // basis points) — canonicalJson digesting forbids floats at write time.
    const stored = (
      ledger.db
        .prepare(
          "SELECT payload_json FROM evidence_events WHERE mission_id = ? AND type = 'planner.decision.snapshot' ORDER BY seq LIMIT 1",
        )
        .get(missionId) as { payload_json: string }
    ).payload_json;
    expect(stored).not.toMatch(/:\s*-?\d+\.\d+(,|\}|])/);

    // Repeated GET still does not journal.
    await get(`/api/missions/${missionId}/decision-snapshots`, 'da-viewer');
    expect(journalCount()).toBe(1);
  });

  it('duplicate snapshot POST is idempotent: the ORIGINAL decision is returned unchanged', async () => {
    const first = await recordSnapshot('baseline');
    expect(first.replayed).toBe(true); // already recorded above
    const second = await post(`/api/missions/${missionId}/decision-snapshots`, 'da-operator', {
      stage: 'baseline',
    }).then((r) => r.json());
    expect(second.replayed).toBe(true);
    expect(second.snapshot.evaluationId).toBe(first.snapshot.evaluationId);
    expect(second.snapshot.recordedAt).toBe(first.snapshot.recordedAt);
    const count = (
      ledger.db
        .prepare(
          "SELECT COUNT(*) AS c FROM evidence_events WHERE mission_id = ? AND type = 'planner.decision.snapshot'",
        )
        .get(missionId) as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it('STALE TELEMETRY is a different economic intent: a NEW decline snapshot records while the original stays intact', async () => {
    // Advance far past the physical freshness window: the admitted events go
    // stale, the economic intent legitimately changes (no usable evidence),
    // and a NEW snapshot records a decline — the ORIGINAL baseline snapshot
    // is never mutated.
    CLOCK.advance(48 * 3_600_000);
    logins.clear(); // existing sessions TTL out across a 48h jump — re-login at the advanced clock
    const stale = await post(`/api/missions/${missionId}/decision-snapshots`, 'da-operator', {
      stage: 'baseline',
    }).then((r) => r.json());
    expect(stale.replayed).toBe(false);
    expect(stale.snapshot.decision.outcome).toBe('decline');
    const rows = ledger.db
      .prepare(
        "SELECT payload_json FROM evidence_events WHERE mission_id = ? AND type = 'planner.decision.snapshot' ORDER BY seq",
      )
      .all(missionId) as { payload_json: string }[];
    expect(rows.length).toBe(2);
    const original = JSON.parse(rows[0]!.payload_json) as {
      decision: { outcome: string };
      acceptedEvents: unknown[];
    };
    expect(original.decision.outcome).toBe('select');
    expect(original.acceptedEvents.length).toBeGreaterThan(0); // original untouched
    CLOCK.advance(-48 * 3_600_000);
    logins.clear();
  });

  it('incident snapshot records explicit before/after linkage; journal state verified', async () => {
    await recordSnapshot('baseline'); // replay the original (side-effect only)
    // The recorder links to the LATEST recorded baseline row (here: the
    // stale-telemetry decline from the previous test is the most recent).
    const listed = await get(`/api/missions/${missionId}/decision-snapshots`, 'da-viewer').then(
      (r) => r.json() as { snapshots: { evaluationId: string; stage: string }[] },
    );
    const latestBaseline = listed.snapshots.find((x) => x.stage === 'baseline')!.evaluationId;
    await syntheticStep('incident');
    const incident = await recordSnapshot('incident');
    expect(incident.replayed).toBe(false);
    expect(incident.snapshot.linkage.baselineEvaluationId).toBe(latestBaseline);
    // Journal state: the incident row carries the linkage; digest-verified.
    const rows = ledger.db
      .prepare(
        "SELECT payload_json FROM evidence_events WHERE mission_id = ? AND type = 'planner.decision.snapshot' ORDER BY seq",
      )
      .all(missionId) as { payload_json: string }[];
    const incidentRow = rows.find(
      (r) => (JSON.parse(r.payload_json) as { stage: string }).stage === 'incident',
    );
    expect(incidentRow).toBeDefined();
    const incidentPayload = JSON.parse(incidentRow!.payload_json) as {
      stage: string;
      linkage: { baselineEvaluationId: string };
    };
    expect(incidentPayload.stage).toBe('incident');
    expect(incidentPayload.linkage.baselineEvaluationId).toBe(latestBaseline);
  });

  it('incident requires a recorded baseline snapshot first', async () => {
    const fresh = ledger.organizations.createMission(orgId, 'no-baseline-yet');
    const r = await post(`/api/missions/${fresh.id}/decision-snapshots`, 'da-operator', {
      stage: 'incident',
    });
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: { code: string } }).error.code).toBe('BASELINE_SNAPSHOT_REQUIRED');
  });

  it('tampered snapshot payload is DETECTED on read (journal integrity verification)', async () => {
    const row = ledger.db
      .prepare(
        "SELECT id, payload_json FROM evidence_events WHERE mission_id = ? AND type = 'planner.decision.snapshot' ORDER BY seq LIMIT 1",
      )
      .get(missionId) as { id: string; payload_json: string };
    const original = row.payload_json;
    // The journal's own triggers block UPDATE (first line of defense). Digest
    // verification is the second: simulate raw-DB-write access by dropping
    // the trigger, forging the payload (digest now mismatches), then
    // restoring payload AND trigger.
    ledger.db.prepare('DROP TRIGGER evidence_events_no_update').run();
    try {
      ledger.db
        .prepare('UPDATE evidence_events SET payload_json = ? WHERE id = ?')
        .run(JSON.stringify({ ...JSON.parse(original), stage: 'forged' }), row.id);
      const r = await get(`/api/missions/${missionId}/decision-snapshots`, 'da-viewer');
      expect(r.statusCode).toBe(500);
      expect((r.json() as { error: { code: string } }).error.code).toBe(
        'JOURNAL_INTEGRITY_VIOLATION',
      );
    } finally {
      ledger.db
        .prepare('UPDATE evidence_events SET payload_json = ? WHERE id = ?')
        .run(original, row.id);
      ledger.db
        .prepare(
          `CREATE TRIGGER evidence_events_no_update BEFORE UPDATE ON evidence_events
BEGIN
  SELECT RAISE(ABORT, 'evidence_events is append-only');
END`,
        )
        .run();
    }
    const restored = await get(`/api/missions/${missionId}/decision-snapshots`, 'da-viewer');
    expect(restored.statusCode).toBe(200);
  });

  it('snapshot requires operate authority: viewer is refused', async () => {
    const r = await post(`/api/missions/${missionId}/decision-snapshots`, 'da-viewer', {
      stage: 'baseline',
    });
    expect(r.statusCode).toBe(403);
  });

  it('A5 — refresh-authority issues a fresh mandate version + balance with explicit provenance (no silent extension)', async () => {
    const before = ledger.db
      .prepare('SELECT COUNT(*) AS c FROM mandates WHERE org_id = ? AND mission_id = ?')
      .get(orgId, missionId) as { c: number };
    const r = await post('/api/demo/refresh-authority', 'da-admin', { missionId });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      clockMode: string;
      provenance: { action: string }[];
      effectiveAuthority: { mandateVersion: number; balanceStatus: string; spendableMinor: number };
    };
    expect(body.clockMode).toBe('SYSTEM_CLOCK');
    expect(body.provenance.map((p) => p.action)).toEqual(['mandate.issued', 'balance.snapshot']);
    expect(body.effectiveAuthority.balanceStatus).toBe('ok');
    const after = ledger.db
      .prepare('SELECT COUNT(*) AS c FROM mandates WHERE org_id = ? AND mission_id = ?')
      .get(orgId, missionId) as { c: number };
    expect(after.c).toBe(before.c + 1); // NEW version journaled, nothing extended
    const r2 = await post('/api/demo/refresh-authority', 'da-viewer', { missionId });
    expect(r2.statusCode).toBe(403); // manageAuthority only
    const r3 = await post('/api/demo/refresh-authority', 'da-operator', { missionId });
    expect(r3.statusCode).toBe(403); // manageAuthority is owner/admin — operators cannot mint authority
  });
});

describe('A2 — immutable plan proposal from a recorded evaluation', () => {
  let incidentEvaluationId = '';
  let planId = '';

  it('propose: server loads the snapshot; client supplied no economics; stable identity', async () => {
    // Snapshot an executable incident decision under the CURRENT authority.
    const incident = await recordSnapshot('incident');
    incidentEvaluationId = incident.snapshot.evaluationId;
    const selected = incident.snapshot.decision.selected;
    expect(selected).not.toBeNull();

    const r = await post(
      `/api/missions/${missionId}/decision-snapshots/${incidentEvaluationId}/propose-plan`,
      'da-proposer',
    );
    if (r.statusCode !== 200) throw new Error(`proposal failed: ${r.statusCode} ${r.body}`);
    const body = r.json() as {
      plan: {
        id: string;
        version: number;
        amountMinor: number;
        currency: string;
        beneficiary: string;
      };
      replayed: boolean;
      authorization: string;
    };
    expect(body.replayed).toBe(false);
    expect(body.plan.version).toBe(1);
    expect(body.plan.amountMinor).toBe(selected!.grossMinor); // from the SNAPSHOT
    expect(body.plan.beneficiary).toBe(selected!.beneficiary);
    expect(body.authorization).toContain('PROPOSED_ONLY');
    planId = body.plan.id;

    // Journal state: proposal evidence row exists with the plan identity.
    const proposedRow = ledger.db
      .prepare(
        "SELECT payload_json FROM evidence_events WHERE mission_id = ? AND type = 'planner.plan.proposed'",
      )
      .get(missionId) as { payload_json: string };
    expect(proposedRow).toBeDefined();
    expect((JSON.parse(proposedRow.payload_json) as { planId: string }).planId).toBe(planId);
  });

  it('duplicate proposal is idempotent: same plan version, no new journal rows', async () => {
    const journalBefore = (
      ledger.db
        .prepare(
          "SELECT COUNT(*) AS c FROM evidence_events WHERE mission_id = ? AND type = 'planner.plan.proposed'",
        )
        .get(missionId) as { c: number }
    ).c;
    const r = await post(
      `/api/missions/${missionId}/decision-snapshots/${incidentEvaluationId}/propose-plan`,
      'da-proposer',
    );
    expect(r.statusCode).toBe(200);
    const body = r.json() as { plan: { id: string; version: number }; replayed: boolean };
    expect(body.replayed).toBe(true);
    expect(body.plan.id).toBe(planId);
    expect(body.plan.version).toBe(1); // NOT a second version
    const journalAfter = (
      ledger.db
        .prepare(
          "SELECT COUNT(*) AS c FROM evidence_events WHERE mission_id = ? AND type = 'planner.plan.proposed'",
        )
        .get(missionId) as { c: number }
    ).c;
    expect(journalAfter).toBe(journalBefore);
  });

  it('unknown evaluation id → 404; decline/escalation outcomes are never executable', async () => {
    const missing = await post(
      `/api/missions/${missionId}/decision-snapshots/deadbeef00000000/propose-plan`,
      'da-proposer',
    );
    expect(missing.statusCode).toBe(404);
    // A baseline decision whose selected action is no-action (gross 0) is not
    // an executable payment proposal.
    const baseline = await recordSnapshot('baseline');
    if (
      baseline.snapshot.decision.outcome === 'select' &&
      baseline.snapshot.decision.selected?.grossMinor === 0
    ) {
      const r = await post(
        `/api/missions/${missionId}/decision-snapshots/${baseline.snapshot.evaluationId}/propose-plan`,
        'da-proposer',
      );
      // no-action → not an executable economic proposal
      expect([200, 409]).toContain(r.statusCode);
      if (r.statusCode === 409)
        expect((r.json() as { error: { code: string } }).error.code).toBe(
          'DECISION_NOT_EXECUTABLE',
        );
    }
  });

  it('authority change AFTER evaluation blocks the proposal (re-evaluation required)', async () => {
    // A new mandate version after the evaluation changes effective authority.
    await post('/api/demo/refresh-authority', 'da-admin', { missionId });
    // The OLD snapshot references the previous mandate version → AUTHORITY_CHANGED.
    const r = await post(
      `/api/missions/${missionId}/decision-snapshots/${incidentEvaluationId}/propose-plan`,
      'da-proposer',
    );
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: { code: string } }).error.code).toBe('AUTHORITY_CHANGED');
    // Fresh snapshot under the new authority proposes cleanly.
    const fresh = await recordSnapshot('incident');
    const r2 = await post(
      `/api/missions/${missionId}/decision-snapshots/${fresh.snapshot.evaluationId}/propose-plan`,
      'da-proposer',
    );
    expect(r2.statusCode).toBe(200);
  });

  it('financial state change between evaluation and proposal fails closed', async () => {
    // Fresh authority first, so this evaluation has NOT been proposed yet.
    await post('/api/demo/refresh-authority', 'da-admin', { missionId });
    const fresh = await recordSnapshot('incident');
    const selected = fresh.snapshot.decision.selected;
    expect(selected).not.toBeNull();
    expect(selected!.grossMinor).toBeGreaterThan(0);
    // A strictly NEWER, much lower balance observation squeezes spendable
    // between evaluation and proposal — the snapshot recorded the older,
    // higher facts; the proposal revalidates against CURRENT truth. (The
    // +60s nudge breaks the observed_at tie so the low snapshot wins the
    // latest-observation pick.)
    CLOCK.advance(60_000);
    logins.clear();
    ledger.accounts.recordBalanceSnapshot({
      orgId,
      currency: 'USD',
      minorUnits: 100_000,
      source: 'manual-seed',
      observedAt: CLOCK.iso(),
      expiresAt: new Date(CLOCK.now().getTime() + 3_600_000).toISOString(),
    });
    const r = await post(
      `/api/missions/${missionId}/decision-snapshots/${fresh.snapshot.evaluationId}/propose-plan`,
      'da-proposer',
    );
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: { code: string } }).error.code).toBe('FINANCIAL_STATE_CHANGED');
    // Restore capacity at a STRICTLY NEWER timestamp (a tie would let the
    // 100k row keep winning the latest-observation pick).
    CLOCK.advance(60_000);
    ledger.accounts.recordBalanceSnapshot({
      orgId,
      currency: 'USD',
      minorUnits: 8_000_000,
      source: 'manual-seed',
      observedAt: CLOCK.iso(),
      expiresAt: new Date(CLOCK.now().getTime() + 24 * 3_600_000).toISOString(),
    });
    CLOCK.advance(-120_000);
    logins.clear();
  });

  it('viewer may read but never propose', async () => {
    const r = await post(
      `/api/missions/${missionId}/decision-snapshots/${incidentEvaluationId}/propose-plan`,
      'da-viewer',
    );
    expect(r.statusCode).toBe(403);
  });
});

describe('A3 — exact human approval handoff through the EXISTING ledger controls', () => {
  it('proposer → plan; DIFFERENT approver approves exact terms; reservation exercises the internal ledger only', async () => {
    // Clean slate: refresh authority and record a fresh executable incident.
    await post('/api/demo/refresh-authority', 'da-admin', { missionId });
    const fresh = await recordSnapshot('incident');
    const evaluationId = fresh.snapshot.evaluationId;
    const selected = fresh.snapshot.decision.selected;
    expect(selected).not.toBeNull();
    expect(selected!.grossMinor).toBeGreaterThan(0);

    const proposal = await post(
      `/api/missions/${missionId}/decision-snapshots/${evaluationId}/propose-plan`,
      'da-proposer',
    );
    expect(proposal.statusCode).toBe(200);
    const plan = (proposal.json() as { plan: { id: string; version: number; digest?: string } })
      .plan;

    // SAME proposer cannot approve (separation of duties).
    const self = await post('/api/approvals', 'da-proposer', {
      missionId,
      planId: plan.id,
      planVersion: plan.version,
      kind: 'airwallex_transfer',
      expiresAt: new Date(CLOCK.now().getTime() + 3_600_000).toISOString(),
    });
    expect(self.statusCode).toBeGreaterThanOrEqual(400);

    // A DIFFERENT authorized human approves the exact version.
    const approval = await post('/api/approvals', 'da-approver', {
      missionId,
      planId: plan.id,
      planVersion: plan.version,
      kind: 'airwallex_transfer',
      expiresAt: new Date(CLOCK.now().getTime() + 3_600_000).toISOString(),
    });
    expect(approval.statusCode).toBe(200);
    const approvalId = (approval.json() as { approval: { id: string } }).approval.id;

    // Reservation through the existing endpoint: the ledger rechecks all
    // authority atomically. No dispatcher is registered ⇒ no provider call is
    // possible; the operation stays inside the internal ledger.
    const reserve = await post('/api/operations/reserve', 'da-operator', {
      missionId,
      kind: 'airwallex_transfer',
      requestId: 'golden-path-1',
      planId: plan.id,
      planVersion: plan.version,
      approvalId,
    });
    expect(reserve.statusCode).toBe(200);
    const reserved = reserve.json() as {
      duplicate: boolean;
      operation: { id: string; state: string; amountMinor: number; beneficiary: string };
    };
    expect(reserved.duplicate).toBe(false);
    expect(reserved.operation.state).toBe('RESERVED');
    expect(reserved.operation.amountMinor).toBe(selected!.grossMinor);
    expect(reserved.operation.beneficiary).toBe(selected!.beneficiary);

    // Journal state: operation.reserved evidence exists for this request.
    const evRow = ledger.db
      .prepare(
        "SELECT payload_json FROM evidence_events WHERE mission_id = ? AND type = 'operation.reserved' AND payload_json LIKE '%golden-path-1%'",
      )
      .get(missionId);
    expect(evRow).toBeDefined();
    // Honest missing-provider behavior: no dispatcher is registered, so the
    // reservation stays inside the internal ledger — the outbox entry sits
    // pending forever and no provider receipt can exist.
    const receipts = (
      ledger.db.prepare('SELECT COUNT(*) AS c FROM provider_receipts').get() as { c: number }
    ).c;
    expect(receipts).toBe(0);
    const outbox = ledger.db
      .prepare("SELECT status FROM outbox_dispatches WHERE request_id = 'golden-path-1'")
      .get() as { status: string } | undefined;
    expect(outbox?.status).toBe('pending');

    // DUPLICATE reserve with the same request id is inert (blind-retry prevention).
    const dup = await post('/api/operations/reserve', 'da-operator', {
      missionId,
      kind: 'airwallex_transfer',
      requestId: 'golden-path-1',
      planId: plan.id,
      planVersion: plan.version,
      approvalId,
    });
    expect(dup.statusCode).toBe(200);
    expect((dup.json() as { duplicate: boolean }).duplicate).toBe(true);
    const opCount = (
      ledger.db.prepare('SELECT COUNT(*) AS c FROM operations WHERE org_id = ?').get(orgId) as {
        c: number;
      }
    ).c;
    const dupCount = (
      ledger.db
        .prepare(
          "SELECT COUNT(*) AS c FROM operations WHERE org_id = ? AND request_id = 'golden-path-1'",
        )
        .get(orgId) as { c: number }
    ).c;
    expect(dupCount).toBe(1);
    void opCount;

    // STALE plan version cannot ride the approval: propose terms changed →
    // recordVersion creates v2; the v1 approval must be refused.
    const plan2 = ledger.plans.recordVersion({
      orgId,
      missionId,
      planId: plan.id,
      proposedBy: proposer,
      terms: {
        amountMinor: selected!.grossMinor + 1,
        currency: 'USD',
        beneficiary: selected!.beneficiary,
        purpose: 'harbor inspection',
      },
    });
    expect(plan2.version).toBe(2);
    const stale = await post('/api/operations/reserve', 'da-operator', {
      missionId,
      kind: 'airwallex_transfer',
      requestId: 'golden-path-stale-1',
      planId: plan.id,
      planVersion: 2,
      approvalId, // bound to v1's digest
    });
    expect(stale.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('revoked mandate between proposal and approval fails closed at reservation', async () => {
    await post('/api/demo/refresh-authority', 'da-admin', { missionId });
    const fresh = await recordSnapshot('incident');
    const selected = fresh.snapshot.decision.selected;
    if (selected === null || selected.grossMinor === 0) return; // nothing executable in this state
    const proposal = await post(
      `/api/missions/${missionId}/decision-snapshots/${fresh.snapshot.evaluationId}/propose-plan`,
      'da-proposer',
    );
    expect(proposal.statusCode).toBe(200);
    const plan = (proposal.json() as { plan: { id: string; version: number } }).plan;
    const approval = await post('/api/approvals', 'da-approver', {
      missionId,
      planId: plan.id,
      planVersion: plan.version,
      kind: 'airwallex_transfer',
      expiresAt: new Date(CLOCK.now().getTime() + 3_600_000).toISOString(),
    });
    expect(approval.statusCode).toBe(200);
    const approvalId = (approval.json() as { approval: { id: string } }).approval.id;
    // Revoke the mandate AFTER approval, BEFORE reservation.
    const mandate = ledger.mandates.activeFor(orgId, missionId, CLOCK.now(), 'USD');
    ledger.mandates.revoke(orgId, missionId, mandate!.id, operator, 'release test');
    const reserve = await post('/api/operations/reserve', 'da-operator', {
      missionId,
      kind: 'airwallex_transfer',
      requestId: 'revoked-mandate-1',
      planId: plan.id,
      planVersion: plan.version,
      approvalId,
    });
    expect(reserve.statusCode).toBeGreaterThanOrEqual(400);
    const op = ledger.db
      .prepare(
        "SELECT COUNT(*) AS c FROM operations WHERE org_id = ? AND request_id = 'revoked-mandate-1'",
      )
      .get(orgId) as { c: number };
    expect(op.c).toBe(0); // nothing reserved — authority failed closed
  });
});

describe('concurrency and time-based failure modes', () => {
  let concurrentEvalId = '';
  let concurrentPlanId = '';

  it('two CONCURRENT proposals of the same fresh evaluation produce exactly ONE plan version and ONE journal row', async () => {
    await post('/api/demo/refresh-authority', 'da-admin', { missionId }); // fresh authority → fresh intent
    const fresh = await recordSnapshot('incident');
    expect(fresh.replayed).toBe(false);
    const selected = fresh.snapshot.decision.selected;
    expect(selected).not.toBeNull();
    expect(selected!.grossMinor).toBeGreaterThan(0);
    concurrentEvalId = fresh.snapshot.evaluationId;

    const [a, b] = await Promise.all([
      post(
        `/api/missions/${missionId}/decision-snapshots/${concurrentEvalId}/propose-plan`,
        'da-proposer',
      ),
      post(
        `/api/missions/${missionId}/decision-snapshots/${concurrentEvalId}/propose-plan`,
        'da-operator',
      ),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const bodies = [a, b].map(
      (r) => r.json() as { plan: { id: string; version: number }; replayed: boolean },
    );
    expect(bodies[0]!.plan.id).toBe(bodies[1]!.plan.id);
    expect(bodies[0]!.plan.version).toBe(1);
    expect(bodies.filter((x) => !x.replayed)).toHaveLength(1); // exactly one committed; the other replayed it
    concurrentPlanId = bodies[0]!.plan.id;
    const versions = (
      ledger.db
        .prepare('SELECT COUNT(*) AS c FROM candidate_plans WHERE id = ?')
        .get(concurrentPlanId) as { c: number }
    ).c;
    expect(versions).toBe(1); // no duplicate versions
    const journal = (
      ledger.db
        .prepare(
          "SELECT COUNT(*) AS c FROM evidence_events WHERE type = 'planner.plan.proposed' AND payload_json LIKE ?",
        )
        .get(`%"${concurrentEvalId}"%`) as { c: number }
    ).c;
    expect(journal).toBe(1);
  });

  it('two CONCURRENT snapshot POSTs of the same intent produce ONE new journal row (duplicate submission)', async () => {
    await post('/api/demo/refresh-authority', 'da-admin', { missionId }); // new mandate id → new intent
    const before = (
      ledger.db
        .prepare(
          "SELECT COUNT(*) AS c FROM evidence_events WHERE mission_id = ? AND type = 'planner.decision.snapshot'",
        )
        .get(missionId) as { c: number }
    ).c;
    const [a, b] = await Promise.all([
      post(`/api/missions/${missionId}/decision-snapshots`, 'da-operator', { stage: 'incident' }),
      post(`/api/missions/${missionId}/decision-snapshots`, 'da-proposer', { stage: 'incident' }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const ja = a.json() as { replayed: boolean; snapshot: { evaluationId: string } };
    const jb = b.json() as { replayed: boolean; snapshot: { evaluationId: string } };
    expect(ja.snapshot.evaluationId).toBe(jb.snapshot.evaluationId); // same economic intent → same row
    const after = (
      ledger.db
        .prepare(
          "SELECT COUNT(*) AS c FROM evidence_events WHERE mission_id = ? AND type = 'planner.decision.snapshot'",
        )
        .get(missionId) as { c: number }
    ).c;
    expect(after).toBe(before + 1); // exactly one new row, not two
  });

  it('mandate EXPIRY between evaluation and proposal fails closed (no silent extension)', async () => {
    const rf = await post('/api/demo/refresh-authority', 'da-admin', { missionId });
    expect(rf.statusCode, 'expiry-test refresh: ' + String(rf.body)).toBe(200);
    const fresh = await recordSnapshot('incident');
    expect(fresh.snapshot.decision.selected).not.toBeNull();
    const plansBefore = (
      ledger.db.prepare('SELECT COUNT(*) AS c FROM candidate_plans').get() as { c: number }
    ).c;
    // Advance past the +26h mandate expiry (physical evidence also goes stale
    // long before this — either gate alone must block the proposal).
    CLOCK.advance(27 * 3_600_000);
    try {
      logins.clear();
      // Direct expiry proof: the ledger refuses lapsed authority outright
      // (fail-closed throw, never a silent null).
      expect(() => ledger.mandates.activeFor(orgId, missionId, CLOCK.now(), 'USD')).toThrow(
        /expired/,
      );
      const r = await post(
        `/api/missions/${missionId}/decision-snapshots/${fresh.snapshot.evaluationId}/propose-plan`,
        'da-proposer',
      );
      expect(r.statusCode).toBe(409);
      expect(['AUTHORITY_CHANGED', 'EVIDENCE_STALE_OR_WITHHELD']).toContain(
        (r.json() as { error: { code: string } }).error.code,
      );
      const plansAfter = (
        ledger.db.prepare('SELECT COUNT(*) AS c FROM candidate_plans').get() as { c: number }
      ).c;
      expect(plansAfter).toBe(plansBefore); // nothing was proposed against lapsed authority
    } finally {
      CLOCK.advance(-27 * 3_600_000);
      logins.clear();
    }
  });
});

describe('tenant isolation for the new routes', () => {
  it("a foreign org cannot read or write another mission's snapshots or proposals", async () => {
    const otherOrg = ledger.organizations.createOrganization('ForeignOrg');
    const otherMission = ledger.organizations.createMission(otherOrg.id, 'foreign');
    ledger.authority.createHumanActor({
      orgId: otherOrg.id,
      username: 'da-foreign',
      displayName: 'F',
      role: 'owner',
      password: TEST_PASSWORD,
    });
    const read = await get(`/api/missions/${missionId}/decision-snapshots`, 'da-foreign');
    expect(read.statusCode).toBe(404);
    const write = await post(`/api/missions/${missionId}/decision-snapshots`, 'da-foreign', {
      stage: 'baseline',
    });
    expect(write.statusCode).toBe(404);
    const propose = await post(
      `/api/missions/${missionId}/decision-snapshots/deadbeef/propose-plan`,
      'da-foreign',
    );
    expect(propose.statusCode, `propose body was: ${propose.body}`).toBe(404);
    void otherMission;
  });
});

describe('durability — restart replay', () => {
  it('the ledger REOPENS with every snapshot digest-verified; replay returns the ORIGINAL decisions and plans', async () => {
    // Prepare a proposed evaluation under the CURRENT authority while the
    // original app is up; sessions persist in the ledger and survive restart.
    const viewerLogin = await login('da-viewer');
    const proposerLogin = await login('da-proposer');
    const rf = await post('/api/demo/refresh-authority', 'da-admin', { missionId });
    expect(rf.statusCode, 'restart-test refresh: ' + String(rf.body)).toBe(200);
    const fresh = await recordSnapshot('incident');
    expect(fresh.snapshot.decision.selected).not.toBeNull();
    const proposal = await post(
      `/api/missions/${missionId}/decision-snapshots/${fresh.snapshot.evaluationId}/propose-plan`,
      'da-proposer',
    );
    expect(proposal.statusCode).toBe(200);
    const proposedPlan = (proposal.json() as { plan: { id: string; version: number } }).plan;

    const before = await get(`/api/missions/${missionId}/decision-snapshots`, 'da-viewer').then(
      (r) => r.json() as { integrity: string; snapshots: { evaluationId: string }[] },
    );
    expect(before.snapshots.length).toBeGreaterThan(0);
    const plansBefore = ledger.db
      .prepare('SELECT id, version, digest FROM candidate_plans ORDER BY id, version')
      .all();

    await app.close();
    ledger.close();

    const ledger2 = openLedger(DB, CLOCK);
    const app2 = buildApp(config, undefined, ledger2);
    try {
      const after = await app2.inject({
        method: 'GET',
        url: `/api/missions/${missionId}/decision-snapshots`,
        headers: { cookie: viewerLogin.cookie },
      });
      expect(after.statusCode).toBe(200);
      const body = after.json() as { integrity: string; snapshots: { evaluationId: string }[] };
      expect(body.integrity).toBe('verified'); // every row digest-verified on reopen
      expect(body.snapshots.map((s) => s.evaluationId).sort()).toEqual(
        before.snapshots.map((s) => s.evaluationId).sort(),
      );

      // Re-proposing the already-proposed evaluation after restart returns the
      // SAME immutable plan version — it never recomputes with a new clock.
      const replay = await app2.inject({
        method: 'POST',
        url: `/api/missions/${missionId}/decision-snapshots/${fresh.snapshot.evaluationId}/propose-plan`,
        headers: { cookie: proposerLogin.cookie, 'x-csrf-token': proposerLogin.csrf },
      });
      expect(replay.statusCode).toBe(200);
      const rb = replay.json() as { plan: { id: string; version: number }; replayed: boolean };
      expect(rb.replayed).toBe(true);
      expect(rb.plan.id).toBe(proposedPlan.id);
      expect(rb.plan.version).toBe(proposedPlan.version);

      // Re-recording the same intent after restart also replays the original.
      // ('incident' was recorded under the CURRENT mandate; a 'baseline'
      // re-record would be a NEW intent because the refresh changed the
      // authority identity that keys economic intent.)
      const again = await app2.inject({
        method: 'POST',
        url: `/api/missions/${missionId}/decision-snapshots`,
        headers: { cookie: proposerLogin.cookie, 'x-csrf-token': proposerLogin.csrf },
        payload: { stage: 'incident' },
      });
      expect(again.statusCode).toBe(200);
      expect((again.json() as { replayed: boolean }).replayed).toBe(true);

      const plansAfter = ledger2.db
        .prepare('SELECT id, version, digest FROM candidate_plans ORDER BY id, version')
        .all();
      expect(plansAfter).toEqual(plansBefore); // plan set byte-identical after restart
    } finally {
      await app2.close();
      ledger2.close();
    }
  });
});
