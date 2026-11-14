import { describe, expect, it } from 'vitest';
import { generateCandidates } from '../src/candidates.js';
import type { GenerationContext } from '../src/candidates.js';
import { evaluate, scoreCandidate } from '../src/evaluate.js';
import type { EvaluationInput } from '../src/evaluate.js';
import { reviewEvidence } from '../src/evidence.js';
import { validateCandidate, validateFacts, validatePolicy } from '../src/validate.js';
import type { FinancialFacts, FinancialPolicy, PlannerCandidate } from '../src/contracts.js';
import {
  ALTERNATIVE,
  DIAGNOSTIC,
  INCUMBENT,
  NOW,
  baseFacts,
  basePolicy,
  evidence,
  weatherWindow,
} from './helpers.js';

/**
 * Numeric-safety adversarial regression matrix (CTO review 6651660983).
 * TypeScript interfaces cannot protect the runtime/model boundary — these
 * tests drive HOSTILE values (NaN, ±Infinity, null, wrong types, overflowing
 * sums) through the exact public entry points and require explicit
 * fail-closed rejections, never crashes, never selected malformed actions.
 */

const MAX = Number.MAX_SAFE_INTEGER;
const TENANT = { orgId: 'org_demo', missionId: 'mission_harbor' };

const CTX: GenerationContext = {
  now: NOW,
  policyCurrency: 'USD',
  missionDeadlineAt: '2026-11-06T20:00:00.000Z',
  incumbent: INCUMBENT,
  alternatives: [ALTERNATIVE],
  diagnosticService: DIAGNOSTIC,
};

const SHARED_EVIDENCE = evidence(weatherWindow(60, 700));

function validCandidate(): PlannerCandidate {
  const review = reviewEvidence([SHARED_EVIDENCE], NOW, TENANT);
  const generated = generateCandidates(review.accepted, CTX);
  const cont = generated.find((c) => c.kind === 'continue-supplier');
  if (cont === undefined) throw new Error('fixture candidate missing');
  return cont;
}

function inputWith(
  candidates: readonly PlannerCandidate[],
  overrides: { policy?: Partial<FinancialPolicy>; facts?: Partial<FinancialFacts> } = {},
): EvaluationInput {
  const review = reviewEvidence([SHARED_EVIDENCE], NOW, TENANT);
  return {
    now: NOW,
    policy: basePolicy(overrides.policy),
    facts: baseFacts(overrides.facts),
    evidence: review,
    candidates: [...candidates] as PlannerCandidate[],
    modelAdapterId: null,
  };
}

const malformedReasonOf = (scored: ReturnType<typeof scoreCandidate>): string =>
  scored.rejection?.code === 'MALFORMED_CANDIDATE' ? scored.rejection.reason : '';

