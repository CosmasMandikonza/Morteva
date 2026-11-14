import type { FinancialFacts, FinancialPolicy, MissionEvidenceInput } from '../src/contracts.js';
import type { SupplierOffer } from '../src/candidates.js';

/** Fixed evaluation clock: everything deterministic. */
export const NOW = new Date('2026-11-06T08:00:00.000Z');

export const TENANT = { orgId: 'org_demo', missionId: 'mission_harbor' } as const;
export const ASSET = { id: 'rov-harbor-1', kind: 'underwater-rov' } as const;

export function basePolicy(overrides: Partial<FinancialPolicy> = {}): FinancialPolicy {
  return {
    version: 1,
    currency: 'USD',
    missionDeadlineAt: '2026-11-06T20:00:00.000Z',
    missionValueMinor: 5_000_000, // USD 50,000
    failureCostMinor: 1_500_000, // USD 15,000
    protectedReserveMinor: 200_000,
    maxProbabilityAssumption: 0.95,
    unconfirmedAvailabilityFactor: 0.5,
    diagnosticValueThreshold: 1.0,
    forbidUnconfirmedAvailability: false,
    escalationScoreGap: 10_000,
    ...overrides,
  };
}

export function baseFacts(overrides: Partial<FinancialFacts> = {}): FinancialFacts {
  return {
    orgId: TENANT.orgId,
    missionId: TENANT.missionId,
    currency: 'USD',
    balanceStatus: 'ok',
    balanceMinor: 8_000_000,
    spendableMinor: 8_000_000,
    outstandingCommittedMinor: 0,
    ambiguousCommittedMinor: 0,
    protectedFloorMinor: 0,
    mandate: {
      id: 'mandate_v1',
      version: 1,
      expiresAt: '2026-11-07T00:00:00.000Z',
      maxPerPaymentMinor: 4_000_000,
      remainingBudgetMinor: 4_000_000,
      permittedKinds: ['airwallex_transfer'],
      allowedBeneficiaries: ['ben-harbor-drones', 'ben-marine-alt', 'ben-diagnostics'],
      allowedPurposes: ['harbor inspection'],
    },
    ...overrides,
  };
}

export const INCUMBENT: SupplierOffer = {
  id: 'harbor-drones',
  kind: 'inspection-service',
  beneficiary: 'ben-harbor-drones',
  purpose: 'harbor inspection',
  currency: 'USD',
  baseCostMinor: 1_200_000,
  feeMinor: 0,
  leadTimeMinutes: 120,
  durationMinutes: 240,
  probabilityOfSuccess: 0.9,
  availability: 'confirmed',
};

export const ALTERNATIVE: SupplierOffer = {
  id: 'marine-alt',
  kind: 'inspection-service',
  beneficiary: 'ben-marine-alt',
  purpose: 'harbor inspection',
  currency: 'USD',
  baseCostMinor: 1_800_000,
  feeMinor: 50_000,
  leadTimeMinutes: 60,
  durationMinutes: 180,
  probabilityOfSuccess: 0.85,
  availability: 'confirmed',
};

export const DIAGNOSTIC: SupplierOffer = {
  id: 'diag-service',
  kind: 'diagnostic-service',
  beneficiary: 'ben-diagnostics',
  purpose: 'harbor inspection',
  currency: 'USD',
  baseCostMinor: 400_000,
  feeMinor: 0,
  leadTimeMinutes: 30,
  durationMinutes: 60,
  probabilityOfSuccess: 0.95,
  availability: 'confirmed',
};

let evidenceCounter = 0;
export function evidence(
  constraint: MissionEvidenceInput['constraint'],
  overrides: Partial<MissionEvidenceInput> = {},
): MissionEvidenceInput {
  evidenceCounter += 1;
  return {
    version: 1,
    tenant: TENANT,
    asset: ASSET,
    event: {
      id: `evt-${String(evidenceCounter).padStart(3, '0')}`,
      sequence: evidenceCounter,
      observedAt: NOW.toISOString(),
      ingestedAt: NOW.toISOString(),
    },
    source: { kind: 'weather-service', digest: `digest-${evidenceCounter}` },
    constraint,
    validity: { notAfter: '2026-11-06T12:00:00.000Z' },
    ...overrides,
  };
}

export function weatherWindow(
  opensInMinutes: number,
  closesInMinutes: number,
  confidence = 0.8,
): MissionEvidenceInput['constraint'] {
  return {
    kind: 'weather-window',
    windowOpensAt: new Date(NOW.getTime() + opensInMinutes * 60_000).toISOString(),
    windowClosesAt: new Date(NOW.getTime() + closesInMinutes * 60_000).toISOString(),
    confidence,
  };
}

export function iso(minutesFromNow: number): string {
  return new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString();
}
