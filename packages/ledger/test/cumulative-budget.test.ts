import { describe, expect, it } from 'vitest';
import { type LedgerError } from '../src/index.js';
import { approvedPlan, ensureApprover, makeLedger, reserveCall } from './helpers.js';

/**
 * Issue #7 Phase 3: cumulative mission/mandate spending envelopes.
 * The defining attack: N individually under-cap payments must NOT bypass the
 * total budget. Settled payments consume the envelope for the mandate's
 * lifetime — a fresh provider balance snapshot frees treasury float, never
 * authority.
 */

function fundedMission(
  ledger: ReturnType<typeof makeLedger>['ledger'],
  clock: ReturnType<typeof makeLedger>['clock'],
  mandate?: {
    maxAmountMinor?: number;
    totalBudgetMinor?: number;
    allowedBeneficiaries?: string[];
    allowedPurposes?: string[];
  },
) {
  const org = ledger.organizations.createOrganization('BudgetOrg');
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
    minorUnits: 1_000_000_000,
    source: 'manual-seed',
    observedAt: clock.iso(),
    expiresAt: new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(),
  });
  const issued = ledger.mandates.issue({
    orgId: org.id,
    missionId: mission.id,
    currency: 'USD',
    maxAmountMinor: mandate?.maxAmountMinor ?? 10_000,
    totalBudgetMinor: mandate?.totalBudgetMinor ?? 30_000,
    permittedOperationKinds: ['airwallex_transfer'],
    allowedBeneficiaries: mandate?.allowedBeneficiaries ?? [],
    allowedPurposes: mandate?.allowedPurposes ?? [],
    expiresAt: new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(),
  });
  return { org, mission, mandate: issued };
}

