import { describe, expect, it } from 'vitest';
import type {
  ProviderCallResult,
  ProviderCallStatus,
  ProviderSubmissionStatus,
} from '@moterva/providers';
import { openLedger, TunableClock, type Ledger, type RailDispatcher } from '../src/index.js';
import { approvedPlan, makeLedger, reserveCall } from './helpers.js';

/**
 * Restart, crash-window and outbox replay proofs:
 *  - a committed reservation survives an abrupt close and is byte-identical after reopen;
 *  - an uncommitted transaction leaves nothing behind (crash mid-reserve);
 *  - pending dispatches replay with the ORIGINAL request id and never create a
 *    second economic intent;
 *  - the disabled worker seam claims nothing until a dispatcher registers;
 *  - timeout-style dispatch failures retain commitments; verified readback settles.
 */

function stubDispatcher(
  rail: 'airwallex' | 'metal',
  behavior: {
    dispatchResult?: ProviderCallResult<unknown, ProviderSubmissionStatus>;
    dispatchError?: Error;
    reconcileResult?: ProviderCallResult<unknown, ProviderCallStatus>;
  } = {},
): RailDispatcher & { dispatchCalls: string[]; reconcileCalls: string[] } {
  const calls = { dispatchCalls: [] as string[], reconcileCalls: [] as string[] };
  return {
    rail,
    ...calls,
    async dispatch(command) {
      calls.dispatchCalls.push(command.requestId);
      if (behavior.dispatchError) throw behavior.dispatchError;
      return (
        behavior.dispatchResult ?? {
          status: 'submitted',
          environment: rail === 'airwallex' ? 'sandbox' : 'testnet',
          providerState: 'SUBMITTED',
        }
      );
    },
    async reconcileByRequestId(requestId) {
      calls.reconcileCalls.push(requestId);
      return (
        behavior.reconcileResult ?? {
          status: 'status-unknown',
          environment: rail === 'airwallex' ? 'sandbox' : 'testnet',
        }
      );
    },
  };
}

describe('restart durability', () => {
  it('a committed reservation is fully reconstructed after an abrupt close', () => {
    const { ledger, clock, path } = makeLedger();
    const org = ledger.organizations.createOrganization('RestartOrg2');
    const mission = ledger.organizations.createMission(org.id, 'm');
    ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'USD',
      label: 'USD',
      protectedFloorMinor: 50_000,
    });
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 500_000,
      source: 'manual-seed',
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    ledger.mandates.issue({
      orgId: org.id,
      missionId: mission.id,
      currency: 'USD',
      maxAmountMinor: 500_000,
      permittedOperationKinds: ['airwallex_transfer'],
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 200_000, currency: 'USD' });
    const { operation } = reserveCall(ledger, { org }, mission.id, ref, 'restart-1');

    // Simulated crash: no graceful cleanup, just drop the handle.
    ledger.db.close();

    const reopened = openLedger(path, new TunableClock(clock.now()));
    const loaded = reopened.reservations.getOperation(org.id, operation.id);
    expect(loaded.state).toBe('RESERVED');
    expect(loaded.requestId).toBe('restart-1');
    const view = reopened.spendable.compute(org.id, 'USD');
    expect(view.outstandingCommittedMinor).toBe(200_000);
    expect(view.spendableMinor).toBe(250_000);
    const integrity = reopened.recovery.verify();
    expect(integrity.integrity).toBe('ok');
    expect(integrity.counts.pendingDispatches).toBe(1);
    reopened.close();
  });

  it('a crash before COMMIT persists nothing (no partial reservation)', () => {
    const { ledger, clock, path } = makeLedger();
    const org = ledger.organizations.createOrganization('TornOrg');
    const mission = ledger.organizations.createMission(org.id, 'm');
    ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'USD',
      label: 'USD',
      protectedFloorMinor: 0,
    });
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 500_000,
      source: 'manual-seed',
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    ledger.mandates.issue({
      orgId: org.id,
      missionId: mission.id,
      currency: 'USD',
      maxAmountMinor: 500_000,
      permittedOperationKinds: ['airwallex_transfer'],
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 100_000, currency: 'USD' });

    // Simulate a crash mid-transaction: begin a raw write transaction and roll back.
    try {
      ledger.db.transaction(() => {
        ledger.db
          .prepare(
            `INSERT INTO operations (id, org_id, mission_id, kind, request_id, state, plan_id, plan_version, plan_digest,
               approval_id, mandate_id, mandate_version, amount_minor, currency, beneficiary, purpose, created_at, updated_at)
             VALUES ('op_torn', ?, ?, 'airwallex_transfer', 'torn-1', 'RESERVED', ?, ?, ?, ?, 'mnd_x', 1, 1, 'USD', 'b', 'p', ?, ?)`,
          )
          .run(
            org.id,
            mission.id,
            ref.planId,
            ref.planVersion,
            ref.digest,
            ref.approvalId,
            clock.iso(),
            clock.iso(),
          );
        throw new Error('simulated crash before COMMIT');
      });
    } catch {
      // expected rollback
    }

    const reopened = openLedger(path, new TunableClock(clock.now()));
    const torn = reopened.db
      .prepare('SELECT COUNT(*) AS c FROM operations WHERE id = ?')
      .get('op_torn') as { c: number };
    expect(torn.c).toBe(0);
    expect(reopened.spendable.compute(org.id, 'USD').spendableMinor).toBe(500_000);
    reopened.close();
    ledger.close();
  });
});

