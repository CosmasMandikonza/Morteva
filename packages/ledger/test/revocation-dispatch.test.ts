import { describe, expect, it } from 'vitest';
import type { ProviderCallResult, ProviderSubmissionStatus } from '@moterva/providers';
import type { Ledger, RailDispatcher } from '../src/index.js';
import { TEST_PASSWORD, approvedPlan, makeLedger, reserveCall } from './helpers.js';

/**
 * Issue #7 Phase 5 — revocation × dispatch races (TOCTOU).
 *
 * The authoritative dispatch decision is ONE transaction: claim the outbox
 * row + re-verify mandate authority + transition RESERVED→SUBMITTING. After
 * that gate the provider attempt may proceed; before it, revocation blocks
 * the dispatch without ever calling the provider and without freeing money
 * that might already be in flight.
 */

function stubDispatcher(
  rail: 'airwallex' | 'metal',
  behavior: {
    dispatchResult?: ProviderCallResult<unknown, ProviderSubmissionStatus>;
    dispatchError?: Error;
    reconcileResult?: ProviderCallResult<unknown, never>;
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
          environment: 'sandbox',
          providerState: 'SUBMITTED',
        }
      );
    },
    async reconcileByRequestId(requestId) {
      calls.reconcileCalls.push(requestId);
      return (
        (behavior.reconcileResult as unknown as ProviderCallResult<unknown>) ?? {
          status: 'status-unknown',
          environment: 'sandbox',
        }
      );
    },
  };
}

function raceWorld(ledger: Ledger, clock: ReturnType<typeof makeLedger>['clock']) {
  const org = ledger.organizations.createOrganization('RevokeRaceOrg');
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
    minorUnits: 1_000_000,
    source: 'manual-seed',
    observedAt: clock.iso(),
    expiresAt: new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(),
  });
  const mandate = ledger.mandates.issue({
    orgId: org.id,
    missionId: mission.id,
    currency: 'USD',
    maxAmountMinor: 500_000,
    totalBudgetMinor: 500_000,
    permittedOperationKinds: ['airwallex_transfer'],
    expiresAt: new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(),
  });
  return { org, mission, mandate };
}

