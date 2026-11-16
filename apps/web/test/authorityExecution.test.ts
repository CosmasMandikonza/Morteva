import { describe, expect, it } from 'vitest';
import {
  approvalFor,
  authorityByCurrency,
  formatWindow,
  historyPresentation,
  isActionableProposal,
  journeySteps,
  operationForPlan,
  proposalStateEntry,
  proposalStats,
  splitMandates,
} from '../src/screens/AuthorityExecution';
import type {
  DecisionPlanProposal,
  MandateRow,
  OperationReadView,
  RecordedApproval,
} from '../src/lib/api';

/**
 * Authority & Execution console — the pure derivations behind the screen:
 * mandate effectivity, per-currency rollups (unlike currencies never merged),
 * actionability (role + CSRF), and the journal-evidenced journey stepper.
 * A step is "done" ONLY with ledger proof; approval is never conflated with
 * reservation or settlement.
 */

const NOW = new Date('2026-11-15T12:00:00.000Z');

function mandate(overrides: Partial<MandateRow> = {}): MandateRow {
  return {
    id: 'md-1',
    mission_id: 'ms-1',
    version: 1,
    status: 'active',
    currency: 'USD',
    max_amount_minor: 8_000_000,
    total_budget_minor: 15_000_000,
    permitted_kinds_json: '["airwallex_transfer"]',
    rails_json: null,
    allowed_beneficiaries_json: null,
    allowed_purposes_json: null,
    require_separate_approver: 1,
    expires_at: '2026-11-16T12:00:00.000Z',
    revoked_at: null,
    created_at: '2026-11-14T12:00:00.000Z',
    consumed_minor: 7_350_000,
    remaining_minor: 7_650_000,
    ...overrides,
  };
}

function plan(overrides: Partial<DecisionPlanProposal['plan']> = {}): DecisionPlanProposal {
  return {
    evaluationId: 'ev-1',
    proposedBy: 'actor-operator',
    plan: {
      id: 'pl-1',
      version: 2,
      digest: 'd'.repeat(64),
      createdAt: '2026-11-15T10:00:00.000Z',
      terms: {
        amountMinor: 6_000_000,
        currency: 'USD',
        beneficiary: 'harbor-diagnostics',
        purpose: 'diagnostic sweep',
      },
      ...overrides,
    },
    providerVerified: false,
  };
}

function approval(overrides: Partial<RecordedApproval> = {}): RecordedApproval {
  return {
    approvalId: 'ap-1',
    planId: 'pl-1',
    planVersion: 2,
    planDigest: 'd'.repeat(64),
    decidedBy: 'actor-approver',
    kind: 'airwallex_transfer',
    expiresAt: '2026-11-16T10:00:00.000Z',
    ...overrides,
  };
}

function operation(overrides: Partial<OperationReadView> = {}): OperationReadView {
  return {
    id: 'op-1',
    missionId: 'ms-1',
    kind: 'airwallex_transfer',
    requestId: 'req-1',
    state: 'RESERVED',
    attention: 'none',
    amount: { minorUnits: 6_000_000, major: '60,000.00', currency: 'USD' },
    beneficiary: 'harbor-diagnostics',
    purpose: 'diagnostic sweep',
    planId: 'pl-1',
    planVersion: 2,
    commitment: { state: 'RESERVED', finalizedAt: null },
    dispatch: null,
    createdAt: '2026-11-15T11:00:00.000Z',
    updatedAt: '2026-11-15T11:00:00.000Z',
    ...overrides,
  };
}

