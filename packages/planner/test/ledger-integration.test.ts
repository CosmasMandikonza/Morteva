import { describe, expect, it } from 'vitest';
import { openLedger, type Ledger } from '@moterva/ledger';
import type { CandidatePlanView } from '@moterva/domain';
import { TunableClock } from '@moterva/ledger';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCandidates } from '../src/candidates.js';
import { evaluate } from '../src/evaluate.js';
import { reviewEvidence } from '../src/evidence.js';
import { financialFacts, journalDecision, recordDecisionPlan } from '../src/ledger-binding.js';
import { ALTERNATIVE, DIAGNOSTIC, INCUMBENT, basePolicy } from './helpers.js';

/**
 * The planner PROPOSES; the LEDGER disposes. These tests drive a real SQLite
 * ledger end-to-end: facts snapshot honesty, decision plan recording through
 * the existing versioned-plan flow, the ledger re-enforcing every planner
 * pre-check at reservation time (stale approval/plan version, mandate gates),
 * and journal replay.
 */

const NOW_ISO = '2026-11-06T08:00:00.000Z';

function makeWorld(options: { fund?: boolean } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'planner-ledger-')), 'ledger.sqlite');
  const clock = new TunableClock(NOW_ISO);
  const ledger: Ledger = openLedger(path, clock);
  ledger.migrate();
  const org = ledger.organizations.createOrganization('PlannerOrg');
  const mission = ledger.organizations.createMission(org.id, 'harbor turbine inspection');
  const operator = ledger.authority.createHumanActor({
    orgId: org.id,
    username: 'planner-operator',
    displayName: 'Op',
    role: 'operator',
    password: ['dev', 'only', 'fixture'].join('-'),
  });
  const approver = ledger.authority.createHumanActor({
    orgId: org.id,
    username: 'planner-approver',
    displayName: 'Ap',
    role: 'approver',
    password: ['dev', 'only', 'fixture'].join('-'),
  });
  ledger.accounts.ensureTreasuryAccount({
    orgId: org.id,
    currency: 'USD',
    label: 'USD',
    protectedFloorMinor: 0,
  });
  if (options.fund !== false) {
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 8_000_000,
      source: 'manual-seed',
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(),
    });
  }
  return { ledger, clock, org, mission, operator, approver, path };
}

function seededMandate(w: ReturnType<typeof makeWorld>) {
  return ledger_mandate(w);
}
function ledger_mandate(w: ReturnType<typeof makeWorld>) {
  return w.ledger.mandates.issue({
    orgId: w.org.id,
    missionId: w.mission.id,
    currency: 'USD',
    maxAmountMinor: 4_000_000,
    totalBudgetMinor: 4_000_000,
    permittedOperationKinds: ['airwallex_transfer'],
    allowedBeneficiaries: ['ben-harbor-drones', 'ben-marine-alt', 'ben-diagnostics'],
    allowedPurposes: ['harbor inspection'],
    byActorId: w.operator.id,
    expiresAt: new Date(w.clock.now().getTime() + 12 * 3_600_000).toISOString(),
  });
}

const windowEvidence = (clock: TunableClock, seq: number) => ({
  version: 1 as const,
  tenant: { orgId: 'org-x', missionId: 'm-x' }, // patched per-test below
  asset: { id: 'rov-harbor-1', kind: 'underwater-rov' },
  event: {
    id: `evt-l-${seq}`,
    sequence: seq,
    observedAt: clock.iso(),
    ingestedAt: clock.iso(),
  },
  source: { kind: 'weather-service' as const, digest: `d-${seq}` },
  constraint: {
    kind: 'weather-window' as const,
    windowOpensAt: new Date(clock.now().getTime() + 300 * 60_000).toISOString(),
    windowClosesAt: new Date(clock.now().getTime() + 720 * 60_000).toISOString(),
    confidence: 0.95,
  },
  validity: { notAfter: new Date(clock.now().getTime() + 4 * 3_600_000).toISOString() },
});

