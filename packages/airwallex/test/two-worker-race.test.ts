import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '@moterva/ledger';
import type { Ledger } from '@moterva/ledger';
import { TunableClock } from '@moterva/ledger';
import { FixtureTransport, created, ok } from '../src/fixture-transport.js';
import type { FixtureScript } from '../src/fixture-transport.js';
import { buildOfflineFixtureDispatcher } from '../src/dispatcher.js';
import { providerRequestIdFor } from '../src/provider-request-id.js';
import { loadAirwallexConfig } from '../src/config.js';

/**
 * TWO-WORKER DISPATCH RACE (issue #5 adversarial set): two worker processes
 * (two Ledger connections on the SAME sqlite file, each with its own
 * dispatcher + fixture transport) race to claim ONE pending outbox row.
 *
 * Invariants proven:
 *  - exactly ONE provider create call across BOTH transports (one economic
 *    operation, no duplicate economic intent);
 *  - exactly one worker wins the claim (the other reports claimed=0);
 *  - the atomic authority gate + claim token make the loser's pass a no-op;
 *  - a later reconcile phase (both workers again) settles exactly once on a
 *    verified PAID readback — the second reconciler sees the terminal state
 *    without re-transitioning or re-submitting.
 */

const CONFIG = loadAirwallexConfig({});

function seedWorld(): { path: string; clock: TunableClock; requestId: string; orgId: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'awx-race-')), 'ledger.sqlite');
  const clock = new TunableClock('2026-11-03T12:00:00.000Z');
  const ledger = openLedger(path, clock);
  ledger.migrate();
  const org = ledger.organizations.createOrganization('Race Org');
  const mission = ledger.organizations.createMission(org.id, 'harbor inspection');
  const admin = ledger.authority.createHumanActor({
    orgId: org.id,
    username: 'race-admin',
    displayName: 'Admin',
    role: 'admin',
    password: ['race', 'fixture'].join('-'),
  });
  const approver = ledger.authority.createHumanActor({
    orgId: org.id,
    username: 'race-approver',
    displayName: 'Approver',
    role: 'approver',
    password: ['race', 'fixture'].join('-'),
  });
  ledger.accounts.ensureTreasuryAccount({
    orgId: org.id,
    currency: 'USD',
    label: 'USD',
    protectedFloorMinor: 10_000,
  });
  ledger.accounts.recordBalanceSnapshot({
    orgId: org.id,
    currency: 'USD',
    minorUnits: 500_000,
    source: 'manual-seed',
    observedAt: clock.iso(),
    expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
  });
  const mandate = ledger.mandates.issue({
    orgId: org.id,
    missionId: mission.id,
    currency: 'USD',
    maxAmountMinor: 50_000,
    totalBudgetMinor: 50_000,
    permittedOperationKinds: ['airwallex_transfer'],
    byActorId: admin.id,
    expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
  });
  const plan = ledger.plans.recordVersion({
    orgId: org.id,
    missionId: mission.id,
    proposedBy: admin.id,
    terms: { amountMinor: 25_000, currency: 'USD', beneficiary: 'ben-e2e', purpose: 'race probe' },
  });
  const approval = ledger.approvals.record({
    orgId: org.id,
    plan,
    decidedByActorId: approver.id,
    kind: 'airwallex_transfer',
    mandateId: mandate.id,
    mandateVersion: mandate.version,
    expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
  });
  ledger.reservations.reserve({
    orgId: org.id,
    missionId: mission.id,
    kind: 'airwallex_transfer',
    requestId: 'rq-race-1',
    planId: plan.id,
    planVersion: plan.version,
    approvalId: approval.id,
  });
  ledger.close();
  return { path, clock, requestId: 'rq-race-1', orgId: org.id };
}

/** Reopens the seeded ledger as an independent "worker process" with its own dispatcher. */
function openWorker(
  path: string,
  clock: TunableClock,
  orgId: string,
  script: (ns: (id: string) => string) => Partial<FixtureScript>,
): {
  ledger: Ledger;
  fixture: FixtureTransport;
  runOnce: () => ReturnType<Ledger['worker']['runOnce']>;
} {
  const ledger = openLedger(path, clock);
  ledger.migrate();
  const ns = (id: string) => providerRequestIdFor(orgId, id);
  const resolved = script(ns);
  const fixture = new FixtureTransport({
    login: [created({ token: 'race-tok', expires_at: '2026-11-03T12:25:00.000Z' })],
    createTransfer: [],
    listTransfers: [],
    getTransfer: [],
    balances: [],
    ...resolved,
  } as FixtureScript);
  const dispatcher = buildOfflineFixtureDispatcher(
    CONFIG,
    fixture,
    ledger.providerReceipts,
    clock,
    () => 'ben-e2e',
  );
  ledger.worker.register(dispatcher);
  return { ledger, fixture, runOnce: () => ledger.worker.runOnce({ claimTtlMs: 0 }) };
}