describe('candidate numeric validation — hostile probabilities and numbers', () => {
  const badProbabilities = [
    NaN,
    Infinity,
    -Infinity,
    'high' as unknown,
    null as unknown,
    undefined as unknown,
    1.0000001,
    -0.0000001,
    2,
    -1,
  ];
  for (const bad of badProbabilities) {
    it(`probabilityOfSuccess=${String(bad)} is rejected MALFORMED (NaN must not bypass range checks)`, () => {
      const c = { ...validCandidate(), probabilityOfSuccess: bad as unknown as number };
      const scored = scoreCandidate(c, inputWith([c]));
      expect(scored.feasible).toBe(false);
      expect(scored.rejection?.code).toBe('MALFORMED_CANDIDATE');
      expect(malformedReasonOf(scored)).toContain('probabilityOfSuccess');
    });
  }

  it('probabilityOfSuccess exactly 0 and exactly 1 are VALID boundaries', () => {
    for (const boundary of [0, 1]) {
      const c = { ...validCandidate(), probabilityOfSuccess: boundary };
      const scored = scoreCandidate(c, inputWith([c]));
      expect(scored.rejection?.code).not.toBe('MALFORMED_CANDIDATE');
    }
  });

  const badNumbers: readonly unknown[] = [
    NaN,
    Infinity,
    -Infinity,
    null,
    '100',
    undefined,
    1.5,
    -1,
  ];
  for (const bad of badNumbers) {
    it(`costMinor=${String(bad)} is rejected before any arithmetic`, () => {
      const c = { ...validCandidate(), costMinor: bad as unknown as number };
      const scored = scoreCandidate(c, inputWith([c]));
      expect(scored.rejection?.code).toBe('MALFORMED_CANDIDATE');
      expect(malformedReasonOf(scored)).toContain('costMinor');
    });
    it(`feeMinor=${String(bad)} is rejected before any arithmetic`, () => {
      const c = { ...validCandidate(), feeMinor: bad as unknown as number };
      const scored = scoreCandidate(c, inputWith([c]));
      expect(scored.rejection?.code).toBe('MALFORMED_CANDIDATE');
      expect(malformedReasonOf(scored)).toContain('feeMinor');
    });
  }

  it('SUM OVERFLOW: individually safe cost + fee beyond MAX_SAFE_INTEGER is rejected together', () => {
    const c = { ...validCandidate(), costMinor: MAX, feeMinor: 2 };
    // Sanity: each operand alone is a safe integer — only the SUM is unsafe.
    expect(Number.isSafeInteger(c.costMinor)).toBe(true);
    expect(Number.isSafeInteger(c.feeMinor)).toBe(true);
    expect(Number.isSafeInteger(c.costMinor + c.feeMinor)).toBe(false);
    const scored = scoreCandidate(c, inputWith([c]));
    expect(scored.feasible).toBe(false);
    expect(scored.rejection?.code).toBe('MALFORMED_CANDIDATE');
    expect(malformedReasonOf(scored)).toContain('safe-integer money range');
  });

  it('durationMinutes hostile values (NaN, ±Infinity, 0, negative, fractional, string) are rejected', () => {
    for (const bad of [NaN, Infinity, -Infinity, 0, -5, 90.5, '120' as unknown]) {
      const c = { ...validCandidate(), durationMinutes: bad as unknown as number };
      const scored = scoreCandidate(c, inputWith([c]));
      expect(scored.rejection?.code).toBe('MALFORMED_CANDIDATE');
    }
  });

  it('informationGain NaN/Infinity/out-of-range is rejected (and required for diagnostics)', () => {
    const diag = {
      ...validCandidate(),
      kind: 'purchase-diagnostics' as const,
      informationGain: NaN,
    };
    const scoredDiag = scoreCandidate(diag, inputWith([diag]));
    expect(malformedReasonOf(scoredDiag)).toContain('informationGain');
    const other = { ...validCandidate(), informationGain: Infinity };
    const scoredOther = scoreCandidate(other, inputWith([other]));
    expect(malformedReasonOf(scoredOther)).toContain('informationGain');
  });
});

