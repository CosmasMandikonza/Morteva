/**
 * Seed: two independent missions that compete over ONE funding pool —
 * the contention scenario from issue #4, now with a real persisted approver
 * actor (issue #7): approvals are granted by a verifiable identity, never a
 * freeform string.
 */
import type { Ledger } from '../ledger.js';
import type {
  ActorView,
  ApprovalView,
  CandidatePlanView,
  MandateView,
  MissionView,
  OrganizationView,
} from '@moterva/domain';

/** Development-only fixture credential. Never a secret; demo/test worlds only. */
export const SEED_APPROVER_PASSWORD = 'seed-approver-dev-only-password';

export interface SeededCompetingWorld {
  readonly org: OrganizationView;
  readonly currency: string;
  readonly missions: readonly [MissionView, MissionView];
  readonly mandates: readonly [MandateView, MandateView];
  /** Persisted human approver actor that granted the seeded approvals. */
  readonly approver: ActorView;
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

  const approver = ledger.authority.createHumanActor({
    orgId: org.id,
    username: 'seed-approver',
    displayName: 'Seeded Approver (dev)',
    role: 'approver',
    password: SEED_APPROVER_PASSWORD,
  });

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

  const mandates = [mandateA, mandateB] as const;
  const approvedPlans = ([missionA, missionB] as const).map((mission, index) => {
    const mandate = mandates[index] as MandateView;
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
      proposedBy: null,
    });
    const approval = ledger.approvals.record({
      orgId: org.id,
      plan,
      decidedByActorId: approver.id,
      kind: 'airwallex_transfer',
      mandateId: mandate.id,
      mandateVersion: mandate.version,
      expiresAt: ttl(options.approvalTtlMs ?? 30 * 60_000),
    });
    return { plan, approval };
  });

  return {
    org,
    currency,
    missions: [missionA, missionB],
    mandates: [mandateA, mandateB],
    approver,
    approvedPlans: [
      approvedPlans[0] as { plan: CandidatePlanView; approval: ApprovalView },
      approvedPlans[1] as { plan: CandidatePlanView; approval: ApprovalView },
    ],
    balanceMinor: snapshot.minorUnits,
    protectedFloorMinor,
  };
}
