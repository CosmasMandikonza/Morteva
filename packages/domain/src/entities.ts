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
  readonly status: 'active' | 'superseded' | 'expired' | 'revoked';
  readonly currency: string;
  readonly maxAmountMinor: number;
  /**
   * Cumulative lifetime envelope for ALL operations under this mandate id.
   * -1 means "unset" and is enforced as the per-operation maximum (legacy
   * v1 semantics), so old rows never gain authority they never had.
   */
  readonly totalBudgetMinor: number;
  readonly permittedOperationKinds: readonly string[];
  /** Provider rails this mandate may spend on. 'metal' is blocked globally until issue #6. */
  readonly rails: readonly string[];
  /** Empty list = any beneficiary (v1 semantics); non-empty = exact-match allowlist. */
  readonly allowedBeneficiaries: readonly string[];
  /** Empty list = any purpose; non-empty = allowlist for info-purchase categories. */
  readonly allowedPurposes: readonly string[];
  /** Human separation of duties: approver must differ from the plan proposer. */
  readonly requireSeparateApprover: boolean;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface CandidatePlanView {
  readonly id: PlanId;
  readonly orgId: OrgId;
  readonly missionId: MissionId;
  readonly version: number;
  readonly terms: Readonly<Record<string, unknown>>;
  readonly digest: string;
  /** Persisted actor id of the proposer (agent/operator), or null. Used for separation of duties. */
  readonly proposedBy: string | null;
  readonly createdAt: string;
}

/**
 * An approval binds the exact plan digest and every economic term it
 * approved (docs/05 #4, issue #7): mandate version, operation kind, quote
 * and evidence digests. Anything changed → the approval is structurally
 * stale. Single-use: consumed atomically by the reservation it authorizes.
 */
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
  readonly kind: OperationKind;
  readonly mandateId: MandateId | null;
  readonly mandateVersion: number | null;
  /** Canonical digest of the plan's quote object (or the null-quote constant). */
  readonly quoteDigest: string;
  /** Digest of the evidence bundle the approver saw; empty string if none bound. */
  readonly evidenceDigest: string;
  /** Single-use economic authorization identity (idempotency for double-clicks). */
  readonly authKey: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly expiresAt: string;
  readonly status: 'valid' | 'consumed' | 'invalidated' | 'revoked';
  readonly revokedAt: string | null;
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

// ---------------------------------------------------------------------------
// Read-only operator projections (issues #34/#36). These are the CONTRACT the
// API serves and the web renders — both compile against these types so the
// wire format cannot drift from the documentation. Everything here is derived
// truth: no field may imply a provider observation that does not exist.
// ---------------------------------------------------------------------------

/** Exact money: an integer in minor units plus the domain's exact major string. Never a float. */
export interface MoneyView {
  readonly minorUnits: number;
  readonly major: string;
}

/**
 * Where a balance number came from, and whether it can still be trusted.
 * `providerVerified` is true ONLY for a balance actually observed at a
 * provider (airwallex-sandbox / metal-testnet). A manual seed is recorded
 * operator input, NOT provider-verified funds — and a balance is a different
 * concept from mandate authority (what the org is PERMITTED to spend): authority is not money.
 */
export interface BalanceProvenanceView {
  readonly source: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly stale: boolean;
  readonly providerVerified: boolean;
}

/**
 * Commitment pressure on one currency, split exactly like the engine's
 * spendable math. `unknownMinor` deliberately includes BOTH ambiguous
 * (STATUS_UNKNOWN) and escalated (REQUIRES_HUMAN) exposure — both retain
 * capacity. `settledPendingObservationMinor` counts settlements finalized at
 * or after the balance observation (still consumed until newer money is
 * observed); it is null when no snapshot exists (honestly unknown).
 */
export interface CommitmentBreakdownView {
  readonly reservedMinor: number;
  readonly unknownMinor: number;
  readonly settledPendingObservationMinor: number | null;
  readonly settledTotalMinor: number;
  readonly releasedMinor: number;
  readonly totalOutstandingMinor: number | null;
}

export type FinancialCurrencyStatus = 'ok' | 'stale' | 'no_snapshot';

export interface FinancialCurrencyView {
  readonly currency: string;
  readonly status: FinancialCurrencyStatus;
  readonly balance: MoneyView | null;
  readonly provenance: BalanceProvenanceView | null;
  readonly protectedFloor: MoneyView;
  readonly spendable: (MoneyView & { overcommitted: boolean }) | null;
  readonly commitments: CommitmentBreakdownView;
  /** Human sentence when status is not ok; null otherwise. */
  readonly statusDetail: string | null;
}

export interface FinancialOverviewView {
  readonly orgId: string;
  readonly generatedAt: string;
  readonly currencies: readonly FinancialCurrencyView[];
}

/** Human-attention classification: escalated, ambiguous, or quiet. */
export type AttentionLevel = 'none' | 'ambiguous' | 'human';

/** The money view of one operation, shared by the list and the detail route. */
export interface OperationReadView {
  readonly id: string;
  readonly missionId: string;
  readonly kind: string;
  readonly requestId: string;
  readonly state: string;
  readonly attention: AttentionLevel;
  readonly amount: MoneyView & { currency: string };
  readonly beneficiary: string;
  readonly purpose: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly commitment: { state: string; finalizedAt: string | null };
  /** Outbox truth once a dispatch row exists; null before — never a guess. */
  readonly dispatch: { rail: string | null; attempts: number; status: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OperationListView {
  readonly operations: readonly OperationReadView[];
  /** Org-wide counts that never shrink with list filters. */
  readonly counts: { returned: number; needsHuman: number; ambiguous: number };
}

/**
 * One append-only journal event. `payload` is a PROJECTED public view, not the
 * stored journal JSON: the API discloses only per-event-type allowlisted
 * scalar fields (see the API's evidence projection); unrecognized event types
 * and non-allowlisted fields yield `payload: null`/absent. The digest stays
 * verifiable against the journal.
 */
export interface MissionEvidenceEventView {
  readonly seq: number;
  readonly id: string;
  readonly topic: 'financial' | 'operational';
  /** Engine-shaped event type, or null when a writer stored an unstructured string. */
  readonly type: string | null;
  /** Structured `namespace:id[:suffix…]` key, or null when it is not engine-shaped. */
  readonly eventKey: string | null;
  readonly payloadDigest: string;
  /** Allowlisted, format-validated projection — never the stored JSON, never free text. */
  readonly payload: unknown;
  readonly recordedAt: string;
}

export interface MissionEvidenceListView {
  readonly missionId: string;
  readonly events: readonly MissionEvidenceEventView[];
}

/** A persisted, server-verified identity. Credentials are never part of the view. */
export interface ActorView {
  readonly id: string;
  readonly orgId: OrgId;
  readonly username: string;
  readonly displayName: string;
  readonly role: string;
  readonly kind: 'human' | 'service';
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

/** Mission-scoped machine authority: service actors need an explicit grant per mission. */
export interface MissionGrantView {
  readonly id: string;
  readonly orgId: OrgId;
  readonly missionId: MissionId;
  readonly actorId: string;
  readonly grantedBy: string;
  readonly grantedAt: string;
  readonly revokedAt: string | null;
}

/** Resolved session context — the ONLY trusted source of "who is acting". */
export interface SessionContextView {
  readonly sessionId: string;
  readonly actor: ActorView;
  readonly expiresAt: string;
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
