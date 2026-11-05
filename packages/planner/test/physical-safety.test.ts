import { describe, expect, it } from 'vitest';
import { generateCandidates } from '../src/candidates.js';
import { evaluate } from '../src/evaluate.js';
import { reviewEvidence } from '../src/evidence.js';
import { ALTERNATIVE, INCUMBENT, NOW, TENANT, baseFacts, basePolicy, evidence } from './helpers.js';

const asset = { id: 'uav-seeker-1', kind: 'uav' } as const;

function decision(state: 'clear' | 'blocked' | 'unknown') {
  const physical = evidence(
    {
      kind: 'asset-safety',
      state,
      reason: state === 'blocked' ? 'wind-limit' : state === 'unknown' ? 'insufficient-evidence' : 'nominal',
      observedWindKt: state === 'blocked' ? 24.6 : 14.2,
      maxWindKt: 22,
    },
    { asset },
  );
  const review = reviewEvidence([physical], NOW, TENANT);
  const candidates = generateCandidates(review.accepted, {
    now: NOW,
    policyCurrency: 'USD',
    missionDeadlineAt: basePolicy().missionDeadlineAt,
    incumbent: INCUMBENT,
    incumbentAssetId: asset.id,
    alternatives: [ALTERNATIVE],
  });
  const result = evaluate({
    now: NOW,
    policy: basePolicy(),
    facts: baseFacts(),
    evidence: review,
    candidates,
    modelAdapterId: null,
  });
  return { review, candidates, result };
}

describe('physical safety → economic candidate gate', () => {
  it('accepts an explicitly cleared admitted UAV and scores it normally', () => {
    const { result } = decision('clear');
    const incumbent = result.trace.scores.find((s) => s.candidate.kind === 'continue-supplier');
    expect(incumbent?.feasible).toBe(true);
  });

  it('blocks a wind-unsafe UAV before ranking while preserving a non-UAV alternative', () => {
    const { result, candidates } = decision('blocked');
    const incumbent = result.trace.scores.find((s) => s.candidate.kind === 'continue-supplier');
    const vessel = result.trace.scores.find((s) => s.candidate.kind === 'hire-alternative');
    expect(incumbent?.feasible).toBe(false);
    expect(incumbent?.rejection?.code).toBe('ASSET_SAFETY_BLOCKED');
    expect(vessel?.rejection?.code).not.toBe('ASSET_SAFETY_BLOCKED');
    expect(candidates.find((c) => c.kind === 'no-action')?.label).toContain('Pause');
  });

  it('missing or unknown physical clearance never makes a UAV candidate eligible', () => {
    const unknown = decision('unknown');
    expect(unknown.result.trace.scores.find((s) => s.candidate.kind === 'continue-supplier')?.rejection?.code).toBe('ASSET_SAFETY_BLOCKED');
    const emptyReview = reviewEvidence([], NOW, TENANT);
    const candidates = generateCandidates(emptyReview.accepted, {
      now: NOW,
      policyCurrency: 'USD',
      missionDeadlineAt: basePolicy().missionDeadlineAt,
      incumbent: INCUMBENT,
      incumbentAssetId: asset.id,
      alternatives: [ALTERNATIVE],
    });
    const result = evaluate({
      now: NOW, policy: basePolicy(), facts: baseFacts(),
      evidence: emptyReview, candidates, modelAdapterId: null,
    });
    expect(result.trace.scores.find((s) => s.candidate.kind === 'continue-supplier')?.rejection?.code).toBe('ASSET_SAFETY_BLOCKED');
  });
});
