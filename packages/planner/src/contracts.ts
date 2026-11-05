/**
 * @moterva/planner — typed contracts for the adaptive mission-finance
 * decision engine (issue #8).
 *
 * ARCHITECTURE LAW (docs/01, CTO lane comment): model interpretation is
 * strictly separated from deterministic money and authorization code.
 *  - Everything in `contracts.ts`/`evidence.ts`/`candidates.ts`/`evaluate.ts`
 *    is PURE and deterministic: same inputs → same decision, bit for bit.
 *  - An LLM (optional adapter) may only (a) interpret unstructured text into
 *    TYPED evidence constraints, (b) propose TYPED candidates, and (c) write
 *    explanation prose. Its output is validated like any other untrusted
 *    input and NEVER touches funds, authorization or the ledger.
 *  - Financial authority lives exclusively in the existing ledger
 *    (mandates, approvals, reservations). The planner PROPOSES; the ledger
 *    disposes.
 *
 * Truth labels (docs/00): every decision trace carries
 * `SIMULATED_OPERATION` + `POLICY-ONLY` (deterministic policy evaluation, no
 * live model inference) or, when a real model adapter ran, the recorded
 * provider/mode. Nothing here is provider-verified money.
 */

// ------------------------------------------------------------------ evidence

/** The versioned mission-evidence input contract agreed with Agent C (#9). */
export interface MissionEvidenceInput {
  readonly version: 1;
  readonly tenant: { readonly orgId: string; readonly missionId: string };
  readonly asset: { readonly id: string; readonly kind: string };
  readonly event: {
    /** Unique idempotent replay key. */
    readonly id: string;
    /** Monotonic per asset; regressions are rejected. */
    readonly sequence: number;
    readonly observedAt: string;
    readonly ingestedAt: string;
  };
  readonly source: {
    readonly kind:
      | 'vehicle-telemetry'
      | 'operator-report'
      | 'weather-service'
      | 'contractor-system'
      | 'diagnostic-report';
    readonly digest: string;
  };
  readonly constraint: MissionConstraint;
  readonly validity: { readonly notAfter: string };
}

export type MissionConstraint =
  | {
      readonly kind: 'weather-window';
      readonly windowOpensAt: string;
      readonly windowClosesAt: string;
      /** 0..1 — source-stated confidence in the window holding. */
      readonly confidence: number;
    }
  | {
      readonly kind: 'contractor-delay';
      readonly contractorId: string;
      readonly delayMinutes: number;
    }
  | {
      readonly kind: 'diagnostic-finding';
      readonly severity: 'low' | 'medium' | 'high';
      /** Interpretation material only — NEVER carries financial authority. */
      readonly detail: string;
    }
  | { readonly kind: 'deadline-change'; readonly newDeadline: string };

export type EvidenceRejectionCode =
  | 'VERSION_MISMATCH'
  | 'MALFORMED_TIMESTAMP'
  | 'INGESTED_BEFORE_OBSERVED'
  | 'FUTURE_OBSERVATION'
  | 'STALE_VALIDITY'
  | 'SEQUENCE_REGRESSION'
  | 'EMPTY_DIGEST'
  | 'CONSTRAINT_OUT_OF_RANGE'
  | 'TENANT_MISMATCH';

export interface AcceptedEvidence {
  readonly input: MissionEvidenceInput;
  readonly acceptedAt: string;
}

export interface RejectedEvidence {
  readonly input: MissionEvidenceInput;
  readonly code: EvidenceRejectionCode;
  readonly reason: string;
}

export interface EvidenceReview {
  readonly accepted: readonly AcceptedEvidence[];
  readonly rejected: readonly RejectedEvidence[];
  /**
   * Two accepted constraints that cannot both hold (e.g. two different
   * deadlines, or a weather window that closes before it opens). Contradictory
   * state escalates instead of silently picking a side.
   */
  readonly contradictions: readonly {
    readonly a: string;
    readonly b: string;
    readonly reason: string;
  }[];
}