describe('splitMandates — effective authority is active AND unexpired', () => {
  it('keeps active unexpired mandates effective', () => {
    const { effective, history } = splitMandates(
      [mandate(), mandate({ id: 'md-2', status: 'superseded' })],
      NOW,
    );
    expect(effective.map((m) => m.id)).toEqual(['md-1']);
    expect(history.map((m) => m.id)).toEqual(['md-2']);
  });

  it('a wall-clock-lapsed active mandate is history, never spendable', () => {
    const lapsed = mandate({
      id: 'md-gbp',
      currency: 'GBP',
      expires_at: '2026-11-15T11:59:59.000Z',
    });
    const { effective, history } = splitMandates([lapsed], NOW);
    expect(effective).toHaveLength(0);
    expect(history.map((m) => m.id)).toEqual(['md-gbp']);
  });

  it('expiry exactly at now is already lapsed (no boundary spend)', () => {
    const { effective } = splitMandates([mandate({ expires_at: '2026-11-15T12:00:00.000Z' })], NOW);
    expect(effective).toHaveLength(0);
  });

  it('revoked mandates are always history', () => {
    const { effective, history } = splitMandates(
      [mandate({ id: 'md-r', status: 'revoked', revoked_at: '2026-11-15T00:00:00.000Z' })],
      NOW,
    );
    expect(effective).toHaveLength(0);
    expect(history).toHaveLength(1);
  });
});

describe('authorityByCurrency — per-currency rollup, never mixed units', () => {
  it('aggregates same-currency envelopes and keeps unlike currencies apart', () => {
    const rollups = authorityByCurrency([
      mandate({
        id: 'a',
        currency: 'USD',
        max_amount_minor: 8_000_000,
        total_budget_minor: 15_000_000,
        remaining_minor: 7_650_000,
      }),
      mandate({
        id: 'b',
        currency: 'USD',
        version: 3,
        max_amount_minor: 5_000_000,
        total_budget_minor: 10_000_000,
        remaining_minor: 9_000_000,
      }),
      mandate({
        id: 'c',
        currency: 'EUR',
        max_amount_minor: 1_500_000,
        total_budget_minor: 4_000_000,
        remaining_minor: 4_000_000,
      }),
    ]);
    expect(rollups).toHaveLength(2);
    const usd = rollups.find((r) => r.currency === 'USD');
    const eur = rollups.find((r) => r.currency === 'EUR');
    expect(usd).toMatchObject({
      count: 2,
      capMinor: 8_000_000, // max per-action cap, never a sum of caps
      totalMinor: 25_000_000,
      remainingMinor: 16_650_000,
    });
    expect(eur).toMatchObject({ count: 1, totalMinor: 4_000_000 });
  });

  it('sorts by currency code deterministically', () => {
    const rollups = authorityByCurrency([
      mandate({ currency: 'EUR' }),
      mandate({ currency: 'USD' }),
    ]);
    expect(rollups.map((r) => r.currency)).toEqual(['EUR', 'USD']);
  });
});

describe('historyPresentation — a lapsed mandate is never “active”', () => {
  it('status active but wall-clock expired renders Lapsed — not spendable', () => {
    const entry = historyPresentation(
      mandate({ status: 'active', expires_at: '2026-11-15T11:00:00.000Z' }),
      NOW,
    );
    expect(entry.label).toBe('Lapsed — not spendable');
    expect(entry.tone).toBe('hold');
  });
  it('ledger-terminal statuses keep their own presentation', () => {
    expect(historyPresentation(mandate({ status: 'superseded' }), NOW).label).toBe('Superseded');
    expect(historyPresentation(mandate({ status: 'expired' }), NOW).label).toBe('Mandate expired');
    expect(historyPresentation(mandate({ status: 'revoked' }), NOW).label).toBe('Mandate revoked');
  });
});

describe('approvalFor / proposalStats — version-exact matching', () => {
  it('matches id AND version; a stale version is not this plan’s approval', () => {
    const stale = [approval({ planVersion: 1 })];
    expect(approvalFor(stale, 'pl-1', 2)).toBeNull();
    expect(approvalFor(stale, 'pl-1', 1)?.approvalId).toBe('ap-1');
  });

  it('counts open vs approved across plans', () => {
    const stats = proposalStats(
      [plan(), plan({ id: 'pl-2' }), plan({ id: 'pl-3' })],
      [approval(), approval({ planId: 'pl-3' })],
    );
    expect(stats).toEqual({ open: 1, approved: 2, total: 3 });
  });
});

