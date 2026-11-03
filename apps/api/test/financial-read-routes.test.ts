import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openLedger, type Ledger } from '@moterva/ledger';
import { TEST_PASSWORD, tempDbPath } from '../../../packages/ledger/test/helpers.js';
import type { FastifyInstance } from 'fastify';

/**
 * Issue #34 — read-only operator financial visibility. Every adversarial
 * case: cross-tenant isolation, stale/missing balances (spendable never
 * computed from them), ambiguous/human operations, unsupported rails, and
 * exact money formatting. All reads go through the session trust boundary.
 */

function makeApp() {
  const path = tempDbPath('mtv032-api-');
  const ledger: Ledger = openLedger(path);
  ledger.migrate();
  const config = loadConfig({
    NODE_ENV: 'development',
    LOG_LEVEL: 'silent',
    MOTERVA_DEV_AUTH: '1',
    WEB_ORIGIN: 'http://localhost:5173',
  });
  const app = buildApp(config, undefined, ledger);
  return { app, ledger };
}

interface World {
  app: FastifyInstance;
  ledger: Ledger;
  orgA: { id: string; missionId: string };
  orgB: { id: string; missionId: string };
  opReserved: string;
  opUnknown: string;
  opSettled: string;
  opHuman: string;
}

function seedOrg(ledger: Ledger, name: string, fundUsd: boolean) {
  const org = ledger.organizations.createOrganization(name);
  const mission = ledger.organizations.createMission(org.id, `${name} mission`);
  const operator = ledger.authority.createHumanActor({
    orgId: org.id,
    username: `${name}-op`,
    displayName: 'Op',
    role: 'operator',
    password: TEST_PASSWORD,
  });
  const viewer = ledger.authority.createHumanActor({
    orgId: org.id,
    username: `${name}-viewer`,
    displayName: 'V',
    role: 'viewer',
    password: TEST_PASSWORD,
  });
  ledger.accounts.ensureTreasuryAccount({
    orgId: org.id,
    currency: 'USD',
    label: 'USD',
    protectedFloorMinor: 0,
  });
  if (fundUsd) {
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 1_000_000,
      source: 'manual-seed',
      observedAt: ledger.clock.iso(),
      expiresAt: new Date(ledger.clock.now().getTime() + 24 * 3_600_000).toISOString(),
    });
  }
  return { org, mission, operator, viewer };
}

function reserveOp(
  ledger: Ledger,
  orgId: string,
  missionId: string,
  actorId: string,
  approverId: string,
  requestId: string,
  amountMinor: number,
) {
  ledger.mandates.issue({
    orgId,
    missionId,
    currency: 'USD',
    maxAmountMinor: 1_000_000,
    totalBudgetMinor: 1_000_000,
    permittedOperationKinds: ['airwallex_transfer', 'internal_hold'],
    byActorId: actorId,
    expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
  });
  const plan = ledger.plans.recordVersion({
    orgId,
    missionId,
    proposedBy: actorId,
    terms: {
      amountMinor,
      currency: 'USD',
      beneficiary: 'benfixture',
      purpose: 'issue #34 test operation',
    },
  });
  const approval = ledger.approvals.record({
    orgId,
    plan,
    decidedByActorId: approverId,
    kind: 'airwallex_transfer',
    expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
  });
  const result = ledger.reservations.reserve({
    orgId,
    missionId,
    kind: 'airwallex_transfer',
    requestId,
    planId: plan.id,
    planVersion: plan.version,
    approvalId: approval.id,
  });
  return result.operation.id;
}