describe('revocation during queued dispatch', () => {
  it('a consumed approval can be revoked while queued; the gate cancels before provider call', async () => {
    const { ledger, clock } = makeLedger();
    const ctx = raceWorld(ledger, clock);
    const ref = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 50_000,
      currency: 'USD',
    });
    const { operation } = reserveCall(
      ledger,
      { org: ctx.org },
      ctx.mission.id,
      ref,
      'approval-revoked-before-dispatch',
    );
    const approver = ledger.authority.getActorByUsername(ctx.org.id, 'test-approver')!;
    const revoked = ledger.approvals.revoke(
      ctx.org.id,
      ref.approvalId,
      approver.id,
      'operator cancelled',
    );
    expect(revoked.status).toBe('revoked');
    const dispatcher = stubDispatcher('airwallex');
    ledger.worker.register(dispatcher);
    const report = await ledger.worker.runOnce();
    expect(report.blocked).toBe(1);
    expect(dispatcher.dispatchCalls).toEqual([]);
    expect(ledger.reservations.getOperation(ctx.org.id, operation.id).state).toBe('CANCELLED');
    expect(ledger.spendable.compute(ctx.org.id, 'USD').outstandingCommittedMinor).toBe(0);
    ledger.close();
  });

  it('the 5-step race: reserve → eligible → REVOKE → worker → provider never called, op cancelled, funds released', async () => {
    const { ledger, clock } = makeLedger();
    const ctx = raceWorld(ledger, clock);
    const ref = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 100_000,
      currency: 'USD',
    });
    const { operation } = reserveCall(
      ledger,
      { org: ctx.org },
      ctx.mission.id,
      ref,
      'revoked-before-dispatch',
    );

    // Outbox row exists and is claim-eligible.
    expect(ledger.outbox.pendingCount()).toBe(1);

    // Authority is revoked between reservation and dispatch.
    const admin = ledger.authority.createHumanActor({
      orgId: ctx.org.id,
      username: 'admin1',
      displayName: 'A',
      role: 'admin',
      password: TEST_PASSWORD,
    });
    ledger.mandates.revoke(ctx.org.id, ctx.mission.id, ctx.mandate.id, admin.id, 'mission halted');

    const dispatcher = stubDispatcher('airwallex');
    ledger.worker.register(dispatcher);
    const report = await ledger.worker.runOnce();

    expect(report.blocked).toBe(1);
    expect(report.dispatched).toBe(0);
    expect(dispatcher.dispatchCalls).toEqual([]); // the provider was NEVER contacted
    expect(dispatcher.reconcileCalls).toEqual([]);

    const op = ledger.reservations.getOperation(ctx.org.id, operation.id);
    expect(op.state).toBe('CANCELLED'); // provably never submitted → safe release
    expect(ledger.reservations.getCommitment(ctx.org.id, operation.id).state).toBe('released');
    expect(ledger.spendable.compute(ctx.org.id, 'USD').outstandingCommittedMinor).toBe(0);
    const dispatch = ledger.outbox.listByOperation(ctx.org.id, operation.id)[0]!;
    expect(dispatch.status).toBe('abandoned');
    const events = ledger.evidence.list(ctx.org.id, { topic: 'financial' }).map((e) => e.type);
    expect(events).toContain('dispatch.blocked');
    ledger.close();
  });

  it('revocation AFTER the dispatch gate: provider attempt proceeds, exposure retained, reconciled by original id', async () => {
    const { ledger, clock } = makeLedger();
    const ctx = raceWorld(ledger, clock);
    const ref = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 100_000,
      currency: 'USD',
    });
    const { operation } = reserveCall(
      ledger,
      { org: ctx.org },
      ctx.mission.id,
      ref,
      'revoked-after-gate',
    );

    const dispatcher = stubDispatcher('airwallex');
    ledger.worker.register(dispatcher);

    // Simulate revocation landing right AFTER the atomic gate but BEFORE the
    // provider call: we invoke the gate effect by hand — transition to
    // SUBMITTING (what the gate does atomically) — then revoke, then run the
    // worker's dispatch phase over the already-gated row.
    ledger.reservations.transition({
      orgId: ctx.org.id,
      operationId: operation.id,
      to: 'SUBMITTING',
      reason: 'gate passed atomically',
    });
    const admin = ledger.authority.createHumanActor({
      orgId: ctx.org.id,
      username: 'admin1',
      displayName: 'A',
      role: 'admin',
      password: TEST_PASSWORD,
    });
    ledger.mandates.revoke(
      ctx.org.id,
      ctx.mission.id,
      ctx.mandate.id,
      admin.id,
      'halted mid-flight',
    );

    const report = await ledger.worker.runOnce();
    // Already past the gate → RECONCILE path with the original request id; the
    // worker must not cancel, and the commitment must be retained.
    expect(report.dispatched).toBe(0);
    expect(report.blocked).toBe(0);
    expect(dispatcher.reconcileCalls).toEqual(['revoked-after-gate']);
    const op = ledger.reservations.getOperation(ctx.org.id, operation.id);
    expect(['SUBMITTING', 'STATUS_UNKNOWN']).toContain(op.state);
    expect(ledger.reservations.getCommitment(ctx.org.id, operation.id).state).not.toBe('released');
    expect(ledger.spendable.compute(ctx.org.id, 'USD').outstandingCommittedMinor).toBe(100_000);
    ledger.close();
  });

  it('expired mandate blocks an undispatched claim at the gate', async () => {
    const { ledger, clock } = makeLedger();
    const ctx = raceWorld(ledger, clock);
    const ref = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 100_000,
      currency: 'USD',
    });
    const { operation } = reserveCall(
      ledger,
      { org: ctx.org },
      ctx.mission.id,
      ref,
      'expires-at-gate',
    );

    clock.advance(25 * 3_600_000); // mandate window over
    const dispatcher = stubDispatcher('airwallex');
    ledger.worker.register(dispatcher);
    const report = await ledger.worker.runOnce();
    expect(report.blocked).toBe(1);
    expect(dispatcher.dispatchCalls).toEqual([]);
    expect(ledger.reservations.getOperation(ctx.org.id, operation.id).state).toBe('CANCELLED');
    ledger.close();
  });

  it('superseding (re-issuing) a mandate blocks dispatch of operations authorized by the previous version', async () => {
    const { ledger, clock } = makeLedger();
    const ctx = raceWorld(ledger, clock);
    const ref = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 100_000,
      currency: 'USD',
    });
    const { operation } = reserveCall(
      ledger,
      { org: ctx.org },
      ctx.mission.id,
      ref,
      'superseded-at-gate',
    );

    // Admin re-issues the mandate (v2) while the operation sits queued.
    ledger.mandates.issue({
      orgId: ctx.org.id,
      missionId: ctx.mission.id,
      mandateId: ctx.mandate.id,
      currency: 'USD',
      maxAmountMinor: 500_000,
      totalBudgetMinor: 500_000,
      permittedOperationKinds: ['airwallex_transfer'],
      expiresAt: new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(),
    });
    const dispatcher = stubDispatcher('airwallex');
    ledger.worker.register(dispatcher);
    const report = await ledger.worker.runOnce();
    expect(report.blocked).toBe(1);
    expect(dispatcher.dispatchCalls).toEqual([]);
    expect(ledger.reservations.getOperation(ctx.org.id, operation.id).state).toBe('CANCELLED');
    ledger.close();
  });

  it('an envelope shrunk by re-issue below existing consumption blocks further dispatch of queued ops', async () => {
    const { ledger, clock } = makeLedger();
    const ctx = raceWorld(ledger, clock);
    // Two queued operations, each 100k under a 500k envelope.
    const refA = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 100_000,
      currency: 'USD',
    });
    const opA = reserveCall(ledger, { org: ctx.org }, ctx.mission.id, refA, 'shrink-a').operation;
    const refB = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 100_000,
      currency: 'USD',
    });
    const opB = reserveCall(ledger, { org: ctx.org }, ctx.mission.id, refB, 'shrink-b').operation;

    // Re-issue shrinks the envelope to 100k — below the 200k already reserved.
    ledger.mandates.issue({
      orgId: ctx.org.id,
      missionId: ctx.mission.id,
      mandateId: ctx.mandate.id,
      currency: 'USD',
      maxAmountMinor: 100_000,
      totalBudgetMinor: 100_000,
      permittedOperationKinds: ['airwallex_transfer'],
      expiresAt: new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(),
    });
    const dispatcher = stubDispatcher('airwallex');
    ledger.worker.register(dispatcher);
    const report = await ledger.worker.runOnce({ limit: 2 });

    // Both queued ops are blocked: consumed (200k) > envelope (100k).
    expect(report.blocked).toBe(2);
    expect(dispatcher.dispatchCalls).toEqual([]);
    expect(ledger.reservations.getOperation(ctx.org.id, opA.id).state).toBe('CANCELLED');
    expect(ledger.reservations.getOperation(ctx.org.id, opB.id).state).toBe('CANCELLED');
    ledger.close();
  });

  it('a healthy gate passes: RESERVED→SUBMITTING→dispatch→IN_FLIGHT, and reconciliation settles only on readback', async () => {
    const { ledger, clock } = makeLedger();
    const ctx = raceWorld(ledger, clock);
    const ref = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 100_000,
      currency: 'USD',
    });
    const { operation } = reserveCall(
      ledger,
      { org: ctx.org },
      ctx.mission.id,
      ref,
      'healthy-gate',
    );

    const dispatcher = stubDispatcher('airwallex');
    ledger.worker.register(dispatcher);
    const first = await ledger.worker.runOnce();
    expect(first.dispatched).toBe(1);
    expect(dispatcher.dispatchCalls).toEqual(['healthy-gate']);
    expect(ledger.reservations.getOperation(ctx.org.id, operation.id).state).toBe('IN_FLIGHT');

    // Reconcile passes: nothing final yet → exposure retained.
    clock.advance(120_000); // claim TTL
    const second = await ledger.worker.runOnce();
    expect(second.reconciled).toBe(0);
    expect(dispatcher.reconcileCalls).toEqual(['healthy-gate']);
    expect(ledger.spendable.compute(ctx.org.id, 'USD').outstandingCommittedMinor).toBe(100_000);

    // Verified readback settles with the provider attestation.
    clock.advance(120_000);
    const confirming = stubDispatcher('airwallex', {
      reconcileResult: {
        status: 'confirmed',
        environment: 'sandbox',
        providerState: 'SETTLED',
        verifiedAt: clock.iso(),
      } as never,
    });
    ledger.worker.register(confirming);
    const third = await ledger.worker.runOnce();
    expect(third.reconciled).toBe(1);
    const settled = ledger.reservations.getOperation(ctx.org.id, operation.id);
    expect(settled.state).toBe('SETTLED');
    expect(ledger.reservations.getCommitment(ctx.org.id, operation.id).finalizedAt).not.toBeNull();
    ledger.close();
  });

  it('a forged test-harness attestation can never settle a real provider operation after dispatch', () => {
    const { ledger, clock } = makeLedger();
    const ctx = raceWorld(ledger, clock);
    const ref = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 100_000,
      currency: 'USD',
    });
    const { operation } = reserveCall(
      ledger,
      { org: ctx.org },
      ctx.mission.id,
      ref,
      'forged-attestation',
    );
    ledger.reservations.transition({
      orgId: ctx.org.id,
      operationId: operation.id,
      to: 'SUBMITTING',
    });
    expect(() =>
      ledger.reservations.transition({
        orgId: ctx.org.id,
        operationId: operation.id,
        to: 'SETTLED',
        attestation: { source: 'test-harness' },
      }),
    ).toThrowError(/provider-readback/);
    expect(ledger.reservations.getOperation(ctx.org.id, operation.id).state).toBe('SUBMITTING');
    expect(ledger.spendable.compute(ctx.org.id, 'USD').outstandingCommittedMinor).toBe(100_000);
    ledger.close();
  });
});
