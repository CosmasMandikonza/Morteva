import { describe, expect, it } from 'vitest';
import { type LedgerError } from '../src/index.js';
import { approvedPlan, makeLedger, reserveCall } from './helpers.js';

function funded(
  ledger: ReturnType<typeof makeLedger>['ledger'],
  clock: ReturnType<typeof makeLedger>['clock'],
) {
  const org = ledger.organizations.createOrganization('LifecycleOrg');
  const mission = ledger.organizations.createMission(org.id, 'm');
  ledger.accounts.ensureTreasuryAccount({
    orgId: org.id,
    currency: 'USD',
    label: 'USD',
    protectedFloorMinor: 100_000,
  });
  ledger.accounts.recordBalanceSnapshot({
    orgId: org.id,
    currency: 'USD',
    minorUnits: 1_000_000,
    source: 'manual-seed',
    observedAt: clock.iso(),
    expiresAt: new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(),
  });
  ledger.mandates.issue({
    orgId: org.id,
    missionId: mission.id,
    currency: 'USD',
    maxAmountMinor: 1_000_000,
    permittedOperationKinds: ['airwallex_transfer'],
    expiresAt: new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(),
  });
  return { org, mission };
}

describe('lifecycle transitions and money retention', () => {
  it('invalid transitions are rejected — no state regression, ever', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = funded(ledger, clock);
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 100_000, currency: 'USD' });
    const { operation } = reserveCall(ledger, { org }, mission.id, ref, 'lc-1');

    // RESERVED -> SETTLED -> (try to go back) must fail.
    ledger.reservations.transition({
      orgId: org.id,
      operationId: operation.id,
      to: 'SETTLED',
      attestation: { source: 'test-harness' },
    });
    for (const bad of ['RESERVED', 'SUBMITTING', 'CANCELLED', 'STATUS_UNKNOWN'] as const) {
      try {
        ledger.reservations.transition({ orgId: org.id, operationId: operation.id, to: bad });
        expect.unreachable(`SETTLED -> ${bad} must be invalid`);
      } catch (error) {
        expect((error as LedgerError).code).toBe('INVALID_TRANSITION');
      }
    }
    // RECONCILED is the only legal next step from SETTLED.
    ledger.reservations.transition({ orgId: org.id, operationId: operation.id, to: 'RECONCILED' });
    ledger.close();
  });

  it('cancelling a reservation releases the funds', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = funded(ledger, clock);
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 500_000, currency: 'USD' });
    const { operation } = reserveCall(ledger, { org }, mission.id, ref, 'lc-cancel');
    expect(ledger.spendable.compute(org.id, 'USD').spendableMinor).toBe(400_000);

    const { commitment } = ledger.reservations.transition({
      orgId: org.id,
      operationId: operation.id,
      to: 'CANCELLED',
      reason: 'operator cancelled before dispatch',
    });
    expect(commitment.state).toBe('released');
    expect(ledger.spendable.compute(org.id, 'USD').spendableMinor).toBe(900_000);
    ledger.close();
  });

  it('a timeout-style unknown RETAINS the full commitment — no code path frees it', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = funded(ledger, clock);
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 500_000, currency: 'USD' });
    const { operation } = reserveCall(ledger, { org }, mission.id, ref, 'lc-unknown');
    ledger.reservations.transition({ orgId: org.id, operationId: operation.id, to: 'SUBMITTING' });

    const { commitment } = ledger.reservations.transition({
      orgId: org.id,
      operationId: operation.id,
      to: 'STATUS_UNKNOWN',
      reason: 'dispatch timed out — outcome genuinely ambiguous',
    });
    expect(commitment.state).toBe('unknown');
    expect(ledger.spendable.compute(org.id, 'USD').outstandingCommittedMinor).toBe(500_000);
    expect(ledger.spendable.compute(org.id, 'USD').spendableMinor).toBe(400_000);

    // Cancelling the unknown op without an attestation is refused (a timeout is not a resolution).
    try {
      ledger.reservations.transition({ orgId: org.id, operationId: operation.id, to: 'CANCELLED' });
      expect.unreachable('resolving STATUS_UNKNOWN requires an attestation');
    } catch (error) {
      expect((error as LedgerError).code).toBe('INVALID_TRANSITION');
      expect((error as LedgerError).message).toMatch(/requires an attestation/);
    }
    // And with a verified attestation it resolves — here to CANCELLED (provider proved non-execution).
    const resolved = ledger.reservations.transition({
      orgId: org.id,
      operationId: operation.id,
      to: 'CANCELLED',
      attestation: { source: 'provider-readback', note: 'provider confirms nothing executed' },
    });
    expect(resolved.commitment.state).toBe('released');
    ledger.close();
  });

  it('REQUIRES_HUMAN retains exposure as unknown', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = funded(ledger, clock);
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 500_000, currency: 'USD' });
    const { operation } = reserveCall(ledger, { org }, mission.id, ref, 'lc-human');
    ledger.reservations.transition({
      orgId: org.id,
      operationId: operation.id,
      to: 'REQUIRES_HUMAN',
      reason: 'provider error',
    });
    expect(ledger.spendable.compute(org.id, 'USD').outstandingCommittedMinor).toBe(500_000);
    ledger.close();
  });

  it('settlement keeps consuming until a NEWER balance snapshot observes it', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = funded(ledger, clock);
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 400_000, currency: 'USD' });
    const { operation } = reserveCall(ledger, { org }, mission.id, ref, 'lc-settle');

    clock.advance(10_000);
    const { commitment } = ledger.reservations.transition({
      orgId: org.id,
      operationId: operation.id,
      to: 'SETTLED',
      attestation: { source: 'provider-readback' },
    });
    expect(commitment.state).toBe('settled');
    expect(commitment.finalizedAt).not.toBeNull();

    // Snapshot predates the settlement (observed 10s earlier): still consuming.
    let view = ledger.spendable.compute(org.id, 'USD');
    expect(view.outstandingCommittedMinor).toBe(400_000);
    expect(view.spendableMinor).toBe(500_000);

    // A newer snapshot that already reflects the money leaving the bank frees it.
    clock.advance(10_000);
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 600_000,
      source: 'airwallex-sandbox',
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    view = ledger.spendable.compute(org.id, 'USD');
    expect(view.outstandingCommittedMinor).toBe(0);
    expect(view.spendableMinor).toBe(500_000);
    ledger.close();
  });

  it('every state change is journaled with a unique event key', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = funded(ledger, clock);
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 1_000, currency: 'USD' });
    const { operation } = reserveCall(ledger, { org }, mission.id, ref, 'lc-journal');
    ledger.reservations.transition({ orgId: org.id, operationId: operation.id, to: 'CANCELLED' });

    const types = ledger.evidence.list(org.id, { topic: 'financial' }).map((e) => e.type);
    expect(types).toContain('operation.reserved');
    expect(types).toContain('operation.cancelled');
    ledger.close();
  });
});