describe('outbox replay with the original request id', () => {
  function reservedLedger(): {
    ledger: Ledger;
    clock: TunableClock;
    org: { id: string };
    missionId: string;
    operationId: string;
  } {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('OutboxOrg');
    const mission = ledger.organizations.createMission(org.id, 'm');
    ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'USD',
      label: 'USD',
      protectedFloorMinor: 0,
    });
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 500_000,
      source: 'manual-seed',
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    ledger.mandates.issue({
      orgId: org.id,
      missionId: mission.id,
      currency: 'USD',
      maxAmountMinor: 500_000,
      permittedOperationKinds: ['airwallex_transfer', 'metal_order'],
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 100_000, currency: 'USD' });
    const { operation } = reserveCall(ledger, { org }, mission.id, ref, 'outbox-1');
    return { ledger, clock, org: { id: org.id }, missionId: mission.id, operationId: operation.id };
  }

  it('the disabled seam claims nothing while no dispatcher is registered', async () => {
    const ctx = reservedLedger();
    const report = await ctx.ledger.worker.runOnce();
    expect(report.claimed).toBe(0);
    expect(ctx.ledger.outbox.pendingCount()).toBe(1); // untouched, visibly pending
    ctx.ledger.close();
  });

  it('claimed-then-crashed dispatch replays with the SAME request id after TTL', async () => {
    const ctx = reservedLedger();
    ctx.ledger.worker.register(
      stubDispatcher('airwallex', { dispatchError: new Error('network dropped mid-dispatch') }),
    );
    const first = await ctx.ledger.worker.runOnce();
    expect(first.markedUnknown).toBe(1);
    // Operation is now ambiguous and retains its money.
    const op = ctx.ledger.reservations.getOperation(ctx.org.id, ctx.operationId);
    expect(op.state).toBe('STATUS_UNKNOWN');
    expect(ctx.ledger.spendable.compute(ctx.org.id, 'USD').outstandingCommittedMinor).toBe(100_000);

    // A crashed claim becomes reclaimable after TTL; replay RECONCILES (never re-submits blindly).
    ctx.clock.advance(120_000);
    const reconciler = stubDispatcher('airwallex', {
      reconcileResult: {
        status: 'confirmed',
        environment: 'sandbox',
        providerState: 'SETTLED',
        verifiedAt: '2026-11-03T12:05:00.000Z',
      },
    });
    ctx.ledger.worker.register(reconciler);
    const second = await ctx.ledger.worker.runOnce();
    expect(second.reconciled).toBe(1);
    expect(reconciler.reconcileCalls).toEqual(['outbox-1']); // original id, not a fresh one

    const settled = ctx.ledger.reservations.getOperation(ctx.org.id, ctx.operationId);
    expect(settled.state).toBe('SETTLED');
    const commitment = ctx.ledger.reservations.getCommitment(ctx.org.id, ctx.operationId);
    expect(commitment.finalizedAt).not.toBeNull();
    expect(ctx.ledger.recovery.verify().integrity).toBe('ok');
    ctx.ledger.close();
  });

  it('successful submission remains IN_FLIGHT and scheduled for verified readback', async () => {
    const ctx = reservedLedger();
    const airwallex = stubDispatcher('airwallex');
    const metal = stubDispatcher('metal');
    ctx.ledger.worker.register(airwallex);
    ctx.ledger.worker.register(metal); // both rails coexist by design
    const report = await ctx.ledger.worker.runOnce();
    expect(report.dispatched).toBe(1);
    expect(airwallex.dispatchCalls).toEqual(['outbox-1']);
    expect(metal.dispatchCalls).toEqual([]);

    const op = ctx.ledger.reservations.getOperation(ctx.org.id, ctx.operationId);
    expect(op.state).toBe('IN_FLIGHT'); // submitted is NOT settled
    expect(ctx.ledger.spendable.compute(ctx.org.id, 'USD').outstandingCommittedMinor).toBe(100_000);
    const dispatch = ctx.ledger.outbox.listByOperation(ctx.org.id, ctx.operationId)[0] as {
      status: string;
    };
    expect(dispatch.status).toBe('claimed'); // never silently stop settlement follow-up
    expect(ctx.ledger.outbox.pendingCount()).toBe(1);
    ctx.ledger.close();
  });

  it('does not re-dispatch IN_FLIGHT after claim TTL and completes only after readback', async () => {
    const ctx = reservedLedger();
    const initial = stubDispatcher('airwallex');
    ctx.ledger.worker.register(initial);
    await ctx.ledger.worker.runOnce();
    await ctx.ledger.worker.runOnce(); // no second dispatch before claim TTL
    expect(initial.dispatchCalls).toEqual(['outbox-1']);
    expect(ctx.ledger.outbox.pendingCount()).toBe(1);

    ctx.clock.advance(120_000);
    const readback = stubDispatcher('airwallex', {
      reconcileResult: {
        status: 'confirmed',
        environment: 'sandbox',
        providerState: 'SETTLED',
        verifiedAt: ctx.clock.iso(),
      },
    });
    ctx.ledger.worker.register(readback);
    const report = await ctx.ledger.worker.runOnce();
    expect(report.reconciled).toBe(1);
    expect(readback.dispatchCalls).toEqual([]); // NEVER a second payment submission
    expect(readback.reconcileCalls).toEqual(['outbox-1']);
    expect(ctx.ledger.reservations.getOperation(ctx.org.id, ctx.operationId).state).toBe('SETTLED');
    expect(ctx.ledger.outbox.pendingCount()).toBe(0);
    const operations = ctx.ledger.db.prepare('SELECT COUNT(*) AS c FROM operations').get() as {
      c: number;
    };
    expect(operations.c).toBe(1);
    ctx.ledger.close();
  });

  it('crash after SUBMITTING transition but before provider response reconciles, never submits', async () => {
    const ctx = reservedLedger();
    const claim = ctx.ledger.outbox.claimPending({ rails: ['airwallex'] })[0]!;
    expect(claim.dispatch.attempts).toBe(1);
    ctx.ledger.reservations.transition({
      orgId: ctx.org.id,
      operationId: ctx.operationId,
      to: 'SUBMITTING',
    });
    // Simulate worker disappearing after writing SUBMITTING, before any known response.
    ctx.clock.advance(120_000);
    const readback = stubDispatcher('airwallex', {
      reconcileResult: { status: 'status-unknown', environment: 'sandbox' },
    });
    ctx.ledger.worker.register(readback);
    const report = await ctx.ledger.worker.runOnce();
    expect(readback.dispatchCalls).toEqual([]);
    expect(readback.reconcileCalls).toEqual(['outbox-1']);
    expect(report.markedUnknown).toBe(1);
    expect(ctx.ledger.reservations.getOperation(ctx.org.id, ctx.operationId).state).toBe(
      'STATUS_UNKNOWN',
    );
    expect(ctx.ledger.spendable.compute(ctx.org.id, 'USD').outstandingCommittedMinor).toBe(100_000);
    ctx.ledger.close();
  });

  it('processing readback keeps funds committed and schedules another check', async () => {
    const ctx = reservedLedger();
    ctx.ledger.worker.register(stubDispatcher('airwallex'));
    await ctx.ledger.worker.runOnce();
    ctx.clock.advance(120_000);
    const readback = stubDispatcher('airwallex', {
      reconcileResult: { status: 'processing', environment: 'sandbox', providerState: 'PENDING' },
    });
    ctx.ledger.worker.register(readback);
    await ctx.ledger.worker.runOnce();
    expect(readback.dispatchCalls).toEqual([]);
    expect(readback.reconcileCalls).toEqual(['outbox-1']);
    expect(ctx.ledger.reservations.getOperation(ctx.org.id, ctx.operationId).state).toBe(
      'IN_FLIGHT',
    );
    expect(ctx.ledger.outbox.pendingCount()).toBe(1);
    ctx.ledger.close();
  });

  it('a worker crash between claim and completion keeps the claim reclaimable (token rotates)', () => {
    const ctx = reservedLedger();
    const claimed = ctx.ledger.outbox.claimPending({ rails: ['airwallex'] })[0]!;
    expect(claimed).toBeDefined();
    const firstToken = claimed.dispatch.claimToken;
    expect(firstToken).toBeTruthy();

    // Wrong token cannot complete the dispatch.
    try {
      ctx.ledger.outbox.completeDispatch(ctx.org.id, claimed.dispatch.id, 'wrong-token');
      expect.unreachable('wrong claim token must be rejected');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('CLAIM_MISMATCH');
    }

    // Another org's token cannot touch it either (org-scoped claim).
    try {
      ctx.ledger.outbox.completeDispatch(
        'org_someone_else',
        claimed.dispatch.id,
        claimed.dispatch.claimToken ?? '',
      );
      expect.unreachable('cross-org claim completion must be rejected');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('CLAIM_MISMATCH');
    }

    // After TTL the stale claim can be reclaimed and completed by the new holder.
    ctx.clock.advance(120_000);
    const reclaimed = ctx.ledger.outbox.claimPending({ rails: ['airwallex'] })[0]!;
    expect(reclaimed).toBeDefined();
    expect(reclaimed.dispatch.claimToken).not.toBe(firstToken);
    expect(reclaimed.dispatch.attempts).toBe(2);
    const done = ctx.ledger.outbox.completeDispatch(
      ctx.org.id,
      reclaimed.dispatch.id,
      reclaimed.dispatch.claimToken ?? '',
    );
    expect(done.status).toBe('dispatched');
    ctx.ledger.close();
  });

  it('synchronous provider failure escalates to REQUIRES_HUMAN and retains exposure', async () => {
    const ctx = reservedLedger();
    ctx.ledger.worker.register(
      stubDispatcher('airwallex', {
        dispatchResult: {
          status: 'failed',
          environment: 'sandbox',
          providerState: 'VALIDATION_ERROR',
        },
      }),
    );
    const report = await ctx.ledger.worker.runOnce();
    expect(report.escalated).toBe(1);
    const op = ctx.ledger.reservations.getOperation(ctx.org.id, ctx.operationId);
    expect(op.state).toBe('REQUIRES_HUMAN');
    expect(ctx.ledger.spendable.compute(ctx.org.id, 'USD').outstandingCommittedMinor).toBe(100_000);
    const dispatch = ctx.ledger.outbox.listByOperation(ctx.org.id, ctx.operationId)[0] as {
      status: string;
    };
    expect(dispatch.status).toBe('abandoned');
    ctx.ledger.close();
  });
});

