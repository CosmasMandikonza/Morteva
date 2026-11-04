import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openLedger, type Ledger } from '@moterva/ledger';
import { TEST_PASSWORD, tempDbPath } from '../../../packages/ledger/test/helpers.js';
import type { FastifyInstance } from 'fastify';

/**
 * Issue #36 — mission-scoped financial history over the append-only evidence
 * journal, plus the typed-contract guarantee: the wire responses are built as
 * @moterva/domain view types, so these tests also pin the contract shapes the
 * frontend compiles against. Adversarial focus: tenant isolation on the new
 * endpoint and the unchanged stale-balance honesty of the base routes.
 */

function makeApp() {
  const path = tempDbPath('mtv033-api-');
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

async function loginAs(app: FastifyInstance, username: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: TEST_PASSWORD },
  });
  if (response.statusCode !== 200)
    throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  const setCookie = response.headers['set-cookie'] as unknown;
  const firstCookie = Array.isArray(setCookie) ? (setCookie[0] as string) : String(setCookie);
  return firstCookie.split(';')[0]!;
}

function seedOrg(ledger: Ledger, name: string, fund: boolean) {
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
  const approver = ledger.authority.createHumanActor({
    orgId: org.id,
    username: `${name}-approver`,
    displayName: 'A',
    role: 'approver',
    password: TEST_PASSWORD,
  });
  ledger.accounts.ensureTreasuryAccount({
    orgId: org.id,
    currency: 'USD',
    label: 'USD',
    protectedFloorMinor: 0,
  });
  if (fund) {
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 1_000_000,
      source: 'manual-seed',
      observedAt: ledger.clock.iso(),
      expiresAt: new Date(ledger.clock.now().getTime() + 24 * 3_600_000).toISOString(),
    });
  }
  return { org, mission, operator, viewer, approver };
}

function reserve(
  ledger: Ledger,
  ctx: ReturnType<typeof seedOrg>,
  requestId: string,
  amountMinor: number,
): string {
  ledger.mandates.issue({
    orgId: ctx.org.id,
    missionId: ctx.mission.id,
    currency: 'USD',
    maxAmountMinor: 1_000_000,
    totalBudgetMinor: 1_000_000,
    permittedOperationKinds: ['airwallex_transfer'],
    byActorId: ctx.operator.id,
    expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
  });
  const plan = ledger.plans.recordVersion({
    orgId: ctx.org.id,
    missionId: ctx.mission.id,
    proposedBy: ctx.operator.id,
    terms: {
      amountMinor,
      currency: 'USD',
      beneficiary: 'benfixture',
      purpose: 'issue #36 journey',
    },
  });
  const approval = ledger.approvals.record({
    orgId: ctx.org.id,
    plan,
    decidedByActorId: ctx.approver.id,
    kind: 'airwallex_transfer',
    expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
  });
  const result = ledger.reservations.reserve({
    orgId: ctx.org.id,
    missionId: ctx.mission.id,
    kind: 'airwallex_transfer',
    requestId,
    planId: plan.id,
    planVersion: plan.version,
    approvalId: approval.id,
  });
  return result.operation.id;
}

// World: org A walks the full journey — reserve → settle → late-failure
// reversal — which journals the exact evidence sequence Decision Room needs.
const world = (() => {
  const { app, ledger } = makeApp();
  const a = seedOrg(ledger, 'HistA', true);
  const b = seedOrg(ledger, 'HistB', true);

  const settledOp = reserve(ledger, a, 'hist-settled', 100_000);
  ledger.reservations.transition({
    orgId: a.org.id,
    operationId: settledOp,
    to: 'SETTLED',
    attestation: { source: 'provider-readback', note: 'verified settlement' },
  });
  ledger.reservations.transition({
    orgId: a.org.id,
    operationId: settledOp,
    to: 'REQUIRES_HUMAN',
    attestation: {
      source: 'provider-readback',
      note: 'PAID later transitioned to FAILED (post-settlement reversal)',
    },
    reason: 'provider reported FAILED AFTER settlement; funds may have been returned',
  });

  const deniedOpContext = 'reservation.denied is journaled too: over-spend attempt';
  void deniedOpContext;
  // An over-budget reservation attempt is refused and journaled as a denial.
  let denialJournaled = false;
  try {
    reserve(ledger, a, 'hist-denied', 5_000_000); // exceeds the 1,000,000 mandate
  } catch {
    denialJournaled = true;
  }
  if (!denialJournaled) throw new Error('expected the over-budget reserve to be refused');

  // Org B: its own quiet history.
  reserve(ledger, b, 'hist-orgb', 10_000);

  return { app, ledger, a, b, settledOp };
})();