// ---------------------------------------------------------------- candidates

export type CandidateKind =
  'continue-supplier' | 'reschedule' | 'purchase-diagnostics' | 'hire-alternative' | 'no-action';

/**
 * A TYPED candidate proposal. The model adapter (or the deterministic
 * generator) may only produce these; every field is validated before any
 * financial reasoning. `rationale` is explanation prose — sanitized, capped
 * and NEVER used by the evaluator.
 */
export interface PlannerCandidate {
  readonly id: string;
  readonly kind: CandidateKind;
  readonly label: string;
  readonly costMinor: number;
  readonly currency: string;
  readonly feeMinor: number;
  readonly beneficiary: string;
  readonly purpose: string;
  readonly earliestStartAt: string;
  readonly durationMinutes: number;
  readonly deadlineAt: string;
  /** 0..1 assumption — always surfaced as an assumption, never a fact. */
  readonly probabilityOfSuccess: number;
  /** For purchase-diagnostics: 0..1 estimated probability the information
   * changes the mission outcome. Required for that kind; ignored elsewhere. */
  readonly informationGain?: number;
  /** Unconfirmed delivery retains its uncertainty end-to-end. */
  readonly availability: 'confirmed' | 'unconfirmed';
  /** Provider/service quote expiry — expired quotes are infeasible. */
  readonly quoteExpiresAt?: string;
  /** Every candidate must cite evidence that was ACCEPTED in this review. */
  readonly evidenceIds: readonly string[];
  readonly rationale: string;
}

export type CandidateRejectionCode =
  | 'MALFORMED_CANDIDATE'
  | 'EVIDENCE_NOT_FOUND'
  | 'EVIDENCE_REJECTED'
  | 'QUOTE_EXPIRED'
  | 'DEADLINE_INFEASIBLE'
  | 'BENEFICIARY_NOT_ALLOWED'
  | 'PURPOSE_NOT_ALLOWED'
  | 'KIND_NOT_PERMITTED'
  | 'MANDATE_EXPIRED'
  | 'INSUFFICIENT_SPENDABLE'
  | 'RESERVE_BREACH'
  | 'OVER_PER_PAYMENT_CAP'
  | 'OVER_MISSION_BUDGET'
  | 'CURRENCY_UNSUPPORTED'
  | 'UNCONFIRMED_AVAILABILITY_FORBIDDEN'
  | 'PROBABILITY_OUT_OF_RANGE'
  | 'INFORMATION_NOT_WORTH_PRICE'
  | 'INVALID_ARITHMETIC';

// ------------------------------------------------------------------- policy

/** Typed, versioned numeric policy. All numbers are explicit assumptions. */
export interface FinancialPolicy {
  readonly version: 1;
  /** The single planning currency. Cross-currency options are rejected —
   * there is NO implicit FX anywhere in the planner. */
  readonly currency: string;
  readonly missionDeadlineAt: string;
  /** Value of mission success, minor units (operator-declared assumption). */
  readonly missionValueMinor: number;
  /** Cost of mission failure (e.g. re-mobilization), minor units. */
  readonly failureCostMinor: number;
  /** Protected reserve that must survive any new commitment. */
  readonly protectedReserveMinor: number;
  /** Estimate optimism cap: probabilities above this are clamped. */
  readonly maxProbabilityAssumption: number;
  /** Discount factor applied to UNCONFIRMED availability (retains uncertainty). */
  readonly unconfirmedAvailabilityFactor: number;
  /** A diagnostic purchase must return >= this multiple of its cost in
   * expected value, otherwise information is DECLINED. */
  readonly diagnosticValueThreshold: number;
  /** Policy may forbid acting on unconfirmed availability entirely. */
  readonly forbidUnconfirmedAvailability: boolean;
  /** Score gap below which two materially different finalists escalate. */
  readonly escalationScoreGap: number;
}

// --------------------------------------------------------------------- facts