describe('recovery integrity verification', () => {
  it('detects drift between commitments and operations (tampered persistence)', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('DriftOrg');
    const mission = ledger.organizations.createMission(org.id, 'm');
    ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'USD',
      label: 'USD',
      protectedFloorMinor: 0,
    });
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 100_000,
      source: 'manual-seed',
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    ledger.mandates.issue({
      orgId: org.id,
      missionId: mission.id,
      currency: 'USD',
      maxAmountMinor: 100_000,
      permittedOperationKinds: ['airwallex_transfer'],
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 10_000, currency: 'USD' });
    const { operation } = reserveCall(ledger, { org }, mission.id, ref, 'drift-1');

    // Corrupt the persisted commitment state directly (simulating a broken writer).
    ledger.db
      .prepare(`UPDATE commitments SET state = 'released' WHERE operation_id = ?`)
      .run(operation.id);
    const report = ledger.recovery.verify();
    expect(report.integrity).toBe('violations');
    expect(report.violations.join(' ')).toMatch(/does not match operation state/);
    ledger.close();
  });

  it('is clean for a healthy database and reports the replay plan', () => {
    const { ledger } = makeLedger();
    const org = ledger.organizations.createOrganization('HealthyOrg');
    const mission = ledger.organizations.createMission(org.id, 'm');
    ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'USD',
      label: 'USD',
      protectedFloorMinor: 0,
    });
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 100_000,
      source: 'manual-seed',
      observedAt: ledger.clock.iso(),
      expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
    });
    ledger.mandates.issue({
      orgId: org.id,
      missionId: mission.id,
      currency: 'USD',
      maxAmountMinor: 100_000,
      permittedOperationKinds: ['airwallex_transfer'],
      expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
    });
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 10_000, currency: 'USD' });
    const { operation } = reserveCall(ledger, { org }, mission.id, ref, 'healthy-1');

    const report = ledger.recovery.verify();
    expect(report.integrity).toBe('ok');
    expect(report.violations).toEqual([]);
    expect(report.counts.operations).toBe(1);
    expect(report.counts.commitments).toBe(1);
    const plan = ledger.recovery.replayPlan();
    expect(plan).toHaveLength(1);
    expect((plan[0] as { requestId: string }).requestId).toBe('healthy-1');
    void operation;
    ledger.close();
  });
});