describe('isActionableProposal — server role AND CSRF both required', () => {
  it('approver with CSRF may act on an unapproved plan', () => {
    expect(isActionableProposal(plan(), [], 'approver', 'csrf-token')).toBe(true);
  });
  it('owner and admin may act; operator and viewer may not', () => {
    expect(isActionableProposal(plan(), [], 'owner', 't')).toBe(true);
    expect(isActionableProposal(plan(), [], 'admin', 't')).toBe(true);
    expect(isActionableProposal(plan(), [], 'operator', 't')).toBe(false);
    expect(isActionableProposal(plan(), [], 'viewer', 't')).toBe(false);
    expect(isActionableProposal(plan(), [], null, 't')).toBe(false);
  });
  it('no CSRF → not actionable (read-only, never a fake affordance)', () => {
    expect(isActionableProposal(plan(), [], 'approver', null)).toBe(false);
  });
  it('already-approved plans are never actionable', () => {
    expect(isActionableProposal(plan(), [approval()], 'approver', 't')).toBe(false);
  });
});

describe('journeySteps — every done step needs ledger evidence', () => {
  const freshPlan = plan();

  it('fresh proposal as operator: only Proposed is done; approval names the other actor', () => {
    const steps = journeySteps(freshPlan, null, null, 'operator');
    expect(steps.map((s) => [s.key, s.state])).toEqual([
      ['proposed', 'done'],
      ['approved', 'active'],
      ['reserved', 'pending'],
      ['submitted', 'pending'],
      ['verified', 'pending'],
    ]);
    expect(steps[1]?.note).toBe('different actor required');
    expect(steps[3]?.note).toContain('provider rail');
  });

  it('fresh proposal as approver: approval is awaiting YOUR approval', () => {
    const steps = journeySteps(freshPlan, null, null, 'approver');
    expect(steps[1]?.note).toBe('awaiting your approval');
  });

  it('journal-verified approval marks Approved done — reservation still pending', () => {
    const steps = journeySteps(freshPlan, approval(), null, 'operator');
    expect(steps[1]?.state).toBe('done');
    expect(steps[1]?.note).toContain('journal-verified');
    expect(steps[2]?.state).toBe('pending');
    expect(steps[4]?.state).toBe('pending');
  });

  it('a RESERVED internal hold proves reservation but never implies a provider submission', () => {
    const steps = journeySteps(
      freshPlan,
      approval(),
      operation({ kind: 'internal_hold', dispatch: null }),
      'operator',
    );
    expect(steps[2]?.state).toBe('done');
    expect(steps[2]?.note).toContain('internal ledger hold');
    expect(steps[3]?.state).toBe('pending');
    expect(steps[3]?.label).toBe('Internal completion');
    expect(steps.some((step) => step.label === 'Submitted')).toBe(false);
  });

  it('an outbox rail plus SUBMITTING proves submission', () => {
    const steps = journeySteps(
      freshPlan,
      approval(),
      operation({
        state: 'SUBMITTING',
        dispatch: { rail: 'airwallex', attempts: 1, status: 'pending' },
      }),
      'operator',
    );
    expect(steps[3]?.state).toBe('done');
    expect(steps[3]?.note).toContain('airwallex');
    expect(steps[4]?.state).toBe('pending'); // submitted ≠ verified
  });

  it('provider-rail SETTLED is provider-verified; internal completion has its own path', () => {
    const providerSteps = journeySteps(
      freshPlan,
      approval(),
      operation({
        state: 'SETTLED',
        dispatch: { rail: 'airwallex', attempts: 1, status: 'sent' },
      }),
      'operator',
    );
    expect(providerSteps[4]?.state).toBe('done');
    expect(providerSteps[4]?.note).toContain('provider readback attested');

    const internalSteps = journeySteps(
      freshPlan,
      approval(),
      operation({ state: 'RECONCILED', kind: 'internal_hold', dispatch: null }),
      'operator',
    );
    expect(internalSteps).toHaveLength(4);
    expect(internalSteps[3]?.state).toBe('done');
    expect(internalSteps[3]?.label).toBe('Reconciled internally');
    expect(internalSteps[3]?.note).toContain('no provider dispatch');
    expect(internalSteps.map((step) => step.label)).not.toContain('Verified settled');

    const undispatchedSteps = journeySteps(
      freshPlan,
      approval(),
      operation({ state: 'SETTLED', kind: 'airwallex_transfer', dispatch: null }),
      'operator',
    );
    expect(undispatchedSteps[3]?.label).toBe('Completed internally');
    expect(undispatchedSteps[3]?.note).toContain('no provider dispatch');
  });

  it('STATUS_UNKNOWN halts nothing falsely: submission is unknown, verified stays pending', () => {
    const steps = journeySteps(
      freshPlan,
      approval(),
      operation({ state: 'STATUS_UNKNOWN' }),
      'operator',
    );
    expect(steps[3]?.state).toBe('unknown');
    expect(steps[4]?.state).toBe('pending');
  });

  it('a REJECTED reservation marks Reserved halted, never done', () => {
    const steps = journeySteps(freshPlan, approval(), operation({ state: 'REJECTED' }), 'operator');
    expect(steps[2]?.state).toBe('halted');
    expect(steps[2]?.note).toContain('reservation refused');
  });
});