/**
 * A read-only snapshot of the durable financial facts the ledger owns.
 * Produced ONLY by the ledger binding; tests may construct it directly.
 * `stale`/`no_snapshot` statuses are carried, never coerced.
 */
export interface FinancialFacts {
  readonly orgId: string;
  readonly missionId: string;
  readonly currency: string;
  readonly balanceStatus: 'ok' | 'stale' | 'no_snapshot';
  readonly balanceMinor: number | null;
  readonly spendableMinor: number | null;
  readonly outstandingCommittedMinor: number;
  /** Ambiguous exposure (STATUS_UNKNOWN / REQUIRES_HUMAN) still consumes capacity. */
  readonly ambiguousCommittedMinor: number;
  readonly protectedFloorMinor: number;
  readonly mandate: {
    readonly id: string;
    readonly version: number;
    readonly expiresAt: string;
    readonly maxPerPaymentMinor: number;
    readonly remainingBudgetMinor: number;
    readonly permittedKinds: readonly string[];
    readonly allowedBeneficiaries: readonly string[];
    readonly allowedPurposes: readonly string[];
  } | null;
}

// ----------------------------------------------------------------- decision

export interface ScoredCandidate {
  readonly candidate: PlannerCandidate;
  readonly feasible: boolean;
  readonly rejection?: { readonly code: CandidateRejectionCode; readonly reason: string };
  readonly grossCostMinor: number;
  /** Effective probability after policy clamps and uncertainty discounts. */
  readonly effectiveProbability: number;
  readonly expectedMissionValueMinor: number;
  readonly expectedNetMinor: number;
  readonly assumptions: readonly string[];
}

export interface DecisionReason {
  readonly code: 'SELECTED' | 'DECLINED' | 'ESCALATED' | 'POLICY_ONLY' | 'MODEL_UNAVAILABLE';
  readonly message: string;
  readonly evidenceIds: readonly string[];
}

export interface DecisionResult {
  readonly outcome: 'select' | 'decline' | 'escalate';
  readonly selected: ScoredCandidate | null;
  readonly runnersUp: readonly ScoredCandidate[];
  readonly declined: readonly ScoredCandidate[];
  readonly reasons: readonly DecisionReason[];
  readonly trace: DecisionTrace;
}

/** Complete replayable record of one evaluation. */
export interface DecisionTrace {
  readonly evaluationId: string;
  readonly evaluatedAt: string;
  readonly truthLabel: 'SIMULATED_OPERATION — POLICY-ONLY (deterministic policy evaluation; no live model inference)';
  readonly modelAdapter: string | null;
  readonly inputDigest: string;
  readonly evidenceAcceptedIds: readonly string[];
  readonly evidenceRejectedIds: readonly string[];
  readonly contradictions: readonly {
    readonly a: string;
    readonly b: string;
    readonly reason: string;
  }[];
  readonly factsSummary: Readonly<Record<string, unknown>>;
  readonly scores: readonly ScoredCandidate[];
  readonly decision: 'select' | 'decline' | 'escalate';
  readonly selectedId: string | null;
}

// ------------------------------------------------------------- model adapter

/**
 * Optional bounded model adapter. It may interpret text and propose typed
 * candidates; it must NEVER see or alter financial facts, and its output is
 * validated exactly like any other candidate source. Throwing = outage: the
 * planner falls back to the deterministic generator (POLICY-ONLY) or
 * escalates per policy.
 */
export interface MissionModelAdapter {
  readonly id: string;
  /** Interpret unstructured observation text into typed evidence constraints. */
  interpret?(text: string, context: { assetKind: string }): readonly MissionEvidenceInput[];
  /** Propose additional typed candidates given accepted evidence. */
  propose?(
    evidence: readonly AcceptedEvidence[],
    context: { assetKind: string; currency: string },
  ): readonly PlannerCandidate[];
  /** Human-facing explanation of a decision (prose only, sanitized). */
  explain?(decision: DecisionResult): string;
}
