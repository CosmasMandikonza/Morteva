/**
 * Seed: two independent missions that compete over ONE funding pool —
 * the contention scenario from issue #4. Deterministic ids make the seeded
 * world addressable from tests and the demo script.
 */
import type { Ledger } from '../ledger.js';
import type {
  ApprovalView,
  CandidatePlanView,
  MandateView,
  MissionView,
  OrganizationView,
} from '@moterva/domain';

export interface SeededCompetingWorld {
  readonly org: OrganizationView;
  readonly currency: string;
  readonly missions: readonly [MissionView, MissionView];
  readonly mandates: readonly [MandateView, MandateView];
  /** A ready-to-reserve approved plan per mission with identical economics — the race inputs. */
  readonly approvedPlans: readonly [
    { plan: CandidatePlanView; approval: ApprovalView },
    { plan: CandidatePlanView; approval: ApprovalView },
  ];
  readonly balanceMinor: number;
  readonly protectedFloorMinor: number;
}

export interface SeedOptions {
  readonly orgName?: string;
  readonly currency?: string;
  readonly balanceMinor?: number;
  readonly protectedFloorMinor?: number;
  readonly planAmountMinor?: number;
  readonly snapshotTtlMs?: number;
  readonly approvalTtlMs?: number;
  readonly mandateTtlMs?: number;
}

export function seedCompetingMissions(
  ledger: Ledger,
  options: SeedOptions = {},
): SeededCompetingWorld {
  const currency = options.currency ?? 'USD';
  const balanceMinor = options.balanceMinor ?? 1_000_000;
  const protectedFloorMinor = options.protectedFloorMinor ?? 100_000;
  const planAmountMinor = options.planAmountMinor ?? 450_000;
  const now = ledger.clock.now();
  const ttl = (ms: number) => new Date(now.getTime() + ms).toISOString();

  const org = ledger.organizations.createOrganization(options.orgName ?? 'Contoso Field Robotics');
  const missionA = ledger.organizations.createMission(org.id, 'Turbine inspection — North ridge');
  const missionB = ledger.organizations.createMission(org.id, 'Conveyor repair — South plant');

  ledger.accounts.ensureTreasuryAccount({
    orgId: org.id,
    currency,
    label: `${currency} treasury`,
    protectedFloorMinor,
  });
  const snapshot = ledger.accounts.recordBalanceSnapshot({
    orgId: org.id,
    currency,
    minorUnits: balanceMinor,
    source: 'manual-seed',
    observedAt: now.toISOString(),
    expiresAt: ttl(options.snapshotTtlMs ?? 10 * 60_000),
  });

  const mandateTerms = {
    currency,
    maxAmountMinor: planAmountMinor,
    permittedOperationKinds: ['airwallex_transfer', 'metal_order', 'internal_hold'],
    expiresAt: ttl(options.mandateTtlMs ?? 60 * 60_000),
  };
  const mandateA = ledger.mandates.issue({
    orgId: org.id,
    missionId: missionA.id,
    ...mandateTerms,
  });
  const mandateB = ledger.mandates.issue({
    orgId: org.id,
    missionId: missionB.id,
    ...mandateTerms,
  });

  const approvedPlans = ([missionA, missionB] as const).map((mission) => {
    const plan = ledger.plans.recordVersion({
      orgId: org.id,
      missionId: mission.id,
      terms: {
        amountMinor: planAmountMinor,
        currency,
        beneficiary: 'acme-diagnostics',
        purpose: 'Diagnostic and repair services',
        quote: { kind: 'seeded', validUntil: ttl(30 * 60_000) },
      },
    });
    const approval = ledger.approvals.record({
      orgId: org.id,
      plan,
      decidedBy: 'seed:operator',
      expiresAt: ttl(options.approvalTtlMs ?? 30 * 60_000),
    });
    return { plan, approval };
  });

  return {
    org,
    currency,
    missions: [missionA, missionB],
    mandates: [mandateA, mandateB],
    approvedPlans: [
      approvedPlans[0] as { plan: CandidatePlanView; approval: ApprovalView },
      approvedPlans[1] as { plan: CandidatePlanView; approval: ApprovalView },
    ],
    balanceMinor: snapshot.minorUnits,
    protectedFloorMinor,
  };
}
