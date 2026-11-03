import { describe, expect, it } from 'vitest';
import { type LedgerError } from '../src/index.js';
import { approvedPlan, ensureApprover, makeLedger, reserveCall } from './helpers.js';

describe('tenant scoping and immutable authority issuance', () => {
  it('prevents cross-organization missions, forged plans and invalid authorization expiry', () => {
    const { ledger, clock } = makeLedger();
    const a = ledger.organizations.createOrganization('Tenant A');
    const b = ledger.organizations.createOrganization('Tenant B');
    const missionA = ledger.organizations.createMission(a.id, 'A');
    const approverA = ensureApprover(ledger, a.id);
    const future = new Date(clock.now().getTime() + 60_000).toISOString();
    expect(() =>
      ledger.mandates.issue({
        orgId: b.id,
        missionId: missionA.id,
        currency: 'USD',
        maxAmountMinor: 10_000,
        permittedOperationKinds: ['airwallex_transfer'],
        expiresAt: future,
      }),
    ).toThrowError(/does not belong to organization/);
    const terms = {
      amountMinor: 10_000,
      currency: 'USD',
      beneficiary: 'supplier',
      purpose: 'inspection',
    };
    expect(() =>
      ledger.plans.recordVersion({
        orgId: b.id,
        missionId: missionA.id,
        terms,
      }),
    ).toThrowError(/does not belong to organization/);
    const planA = ledger.plans.recordVersion({ orgId: a.id, missionId: missionA.id, terms });
    expect(() =>
      ledger.approvals.record({
        orgId: b.id,
        plan: planA,
        decidedByActorId: approverA.id,
        kind: 'airwallex_transfer',
        expiresAt: future,
      }),
    ).toThrowError(/belongs to another organization/);
    expect(() =>
      ledger.approvals.record({
        orgId: a.id,
        plan: { ...planA, terms: { ...terms, amountMinor: 25_000 } },
        decidedByActorId: approverA.id,
        kind: 'airwallex_transfer',
        expiresAt: future,
      }),
    ).toThrowError(/exact persisted, untampered plan/);
    expect(() =>
      ledger.approvals.record({
        orgId: a.id,
        plan: planA,
        decidedByActorId: approverA.id,
        kind: 'airwallex_transfer',
        expiresAt: 'not-a-date',
      }),
    ).toThrowError(/valid future date/);
    ledger.close();
  });
});

describe('mandates', () => {
  it('issues versioned mandates and supersedes previous versions', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('OrgM');
    const mission = ledger.organizations.createMission(org.id, 'm');
    const terms = {
      currency: 'USD',
      maxAmountMinor: 100_000,
      permittedOperationKinds: ['airwallex_transfer'],
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    };
    const v1 = ledger.mandates.issue({ orgId: org.id, missionId: mission.id, ...terms });
    expect(v1.version).toBe(1);
    const v2 = ledger.mandates.issue({
      orgId: org.id,
      missionId: mission.id,
      mandateId: v1.id,
      ...terms,
      maxAmountMinor: 50_000,
    });
    expect(v2.version).toBe(2);
    expect(v2.maxAmountMinor).toBe(50_000);
    const latest = ledger.mandates.latest(org.id, mission.id, v1.id);
    expect(latest.version).toBe(2);
    // The active mandate for reservations is the newest active version.
    expect(ledger.mandates.activeFor(org.id, mission.id, clock.now()).maxAmountMinor).toBe(50_000);
    ledger.close();
  });

  it('expired mandates never authorize (even if newest)', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('OrgN');
    const mission = ledger.organizations.createMission(org.id, 'm');
    ledger.mandates.issue({
      orgId: org.id,
      missionId: mission.id,
      currency: 'USD',
      maxAmountMinor: 10_000,
      permittedOperationKinds: ['airwallex_transfer'],
      expiresAt: new Date(clock.now().getTime() + 1_000).toISOString(),
    });
    clock.advance(2_000);
    try {
      ledger.mandates.activeFor(org.id, mission.id, clock.now());
      expect.unreachable('expired mandate must not authorize');
    } catch (error) {
      expect((error as LedgerError).code).toBe('MANDATE_EXPIRED');
    }
    ledger.close();
  });

  it('rejects malformed mandate terms at issuance', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('OrgO');
    const mission = ledger.organizations.createMission(org.id, 'm');
    const base = {
      orgId: org.id,
      missionId: mission.id,
      currency: 'USD',
      permittedOperationKinds: ['airwallex_transfer'],
    };
    expect(() =>
      ledger.mandates.issue({
        ...base,
        maxAmountMinor: 0,
        expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
      }),
    ).toThrowError(/must be positive/);
    expect(() =>
      ledger.mandates.issue({
        ...base,
        maxAmountMinor: 100,
        expiresAt: new Date(clock.now().getTime() - 60_000).toISOString(),
      }),
    ).toThrowError(/expiry must be in the future/);
    ledger.close();
  });
});