function buildWorld(): World {
  const { app, ledger } = makeApp();
  const a = seedOrg(ledger, 'OrgA', true);
  const b = seedOrg(ledger, 'OrgB', true);

  // Org A: an account with NO snapshot at all (missing-balance case).
  ledger.accounts.ensureTreasuryAccount({
    orgId: a.org.id,
    currency: 'EUR',
    label: 'EUR',
    protectedFloorMinor: 0,
  });

  const aApprover = ledger.authority.createHumanActor({
    orgId: a.org.id,
    username: 'orgA-approver',
    displayName: 'A',
    role: 'approver',
    password: TEST_PASSWORD,
  });
  const opReserved = reserveOp(
    ledger,
    a.org.id,
    a.mission.id,
    a.operator.id,
    aApprover.id,
    'r032-reserved',
    250_000,
  );
  const opUnknown = reserveOp(
    ledger,
    a.org.id,
    a.mission.id,
    a.operator.id,
    aApprover.id,
    'r032-unknown',
    33_250,
  );
  ledger.reservations.transition({
    orgId: a.org.id,
    operationId: opUnknown,
    to: 'STATUS_UNKNOWN',
    attestation: { source: 'test-harness', note: 'ambiguous dispatch' },
    reason: 'fixture: ambiguous outcome',
  });
  const opSettled = reserveOp(
    ledger,
    a.org.id,
    a.mission.id,
    a.operator.id,
    aApprover.id,
    'r032-settled',
    100_000,
  );
  ledger.reservations.transition({
    orgId: a.org.id,
    operationId: opSettled,
    to: 'SETTLED',
    attestation: { source: 'provider-readback', note: 'fixture settlement' },
  });
  const opHuman = reserveOp(
    ledger,
    a.org.id,
    a.mission.id,
    a.operator.id,
    aApprover.id,
    'r032-human',
    50_000,
  );
  ledger.reservations.transition({
    orgId: a.org.id,
    operationId: opHuman,
    to: 'REQUIRES_HUMAN',
    attestation: { source: 'test-harness', note: 'escalated' },
    reason: 'fixture: needs a human',
  });

  // Org B: one plain reserved operation of its own.
  const bApprover = ledger.authority.createHumanActor({
    orgId: b.org.id,
    username: 'orgB-approver',
    displayName: 'B',
    role: 'approver',
    password: TEST_PASSWORD,
  });
  reserveOp(ledger, b.org.id, b.mission.id, b.operator.id, bApprover.id, 'r032-orgb', 10_000);

  return {
    app,
    ledger,
    orgA: { id: a.org.id, missionId: a.mission.id },
    orgB: { id: b.org.id, missionId: b.mission.id },
    opReserved,
    opUnknown,
    opSettled,
    opHuman,
  };
}

const world = buildWorld();
const staleWorld = (() => {
  // Separate app whose ONLY USD snapshot was observed in the past and has
  // already expired (valid ordering, no longer fresh).
  const { app, ledger } = makeApp();
  const seeded = seedOrg(ledger, 'StaleOrg', false);
  ledger.accounts.ensureTreasuryAccount({
    orgId: seeded.org.id,
    currency: 'USD',
    label: 'USD',
    protectedFloorMinor: 0,
  });
  const now = ledger.clock.now().getTime();
  ledger.accounts.recordBalanceSnapshot({
    orgId: seeded.org.id,
    currency: 'USD',
    minorUnits: 500_000,
    source: 'manual-seed',
    observedAt: new Date(now - 10 * 60_000).toISOString(),
    expiresAt: new Date(now - 5 * 60_000).toISOString(), // already past
  });
  return { app, ledger, viewerName: 'StaleOrg-viewer' };
})();

async function loginAs(app: FastifyInstance, username: string, orgId?: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: TEST_PASSWORD, orgId },
  });
  if (response.statusCode !== 200)
    throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  const setCookie = response.headers['set-cookie'] as unknown;
  const firstCookie = Array.isArray(setCookie) ? (setCookie[0] as string) : String(setCookie);
  return firstCookie.split(';')[0]!;
}

afterAll(async () => {
  await world.app.close();
  await staleWorld.app.close();
  world.ledger.close();
  staleWorld.ledger.close();
});