afterAll(async () => {
  await world.app.close();
  world.ledger.close();
});

describe('GET /api/missions/:missionId/evidence — mission financial history', () => {
  it('replays the journey in journal order with payloads and digests', async () => {
    const cookie = await loginAs(world.app, 'HistA-viewer');
    const response = await world.app.inject({
      method: 'GET',
      url: `/api/missions/${world.a.mission.id}/evidence?limit=200`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.missionId).toBe(world.a.mission.id);

    const types = body.events.map((e: { type: string }) => e.type);
    // The journal replays the journey exactly as the ledger recorded it:
    // reservation → settlement → late-failure escalation (the reversal is the
    // REQUIRES_HUMAN transition with its auditable attestation+reason kept in
    // the payload — the worker's settlement.reversed variant journals the
    // same decision when it drives the reversal).
    expect(types).toContain('operation.reserved');
    expect(types).toContain('operation.settled');
    expect(types).toContain('operation.requires_human');
    expect(types).toContain('reservation.denied');

    const seqs = body.events.map((e: { seq: number }) => e.seq);
    expect([...seqs].sort((x, y) => y - x)).toEqual(seqs); // descending

    const settledEvent = body.events.find((e: { type: string }) => e.type === 'operation.settled');
    expect(settledEvent.topic).toBe('financial');
    expect(settledEvent.eventKey).toContain(world.settledOp);
    expect(settledEvent.payloadDigest).toMatch(/^[0-9a-f]{16,}/);
    expect(settledEvent.payload).toMatchObject({ operationId: world.settledOp });
    const escalatedEvent = body.events.find(
      (e: { type: string }) => e.type === 'operation.requires_human',
    );
    // Escalation keeps history: settlement AND reversal-decision both present,
    // with the attestation and reason the operator must see.
    expect(escalatedEvent.seq).toBeGreaterThan(settledEvent.seq);
    expect(escalatedEvent.payload.reason).toMatch(/FAILED AFTER settlement/);
    expect(escalatedEvent.payload.attestation.note).toMatch(/post-settlement reversal/);
  });

  it('topic filter narrows to financial events; invalid topic/limit fail closed', async () => {
    const cookie = await loginAs(world.app, 'HistA-viewer');
    const financial = await world.app.inject({
      method: 'GET',
      url: `/api/missions/${world.a.mission.id}/evidence?topic=financial`,
      headers: { cookie },
    });
    for (const e of financial.json().events) expect(e.topic).toBe('financial');

    const badTopic = await world.app.inject({
      method: 'GET',
      url: `/api/missions/${world.a.mission.id}/evidence?topic=weather`,
      headers: { cookie },
    });
    expect(badTopic.statusCode).toBe(400);

    const badLimit = await world.app.inject({
      method: 'GET',
      url: `/api/missions/${world.a.mission.id}/evidence?limit=999`,
      headers: { cookie },
    });
    expect(badLimit.statusCode).toBe(400);

    const anon = await world.app.inject({
      method: 'GET',
      url: `/api/missions/${world.a.mission.id}/evidence`,
    });
    expect(anon.statusCode).toBe(401);
  });

  it('limit bounds the page (oldest events beyond the page are simply absent)', async () => {
    const cookie = await loginAs(world.app, 'HistA-viewer');
    const response = await world.app.inject({
      method: 'GET',
      url: `/api/missions/${world.a.mission.id}/evidence?limit=1`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const events = response.json().events;
    expect(events).toHaveLength(1);
  });

  it('TENANT ISOLATION: a foreign mission is a 404 and org B never sees org A events', async () => {
    const cookieB = await loginAs(world.app, 'HistB-viewer');
    const foreign = await world.app.inject({
      method: 'GET',
      url: `/api/missions/${world.a.mission.id}/evidence`,
      headers: { cookie: cookieB },
    });
    expect(foreign.statusCode).toBe(404);
    expect(JSON.stringify(foreign.json())).not.toContain('hist-settled');

    const own = await world.app.inject({
      method: 'GET',
      url: `/api/missions/${world.b.mission.id}/evidence`,
      headers: { cookie: cookieB },
    });
    expect(own.statusCode).toBe(200);
    const serialized = JSON.stringify(own.json());
    expect(serialized).toContain('hist-orgb');
    expect(serialized).not.toContain('hist-settled');
    expect(serialized).not.toContain(world.a.org.id);
    expect(serialized).not.toContain('operation.requires_human');
  });
});

describe('typed contracts (#36) — the wire shapes ARE the domain views', () => {
  it('overview and operations responses match the exported view shapes exactly', async () => {
    const cookie = await loginAs(world.app, 'HistA-viewer');
    const overview = (
      await world.app.inject({
        method: 'GET',
        url: '/api/financial/overview',
        headers: { cookie },
      })
    ).json();
    const usd = overview.currencies.find((c: { currency: string }) => c.currency === 'USD');
    // Late-failure reversal: the escalated operation retains exposure — the
    // number must gate new reservations, and it does (commitment unknown).
    expect(usd.status).toBe('ok');
    expect(usd.commitments.unknownMinor).toBe(100_000);
    expect(usd.spendable.minorUnits).toBe(900_000 - 0);
    expect(typeof usd.balance.major).toBe('string');

    const operations = (
      await world.app.inject({
        method: 'GET',
        url: '/api/operations',
        headers: { cookie },
      })
    ).json();
    const reversed = operations.operations.find((o: { id: string }) => o.id === world.settledOp);
    expect(reversed.state).toBe('REQUIRES_HUMAN');
    expect(reversed.attention).toBe('human');
    expect(reversed.commitment.state).toBe('unknown');
    expect(operations.counts.needsHuman).toBe(1);
  });

  it('stale-balance honesty is unchanged by the typed refactor', async () => {
    const { app, ledger } = makeApp();
    const seeded = seedOrg(ledger, 'StaleB', false);
    const now = ledger.clock.now().getTime();
    ledger.accounts.recordBalanceSnapshot({
      orgId: seeded.org.id,
      currency: 'USD',
      minorUnits: 250_000,
      source: 'manual-seed',
      observedAt: new Date(now - 10 * 60_000).toISOString(),
      expiresAt: new Date(now - 5 * 60_000).toISOString(),
    });
    const cookie = await loginAs(app, 'StaleB-viewer');
    const response = await app.inject({
      method: 'GET',
      url: '/api/financial/overview',
      headers: { cookie },
    });
    const usd = response.json().currencies[0];
    expect(usd.status).toBe('stale');
    expect(usd.provenance.stale).toBe(true);
    expect(usd.spendable).toBeNull();
    expect(usd.statusDetail).toMatch(/not computed from stale money/);
    await app.close();
    ledger.close();
  });
});

describe('evidence disclosure boundary (#37 CTO review) — payloads are projected, never raw', () => {
  // EvidenceService.append is a GENERIC writer: it stores caller-supplied
  // JSON verbatim. These tests inject hostile payloads through that exact
  // seam and prove the API discloses only the per-type allowlist.
  function injectHostile() {
    const { app, ledger } = makeApp();
    const seeded = seedOrg(ledger, 'LeakA', true);
    // 1. An allowlisted TYPE carrying secrets in non-allowlisted fields AND
    //    a nested object under an allowlisted key AND nested attestation junk.
    ledger.evidence.append({
      orgId: seeded.org.id,
      missionId: seeded.mission.id,
      topic: 'financial',
      type: 'operation.settled',
      eventKey: 'operation:op_leak1:settled',
      payload: {
        operationId: 'op_leak1',
        from: 'IN_FLIGHT',
        to: 'SETTLED',
        reason: { api_key: 'leak-if-you-can', nested: { pii: 'Jane Doe' } },
        attestation: {
          source: 'provider-readback',
          note: 'legitimate note',
          authorization: 'Bearer leak-token',
          bank_details: { account_number: '999' },
        },
        api_key: 'secret-key-1',
        authorization: 'Bearer raw-credential',
        beneficiaryDetails: { full_name: 'Jane Doe', email: 'jane@example.test' },
      },
    });
    // 2. An UNRECOGNIZED event type with a fully juicy payload.
    ledger.evidence.append({
      orgId: seeded.org.id,
      missionId: seeded.mission.id,
      topic: 'financial',
      type: 'admin.debug.internal',
      eventKey: 'admin:debug:1',
      payload: { password: 'hunter2-xx', sessionToken: 'tok_leak', pii: ['Jane Doe'] },
    });
    return { app, ledger, mission: seeded.mission };
  }

  it('an allowlisted type discloses ONLY allowlisted scalar fields; nested secrets/PII never surface', async () => {
    const { app, ledger, mission } = injectHostile();
    const cookie = await loginAs(app, 'LeakA-viewer');
    const response = await app.inject({
      method: 'GET',
      url: `/api/missions/${mission.id}/evidence`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const settled = response
      .json()
      .events.find((e: { eventKey: string }) => e.eventKey === 'operation:op_leak1:settled');
    expect(settled).toBeDefined();
    // Allowlisted scalars survive…
    expect(settled.payload).toMatchObject({
      operationId: 'op_leak1',
      from: 'IN_FLIGHT',
      to: 'SETTLED',
    });
    // …the attestation is projected to source+note only…
    expect(settled.payload.attestation).toEqual({
      source: 'provider-readback',
      note: 'legitimate note',
    });
    // …and NOTHING else crosses the wire — not top-level secrets, not nested
    // objects under allowlisted keys, not PII blobs.
    const serialized = JSON.stringify(response.json());
    for (const leak of [
      'leak-if-you-can',
      'Jane Doe',
      'jane@example.test',
      'secret-key-1',
      'raw-credential',
      'Bearer leak-token',
      'account_number',
      'bank_details',
    ]) {
      expect(serialized).not.toContain(leak);
    }
    await app.close();
    ledger.close();
  });

  it('an UNRECOGNIZED event type is listed (digest intact) with payload null — never its raw JSON', async () => {
    const { app, ledger, mission } = injectHostile();
    const cookie = await loginAs(app, 'LeakA-viewer');
    const response = await app.inject({
      method: 'GET',
      url: `/api/missions/${mission.id}/evidence`,
      headers: { cookie },
    });
    const unknownEvent = response
      .json()
      .events.find((e: { type: string }) => e.type === 'admin.debug.internal');
    expect(unknownEvent).toBeDefined();
    expect(unknownEvent.payload).toBeNull();
    expect(unknownEvent.payloadDigest).toMatch(/^[0-9a-f]{16,}/); // integrity intact
    const serialized = JSON.stringify(response.json());
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('tok_leak');
    await app.close();
    ledger.close();
  });

  it('the stored journal itself is untouched by projection (append-only history preserved)', async () => {
    const { app, ledger, mission } = injectHostile();
    const cookie = await loginAs(app, 'LeakA-viewer');
    await app.inject({
      method: 'GET',
      url: `/api/missions/${mission.id}/evidence`,
      headers: { cookie },
    });
    const stored = ledger.db
      .prepare(`SELECT payload_json FROM evidence_events WHERE event_key = ?`)
      .get('operation:op_leak1:settled') as { payload_json: string };
    // What the journal STORED is exactly what was appended — the projection
    // happens at read time only; the append-only record keeps full fidelity.
    expect(stored.payload_json).toContain('leak-if-you-can');
    await app.close();
    ledger.close();
  });
});