describe('candidate shape validation — prose, enums, arrays, timestamps', () => {
  it('non-string rationale is rejected without crashing (no .replace TypeError)', () => {
    for (const bad of [null, 42, undefined, { inject: true } as unknown, ['x'] as unknown]) {
      const c = { ...validCandidate(), rationale: bad as unknown as string };
      expect(() => scoreCandidate(c, inputWith([c]))).not.toThrow();
      const scored = scoreCandidate(c, inputWith([c]));
      expect(scored.rejection?.code).toBe('MALFORMED_CANDIDATE');
      expect(malformedReasonOf(scored)).toContain('rationale');
    }
  });

  it('missing rationale is rejected (rationale is required, not optional)', () => {
    const c = validCandidate() as unknown as Record<string, unknown>;
    delete c.rationale;
    const scored = scoreCandidate(
      c as unknown as PlannerCandidate,
      inputWith([c as unknown as PlannerCandidate]),
    );
    expect(scored.rejection?.code).toBe('MALFORMED_CANDIDATE');
  });

  it('unknown candidate kind and availability are rejected', () => {
    const badKind = {
      ...validCandidate(),
      kind: 'authorize-everything' as unknown as PlannerCandidate['kind'],
    };
    expect(malformedReasonOf(scoreCandidate(badKind, inputWith([badKind])))).toContain(
      'unknown candidate kind',
    );
    const badAvail = {
      ...validCandidate(),
      availability: 'maybe' as unknown as PlannerCandidate['availability'],
    };
    expect(malformedReasonOf(scoreCandidate(badAvail, inputWith([badAvail])))).toContain(
      'unknown availability',
    );
  });

  it('invalid and expired timestamps are distinguished (invalid → MALFORMED, expired → QUOTE_EXPIRED)', () => {
    const badStart = { ...validCandidate(), earliestStartAt: 'not-a-date' };
    expect(malformedReasonOf(scoreCandidate(badStart, inputWith([badStart])))).toContain(
      'earliestStartAt',
    );
    const badDeadline = { ...validCandidate(), deadlineAt: 12345 as unknown as string };
    expect(malformedReasonOf(scoreCandidate(badDeadline, inputWith([badDeadline])))).toContain(
      'deadlineAt',
    );
    const badQuote = { ...validCandidate(), quoteExpiresAt: 'whenever' };
    expect(malformedReasonOf(scoreCandidate(badQuote, inputWith([badQuote])))).toContain(
      'quoteExpiresAt',
    );
    // A WELL-FORMED but expired quote is a different, existing rejection.
    const expiredQuote = { ...validCandidate(), quoteExpiresAt: '2026-11-06T07:00:00.000Z' };
    expect(scoreCandidate(expiredQuote, inputWith([expiredQuote])).rejection?.code).toBe(
      'QUOTE_EXPIRED',
    );
  });

  it('impossible candidate timing (start + duration beyond the Date range) is rejected', () => {
    const c = {
      ...validCandidate(),
      earliestStartAt: new Date(8.6e15).toISOString(), // at the Date edge
      durationMinutes: MAX, // pushes finish far beyond valid time
      deadlineAt: new Date(8.64e15).toISOString(),
    };
    const scored = scoreCandidate(c, inputWith([c]));
    expect(scored.rejection?.code).toBe('MALFORMED_CANDIDATE');
    expect(malformedReasonOf(scored)).toContain('impossible candidate timing');
  });

  it('evidenceIds non-array or containing non-strings is rejected', () => {
    const notArray = {
      ...validCandidate(),
      evidenceIds: 'evt-001' as unknown as readonly string[],
    };
    expect(malformedReasonOf(scoreCandidate(notArray, inputWith([notArray])))).toContain(
      'evidenceIds',
    );
    const mixed = { ...validCandidate(), evidenceIds: ['evt-001', 42 as unknown as string] };
    expect(malformedReasonOf(scoreCandidate(mixed, inputWith([mixed])))).toContain('evidenceIds');
  });

  it('a non-object candidate is rejected with a display-safe placeholder that serializes', () => {
    for (const bad of [null, undefined, 'candidate', 42, []]) {
      const scored = scoreCandidate(
        bad as unknown as PlannerCandidate,
        inputWith([validCandidate()]),
      );
      expect(scored.rejection?.code).toBe('MALFORMED_CANDIDATE');
      expect(() => JSON.stringify(scored.candidate)).not.toThrow();
    }
  });
});