describe('proposalStateEntry — approval is not reservation is not settlement', () => {
  it('unapproved → neutral Proposed label that says nothing moved', () => {
    const entry = proposalStateEntry(null, null);
    expect(entry.tone).toBe('neutral');
    expect(entry.label).toBe('Proposed — awaiting approval');
  });
  it('approved without an operation → info Approved — awaiting reservation', () => {
    const entry = proposalStateEntry(approval(), null);
    expect(entry.tone).toBe('info');
    expect(entry.label).toBe('Approved — awaiting reservation');
  });
  it('an operation takes over: rail-aware operation truth', () => {
    const reserved = proposalStateEntry(approval(), operation({ state: 'RESERVED' }));
    expect(reserved.label).toBe('Reserved');
    const inFlight = proposalStateEntry(
      approval(),
      operation({
        state: 'SETTLED',
        dispatch: { rail: 'airwallex', attempts: 1, status: 'sent' },
      }),
    );
    expect(inFlight.tone).toBe('verified'); // provider readback only
    const internal = proposalStateEntry(
      approval(),
      operation({ state: 'SETTLED', kind: 'internal_hold', dispatch: null }),
    );
    expect(internal.tone).toBe('info'); // internal completion never borrows green
    expect(internal.label).toBe('Completed internally');
  });
});

describe('operationForPlan — id + version match', () => {
  it('matches the plan’s own operation only', () => {
    const ops = [operation({ planId: 'pl-9' }), operation()];
    expect(operationForPlan(ops, 'pl-1', 2)?.id).toBe('op-1');
    expect(operationForPlan(ops, 'pl-1', 3)).toBeNull();
  });
});

describe('formatWindow — compact relative expiry, honest fallbacks', () => {
  it('minutes, hours and days render compactly', () => {
    expect(formatWindow('2026-11-15T12:45:00.000Z', NOW)).toBe('in 45m');
    expect(formatWindow('2026-11-16T14:00:00.000Z', NOW)).toBe('in 26h');
    expect(formatWindow('2026-11-18T12:00:00.000Z', NOW)).toBe('in 3d');
  });
  it('the past renders "ago"; far futures fall back to the absolute date', () => {
    expect(formatWindow('2026-11-15T11:50:00.000Z', NOW)).toBe('10m ago');
    expect(formatWindow('2026-11-15T10:00:00.000Z', NOW)).toBe('2h ago');
    expect(formatWindow('2027-05-15T12:00:00.000Z', NOW)).toMatch(/2027/);
  });
  it('invalid timestamps render raw, never a guessed window', () => {
    expect(formatWindow('not-a-date', NOW)).toBe('not-a-date');
  });
});