describe('GET /api/financial/overview — balances, provenance, spendable, commitments', () => {
  it('reports exactly what the engine computes, with exact money strings', async () => {
    const cookie = await loginAs(world.app, 'OrgA-viewer');
    const response = await world.app.inject({
      method: 'GET',
      url: '/api/financial/overview',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.orgId).toBe(world.orgA.id);

    const usd = body.currencies.find((c: { currency: string }) => c.currency === 'USD');
    expect(usd.status).toBe('ok');
    expect(usd.balance).toEqual({ minorUnits: 1_000_000, major: '10000.00' });
    expect(usd.provenance).toMatchObject({
      source: 'manual-seed',
      stale: false,
    });
    // 1,000,000 − 0 floor − (250,000 reserved + 83,250 unknown [ambiguous 33,250 +
    // escalated 50,000 — both retain exposure] + 100,000 settled-pending)
    expect(usd.spendable).toEqual({ minorUnits: 566_750, major: '5667.50', overcommitted: false });
    expect(usd.commitments).toMatchObject({
      reservedMinor: 250_000,
      unknownMinor: 83_250,
      settledPendingObservationMinor: 100_000,
      settledTotalMinor: 100_000,
      releasedMinor: 0,
      totalOutstandingMinor: 433_250,
    });
  });

  it('a currency with NO balance observation reports no_snapshot and never computes spendable', async () => {
    const cookie = await loginAs(world.app, 'OrgA-viewer');
    const response = await world.app.inject({
      method: 'GET',
      url: '/api/financial/overview',
      headers: { cookie },
    });
    const eur = response.json().currencies.find((c: { currency: string }) => c.currency === 'EUR');
    expect(eur.status).toBe('no_snapshot');
    expect(eur.balance).toBeNull();
    expect(eur.provenance).toBeNull();
    expect(eur.spendable).toBeNull();
    expect(eur.statusDetail).toMatch(/no balance observation exists for EUR/);
    // Commitment sums are snapshot-independent truth; the settled split is
    // honestly unknown rather than guessed.
    expect(eur.commitments.settledPendingObservationMinor).toBeNull();
    expect(eur.commitments.totalOutstandingMinor).toBeNull();
  });

  it('an EXPIRED balance is stale: provenance is shown, spendable is withheld', async () => {
    const cookie = await loginAs(staleWorld.app, 'StaleOrg-viewer');
    const response = await staleWorld.app.inject({
      method: 'GET',
      url: '/api/financial/overview',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const usd = response.json().currencies[0];
    expect(usd.status).toBe('stale');
    expect(usd.balance).toEqual({ minorUnits: 500_000, major: '5000.00' });
    expect(usd.provenance.stale).toBe(true);
    expect(usd.spendable).toBeNull();
    expect(usd.statusDetail).toMatch(/spendable capacity is not computed from stale money/);
  });

  it('requires a session (401) — no anonymous financial visibility', async () => {
    const response = await world.app.inject({ method: 'GET', url: '/api/financial/overview' });
    expect(response.statusCode).toBe(401);
  });

  it('organization isolation: org B sees ONLY its own currencies — never org A data', async () => {
    const cookie = await loginAs(world.app, 'OrgB-viewer');
    const response = await world.app.inject({
      method: 'GET',
      url: '/api/financial/overview',
      headers: { cookie },
    });
    const body = response.json();
    expect(body.orgId).toBe(world.orgB.id);
    const currencies = body.currencies.map((c: { currency: string }) => c.currency);
    expect(currencies).toEqual(['USD']); // org A's EUR account is invisible
    const usd = body.currencies[0];
    expect(usd.commitments.reservedMinor).toBe(10_000); // org B's own operation only
    expect(JSON.stringify(body)).not.toContain('r032-reserved');
    expect(JSON.stringify(body)).not.toContain('6167.50');
  });
});

describe('GET /api/operations — list, filters, exceptions', () => {
  it('lists org-scoped operations newest-first with attention and commitment truth', async () => {
    const cookie = await loginAs(world.app, 'OrgA-viewer');
    const response = await world.app.inject({
      method: 'GET',
      url: '/api/operations',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.operations).toHaveLength(4);
    interface OpRow {
      id: string;
      state: string;
      attention: string;
      amount: { currency: string; minorUnits: number; major: string };
      commitment: { state: string; finalizedAt: string | null };
      dispatch: { rail: string | null; attempts: number; status: string } | null;
    }
    const byId = new Map<string, OpRow>(
      (body.operations as OpRow[]).map((o) => [o.id, o] as [string, OpRow]),
    );

    const unknownOp = byId.get(world.opUnknown)!;
    expect(unknownOp.state).toBe('STATUS_UNKNOWN');
    expect(unknownOp.attention).toBe('ambiguous');
    expect(unknownOp.commitment.state).toBe('unknown'); // exposure retained
    expect(unknownOp.amount).toEqual({ currency: 'USD', minorUnits: 33_250, major: '332.50' });

    const humanOp = byId.get(world.opHuman)!;
    expect(humanOp.attention).toBe('human');
    expect(humanOp.commitment.state).toBe('unknown');

    const settledOp = byId.get(world.opSettled)!;
    expect(settledOp.attention).toBe('none');
    expect(settledOp.commitment.state).toBe('settled');
    expect(settledOp.commitment.finalizedAt).not.toBeNull();

    const reservedOp = byId.get(world.opReserved)!;
    expect(reservedOp.attention).toBe('none');
    expect(reservedOp.commitment.state).toBe('reserved');
    // Reserved through the real flow carries a queued outbox dispatch with no
    // rail claim yet — reported as such, never guessed.
    // Reserved through the real flow: a dispatch is queued with its rail chosen
    // by kind but ZERO attempts (never claimed) — reported exactly like that.
    expect(reservedOp.dispatch).toMatchObject({
      rail: 'airwallex',
      attempts: 0,
      status: 'pending',
    });

    expect(body.counts).toEqual({ returned: 4, needsHuman: 1, ambiguous: 1 });
  });

  it('attention=needs-human returns exactly the human-attention exceptions', async () => {
    const cookie = await loginAs(world.app, 'OrgA-viewer');
    const response = await world.app.inject({
      method: 'GET',
      url: '/api/operations?attention=needs-human',
      headers: { cookie },
    });
    const body = response.json();
    expect(body.operations).toHaveLength(2);
    expect(new Set(body.operations.map((o: { id: string }) => o.id))).toEqual(
      new Set([world.opUnknown, world.opHuman]),
    );
    // Counts stay org-wide (the badge must not shrink with the filter).
    expect(body.counts).toEqual({ returned: 2, needsHuman: 1, ambiguous: 1 });
  });

  it('state and missionId filters work; invalid values fail closed with 400/404', async () => {
    const cookie = await loginAs(world.app, 'OrgA-viewer');
    const byState = await world.app.inject({
      method: 'GET',
      url: '/api/operations?state=SETTLED',
      headers: { cookie },
    });
    expect(byState.json().operations).toHaveLength(1);
    expect(byState.json().operations[0].id).toBe(world.opSettled);

    const byMission = await world.app.inject({
      method: 'GET',
      url: `/api/operations?missionId=${world.orgA.missionId}`,
      headers: { cookie },
    });
    expect(byMission.json().operations).toHaveLength(4);

    const badState = await world.app.inject({
      method: 'GET',
      url: '/api/operations?state=COMPLETED',
      headers: { cookie },
    });
    expect(badState.statusCode).toBe(400);

    const badAttention = await world.app.inject({
      method: 'GET',
      url: '/api/operations?attention=everything',
      headers: { cookie },
    });
    expect(badAttention.statusCode).toBe(400);

    const badLimit = await world.app.inject({
      method: 'GET',
      url: '/api/operations?limit=0',
      headers: { cookie },
    });
    expect(badLimit.statusCode).toBe(400);
  });

  it('cross-tenant: a foreign missionId is a 404, and org B never lists org A operations', async () => {
    const cookieB = await loginAs(world.app, 'OrgB-viewer');
    const foreignMission = await world.app.inject({
      method: 'GET',
      url: `/api/operations?missionId=${world.orgA.missionId}`,
      headers: { cookie: cookieB },
    });
    expect(foreignMission.statusCode).toBe(404);

    const listB = await world.app.inject({
      method: 'GET',
      url: '/api/operations',
      headers: { cookie: cookieB },
    });
    const bodyB = listB.json();
    expect(bodyB.operations).toHaveLength(1);
    expect(bodyB.counts).toEqual({ returned: 1, needsHuman: 0, ambiguous: 0 });
    expect(JSON.stringify(bodyB)).not.toContain(world.opReserved);

    const foreignDetail = await world.app.inject({
      method: 'GET',
      url: `/api/operations/${world.opReserved}`,
      headers: { cookie: cookieB },
    });
    expect(foreignDetail.statusCode).toBe(404);

    // A session is required for the list too.
    const anon = await world.app.inject({ method: 'GET', url: '/api/operations' });
    expect(anon.statusCode).toBe(401);
  });
});

describe('GET /api/operations/:id — enriched detail (backward-compatible)', () => {
  it('adds amount.major, commitment, attention and dispatch to the existing shape', async () => {
    const cookie = await loginAs(world.app, 'OrgA-viewer');
    const response = await world.app.inject({
      method: 'GET',
      url: `/api/operations/${world.opUnknown}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const operation = response.json().operation;
    expect(operation.state).toBe('STATUS_UNKNOWN');
    expect(operation.attention).toBe('ambiguous');
    expect(operation.amount).toEqual({ currency: 'USD', minorUnits: 33_250, major: '332.50' });
    expect(operation.commitment.state).toBe('unknown');
    expect(operation.dispatch).toMatchObject({ rail: 'airwallex', attempts: 0, status: 'pending' });
  });
});

describe('unsupported capabilities stay honestly unsupported', () => {
  it('reserving a metal_order is still refused (RAIL_ASSET_UNSUPPORTED) — the read side never invents a rail', async () => {
    const { app, ledger } = makeApp();
    const seeded = seedOrg(ledger, 'MetalOrg', true);
    const approver = ledger.authority.createHumanActor({
      orgId: seeded.org.id,
      username: 'metal-approver',
      displayName: 'A',
      role: 'approver',
      password: TEST_PASSWORD,
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'MetalOrg-op', password: TEST_PASSWORD },
    });
    if (login.statusCode !== 200) throw new Error('metal login failed: ' + login.body);
    const setCookie = login.headers['set-cookie'] as unknown;
    const cookieLine = Array.isArray(setCookie) ? (setCookie[0] as string) : String(setCookie);
    const cookie = cookieLine.split(';')[0]!;
    const csrf = (login.json() as { csrfToken: string }).csrfToken;

    ledger.mandates.issue({
      orgId: seeded.org.id,
      missionId: seeded.mission.id,
      currency: 'USD',
      maxAmountMinor: 100,
      totalBudgetMinor: 100,
      permittedOperationKinds: ['metal_order'],
      byActorId: seeded.operator.id,
      expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
    });
    const plan = ledger.plans.recordVersion({
      orgId: seeded.org.id,
      missionId: seeded.mission.id,
      proposedBy: seeded.operator.id,
      terms: { amountMinor: 100, currency: 'USD', beneficiary: 'metal-ben', purpose: 'x' },
    });
    const approval = ledger.approvals.record({
      orgId: seeded.org.id,
      plan,
      decidedByActorId: approver.id,
      kind: 'metal_order',
      expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/operations/reserve',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        missionId: seeded.mission.id,
        kind: 'metal_order',
        requestId: 'r032-metal',
        planId: plan.id,
        planVersion: plan.version,
        approvalId: approval.id,
      },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.json())).toContain('RAIL_ASSET_UNSUPPORTED');
    await app.close();
    ledger.close();
  });

  it('no financial read route implies provider funds: provenance names its real source', async () => {
    const cookie = await loginAs(world.app, 'OrgA-viewer');
    const response = await world.app.inject({
      method: 'GET',
      url: '/api/financial/overview',
      headers: { cookie },
    });
    const serialized = JSON.stringify(response.json()).toLowerCase();
    expect(serialized).toContain('manual-seed'); // the honest origin
    expect(serialized).not.toContain('airwallex-sandbox'); // no provider observation exists
    expect(serialized).not.toContain('verified provider');
  });
});