describe('policy and facts validation — invalid inputs never reach ranking', () => {
  const badPolicyFields = [
    { field: 'maxProbabilityAssumption', value: NaN },
    { field: 'maxProbabilityAssumption', value: 0 },
    { field: 'maxProbabilityAssumption', value: 1.5 },
    { field: 'unconfirmedAvailabilityFactor', value: Infinity },
    { field: 'unconfirmedAvailabilityFactor', value: -0.1 },
    { field: 'diagnosticValueThreshold', value: NaN },
    { field: 'diagnosticValueThreshold', value: -1 },
    { field: 'missionValueMinor', value: Infinity },
    { field: 'missionValueMinor', value: -5 },
    { field: 'failureCostMinor', value: NaN },
    { field: 'protectedReserveMinor', value: 1.5 },
    { field: 'escalationScoreGap', value: 'small' as unknown },
    { field: 'missionDeadlineAt', value: 'tomorrow' },
    { field: 'currency', value: '' },
    { field: 'version', value: 2 as unknown },
    { field: 'forbidUnconfirmedAvailability', value: 'yes' as unknown },
  ] as const;
  for (const { field, value } of badPolicyFields) {
    it(`policy.${field}=${String(value)} → evaluate fails closed (escalate, no scores, named rule)`, () => {
      const policy = { ...basePolicy(), [field]: value } as unknown as FinancialPolicy;
      expect(validatePolicy(policy).ok).toBe(false);
      const result = evaluate({ ...inputWith([validCandidate()]), policy });
      expect(result.outcome).toBe('escalate');
      expect(result.selected).toBeNull();
      expect(result.trace.scores).toHaveLength(0);
      expect(result.reasons[0]?.message).toContain('refusing to evaluate');
      expect(result.reasons[0]?.message).toContain(String(field));
    });
  }

  const badFactsFields = [
    { field: 'spendableMinor', value: NaN },
    { field: 'spendableMinor', value: -1 },
    { field: 'spendableMinor', value: 1.5 },
    { field: 'outstandingCommittedMinor', value: Infinity },
    { field: 'ambiguousCommittedMinor', value: -2 },
    { field: 'balanceStatus', value: 'probably-fine' as unknown },
    { field: 'balanceStatus', value: 'ok' }, // ok without a numeric spendable is invalid
    { field: 'currency', value: '' },
  ] as const;
  for (const { field, value } of badFactsFields) {
    it(`facts.${field}=${String(value)} → evaluate fails closed`, () => {
      const facts = { ...baseFacts(), [field]: value } as unknown as FinancialFacts;
      if (field === 'balanceStatus' && value === 'ok') {
        // spendableMinor must then be a number; null is invalid.
        (facts as unknown as Record<string, unknown>).spendableMinor = null;
      }
      expect(validateFacts(facts).ok).toBe(false);
      const result = evaluate({ ...inputWith([validCandidate()]), facts });
      expect(result.outcome).toBe('escalate');
      expect(result.selected).toBeNull();
      expect(result.trace.scores).toHaveLength(0);
    });
  }

  it('malformed mandate fields are rejected at the facts boundary', () => {
    const facts = baseFacts({
      mandate: { ...baseFacts().mandate!, maxPerPaymentMinor: NaN },
    });
    expect(validateFacts(facts).ok).toBe(false);
    const result = evaluate({ ...inputWith([validCandidate()]), facts });
    expect(result.outcome).toBe('escalate');
  });

  it('non-Date clock and non-array candidates container fail closed', () => {
    const badClock = evaluate({
      ...inputWith([validCandidate()]),
      now: 'later' as unknown as Date,
    });
    expect(badClock.outcome).toBe('escalate');
    const badArray = evaluate({
      ...inputWith([validCandidate()]),
      candidates: 'all' as unknown as PlannerCandidate[],
    });
    expect(badArray.outcome).toBe('escalate');
  });

  it('insufficient financial capacity still DECLINES valid candidates (existing gate preserved)', () => {
    const result = evaluate(inputWith([validCandidate()], { facts: { spendableMinor: 10_000 } }));
    const paid = result.trace.scores.filter((s) => s.grossCostMinor > 0);
    expect(paid.every((s) => !s.feasible)).toBe(true);
  });
});