describe('two-worker dispatch race (offline fixture)', () => {
  it('exactly one provider create across two racing workers; loser claims nothing; settle happens exactly once', async () => {
    const seeded = seedWorld();
    const paidthrough = (ns: (id: string) => string) => ({
      id: 'tr_race',
      request_id: ns('rq-race-1'),
      status: 'PAID',
      transfer_amount: 250.0,
      transfer_currency: 'USD',
      beneficiary_id: 'ben-e2e',
    });

    // Worker A: create accepted, then PAID readback. Worker B: identical script.
    const workerA = openWorker(seeded.path, seeded.clock, seeded.orgId, (ns) => ({
      createTransfer: [created(paidthrough(ns))],
      listTransfers: [ok({ items: [paidthrough(ns)], has_more: false })],
      getTransfer: [ok(paidthrough(ns))],
    }));
    const workerB = openWorker(seeded.path, seeded.clock, seeded.orgId, (ns) => ({
      createTransfer: [created(paidthrough(ns))],
      listTransfers: [ok({ items: [paidthrough(ns)], has_more: false })],
      getTransfer: [ok(paidthrough(ns))],
    }));

    // The race: both workers pass in the same tick. The atomic
    // BEGIN IMMEDIATE claim gate decides the winner.
    const [reportA, reportB] = await Promise.all([workerA.runOnce(), workerB.runOnce()]);
    const reports = [reportA, reportB];
    const totalDispatched = reports.reduce((sum, r) => sum + r.dispatched, 0);
    expect(totalDispatched).toBe(1); // ONE economic operation dispatched
    const totalClaimed = reports.reduce((sum, r) => sum + r.claimed, 0);
    expect(totalClaimed).toBe(1); // exactly one worker won the row

    // Exactly ONE create call across BOTH transports.
    const createsA = workerA.fixture.performedRequests.filter((r) =>
      r.path.endsWith('/transfers/create'),
    );
    const createsB = workerB.fixture.performedRequests.filter((r) =>
      r.path.endsWith('/transfers/create'),
    );
    expect(createsA.length + createsB.length).toBe(1);

    // Durable outcome on a FRESH connection (the shared source of truth):
    const judge = openLedger(seeded.path, seeded.clock);
    const op = judge.db
      .prepare('SELECT state FROM operations WHERE request_id = ?')
      .get('rq-race-1') as {
      state: string;
    };
    expect(op.state).toBe('IN_FLIGHT'); // submitted, not settled
    const dispatchRows = judge.db.prepare('SELECT COUNT(*) AS c FROM outbox_dispatches').get() as {
      c: number;
    };
    expect(dispatchRows.c).toBe(1);
    judge.close();

    // Reconcile phase: both workers again after the claim window elapses
    // (shared TunableClock advanced past the phase-1 claim timestamp), PAID
    // readback on both. Exactly ONE settlement transition may occur; the
    // loser's pass is a monitored no-op, and NEITHER ever submits again.
    seeded.clock.advance(61_000);
    const [reA, reB] = await Promise.all([workerA.runOnce(), workerB.runOnce()]);
    expect(reA.dispatched + reB.dispatched).toBe(0); // no second economic op
    expect(reA.reconciled + reB.reconciled).toBe(1); // exactly one settle

    const createsAfter = [
      ...workerA.fixture.performedRequests,
      ...workerB.fixture.performedRequests,
    ].filter((r) => r.path.endsWith('/transfers/create'));
    expect(createsAfter.length).toBe(1); // still exactly one create EVER

    const judge2 = openLedger(seeded.path, seeded.clock);
    const settled = judge2.db
      .prepare('SELECT state FROM operations WHERE request_id = ?')
      .get('rq-race-1') as { state: string };
    expect(settled.state).toBe('SETTLED');
    const settledEvidence = judge2.db
      .prepare(
        "SELECT COUNT(*) AS c FROM evidence_events WHERE type = 'dispatch.reconcile' AND payload_json LIKE '%confirmed%'",
      )
      .get() as { c: number };
    expect(settledEvidence.c).toBeGreaterThanOrEqual(1);
    judge2.close();
    workerA.ledger.close();
    workerB.ledger.close();
  });
});
