/**
 * The pure financial feasibility + evaluation layer. Deterministic: the same
 * (evidence, candidates, policy, facts, now) always yields the same decision
 * bit-for-bit. No model text, no I/O, no clocks beyond the injected `now`.
 */
import { createHash } from 'node:crypto';
import type {
  DecisionReason,
  DecisionResult,
  DecisionTrace,
  FinancialFacts,
  FinancialPolicy,
  PlannerCandidate,
  ScoredCandidate,
} from './contracts.js';
import type { AcceptedEvidence, EvidenceReview, MissionEvidenceInput } from './contracts.js';

export interface EvaluationInput {
  readonly now: Date;
  readonly policy: FinancialPolicy;
  readonly facts: FinancialFacts;
  readonly evidence: EvidenceReview;
  /** All candidates (deterministic generator + any validated model proposals). */
  readonly candidates: readonly PlannerCandidate[];
  /** Model adapter id when one contributed (recorded in the trace; null = POLICY-ONLY generator). */
  readonly modelAdapterId: string | null;
  /** When the model adapter threw, its outage is recorded (never fatal). */
  readonly modelOutage?: { readonly adapterId: string; readonly message: string };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sanitizeRationale(text: string): string {
  // Control characters stripped; length capped. Rationale NEVER influences
  // evaluation — this only keeps stored prose safe to display.
  // eslint-disable-next-line no-control-regex -- stripping control characters IS the sanitize behavior
  const stripped = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  return stripped.slice(0, 500);
}

function validateShape(candidate: PlannerCandidate): string | null {
  if (candidate.id === '' || candidate.label === '') return 'id and label are required';
  if (!Number.isSafeInteger(candidate.costMinor) || candidate.costMinor < 0)
    return 'costMinor must be a non-negative safe integer';
  if (!Number.isSafeInteger(candidate.feeMinor) || candidate.feeMinor < 0)
    return 'feeMinor must be a non-negative safe integer';
  if (typeof candidate.beneficiary !== 'string' || candidate.beneficiary === '')
    return 'beneficiary required';
  if (typeof candidate.purpose !== 'string' || candidate.purpose === '') return 'purpose required';
  if (!Number.isFinite(candidate.durationMinutes) || candidate.durationMinutes <= 0)
    return 'durationMinutes must be positive';
  if (Number.isNaN(Date.parse(candidate.earliestStartAt))) return 'earliestStartAt malformed';
  if (Number.isNaN(Date.parse(candidate.deadlineAt))) return 'deadlineAt malformed';
  if (candidate.probabilityOfSuccess < 0 || candidate.probabilityOfSuccess > 1)
    return 'probabilityOfSuccess outside 0..1';
  if (
    candidate.kind === 'purchase-diagnostics' &&
    (candidate.informationGain === undefined ||
      candidate.informationGain < 0 ||
      candidate.informationGain > 1)
  )
    return 'purchase-diagnostics requires informationGain in 0..1';
  return null;
}

/** Score one candidate against policy and facts. Pure. */
export function scoreCandidate(
  candidate: PlannerCandidate,
  input: EvaluationInput,
): ScoredCandidate {
  const assumptions: string[] = [];

  const gross = candidate.costMinor + candidate.feeMinor;

  const evidenceById = new Map<string, { accepted: boolean }>();
  for (const a of input.evidence.accepted) evidenceById.set(a.input.event.id, { accepted: true });
  for (const r of input.evidence.rejected) evidenceById.set(r.input.event.id, { accepted: false });

  const malformed = validateShape(candidate);
  if (malformed !== null) {
    return {
      candidate: { ...candidate, rationale: sanitizeRationale(candidate.rationale) },
      feasible: false,
      rejection: { code: 'MALFORMED_CANDIDATE', reason: malformed },
      grossCostMinor: 0,
      effectiveProbability: 0,
      expectedMissionValueMinor: 0,
      expectedNetMinor: 0,
      assumptions,
    };
  }

  const safeCandidate: PlannerCandidate = {
    ...candidate,
    rationale: sanitizeRationale(candidate.rationale),
  };
  const nowMs = input.now.getTime();

  // ---- evidence linkage: cited ids must exist and be ACCEPTED.
  if (safeCandidate.evidenceIds.length === 0 && safeCandidate.kind !== 'no-action') {
    return verdict('EVIDENCE_NOT_FOUND', 'candidate cites no evidence');
  }
  for (const id of safeCandidate.evidenceIds) {
    const state = evidenceById.get(id);
    if (state === undefined) {
      return verdict(
        'EVIDENCE_NOT_FOUND',
        `cited evidence ${id} does not exist in this review (hallucination guard)`,
      );
    }
    if (!state.accepted) {
      return verdict('EVIDENCE_REJECTED', `cited evidence ${id} was rejected in this review`);
    }
  }

  // ---- quote freshness.
  if (safeCandidate.quoteExpiresAt !== undefined) {
    if (Date.parse(safeCandidate.quoteExpiresAt) <= nowMs) {
      return verdict('QUOTE_EXPIRED', `quote expired at ${safeCandidate.quoteExpiresAt}`);
    }
  }

  // ---- deadline feasibility (deterministic calendar math).
  const finishMs =
    Date.parse(safeCandidate.earliestStartAt) + safeCandidate.durationMinutes * 60_000;
  const deadlineMs = Date.parse(safeCandidate.deadlineAt);
  if (!Number.isFinite(deadlineMs)) {
    return verdict('MALFORMED_CANDIDATE', 'deadlineAt is not a valid timestamp');
  }
  if (finishMs > deadlineMs) {
    return verdict(
      'DEADLINE_INFEASIBLE',
      `completion ${new Date(finishMs).toISOString()} is after deadline ${safeCandidate.deadlineAt}`,
    );
  }

  // ---- currency separation: NO invented FX.
  if (
    safeCandidate.currency !== input.policy.currency ||
    safeCandidate.currency !== input.facts.currency
  ) {
    return verdict(
      'CURRENCY_UNSUPPORTED',
      `candidate currency ${safeCandidate.currency} is outside the single planning currency ${input.policy.currency} (no implicit FX)`,
    );
  }

  // ---- authority gates mirrored from the durable mandate (the LEDGER
  // re-checks all of these at reservation time; these are pre-checks only).
  const mandate = input.facts.mandate;
  if (mandate === null) {
    return verdict('MANDATE_EXPIRED', 'no active mandate for this mission/currency');
  }
  if (Date.parse(mandate.expiresAt) <= nowMs) {
    return verdict('MANDATE_EXPIRED', `mandate expired at ${mandate.expiresAt}`);
  }
  if (!mandate.permittedKinds.includes('airwallex_transfer') && safeCandidate.costMinor > 0) {
    return verdict('KIND_NOT_PERMITTED', 'mandate does not permit payment operations');
  }
  if (
    mandate.allowedBeneficiaries.length > 0 &&
    !mandate.allowedBeneficiaries.includes(safeCandidate.beneficiary)
  ) {
    return verdict(
      'BENEFICIARY_NOT_ALLOWED',
      `beneficiary ${safeCandidate.beneficiary} is not in the mandate allowlist`,
    );
  }
  if (
    mandate.allowedPurposes.length > 0 &&
    !mandate.allowedPurposes.includes(safeCandidate.purpose)
  ) {
    return verdict(
      'PURPOSE_NOT_ALLOWED',
      `purpose "${safeCandidate.purpose}" is not in the mandate allowlist`,
    );
  }

  // ---- money gates (spendable is only meaningful when the balance snapshot
  // is fresh; a stale/missing snapshot makes ANY new spend infeasible).
  if (input.facts.balanceStatus !== 'ok' || input.facts.spendableMinor === null) {
    if (gross > 0) {
      return verdict(
        'INSUFFICIENT_SPENDABLE',
        `balance status ${input.facts.balanceStatus}: the ledger refuses to commit against unverified funds`,
      );
    }
  } else {
    if (gross > input.facts.spendableMinor) {
      return verdict(
        'INSUFFICIENT_SPENDABLE',
        `gross ${String(gross)} minor exceeds spendable ${String(input.facts.spendableMinor)} minor`,
      );
    }
    if (input.facts.spendableMinor - gross < input.policy.protectedReserveMinor) {
      return verdict(
        'RESERVE_BREACH',
        `committing ${String(gross)} minor would breach the protected reserve ${String(input.policy.protectedReserveMinor)} minor`,
      );
    }
  }
  if (gross > mandate.maxPerPaymentMinor) {
    return verdict(
      'OVER_PER_PAYMENT_CAP',
      `gross ${String(gross)} minor exceeds per-payment cap ${String(mandate.maxPerPaymentMinor)} minor`,
    );
  }
  if (gross > mandate.remainingBudgetMinor) {
    return verdict(
      'OVER_MISSION_BUDGET',
      `gross ${String(gross)} minor exceeds remaining mission budget ${String(mandate.remainingBudgetMinor)} minor`,
    );
  }

  // ---- uncertainty retention.
  if (
    safeCandidate.availability === 'unconfirmed' &&
    input.policy.forbidUnconfirmedAvailability &&
    gross > 0
  ) {
    return verdict(
      'UNCONFIRMED_AVAILABILITY_FORBIDDEN',
      'policy forbids spending on unconfirmed availability; delivery uncertainty is retained, not assumed away',
    );
  }

  // ---- probability handling (clamped, discounted, always labeled).
  let p = safeCandidate.probabilityOfSuccess;
  if (p > input.policy.maxProbabilityAssumption) {
    assumptions.push(
      `probability clamped ${String(p)} → ${String(input.policy.maxProbabilityAssumption)} (policy optimism cap)`,
    );
    p = input.policy.maxProbabilityAssumption;
  }
  if (safeCandidate.availability === 'unconfirmed') {
    const before = p;
    p = p * input.policy.unconfirmedAvailabilityFactor;
    assumptions.push(
      `unconfirmed availability: probability ${String(before)} → ${String(p)} (uncertainty retained)`,
    );
  }

  // ---- expected value (all inputs are operator-declared assumptions).
  assumptions.push(
    `mission success value ${String(input.policy.missionValueMinor)} minor (assumption)`,
  );
  assumptions.push(`failure cost ${String(input.policy.failureCostMinor)} minor (assumption)`);
  const expectedMissionValue =
    p * input.policy.missionValueMinor - (1 - p) * input.policy.failureCostMinor;

  // ---- diagnostic information must justify its own price (refusal path).
  // An information action competes on VALUE OF INFORMATION, never on
  // mission-completion value: buying a report is not flying the mission.
  let diagnosticsVoi: number | null = null;
  if (safeCandidate.kind === 'purchase-diagnostics') {
    const gain = safeCandidate.informationGain ?? 0;
    diagnosticsVoi = gain * input.policy.failureCostMinor; // avoided failure is the realistic benefit
    assumptions.push(
      `value-of-information estimate ${String(diagnosticsVoi)} minor (assumption, gain ${String(gain)} × avoided failure cost)`,
    );
    if (diagnosticsVoi < gross * input.policy.diagnosticValueThreshold) {
      return {
        candidate: safeCandidate,
        feasible: false,
        rejection: {
          code: 'INFORMATION_NOT_WORTH_PRICE',
          reason: `value of information ${String(diagnosticsVoi)} minor is below ${String(gross * input.policy.diagnosticValueThreshold)} minor (threshold × price); declining the diagnostic purchase`,
        },
        grossCostMinor: gross,
        effectiveProbability: p,
        expectedMissionValueMinor: 0,
        expectedNetMinor: 0,
        assumptions: [...assumptions, 'DECLINED: information does not justify its price'],
      };
    }
  }
  const expectedNet =
    diagnosticsVoi !== null ? diagnosticsVoi - gross : expectedMissionValue - gross;
  assumptions.push(`expected net ${String(expectedNet)} minor = E[mission value] − gross cost`);

  return {
    candidate: safeCandidate,
    feasible: true,
    grossCostMinor: gross,
    effectiveProbability: p,
    expectedMissionValueMinor: expectedMissionValue,
    expectedNetMinor: expectedNet,
    assumptions,
  };

  function verdict(
    code: NonNullable<ScoredCandidate['rejection']>['code'],
    reason: string,
  ): ScoredCandidate {
    return {
      candidate: safeCandidate,
      feasible: false,
      rejection: { code, reason },
      grossCostMinor: gross,
      effectiveProbability: 0,
      expectedMissionValueMinor: 0,
      expectedNetMinor: 0,
      assumptions,
    };
  }
}

/**
 * Evaluate and decide. Deterministic selection: maximize expected net; ties
 * broken by lower gross cost, then lexicographic id. Escalates on
 * contradictions, model outage with no policy fallback, or near-tied
 * materially different finalists.
 */
export function evaluate(input: EvaluationInput): DecisionResult {
  const scored = input.candidates.map((c) => scoreCandidate(c, input));
  const feasible = scored.filter((s) => s.feasible);
  const declined = scored.filter((s) => !s.feasible);
  const reasons: DecisionReason[] = [];

  // Contradictory accepted evidence → escalate (never pick a side).
  if (input.evidence.contradictions.length > 0) {
    return buildResult(
      'escalate',
      null,
      feasible,
      declined,
      [
        {
          code: 'ESCALATED',
          message: `accepted evidence is contradictory: ${input.evidence.contradictions.map((c) => c.reason).join('; ')}`,
          evidenceIds: input.evidence.contradictions.flatMap((c) => [c.a, c.b]),
        },
        policyOnlyReason(input),
      ],
      input,
      scored,
    );
  }

  if (feasible.length === 0) {
    return buildResult(
      'decline',
      null,
      [],
      declined,
      [
        {
          code: 'DECLINED',
          message: 'no candidate is feasible under the current facts, policy and evidence',
          evidenceIds: input.evidence.accepted.map((a) => a.input.event.id),
        },
        policyOnlyReason(input),
      ],
      input,
      scored,
    );
  }

  const ordered = [...feasible].sort((a, b) => {
    if (b.expectedNetMinor !== a.expectedNetMinor) return b.expectedNetMinor - a.expectedNetMinor;
    if (a.grossCostMinor !== b.grossCostMinor) return a.grossCostMinor - b.grossCostMinor;
    return a.candidate.id.localeCompare(b.candidate.id);
  });

  const best = ordered[0]!;
  const second = ordered[1];

  // Material near-tie between different KINDS of action → human decides.
  if (
    second !== undefined &&
    best.candidate.kind !== second.candidate.kind &&
    Math.abs(best.expectedNetMinor - second.expectedNetMinor) <= input.policy.escalationScoreGap &&
    best.candidate.kind !== 'no-action' &&
    second.candidate.kind !== 'no-action'
  ) {
    return buildResult(
      'escalate',
      null,
      ordered,
      declined,
      [
        {
          code: 'ESCALATED',
          message: `two materially different actions are within ${String(input.policy.escalationScoreGap)} minor of expected value (${best.candidate.id} vs ${second.candidate.id}); a human decides`,
          evidenceIds: [...best.candidate.evidenceIds, ...second.candidate.evidenceIds],
        },
        policyOnlyReason(input),
      ],
      input,
      scored,
    );
  }

  reasons.push({
    code: 'SELECTED',
    message: `${best.candidate.label}: expected net ${String(best.expectedNetMinor)} minor, gross ${String(best.grossCostMinor)} minor, effective p=${String(best.effectiveProbability)}; ${best.candidate.rationale}`,
    evidenceIds: best.candidate.evidenceIds,
  });
  if (best.candidate.kind === 'no-action') {
    reasons.push({
      code: 'DECLINED',
      message:
        'the economically dominant action is to spend nothing: every paid alternative is dominated by expected value',
      evidenceIds: best.candidate.evidenceIds,
    });
  }
  const out = policyOnlyReason(input);
  return buildResult('select', best, ordered.slice(1), declined, [...reasons, out], input, scored);
}

function policyOnlyReason(input: EvaluationInput): DecisionReason {
  if (input.modelOutage !== undefined) {
    return {
      code: 'MODEL_UNAVAILABLE',
      message: `model adapter ${input.modelOutage.adapterId} unavailable (${input.modelOutage.message}); decision made by the deterministic POLICY-ONLY engine`,
      evidenceIds: [],
    };
  }
  return {
    code: 'POLICY_ONLY',
    message:
      input.modelAdapterId === null
        ? 'decision by the deterministic POLICY-ONLY engine (no live model inference)'
        : `deterministic policy evaluation over validated typed candidates (model adapter ${input.modelAdapterId} contributed proposals; prose never influences money)`,
    evidenceIds: [],
  };
}

function buildResult(
  outcome: DecisionResult['outcome'],
  selected: ScoredCandidate | null,
  runnersUp: readonly ScoredCandidate[],
  declined: readonly ScoredCandidate[],
  reasons: readonly DecisionReason[],
  input: EvaluationInput,
  scored: readonly ScoredCandidate[],
): DecisionResult {
  const trace: DecisionTrace = {
    evaluationId: sha256Hex(
      JSON.stringify({
        accepted: input.evidence.accepted.map((a) => a.input.event.id),
        rejected: input.evidence.rejected.map((r) => r.input.event.id),
        candidates: input.candidates.map((c) => c.id),
        facts: input.facts,
        policy: input.policy,
        now: input.now.toISOString(),
      }),
    ).slice(0, 16),
    evaluatedAt: input.now.toISOString(),
    truthLabel:
      'SIMULATED_OPERATION — POLICY-ONLY (deterministic policy evaluation; no live model inference)',
    modelAdapter: input.modelAdapterId,
    inputDigest: sha256Hex(
      JSON.stringify({
        evidence: input.evidence.accepted.map((a) => a.input),
        policy: input.policy,
        facts: input.facts,
      }),
    ).slice(0, 32),
    evidenceAcceptedIds: input.evidence.accepted.map((a) => a.input.event.id),
    evidenceRejectedIds: input.evidence.rejected.map((r) => r.input.event.id),
    contradictions: input.evidence.contradictions,
    factsSummary: {
      currency: input.facts.currency,
      balanceStatus: input.facts.balanceStatus,
      spendableMinor: input.facts.spendableMinor,
      outstandingCommittedMinor: input.facts.outstandingCommittedMinor,
      ambiguousCommittedMinor: input.facts.ambiguousCommittedMinor,
      mandateId: input.facts.mandate?.id ?? null,
    },
    scores: scored,
    decision: outcome,
    selectedId: selected?.candidate.id ?? null,
  };
  return { outcome, selected, runnersUp, declined, reasons, trace };
}

/** Replay helper: re-derive the decision from recorded inputs. */
export function replayDecision(
  evidenceInputs: readonly MissionEvidenceInput[],
  acceptedEvidence: readonly AcceptedEvidence[],
  input: EvaluationInput,
): DecisionResult {
  // Deterministic by construction: re-running evaluate with the same inputs
  // reproduces the trace; this helper exists to make replay an explicit,
  // testable operation (id + digest equality asserted in tests).
  void evidenceInputs;
  void acceptedEvidence;
  return evaluate(input);
}
