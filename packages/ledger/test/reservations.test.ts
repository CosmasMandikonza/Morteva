import { describe, expect, it } from 'vitest';
import { type LedgerError } from '../src/index.js';
import { approvedPlan, makeLedger, reserveCall } from './helpers.js';

function fundedOrg(
  ledger: ReturnType<typeof makeLedger>['ledger'],
  clock: ReturnType<typeof makeLedger>['clock'],
  balance = 1_000_000,
  floor = 100_000,
) {
  const org = ledger.organizations.createOrganization('Org');
  const mission = ledger.organizations.createMission(org.id, 'm');
  ledger.accounts.ensureTreasuryAccount({
    orgId: org.id,
    currency: 'USD',
    label: 'USD',
    protectedFloorMinor: floor,
  });
  ledger.accounts.recordBalanceSnapshot({
    orgId: org.id,
    currency: 'USD',
    minorUnits: balance,
    source: 'manual-seed',
    observedAt: clock.iso(),
    expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
  });
  ledger.mandates.issue({
    orgId: org.id,
    missionId: mission.id,
    currency: 'USD',
    maxAmountMinor: 10_000_000,
    permittedOperationKinds: ['airwallex_transfer', 'metal_order', 'internal_hold'],
    expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
  });
  return { org, mission };
}

describe('reservation — spendable math and atomicity', () => {
  it('fails closed for Metal token orders until a distinct token-asset ledger exists', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = fundedOrg(ledger, clock);
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 10_000, currency: 'USD' });
    expect(() => reserveCall(ledger, { org }, mission.id, ref, 'no-fiat-bridge', 'metal_order'))
      .toThrowError(/Metal token orders require a separate/);
    const rows = ledger.db.prepare('SELECT COUNT(*) AS c FROM operations').get() as { c: number };
    expect(rows.c).toBe(0);
    expect(ledger.spendable.compute(org.id, 'USD').spendableMinor).toBe(900_000);
    ledger.close();
  });

  it('reserves within spendable and exposes the exact breakdown', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = fundedOrg(ledger, clock);
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 400_000, currency: 'USD' });
    const result = reserveCall(ledger, { org }, mission.id, ref, 'rq-1');

    expect(result.duplicate).toBe(false);
    expect(result.operation.state).toBe('RESERVED');
    expect(result.commitment.state).toBe('reserved');
    expect(result.spendableBefore).toBe(900_000);
    expect(result.spendableAfter).toBe(500_000);

    const view = ledger.spendable.compute(org.id, 'USD');
    expect(view.outstandingCommittedMinor).toBe(400_000);
    expect(view.spendableMinor).toBe(500_000);
    ledger.close();
  });

  it('rejects a reservation that exceeds spendable with the full math in the error', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = fundedOrg(ledger, clock);
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 900_001, currency: 'USD' });
    try {
      reserveCall(ledger, { org }, mission.id, ref, 'rq-too-much');
      expect.unreachable('over-spendable reserve must fail');
    } catch (error) {
      expect((error as LedgerError).code).toBe('INSUFFICIENT_SPENDABLE');
      expect((error as LedgerError).message).toMatch(
        /balance 1000000 − floor 100000 − outstanding 0/,
      );
    }
    // Nothing was committed by the failure.
    expect(ledger.spendable.compute(org.id, 'USD').spendableMinor).toBe(900_000);
    ledger.close();
  });

  it('two sequential reservations share the pool without overcommitting', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = fundedOrg(ledger, clock);
    const a = approvedPlan(ledger, org.id, mission.id, { amountMinor: 600_000, currency: 'USD' });
    reserveCall(ledger, { org }, mission.id, a, 'rq-a');

    const b = approvedPlan(ledger, org.id, mission.id, { amountMinor: 600_000, currency: 'USD' });
    try {
      reserveCall(ledger, { org }, mission.id, b, 'rq-b');
      expect.unreachable('second 600k must not fit');
    } catch (error) {
      expect((error as LedgerError).code).toBe('INSUFFICIENT_SPENDABLE');
    }
    const c = approvedPlan(ledger, org.id, mission.id, { amountMinor: 300_000, currency: 'USD' });
    expect(reserveCall(ledger, { org }, mission.id, c, 'rq-c').spendableAfter).toBe(0);
    ledger.close();
  });

  it('protected floor is never spendable', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = fundedOrg(ledger, clock, 100_000, 100_000);
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 1, currency: 'USD' });
    try {
      reserveCall(ledger, { org }, mission.id, ref, 'rq-floor');
      expect.unreachable('floor-only balance must not be spendable');
    } catch (error) {
      expect((error as LedgerError).code).toBe('INSUFFICIENT_SPENDABLE');
    }
    ledger.close();
  });

  it('rejects zero/negative/float amounts and unsupported currencies through plan terms', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = fundedOrg(ledger, clock);
    for (const bad of [0, -5]) {
      try {
        approvedPlan(ledger, org.id, mission.id, { amountMinor: bad, currency: 'USD' });
        expect.unreachable(`amount ${String(bad)} must be rejected`);
      } catch (error) {
        expect((error as LedgerError).code).toBe('INVALID_AMOUNT');
      }
    }
    try {
      approvedPlan(ledger, org.id, mission.id, { amountMinor: 12.5, currency: 'USD' });
      expect.unreachable('float amount must be rejected');
    } catch (error) {
      // Rejected by the domain Money guard (createMoney) inside term validation.
      expect((error as Error).message).toMatch(/must be an integer/);
    }
    try {
      approvedPlan(ledger, org.id, mission.id, { amountMinor: 100, currency: 'XXX' });
      expect.unreachable('unsupported currency must be rejected at plan time');
    } catch (error) {
      expect(String(error)).toMatch(/not in the supported table/);
    }
    ledger.close();
  });

  it('overflow attempts are refused, never silently truncated', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('OrgOverflow');
    const mission = ledger.organizations.createMission(org.id, 'm');
    const maxSafe = Number.MAX_SAFE_INTEGER;
    ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'USD',
      label: 'USD',
      protectedFloorMinor: 0,
    });
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: maxSafe,
      source: 'manual-seed',
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    ledger.mandates.issue({
      orgId: org.id,
      missionId: mission.id,
      currency: 'USD',
      maxAmountMinor: maxSafe,
      permittedOperationKinds: ['airwallex_transfer'],
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: maxSafe, currency: 'USD' });
    const first = reserveCall(ledger, { org }, mission.id, ref, 'rq-huge');
    expect(first.operation.amountMinor).toBe(maxSafe);
    expect(ledger.spendable.compute(org.id, 'USD').spendableMinor).toBe(0);

    const second = approvedPlan(ledger, org.id, mission.id, {
      amountMinor: maxSafe,
      currency: 'USD',
    });
    try {
      reserveCall(ledger, { org }, mission.id, second, 'rq-huge-2');
      expect.unreachable('second MAX_SAFE reservation must fail');
    } catch (error) {
      expect((error as LedgerError).code).toBe('INSUFFICIENT_SPENDABLE');
    }
    expect(ledger.spendable.compute(org.id, 'USD').overcommitted).toBe(false);
    ledger.close();
  });

  it('inactive missions cannot reserve', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = fundedOrg(ledger, clock);
    ledger.db.prepare(`UPDATE missions SET status = 'archived' WHERE id = ?`).run(mission.id);
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 100, currency: 'USD' });
    try {
      reserveCall(ledger, { org }, mission.id, ref, 'rq-archived');
      expect.unreachable('archived mission must not reserve');
    } catch (error) {
      expect((error as LedgerError).code).toBe('MISSION_INACTIVE');
    }
    ledger.close();
  });

  it('an external spend that leaves commitments over the balance halts new spending (OVERCOMMITTED)', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = fundedOrg(ledger, clock);
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 500_000, currency: 'USD' });
    reserveCall(ledger, { org }, mission.id, ref, 'rq-1');

    // A newer snapshot shows the wallet was drained externally below our commitments.
    clock.advance(1_000);
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 200_000,
      source: 'airwallex-sandbox',
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const view = ledger.spendable.compute(org.id, 'USD');
    expect(view.overcommitted).toBe(true);
    expect(view.spendableMinor).toBe(0);

    const ref2 = approvedPlan(ledger, org.id, mission.id, { amountMinor: 10, currency: 'USD' });
    try {
      reserveCall(ledger, { org }, mission.id, ref2, 'rq-overcommitted');
      expect.unreachable('overcommitted org must not spend');
    } catch (error) {
      expect((error as LedgerError).code).toBe('OVERCOMMITTED');
    }
    ledger.close();
  });
});