describe('cumulative mandate budgets', () => {
  it('a NEW mandate ID cannot reset a mission/currency cumulative spend envelope', () => {
    const { ledger, clock } = makeLedger();
    const ctx = fundedMission(ledger, clock, { maxAmountMinor: 10_000, totalBudgetMinor: 30_000 });
    for (let i = 0; i < 3; i += 1) {
      const ref = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
        amountMinor: 10_000,
        currency: 'USD',
      });
      reserveCall(ledger, { org: ctx.org }, ctx.mission.id, ref, `before-new-id-${i}`);
    }
    const freshIdentity = ledger.mandates.issue({
      orgId: ctx.org.id,
      missionId: ctx.mission.id,
      currency: 'USD',
      maxAmountMinor: 10_000,
      totalBudgetMinor: 30_000,
      permittedOperationKinds: ['airwallex_transfer'],
      expiresAt: new Date(clock.now().getTime() + 86_400_000).toISOString(),
    });
    expect(freshIdentity.id).not.toBe(ctx.mandate.id);
    expect(ledger.mandates.latest(ctx.org.id, ctx.mission.id, ctx.mandate.id).status).toBe(
      'superseded',
    );
    expect(ledger.mandates.consumedBudget(ctx.org.id, freshIdentity.id)).toBe(0);
    expect(ledger.mandates.consumedMissionBudget(ctx.org.id, ctx.mission.id, 'USD')).toBe(30_000);
    const ref = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 1,
      currency: 'USD',
    });
    expect(() =>
      reserveCall(ledger, { org: ctx.org }, ctx.mission.id, ref, 'new-id-bypass'),
    ).toThrowError(/cumulative mission budget exceeded/);
    ledger.close();
  });

  it('ten under-cap payments cannot bypass the total envelope: the 4th of a 3× budget is denied', () => {
    const { ledger, clock } = makeLedger();
    const ctx = fundedMission(ledger, clock, { maxAmountMinor: 10_000, totalBudgetMinor: 30_000 });
    for (let i = 1; i <= 3; i += 1) {
      const ref = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
        amountMinor: 10_000,
        currency: 'USD',
      });
      const result = reserveCall(ledger, { org: ctx.org }, ctx.mission.id, ref, `slice-${i}`);
      expect(result.duplicate).toBe(false);
      const status = ledger.mandates.budgetStatus(ctx.org.id, ctx.mission.id, ctx.mandate.id);
      expect(status.consumedMinor).toBe(10_000 * i);
      expect(status.remainingMinor).toBe(30_000 - 10_000 * i);
    }
    const fourth = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 10_000,
      currency: 'USD',
    });
    try {
      reserveCall(ledger, { org: ctx.org }, ctx.mission.id, fourth, 'slice-4');
      expect.unreachable('cumulative envelope must deny the fourth payment');
    } catch (error) {
      expect((error as LedgerError).code).toBe('MANDATE_BUDGET_EXCEEDED');
      expect((error as LedgerError).message).toMatch(
        /consumed 30000 \+ requested 10000 > envelope 30000/,
      );
    }
    ledger.close();
  });

  it('a partially-consumed envelope still allows a smaller final payment within the remainder', () => {
    const { ledger, clock } = makeLedger();
    const ctx = fundedMission(ledger, clock, { maxAmountMinor: 10_000, totalBudgetMinor: 25_000 });
    reserveCall(
      ledger,
      { org: ctx.org },
      ctx.mission.id,
      approvedPlan(ledger, ctx.org.id, ctx.mission.id, { amountMinor: 10_000, currency: 'USD' }),
      'a',
    );
    reserveCall(
      ledger,
      { org: ctx.org },
      ctx.mission.id,
      approvedPlan(ledger, ctx.org.id, ctx.mission.id, { amountMinor: 10_000, currency: 'USD' }),
      'b',
    );
    const ref = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 5_000,
      currency: 'USD',
    });
    expect(
      reserveCall(ledger, { org: ctx.org }, ctx.mission.id, ref, 'c').operation.amountMinor,
    ).toBe(5_000);
    const over = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 1,
      currency: 'USD',
    });
    try {
      reserveCall(ledger, { org: ctx.org }, ctx.mission.id, over, 'd');
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).code).toBe('MANDATE_BUDGET_EXCEEDED');
    }
    ledger.close();
  });

  it('SETTLED payments still consume the mandate envelope even after a fresh balance snapshot', () => {
    const { ledger, clock } = makeLedger();
    const ctx = fundedMission(ledger, clock, { maxAmountMinor: 10_000, totalBudgetMinor: 10_000 });
    const { operation } = reserveCall(
      ledger,
      { org: ctx.org },
      ctx.mission.id,
      approvedPlan(ledger, ctx.org.id, ctx.mission.id, { amountMinor: 10_000, currency: 'USD' }),
      'settle-me',
    );
    // Provider-verified settlement with readback attestation.
    ledger.reservations.transition({
      orgId: ctx.org.id,
      operationId: operation.id,
      to: 'SETTLED',
      attestation: { source: 'provider-readback' },
    });
    // A NEWER snapshot reflects the money leaving the treasury — treasury
    // spendable recovers, but the mandate envelope stays consumed forever.
    clock.advance(60_000);
    ledger.accounts.recordBalanceSnapshot({
      orgId: ctx.org.id,
      currency: 'USD',
      minorUnits: 990_000_000,
      source: 'airwallex-sandbox',
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    expect(ledger.spendable.compute(ctx.org.id, 'USD').outstandingCommittedMinor).toBe(0);
    const status = ledger.mandates.budgetStatus(ctx.org.id, ctx.mission.id, ctx.mandate.id);
    expect(status.consumedMinor).toBe(10_000);
    expect(status.remainingMinor).toBe(0);
    const ref = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 1,
      currency: 'USD',
    });
    try {
      reserveCall(ledger, { org: ctx.org }, ctx.mission.id, ref, 'after-settle');
      expect.unreachable('settled spend must still consume authority');
    } catch (error) {
      expect((error as LedgerError).code).toBe('MANDATE_BUDGET_EXCEEDED');
    }
    ledger.close();
  });

  it('CANCELLED (never-executed) operations release envelope budget; UNKNOWN and REQUIRES_HUMAN retain it', () => {
    const { ledger, clock } = makeLedger();
    const ctx = fundedMission(ledger, clock, { maxAmountMinor: 10_000, totalBudgetMinor: 10_000 });
    const first = reserveCall(
      ledger,
      { org: ctx.org },
      ctx.mission.id,
      approvedPlan(ledger, ctx.org.id, ctx.mission.id, { amountMinor: 6_000, currency: 'USD' }),
      'will-cancel',
    );
    ledger.reservations.transition({
      orgId: ctx.org.id,
      operationId: first.operation.id,
      to: 'CANCELLED',
      reason: 'operator cancelled before dispatch',
    });
    expect(ledger.mandates.consumedBudget(ctx.org.id, ctx.mandate.id)).toBe(0); // released

    const second = reserveCall(
      ledger,
      { org: ctx.org },
      ctx.mission.id,
      approvedPlan(ledger, ctx.org.id, ctx.mission.id, { amountMinor: 6_000, currency: 'USD' }),
      'will-go-unknown',
    );
    ledger.reservations.transition({
      orgId: ctx.org.id,
      operationId: second.operation.id,
      to: 'SUBMITTING',
    });
    ledger.reservations.transition({
      orgId: ctx.org.id,
      operationId: second.operation.id,
      to: 'STATUS_UNKNOWN',
      reason: 'timeout',
    });
    expect(ledger.mandates.consumedBudget(ctx.org.id, ctx.mandate.id)).toBe(6_000); // unknown retains
    ledger.reservations.transition({
      orgId: ctx.org.id,
      operationId: second.operation.id,
      to: 'REQUIRES_HUMAN',
      attestation: { source: 'operator-action', note: 'escalated' },
      reason: 'escalate',
    });
    expect(ledger.mandates.consumedBudget(ctx.org.id, ctx.mandate.id)).toBe(6_000); // escalated retains
    ledger.close();
  });

  it('same payee/amount under different requestIds counts twice; the same requestId never counts twice', () => {
    const { ledger, clock } = makeLedger();
    const ctx = fundedMission(ledger, clock, { maxAmountMinor: 10_000, totalBudgetMinor: 15_000 });
    const ref = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 10_000,
      currency: 'USD',
    });
    reserveCall(ledger, { org: ctx.org }, ctx.mission.id, ref, 'idempotent-1');
    const duplicate = reserveCall(ledger, { org: ctx.org }, ctx.mission.id, ref, 'idempotent-1');
    expect(duplicate.duplicate).toBe(true);
    expect(ledger.mandates.consumedBudget(ctx.org.id, ctx.mandate.id)).toBe(10_000); // counted once

    const ref2 = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 10_000,
      currency: 'USD',
    });
    try {
      reserveCall(ledger, { org: ctx.org }, ctx.mission.id, ref2, 'distinct-intent');
      expect.unreachable('distinct intent with same economics must hit the envelope');
    } catch (error) {
      expect((error as LedgerError).code).toBe('MANDATE_BUDGET_EXCEEDED');
    }
    ledger.close();
  });

  it('different organizations never share budgets (per-org mandate identities)', () => {
    const { ledger, clock } = makeLedger();
    const a = fundedMission(ledger, clock, { maxAmountMinor: 10_000, totalBudgetMinor: 10_000 });
    const b = fundedMission(ledger, clock, { maxAmountMinor: 10_000, totalBudgetMinor: 10_000 });
    reserveCall(
      ledger,
      { org: a.org },
      a.mission.id,
      approvedPlan(ledger, a.org.id, a.mission.id, { amountMinor: 10_000, currency: 'USD' }),
      'a-1',
    );
    expect(() =>
      reserveCall(
        ledger,
        { org: a.org },
        a.mission.id,
        approvedPlan(ledger, a.org.id, a.mission.id, { amountMinor: 1, currency: 'USD' }),
        'a-2',
      ),
    ).toThrowError(/budget/);
    // Org B's identical-shaped mandate is untouched.
    expect(
      reserveCall(
        ledger,
        { org: b.org },
        b.mission.id,
        approvedPlan(ledger, b.org.id, b.mission.id, { amountMinor: 10_000, currency: 'USD' }),
        'b-1',
      ).duplicate,
    ).toBe(false);
    ledger.close();
  });

  it('revoked and expired mandates refuse new reservations with distinct machine codes', () => {
    const { ledger, clock } = makeLedger();
    const ctx = fundedMission(ledger, clock, { maxAmountMinor: 10_000, totalBudgetMinor: 10_000 });
    ledger.mandates.revoke(ctx.org.id, ctx.mission.id, ctx.mandate.id, 'admin', 'rotation');
    try {
      reserveCall(
        ledger,
        { org: ctx.org },
        ctx.mission.id,
        approvedPlan(ledger, ctx.org.id, ctx.mission.id, { amountMinor: 100, currency: 'USD' }),
        'post-revoke',
      );
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).code).toBe('MANDATE_REVOKED');
    }

    const ctx2 = fundedMission(ledger, clock, { maxAmountMinor: 10_000, totalBudgetMinor: 10_000 });
    clock.advance(25 * 3_600_000); // past the 24h mandate window
    try {
      reserveCall(
        ledger,
        { org: ctx2.org },
        ctx2.mission.id,
        approvedPlan(ledger, ctx2.org.id, ctx2.mission.id, { amountMinor: 100, currency: 'USD' }),
        'post-expiry',
      );
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).code).toBe('MANDATE_EXPIRED');
    }
    ledger.close();
  });

  it('beneficiary and purpose allowlists are enforced at reservation', () => {
    const { ledger, clock } = makeLedger();
    const ctx = fundedMission(ledger, clock, {
      maxAmountMinor: 10_000,
      totalBudgetMinor: 50_000,
      allowedBeneficiaries: ['trusted-vendor'],
      allowedPurposes: ['inspection'],
    });
    const evil = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 1_000,
      currency: 'USD',
      beneficiary: 'ATTACKER-SWAPPED',
    });
    try {
      reserveCall(ledger, { org: ctx.org }, ctx.mission.id, evil, 'ben-1');
      expect.unreachable('beneficiary swap after approval of different terms must fail');
    } catch (error) {
      expect((error as LedgerError).code).toBe('BENEFICIARY_NOT_ALLOWED');
    }
    const wrongPurpose = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 1_000,
      currency: 'USD',
      beneficiary: 'trusted-vendor',
      purpose: 'off-books-gift',
    });
    try {
      reserveCall(ledger, { org: ctx.org }, ctx.mission.id, wrongPurpose, 'pur-1');
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).code).toBe('PURPOSE_NOT_ALLOWED');
    }
    const ok = approvedPlan(ledger, ctx.org.id, ctx.mission.id, {
      amountMinor: 1_000,
      currency: 'USD',
      beneficiary: 'trusted-vendor',
      purpose: 'inspection',
    });
    expect(reserveCall(ledger, { org: ctx.org }, ctx.mission.id, ok, 'ben-ok').duplicate).toBe(
      false,
    );
    ledger.close();
  });

  it('an envelope smaller than the per-operation max is rejected at issuance', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('BadEnvOrg');
    const mission = ledger.organizations.createMission(org.id, 'm');
    expect(() =>
      ledger.mandates.issue({
        orgId: org.id,
        missionId: mission.id,
        currency: 'USD',
        maxAmountMinor: 10_000,
        totalBudgetMinor: 5_000,
        permittedOperationKinds: ['airwallex_transfer'],
        expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
      }),
    ).toThrowError(/must be >= maxAmountMinor/);
    ledger.close();
  });

  it('superseding a mandate makes approvals bound to the previous version stale', () => {
    const { ledger, clock } = makeLedger();
    const ctx = fundedMission(ledger, clock, { maxAmountMinor: 10_000, totalBudgetMinor: 50_000 });
    const approver = ensureApprover(ledger, ctx.org.id);
    const plan = ledger.plans.recordVersion({
      orgId: ctx.org.id,
      missionId: ctx.mission.id,
      terms: { amountMinor: 5_000, currency: 'USD', beneficiary: 'b', purpose: 'p' },
    });
    const approval = ledger.approvals.record({
      orgId: ctx.org.id,
      plan,
      decidedByActorId: approver.id,
      kind: 'airwallex_transfer',
      mandateId: ctx.mandate.id,
      mandateVersion: ctx.mandate.version,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    // Re-issue v2 (e.g. larger envelope) — v1 approvals must not carry over.
    ledger.mandates.issue({
      orgId: ctx.org.id,
      missionId: ctx.mission.id,
      mandateId: ctx.mandate.id,
      currency: 'USD',
      maxAmountMinor: 10_000,
      totalBudgetMinor: 100_000,
      permittedOperationKinds: ['airwallex_transfer'],
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    try {
      ledger.reservations.reserve({
        orgId: ctx.org.id,
        missionId: ctx.mission.id,
        kind: 'airwallex_transfer',
        requestId: 'stale-after-supersede',
        planId: plan.id,
        planVersion: plan.version,
        approvalId: approval.id,
      });
      expect.unreachable('approval bound to superseded mandate version must be stale');
    } catch (error) {
      expect((error as LedgerError).code).toBe('APPROVAL_TERMS_MISMATCH');
      expect((error as LedgerError).message).toMatch(/v2 is active; the approval is stale/);
    }
    ledger.close();
  });

  it('mixed currencies cannot cross-fund: JPY treasury never backs a USD envelope or vice versa', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('MixoOrg');
    const mission = ledger.organizations.createMission(org.id, 'm');
    for (const currency of ['USD', 'JPY']) {
      ledger.accounts.ensureTreasuryAccount({
        orgId: org.id,
        currency,
        label: currency,
        protectedFloorMinor: 0,
      });
      ledger.accounts.recordBalanceSnapshot({
        orgId: org.id,
        currency,
        minorUnits: 100_000_000,
        source: 'manual-seed',
        observedAt: clock.iso(),
        expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
      });
      ledger.mandates.issue({
        orgId: org.id,
        missionId: mission.id,
        currency,
        maxAmountMinor: 50_000,
        totalBudgetMinor: 50_000,
        permittedOperationKinds: ['airwallex_transfer'],
        expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
      });
    }
    // A USD plan exhausts the USD envelope; the JPY envelope must not absorb it.
    const usdRef = approvedPlan(ledger, org.id, mission.id, {
      amountMinor: 50_000,
      currency: 'USD',
    });
    reserveCall(ledger, { org }, mission.id, usdRef, 'usd-1');
    const usdAgain = approvedPlan(ledger, org.id, mission.id, {
      amountMinor: 1_000,
      currency: 'USD',
    });
    try {
      reserveCall(ledger, { org }, mission.id, usdAgain, 'usd-2');
      expect.unreachable('USD envelope exhausted; JPY budget must not cover it');
    } catch (error) {
      expect((error as LedgerError).code).toBe('MANDATE_BUDGET_EXCEEDED');
    }
    // JPY is still fully available under its own envelope.
    const jpyRef = approvedPlan(ledger, org.id, mission.id, {
      amountMinor: 50_000,
      currency: 'JPY',
    });
    expect(reserveCall(ledger, { org }, mission.id, jpyRef, 'jpy-1').duplicate).toBe(false);
    ledger.close();
  });
});