describe('poison-resistance and determinism', () => {
  it('one malformed candidate among valid ones does NOT change the decision', () => {
    const review = reviewEvidence([evidence(weatherWindow(300, 720, 0.95))], NOW, TENANT);
    const generated = generateCandidates(review.accepted, CTX);
    const clean = evaluate({
      now: NOW,
      policy: basePolicy(),
      facts: baseFacts(),
      evidence: review,
      candidates: generated,
      modelAdapterId: null,
    });
    const poisoned = evaluate({
      now: NOW,
      policy: basePolicy(),
      facts: baseFacts(),
      evidence: review,
      candidates: [
        ...generated,
        { ...validCandidate(), id: 'nan-ghost', probabilityOfSuccess: NaN },
        { ...validCandidate(), id: 'overflow-ghost', costMinor: MAX, feeMinor: MAX },
        { ...validCandidate(), id: 'string-fee', feeMinor: 'free' as unknown as number },
      ] as PlannerCandidate[],
      modelAdapterId: null,
    });
    expect(poisoned.outcome).toBe(clean.outcome);
    expect(poisoned.selected?.candidate.id).toBe(clean.selected?.candidate.id);
    // The malformed ghosts are explicitly rejected in the trace.
    const ghosts = poisoned.trace.scores.filter(
      (s) => s.candidate.id.endsWith('-ghost') || s.candidate.id === 'string-fee',
    );
    expect(ghosts.every((g) => !g.feasible && g.rejection?.code === 'MALFORMED_CANDIDATE')).toBe(
      true,
    );
  });

  it('a malformed candidate can never OUTRANK a valid one (it never ranks at all)', () => {
    const review = reviewEvidence([evidence(weatherWindow(60, 700, 0.9))], NOW, TENANT);
    const generated = generateCandidates(review.accepted, CTX);
    const result = evaluate({
      now: NOW,
      policy: basePolicy(),
      facts: baseFacts(),
      evidence: review,
      candidates: [
        { ...validCandidate(), id: 'aa-nan-first-alphabetically', probabilityOfSuccess: NaN },
        ...generated,
      ] as PlannerCandidate[],
      modelAdapterId: null,
    });
    expect(result.selected?.candidate.id).not.toBe('aa-nan-first-alphabetically');
    expect(result.outcome).not.toBe('escalate'); // poison must not force escalation either
  });

  it('repeated VALID input reproduces the identical evaluationId and decision', () => {
    const review = reviewEvidence([evidence(weatherWindow(300, 720, 0.95))], NOW, TENANT);
    const generated = generateCandidates(review.accepted, CTX);
    const run = () =>
      evaluate({
        now: NOW,
        policy: basePolicy(),
        facts: baseFacts(),
        evidence: review,
        candidates: generated,
        modelAdapterId: null,
      });
    const a = run();
    const b = run();
    expect(a.trace.evaluationId).toBe(b.trace.evaluationId);
    expect(a.trace.selectedId).toBe(b.trace.selectedId);
    expect(JSON.stringify(a.trace.scores)).toBe(JSON.stringify(b.trace.scores));
  });

  it('safe money arithmetic is guaranteed: every score of extreme-but-valid inputs is finite', () => {
    // Largest validated monetary policy with boundary probabilities.
    const policy = basePolicy({
      missionValueMinor: MAX,
      failureCostMinor: MAX,
      protectedReserveMinor: 0,
    });
    const review = reviewEvidence([evidence(weatherWindow(60, 700, 0.9))], NOW, TENANT);
    const generated = generateCandidates(review.accepted, CTX);
    const result = evaluate({
      now: NOW,
      policy,
      facts: baseFacts(),
      evidence: review,
      candidates: generated,
      modelAdapterId: null,
    });
    expect(result.trace.scores.length).toBeGreaterThan(0);
    for (const s of result.trace.scores) {
      if (s.feasible) {
        expect(Number.isFinite(s.expectedMissionValueMinor)).toBe(true);
        expect(Number.isFinite(s.expectedNetMinor)).toBe(true);
        expect(Number.isFinite(s.effectiveProbability)).toBe(true);
        expect(Math.abs(s.expectedNetMinor)).toBeLessThanOrEqual(MAX);
      }
    }
  });

  it('the standalone validator agrees with the evaluator on a fully hostile object', () => {
    expect(validateCandidate(undefined).ok).toBe(false);
    expect(validateCandidate({ id: 'x' }).ok).toBe(false);
    expect(validateCandidate(validCandidate()).ok).toBe(true);
    expect(validatePolicy(basePolicy()).ok).toBe(true);
    expect(validateFacts(baseFacts()).ok).toBe(true);
  });
});
