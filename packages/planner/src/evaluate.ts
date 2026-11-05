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
import { validateCandidate, validateFacts, validatePolicy } from './validate.js';

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
  // Runtime-hardened (CTO review 6651660983): non-strings can reach this
  // boundary from model adapters — coerce before touching .replace.
  const asString = typeof text === 'string' ? text : '';
  // Control characters stripped; length capped. Rationale NEVER influences
  // evaluation — this only keeps stored prose safe to display.
  // eslint-disable-next-line no-control-regex -- stripping control characters IS the sanitize behavior
  const stripped = asString.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  return stripped.slice(0, 500);
}

/**
 * Display-safe placeholder for a malformed candidate. Never selected
 * (infeasible by construction); exists only so traces and JSON serialization
 * cannot crash on hostile runtime shapes.
 */
function malformedCandidateView(raw: unknown): PlannerCandidate {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const id =
    typeof r.id === 'string' && r.id.length > 0 ? r.id.slice(0, 64) : '(malformed candidate)';
  return {
    id,
    kind: 'no-action',
    label: '(malformed candidate — rejected at the validation boundary)',
    costMinor: 0,
    feeMinor: 0,
    beneficiary: '(unavailable)',
    purpose: '(unavailable)',
    currency: '(invalid)',
    earliestStartAt: '1970-01-01T00:00:00.000Z',
    durationMinutes: 1,
    deadlineAt: '1970-01-01T00:00:00.000Z',
    probabilityOfSuccess: 0,
    availability: 'confirmed',
    evidenceIds: [],
    rationale: '(malformed candidate — details withheld)',
  };
}

/**
 * Score one candidate against policy and facts. Pure.
 *
 * VALIDATION BOUNDARY (CTO review 6651660983): the candidate is UNTRUSTED at
 * runtime (TypeScript interfaces do not protect the model/external boundary).
 * `validateCandidate` rejects NaN/Infinity probabilities (NaN bypasses range
 * comparisons), non-string prose, wrong runtime types, unsafe integers,
 * individually-safe-but-overflowing cost+fee sums and impossible timing
 * BEFORE any field is read for arithmetic — malformed input produces an
 * explicit fail-closed MALFORMED_CANDIDATE result, never an uncaught
 * TypeError and never a selected action.
 */
export function scoreCandidate(
  candidate: PlannerCandidate,
  input: EvaluationInput,
): ScoredCandidate {
  const assumptions: string[] = [];

  // ---- validation boundary FIRST: nothing below reads an unvalidated field.
  const check = validateCandidate(candidate);
  if (!check.ok) {
    return {
      candidate: malformedCandidateView(candidate),
      feasible: false,
      rejection: { code: 'MALFORMED_CANDIDATE', reason: check.reason },
      grossCostMinor: 0,
      effectiveProbability: 0,
      expectedMissionValueMinor: 0,
      expectedNetMinor: 0,
      assumptions,
    };
  }
  // Gross is now proven safe: both operands are safe integers AND their sum
  // is range-checked together in validateCandidate.
  const gross = check.value.costMinor + check.value.feeMinor;
  if (!Number.isSafeInteger(gross)) {
    // Unreachable with the validator in place; kept as a belt-and-braces
    // fail-closed guard for future refactors.
    return {
      candidate: malformedCandidateView(candidate),
      feasible: false,
      rejection: {
        code: 'MALFORMED_CANDIDATE',
        reason: 'internal guard: gross cost is not a safe integer',
      },
      grossCostMinor: 0,
      effectiveProbability: 0,
      expectedMissionValueMinor: 0,
      expectedNetMinor: 0,
      assumptions,
    };
  }

  const evidenceById = new Map<string, { accepted: boolean }>();
  for (const a of Array.isArray(input.evidence?.accepted) ? input.evidence.accepted : []) {
    evidenceById.set(a.input.event.id, { accepted: true });
  }
  for (const r of Array.isArray(input.evidence?.rejected) ? input.evidence.rejected : []) {
    evidenceById.set(r.input.event.id, { accepted: false });
  }

  const safeCandidate: PlannerCandidate = {
    ...check.value,
    rationale: sanitizeRationale(check.value.rationale),
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

  // ---- arithmetic safety (CTO review 6651660983): every score term must be
  // finite and within the safe-integer magnitude envelope before it can rank.
  // With validated inputs this is unreachable (proof: p ∈ [0,1] finite,
  // monetary terms ≤ MAX_SAFE_INTEGER, so each product ≤ MAX_SAFE_INTEGER and
  // differences stay bounded) — the guard exists so a future refactor cannot
  // silently overflow or emit NaN/Infinity into selection.
  if (
    !Number.isFinite(expectedMissionValue) ||
    !Number.isFinite(expectedNet) ||
    Math.abs(expectedMissionValue) > Number.MAX_SAFE_INTEGER ||
    Math.abs(expectedNet) > Number.MAX_SAFE_INTEGER ||
    !Number.isFinite(p)
  ) {
    return verdict(
      'INVALID_ARITHMETIC',
      'expected-value computation left the finite safe-integer envelope; rejecting rather than ranking an unsafe score',
    );
  }

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
  // ---- trust boundary for the evaluation inputs themselves (CTO review
  // 6651660983): TypeScript cannot guarantee runtime shapes from external
  // callers. Invalid policy/facts/clock NEVER reach ranking — the decision
  // fails closed as an escalation to a human with the violated rule named.
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    return invalidInputResult('evaluation clock (input.now) must be a valid Date');
  }
  if (!Array.isArray(input.candidates)) {
    return invalidInputResult('candidates must be an array');
  }
  const policyCheck = validatePolicy(input.policy);
  if (!policyCheck.ok) return invalidInputResult(`invalid policy: ${policyCheck.reason}`);
  const factsCheck = validateFacts(input.facts);
  if (!factsCheck.ok) return invalidInputResult(`invalid financial facts: ${factsCheck.reason}`);

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

/**
 * Fail-closed result for invalid evaluation INPUTS (clock, candidates
 * container, policy, facts). Never a selection; the reason names the exact
 * violated rule so an operator can correct it. Trace is synthetic but
 * digested and labeled like every other decision.
 */
function invalidInputResult(reason: string): DecisionResult {
  const evaluationId = sha256Hex(`invalid-input:${reason}`).slice(0, 16);
  const trace: DecisionTrace = {
    evaluationId,
    evaluatedAt: new Date().toISOString(),
    truthLabel:
      'SIMULATED_OPERATION — POLICY-ONLY (deterministic policy evaluation; no live model inference)',
    modelAdapter: null,
    inputDigest: sha256Hex(reason).slice(0, 32),
    evidenceAcceptedIds: [],
    evidenceRejectedIds: [],
    contradictions: [],
    factsSummary: { invalidInput: reason },
    scores: [],
    decision: 'escalate',
    selectedId: null,
  };
  return {
    outcome: 'escalate',
    selected: null,
    runnersUp: [],
    declined: [],
    reasons: [
      {
        code: 'ESCALATED',
        message: `INVALID INPUT — refusing to evaluate: ${reason}`,
        evidenceIds: [],
      },
    ],
    trace,
  };
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