describe('plans and approvals — exact-term binding', () => {
  function orgWithFundedUsdMission(
    ledger: ReturnType<typeof makeLedger>['ledger'],
    clock: ReturnType<typeof makeLedger>['clock'],
  ) {
    const org = ledger.organizations.createOrganization('FundedOrg');
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
    return { org, mission };
  }

  it('a changed plan version gets a new digest and the old approval cannot authorize it', () => {
    const { ledger, clock } = makeLedger();
    const { org, mission } = orgWithFundedUsdMission(ledger, clock);
    const approver = ensureApprover(ledger, org.id);

    const v1 = ledger.plans.recordVersion({
      orgId: org.id,
      missionId: mission.id,
      terms: { amountMinor: 100_000, currency: 'USD', beneficiary: 'vendor-a', purpose: 'repair' },
    });
    const approvalV1 = ledger.approvals.record({
      orgId: org.id,
      plan: v1,
      decidedByActorId: approver.id,
      kind: 'airwallex_transfer',
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });

    // Same plan id, changed beneficiary -> v2, different digest.
    const v2 = ledger.plans.recordVersion({
      orgId: org.id,
      missionId: mission.id,
      planId: v1.id,
      terms: {
        amountMinor: 100_000,
        currency: 'USD',
        beneficiary: 'ATTACKER-DIFFERENT',
        purpose: 'repair',
      },
    });
    expect(v2.digest).not.toBe(v1.digest);
    expect(v2.version).toBe(2);

    try {
      ledger.reservations.reserve({
        orgId: org.id,
        missionId: mission.id,
        kind: 'airwallex_transfer',
        requestId: 'changed-terms-1',
        planId: v2.id,
        planVersion: v2.version,
        approvalId: approvalV1.id,
      });
      expect.unreachable('old approval must not authorize changed terms');
    } catch (error) {
      expect((error as LedgerError).code).toBe('APPROVAL_TERMS_MISMATCH');
      expect((error as LedgerError).message).toMatch(/beneficiary/);
    }
    ledger.close();
  });

  it('consumed and expired approvals are rejected', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('OrgQ');
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

    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 10_000, currency: 'USD' });
    reserveCall(ledger, { org }, mission.id, ref, 'consume-1');
    try {
      reserveCall(ledger, { org }, mission.id, ref, 'consume-2-different-request');
      expect.unreachable('consumed approval must be rejected');
    } catch (error) {
      expect((error as LedgerError).code).toBe('APPROVAL_CONSUMED');
    }

    const expiringRef = approvedPlan(
      ledger,
      org.id,
      mission.id,
      { amountMinor: 10_000, currency: 'USD' },
      { ttlMs: 1_000 },
    );
    clock.advance(2_000);
    try {
      reserveCall(ledger, { org }, mission.id, expiringRef, 'expired-approval');
      expect.unreachable('expired approval must be rejected');
    } catch (error) {
      expect((error as LedgerError).code).toBe('APPROVAL_EXPIRED');
    }
    ledger.close();
  });

  it('tampered plan terms (digest mismatch) are refused', () => {
    const { ledger } = makeLedger();
    const org = ledger.organizations.createOrganization('OrgR');
    const mission = ledger.organizations.createMission(org.id, 'm');
    const plan = ledger.plans.recordVersion({
      orgId: org.id,
      missionId: mission.id,
      terms: { amountMinor: 100, currency: 'USD', beneficiary: 'b', purpose: 'p' },
    });
    // Corrupt the stored terms without updating the digest.
    ledger.db
      .prepare('UPDATE candidate_plans SET terms_json = ? WHERE id = ? AND version = ?')
      .run(
        JSON.stringify({ amountMinor: 999_999, currency: 'USD', beneficiary: 'b', purpose: 'p' }),
        plan.id,
        plan.version,
      );
    try {
      const loaded = ledger.plans.getVersion(org.id, mission.id, plan.id, plan.version);
      ledger.plans.verifyIntegrity(loaded);
      expect.unreachable('tampered terms must be detected');
    } catch (error) {
      expect((error as LedgerError).code).toBe('PLAN_DIGEST_MISMATCH');
    }
    ledger.close();
  });

  it('mandate currency/kind ceilings are enforced at reservation time', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('OrgS');
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
        minorUnits: 1_000_000,
        source: 'manual-seed',
        observedAt: clock.iso(),
        expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
      });
    }
    ledger.mandates.issue({
      orgId: org.id,
      missionId: mission.id,
      currency: 'USD',
      maxAmountMinor: 50_000,
      permittedOperationKinds: ['airwallex_transfer'], // metal_order NOT permitted
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });

    // Approvals themselves cannot be issued without an active mandate
    // in the plan's currency; reject the mismatch before reservation.
    expect(() =>
      approvedPlan(ledger, org.id, mission.id, {
        amountMinor: 1_000,
        currency: 'JPY',
      }),
    ).toThrowError(/no active mandate/);

    const tooBig = approvedPlan(ledger, org.id, mission.id, {
      amountMinor: 60_000,
      currency: 'USD',
    });
    try {
      reserveCall(ledger, { org }, mission.id, tooBig, 'over-mandate-max');
      expect.unreachable('over-max plan must be rejected');
    } catch (error) {
      expect((error as LedgerError).code).toBe('MANDATE_AMOUNT_EXCEEDS_MAX');
    }

    const metalRef = approvedPlan(
      ledger,
      org.id,
      mission.id,
      { amountMinor: 1_000, currency: 'USD' },
      { kind: 'metal_order' },
    );
    try {
      reserveCall(ledger, { org }, mission.id, metalRef, 'forbidden-kind', 'metal_order');
      expect.unreachable('forbidden kind must be rejected');
    } catch (error) {
      expect((error as LedgerError).code).toBe('MANDATE_KIND_FORBIDDEN');
    }
    ledger.close();
  });
});
