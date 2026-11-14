import { describe, expect, it } from 'vitest';
import { generateCandidates } from '../src/candidates.js';
import { evaluate } from '../src/evaluate.js';
import { reviewEvidence } from '../src/evidence.js';
import type { EvaluationInput } from '../src/evaluate.js';
import type {
  FinancialFacts,
  FinancialPolicy,
  MissionEvidenceInput,
  PlannerCandidate,
} from '../src/contracts.js';
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

function run(
  evidenceInputs: MissionEvidenceInput[],
  options: {
    policy?: Partial<FinancialPolicy>;
    facts?: Partial<FinancialFacts>;
    candidates?: PlannerCandidate[];
    modelAdapterId?: string | null;
    modelOutage?: { adapterId: string; message: string };
  } = {},
) {
  const review = reviewEvidence(evidenceInputs, NOW, {
    orgId: 'org_demo',
    missionId: 'mission_harbor',
  });
  const ctx = {
    now: NOW,
    policyCurrency: 'USD',
    missionDeadlineAt: '2026-11-06T20:00:00.000Z',
    incumbent: INCUMBENT,
    alternatives: [ALTERNATIVE],
    diagnosticService: DIAGNOSTIC,
  };
  const candidates = options.candidates ?? generateCandidates(review.accepted, ctx);
  const input: EvaluationInput = {
    now: NOW,
    policy: basePolicy(options.policy),
    facts: baseFacts(options.facts),
    evidence: review,
    candidates,
    modelAdapterId: options.modelAdapterId ?? null,
    modelOutage: options.modelOutage,
  };
  return { result: evaluate(input), input, review };
}

describe('core evaluator — deterministic selection and justification', () => {
  it('same state reproduces the identical decision, bit for bit', () => {
    const inputs = [evidence(weatherWindow(180, 420, 0.85))];
    const a = run(inputs);
    const b = run(inputs);
    expect(a.result.trace.evaluationId).toBe(b.result.trace.evaluationId);
    expect(a.result.selected?.candidate.id).toBe(b.result.selected?.candidate.id);
    expect(JSON.stringify(a.result.trace.scores)).toBe(JSON.stringify(b.result.trace.scores));
  });

  it('DECISION FLIP 1: a moving weather window changes hold-course → paid reschedule', () => {
    // Comfortable window covering the nominal flight: hold-course (zero new
    // spend, same delivery probability) is the economically justified plan.
    const before = run([evidence(weatherWindow(60, 700, 0.95))]);
    expect(before.result.outcome).toBe('select');
    expect(before.result.selected?.candidate.kind).toBe('no-action');

    // The window MOVES past the nominal flight: holding forfeits the
    // mission, and rescheduling the SAME supplier into the window delivers
    // the identical probability for a 5% fee instead of a full new contract
    // — a genuinely justified, cheaper-than-alternative decision.
    const after = run([evidence(weatherWindow(300, 720, 0.95))]);
    expect(after.result.outcome).toBe('select');
    expect(after.result.selected?.candidate.kind).toBe('reschedule');
    expect(after.result.selected?.candidate.id).not.toBe(before.result.selected?.candidate.id);
    // Financial justification is quantified in the trace.
    expect(after.result.selected?.expectedNetMinor).toBeGreaterThan(0);
    const cont = after.result.trace.scores.find((sc) => sc.candidate.kind === 'continue-supplier');
    expect(after.result.selected!.grossCostMinor).toBeLessThan(cont!.grossCostMinor);
    expect(after.result.trace.truthLabel).toContain('SIMULATED_OPERATION');
    expect(after.result.trace.truthLabel).toContain('POLICY-ONLY');
  });

  it('DECISION FLIP 2: an alternative becomes optimal when the incumbent is delayed past the deadline', () => {
    const before = run([evidence(weatherWindow(60, 720, 0.9))]);
    expect(before.result.selected?.candidate.kind).toBe('no-action'); // nominal flight inside the window: hold course

    const delay = evidence({
      kind: 'contractor-delay',
      contractorId: 'harbor-drones',
      delayMinutes: 600,
    });
    const after = run([evidence(weatherWindow(120, 720, 0.9)), delay]);
    // The incumbent's delayed start (120 lead + 600 delay + 240 duration)
    // exceeds the deadline → continue/reschedule/no-action collapse; the
    // faster alternative wins on expected net.
    expect(after.result.outcome).toBe('select');
    expect(after.result.selected?.candidate.kind).toBe('hire-alternative');
    const declinedContinue = after.result.declined.find(
      (d) => d.candidate.kind === 'continue-supplier',
    );
    expect(declinedContinue?.rejection?.code).toBe('DEADLINE_INFEASIBLE');
  });

  it('REFUSAL: a diagnostic purchase that cannot justify its price is declined with a machine reason', () => {
    const finding = evidence({
      kind: 'diagnostic-finding',
      severity: 'low',
      detail: 'minor fouling',
    });
    const { result } = run([finding]);
    const diag = [...result.declined, ...result.runnersUp].find(
      (s) => s.candidate.kind === 'purchase-diagnostics',
    );
    expect(diag).toBeDefined();
    expect(diag?.rejection?.code).toBe('INFORMATION_NOT_WORTH_PRICE');
    expect(diag?.rejection?.reason).toMatch(/value of information/);
  });

  it('PURSUIT: a high-severity finding can justify the same diagnostic purchase', () => {
    const finding = evidence({
      kind: 'diagnostic-finding',
      severity: 'high',
      detail: 'blade anomaly',
    });
    const { result } = run([finding]);
    const diag = result.trace.scores.find((s) => s.candidate.kind === 'purchase-diagnostics');
    expect(diag?.feasible ?? false).toBe(true);
  });

  it('quantified trade-offs: every score carries gross cost, effective probability and labeled assumptions', () => {
    const { result } = run([evidence(weatherWindow(120, 720, 0.9))]);
    for (const score of result.trace.scores) {
      expect(Number.isFinite(score.grossCostMinor)).toBe(true);
      expect(score.effectiveProbability).toBeGreaterThanOrEqual(0);
      expect(score.effectiveProbability).toBeLessThanOrEqual(1);
      expect(score.assumptions.length).toBeGreaterThan(0);
    }
    expect(result.reasons.some((r) => r.code === 'POLICY_ONLY')).toBe(true);
  });

  it('every selected reason cites accepted evidence IDs', () => {
    const inputs = [evidence(weatherWindow(120, 720, 0.9))];
    const { result } = run(inputs);
    const selectedReason = result.reasons.find((r) => r.code === 'SELECTED');
    expect(selectedReason).toBeDefined();
    expect(selectedReason!.evidenceIds).toContain(inputs[0]!.event.id);
  });
});