describe('ledger binding — facts honesty', () => {
  it('mirrors the engine: fresh balance, active mandate, remaining budget', () => {
    const w = makeWorld();
    seededMandate(w);
    const facts = financialFacts(w.ledger, w.org.id, w.mission.id, 'USD');
    expect(facts.balanceStatus).toBe('ok');
    expect(facts.spendableMinor).toBe(8_000_000);
    expect(facts.mandate).not.toBeNull();
    expect(facts.mandate?.remainingBudgetMinor).toBe(4_000_000);
    w.ledger.close();
  });

  it('selects the effective active mandate after a superseded same-version issue', () => {
    const w = makeWorld();
    const older = seededMandate(w);
    const active = seededMandate(w);
    const facts = financialFacts(w.ledger, w.org.id, w.mission.id, 'USD');
    expect(active.id).not.toBe(older.id);
    expect(facts.mandate?.id).toBe(active.id);
    expect(facts.mandate?.expiresAt).toBe(active.expiresAt);
    w.ledger.close();
  });

  it('STALE balance carries status, never a number', () => {
    const w = makeWorld({ fund: false });
    const past = new Date(w.clock.now().getTime() - 2 * 3_600_000);
    w.ledger.accounts.recordBalanceSnapshot({
      orgId: w.org.id,
      currency: 'USD',
      minorUnits: 5_000_000,
      source: 'manual-seed',
      observedAt: new Date(past.getTime() - 60_000).toISOString(),
      expiresAt: past.toISOString(),
    });
    const facts = financialFacts(w.ledger, w.org.id, w.mission.id, 'USD');
    expect(facts.balanceStatus).toBe('stale');
    expect(facts.spendableMinor).toBeNull();
    w.ledger.close();
  });

  it('expired mandate yields mandate null — planner sees MANDATE_EXPIRED upstream', () => {
    const w = makeWorld();
    w.ledger.mandates.issue({
      orgId: w.org.id,
      missionId: w.mission.id,
      currency: 'USD',
      maxAmountMinor: 4_000_000,
      totalBudgetMinor: 4_000_000,
      permittedOperationKinds: ['airwallex_transfer'],
      byActorId: w.operator.id,
      expiresAt: new Date(w.clock.now().getTime() + 5 * 60_000).toISOString(),
    });
    w.clock.advance(10 * 60_000); // mandate expires before evaluation
    const facts = financialFacts(w.ledger, w.org.id, w.mission.id, 'USD');
    expect(facts.mandate).toBeNull();
    w.ledger.close();
  });
});

