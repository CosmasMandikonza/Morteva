/**
 * Shared entity views for the financial ledger (docs/01 "Domain objects").
 * Pure data shapes: the ledger package owns persistence, this file owns the
 * vocabulary so web/api/providers cannot invent divergent field names.
 * All records are org-scoped; all money is integer minor units + ISO currency.
 */
import type { CommitmentState } from './commitments.js';
import type { OperationState } from './operations.js';

export type OrgId = string;
export type MissionId = string;
export type AccountId = string;
export type PlanId = string;
export type ApprovalId = string;
export type OperationId = string;
export type MandateId = string;

export type MissionStatus = 'active' | 'completed' | 'archived';

export interface OrganizationView {
  readonly id: OrgId;
  readonly name: string;
  readonly createdAt: string;
}

export interface MissionView {
  readonly id: MissionId;
  readonly orgId: OrgId;
  readonly title: string;
  readonly status: MissionStatus;
  readonly createdAt: string;
}

/** Treasury account per org+currency. protectedFloorMinor is org money that may never be spent autonomously. */
export interface AccountView {
  readonly id: AccountId;
  readonly orgId: OrgId;
  readonly currency: string;
  readonly kind: 'treasury';
  readonly label: string;
  readonly protectedFloorMinor: number;
  readonly createdAt: string;
}

/** Where the balance number came from. Provider truth and manual seeds are never confused. */
export type BalanceSource = 'airwallex-sandbox' | 'metal-testnet' | 'manual-seed';

export interface BalanceSnapshotView {
  readonly id: string;
  readonly accountId: AccountId;
  readonly orgId: OrgId;
  readonly currency: string;
  readonly minorUnits: number;
  readonly source: BalanceSource;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly recordedAt: string;
}

/** Mandates are immutable versions; superseding creates a new version row. */
export interface MandateView {
  readonly id: MandateId;
  readonly orgId: OrgId;
  readonly missionId: MissionId;
  readonly version: number;
  readonly status: 'active' | 'superseded' | 'expired';
  readonly currency: string;
  readonly maxAmountMinor: number;
  readonly permittedOperationKinds: readonly string[];
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface CandidatePlanView {
  readonly id: PlanId;
  readonly orgId: OrgId;
  readonly missionId: MissionId;
  readonly version: number;
  readonly terms: Readonly<Record<string, unknown>>;
  readonly digest: string;
  readonly createdAt: string;
}

/** An approval binds the exact plan digest and economic terms it approved (docs/05 #4). */
export interface ApprovalView {
  readonly id: ApprovalId;
  readonly orgId: OrgId;
  readonly planId: PlanId;
  readonly planVersion: number;
  readonly planDigest: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly beneficiary: string;
  readonly purpose: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly expiresAt: string;
  readonly status: 'valid' | 'consumed' | 'invalidated';
}

export type OperationKind = 'airwallex_transfer' | 'metal_order' | 'internal_hold';

/** Durable economic identity: (orgId, requestId) is globally unique and reused for every retry of the SAME intent. */
export interface FinancialOperationView {
  readonly id: OperationId;
  readonly orgId: OrgId;
  readonly missionId: MissionId;
  readonly kind: OperationKind;
  readonly requestId: string;
  readonly state: OperationState;
  readonly planId: PlanId;
  readonly planVersion: number;
  readonly planDigest: string;
  readonly approvalId: ApprovalId;
  readonly mandateId: MandateId;
  readonly mandateVersion: number;
  readonly amountMinor: number;
  readonly currency: string;
  readonly beneficiary: string;
  readonly purpose: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CommitmentView {
  readonly id: string;
  readonly orgId: OrgId;
  readonly missionId: MissionId;
  readonly operationId: OperationId;
  readonly currency: string;
  readonly amountMinor: number;
  readonly state: CommitmentState;
  /** Set when the commitment reached 'settled'; used for snapshot-freshness accounting. */
  readonly finalizedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type OutboxStatus = 'pending' | 'claimed' | 'dispatched' | 'abandoned';

export interface OutboxDispatchView {
  readonly id: string;
  readonly operationId: OperationId;
  readonly orgId: OrgId;
  readonly rail: 'airwallex' | 'metal';
  readonly requestId: string;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly claimToken: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EvidenceEventView {
  readonly seq: number;
  readonly id: string;
  readonly orgId: OrgId;
  readonly missionId: MissionId | null;
  readonly topic: 'financial' | 'operational';
  readonly type: string;
  readonly eventKey: string;
  readonly payloadDigest: string;
  readonly recordedAt: string;
}

/** Spendable computation breakdown — returned so callers/UI can show the math, not just a number. */
export interface SpendableView {
  readonly orgId: OrgId;
  readonly currency: string;
  readonly balanceMinor: number;
  readonly balanceSource: BalanceSource;
  readonly balanceObservedAt: string;
  readonly balanceExpiresAt: string;
  readonly protectedFloorMinor: number;
  readonly outstandingCommittedMinor: number;
  readonly spendableMinor: number;
  /** True when commitments exceed balance+floor (external spend detected); spendable clamps to 0. */
  readonly overcommitted: boolean;
}