describe('idempotency — durable economic identity', () => {
  it('the same requestId with identical terms returns the SAME operation (no double commitment)', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = fundedOrg(ledger, clock);
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 100_000, currency: 'USD' });

    const first = reserveCall(ledger, { org }, mission.id, ref, 'idem-1');
    const second = reserveCall(ledger, { org }, mission.id, ref, 'idem-1');
    expect(second.duplicate).toBe(true);
    expect(second.operation.id).toBe(first.operation.id);
    expect(ledger.spendable.compute(org.id, 'USD').outstandingCommittedMinor).toBe(100_000);

    const commitmentRows = ledger.db
      .prepare('SELECT COUNT(*) AS c FROM commitments WHERE operation_id = ?')
      .get(first.operation.id) as { c: number };
    expect(commitmentRows.c).toBe(1);
    ledger.close();
  });

  it('the same requestId with DIFFERENT terms is a hard conflict', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = fundedOrg(ledger, clock);
    const a = approvedPlan(ledger, org.id, mission.id, { amountMinor: 100_000, currency: 'USD' });
    const b = approvedPlan(ledger, org.id, mission.id, {
      amountMinor: 100_000,
      currency: 'USD',
      beneficiary: 'someone-else',
    });
    reserveCall(ledger, { org }, mission.id, a, 'shared-id');
    try {
      reserveCall(ledger, { org }, mission.id, b, 'shared-id');
      expect.unreachable('same requestId with different terms must conflict');
    } catch (error) {
      expect((error as LedgerError).code).toBe('IDEMPOTENCY_CONFLICT');
      expect((error as LedgerError).message).toMatch(/DIFFERENT economic operation/);
    }
    ledger.close();
  });

  it('the same terms under different requestIds are two distinct intents (both must fit spendable)', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = fundedOrg(ledger, clock, 700_000, 100_000);
    const a = approvedPlan(ledger, org.id, mission.id, { amountMinor: 500_000, currency: 'USD' });
    const b = approvedPlan(ledger, org.id, mission.id, { amountMinor: 500_000, currency: 'USD' });
    reserveCall(ledger, { org }, mission.id, a, 'intent-1');
    try {
      reserveCall(ledger, { org }, mission.id, b, 'intent-2');
      expect.unreachable('two intents must share the same spendable pool');
    } catch (error) {
      expect((error as LedgerError).code).toBe('INSUFFICIENT_SPENDABLE');
    }
    ledger.close();
  });
});