describe('planner proposes, ledger disposes — commitment gates', () => {
  it('records the selected decision as a candidate plan with the evaluation quote block', () => {
    const w = makeWorld();
    seededMandate(w);
    const ev = {
      ...windowEvidence(w.clock, 1),
      tenant: { orgId: w.org.id, missionId: w.mission.id },
    };
    const review = reviewEvidence([ev], w.clock.now(), {
      orgId: w.org.id,
      missionId: w.mission.id,
    });
    const facts = financialFacts(w.ledger, w.org.id, w.mission.id, 'USD');
    const candidates = generateCandidates(review.accepted, {
      now: w.clock.now(),
      policyCurrency: 'USD',
      missionDeadlineAt: '2026-11-06T20:00:00.000Z',
      incumbent: INCUMBENT,
      alternatives: [ALTERNATIVE],
      diagnosticService: DIAGNOSTIC,
    });
    const decision = evaluate({
      now: w.clock.now(),
      policy: basePolicy(),
      facts,
      evidence: review,
      candidates,
      modelAdapterId: null,
    });
    expect(decision.outcome).toBe('select');
    const { plan } = recordDecisionPlan(w.ledger, decision, {
      orgId: w.org.id,
      missionId: w.mission.id,
      proposedBy: w.operator.id,
    });
    expect(plan).not.toBeNull();
    expect(plan!.terms.beneficiary).toBe(decision.selected!.candidate.beneficiary);
    const quote = plan!.terms.quote as Record<string, unknown>;
    expect(String(quote.plannerEvaluationId)).toBe(decision.trace.evaluationId);

    // The plan alone authorizes nothing: a reservation requires an approval
    // bound to THIS plan version, by a different human (SoD), and the ledger
    // enforces it.
    expect(() =>
      w.ledger.reservations.reserve({
        orgId: w.org.id,
        missionId: w.mission.id,
        kind: 'airwallex_transfer',
        requestId: 'req-no-approval',
        planId: plan!.id,
        planVersion: plan!.version,
        approvalId: 'approval-nonexistent',
      }),
    ).toThrow();

    const approval = w.ledger.approvals.record({
      orgId: w.org.id,
      plan: plan as CandidatePlanView,
      decidedByActorId: w.approver.id,
      kind: 'airwallex_transfer',
      mandateId: facts.mandate!.id,
      mandateVersion: facts.mandate!.version,
      expiresAt: new Date(w.clock.now().getTime() + 3_600_000).toISOString(),
    });
    const reserved = w.ledger.reservations.reserve({
      orgId: w.org.id,
      missionId: w.mission.id,
      kind: 'airwallex_transfer',
      requestId: 'req-plan-1',
      planId: plan!.id,
      planVersion: plan!.version,
      approvalId: approval.id,
    });
    expect(reserved.operation.state).toBe('RESERVED');
    // Facts now show the commitment consuming capacity.
    const factsAfter = financialFacts(w.ledger, w.org.id, w.mission.id, 'USD');
    expect(factsAfter.spendableMinor).toBe(8_000_000 - reserved.operation.amountMinor);
    w.ledger.close();
  });

  it('STALE APPROVAL/PLAN VERSION: approving v1 then proposing v2 is rejected by the LEDGER', () => {
    const w = makeWorld();
    seededMandate(w);
    const ev = {
      ...windowEvidence(w.clock, 1),
      tenant: { orgId: w.org.id, missionId: w.mission.id },
    };
    const review = reviewEvidence([ev], w.clock.now(), {
      orgId: w.org.id,
      missionId: w.mission.id,
    });
    const candidates = generateCandidates(review.accepted, {
      now: w.clock.now(),
      policyCurrency: 'USD',
      missionDeadlineAt: '2026-11-06T20:00:00.000Z',
      incumbent: INCUMBENT,
      alternatives: [ALTERNATIVE],
      diagnosticService: DIAGNOSTIC,
    });
    const decision = evaluate({
      now: w.clock.now(),
      policy: basePolicy(),
      facts: financialFacts(w.ledger, w.org.id, w.mission.id, 'USD'),
      evidence: review,
      candidates,
      modelAdapterId: null,
    });
    const { plan: v1 } = recordDecisionPlan(w.ledger, decision, {
      orgId: w.org.id,
      missionId: w.mission.id,
      proposedBy: w.operator.id,
    });
    const approvalV1 = w.ledger.approvals.record({
      orgId: w.org.id,
      plan: v1 as CandidatePlanView,
      decidedByActorId: w.approver.id,
      kind: 'airwallex_transfer',
      expiresAt: new Date(w.clock.now().getTime() + 3_600_000).toISOString(),
    });
    // New evidence → a materially different, cheaper plan v2 under the SAME
    // plan identity (terms changed → new digest → v1 approval cannot serve).
    const v2 = w.ledger.plans.recordVersion({
      orgId: w.org.id,
      missionId: w.mission.id,
      planId: v1!.id,
      proposedBy: w.operator.id,
      terms: {
        amountMinor: v1!.terms.amountMinor === 60_000 ? 1_000 : 60_000,
        currency: 'USD',
        beneficiary: decision.selected!.candidate.beneficiary,
        purpose: 'harbor inspection — revised after weather update',
        quote: { revised: true },
      },
    });
    expect(v2.version).toBe(2);
    let rejected = false;
    try {
      w.ledger.reservations.reserve({
        orgId: w.org.id,
        missionId: w.mission.id,
        kind: 'airwallex_transfer',
        requestId: 'req-stale-approval',
        planId: v2.id,
        planVersion: v2.version,
        approvalId: approvalV1.id, // bound to v1's digest
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true); // the LEDGER refuses the stale approval
    w.ledger.close();
  });

  it('journals decisions append-only and replays them from the evidence log', () => {
    const w = makeWorld();
    seededMandate(w);
    const ev = {
      ...windowEvidence(w.clock, 1),
      tenant: { orgId: w.org.id, missionId: w.mission.id },
    };
    const review = reviewEvidence([ev], w.clock.now(), {
      orgId: w.org.id,
      missionId: w.mission.id,
    });
    const candidates = generateCandidates(review.accepted, {
      now: w.clock.now(),
      policyCurrency: 'USD',
      missionDeadlineAt: '2026-11-06T20:00:00.000Z',
      incumbent: INCUMBENT,
      alternatives: [ALTERNATIVE],
      diagnosticService: DIAGNOSTIC,
    });
    const decision = evaluate({
      now: w.clock.now(),
      policy: basePolicy(),
      facts: financialFacts(w.ledger, w.org.id, w.mission.id, 'USD'),
      evidence: review,
      candidates,
      modelAdapterId: null,
    });
    journalDecision(w.ledger, decision, { orgId: w.org.id, missionId: w.mission.id });
    const replayed = w.ledger.evidence.list(w.org.id, { topic: 'operational' });
    const plannerEvent = replayed.find((e) => e.type === 'planner.decision');
    expect(plannerEvent).toBeDefined();
    expect(plannerEvent!.payloadDigest).toMatch(/^[0-9a-f]{16,}/);
    // The stored payload round-trips the decision identity and label.
    const stored = w.ledger.db
      .prepare('SELECT payload_json FROM evidence_events WHERE id = ?')
      .get(plannerEvent!.id) as { payload_json: string };
    const payload = JSON.parse(stored.payload_json) as { evaluationId: string; truthLabel: string };
    expect(payload.evaluationId).toBe(decision.trace.evaluationId);
    expect(payload.truthLabel).toContain('SIMULATED_OPERATION');
    expect(payload.truthLabel).toContain('POLICY-ONLY');
    w.ledger.close();
  });
});
