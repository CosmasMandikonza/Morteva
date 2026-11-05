/**
 * Harbor inspection demo (issue #8) — runnable offline demonstration of the
 * adaptive mission-finance engine against a REAL SQLite ledger:
 *
 *   initial plan → new timestamped evidence → materially different revised
 *   decision → refusal (declines an uneconomic action) → escalation → replay
 *
 * Every printed trace carries the honest labels:
 *   SIMULATED_OPERATION — POLICY-ONLY (deterministic policy evaluation; no
 *   live model inference). No provider funds are claimed anywhere.
 *
 * Run: npm run demo:harbor -w @moterva/planner
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, TunableClock, type Ledger } from '@moterva/ledger';
import { generateCandidates } from '../candidates.js';
import { evaluate } from '../evaluate.js';
import { reviewEvidence } from '../evidence.js';
import { financialFacts, journalDecision } from '../ledger-binding.js';
import type { GenerationContext, SupplierOffer } from '../candidates.js';
import type { FinancialPolicy, MissionEvidenceInput } from '../contracts.js';

const LABEL =
  'SIMULATED_OPERATION — POLICY-ONLY (deterministic policy evaluation; no live model inference)';

function line(title: string): void {
  console.info('\n' + '='.repeat(78));
  console.info(title);
  console.info('='.repeat(78));
}

function printDecision(
  index: number,
  heading: string,
  decision: ReturnType<typeof evaluate>,
): void {
  line(`DECISION ${index}: ${heading}`);
  console.info(`[${LABEL}]`);
  console.info(`outcome: ${decision.outcome}`);
  if (decision.selected !== null) {
    const c = decision.selected.candidate;
    console.info(
      `selected: ${c.label} (${c.id}) — gross $${(c.costMinor + c.feeMinor) / 100} | effective p=${decision.selected.effectiveProbability.toFixed(3)} | expected net $${decision.selected.expectedNetMinor / 100}`,
    );
    console.info(`evidence cited: ${c.evidenceIds.join(', ') || '(none required)'}`);
  }
  for (const r of decision.reasons) {
    console.info(
      `reason [${r.code}]: ${r.message}${r.evidenceIds.length > 0 ? ` (evidence: ${r.evidenceIds.join(', ')})` : ''}`,
    );
  }
  console.info('alternatives considered:');
  for (const s of decision.trace.scores) {
    const verdict = s.feasible
      ? `net=${String(s.expectedNetMinor / 100)}`
      : `REJECTED ${s.rejection?.code}: ${s.rejection?.reason}`;
    console.info(
      `  - ${s.candidate.id.padEnd(24)} gross=${String((s.candidate.costMinor + s.candidate.feeMinor) / 100).padStart(9)} ${verdict}`,
    );
  }
  console.info(`trace evaluationId: ${decision.trace.evaluationId}`);
}

const INCUMBENT: SupplierOffer = {
  id: 'harbor-drones',
  kind: 'inspection-service',
  beneficiary: 'ben-harbor-drones',
  purpose: 'harbor inspection',
  currency: 'USD',
  baseCostMinor: 1_200_000,
  feeMinor: 0,
  leadTimeMinutes: 120,
  durationMinutes: 240,
  probabilityOfSuccess: 0.9,
  availability: 'confirmed',
};

const ALTERNATIVE: SupplierOffer = {
  id: 'marine-alt',
  kind: 'inspection-service',
  beneficiary: 'ben-marine-alt',
  purpose: 'harbor inspection',
  currency: 'USD',
  baseCostMinor: 1_800_000,
  feeMinor: 50_000,
  leadTimeMinutes: 60,
  durationMinutes: 180,
  probabilityOfSuccess: 0.85,
  availability: 'confirmed',
};

const DIAGNOSTIC: SupplierOffer = {
  id: 'diag-service',
  kind: 'diagnostic-service',
  beneficiary: 'ben-diag',
  purpose: 'harbor inspection',
  currency: 'USD',
  baseCostMinor: 400_000,
  feeMinor: 0,
  leadTimeMinutes: 30,
  durationMinutes: 60,
  probabilityOfSuccess: 0.95,
  availability: 'confirmed',
};

const POLICY: FinancialPolicy = {
  version: 1,
  currency: 'USD',
  missionDeadlineAt: '2026-11-06T20:00:00.000Z',
  missionValueMinor: 5_000_000,
  failureCostMinor: 1_500_000,
  protectedReserveMinor: 200_000,
  maxProbabilityAssumption: 0.95,
  unconfirmedAvailabilityFactor: 0.5,
  diagnosticValueThreshold: 1.0,
  forbidUnconfirmedAvailability: false,
  escalationScoreGap: 10_000,
};

let DEMO_TENANT = { orgId: 'uninitialized', missionId: 'uninitialized' };

function ev(
  clock: TunableClock,
  seq: number,
  constraint: MissionEvidenceInput['constraint'],
  sourceKind: MissionEvidenceInput['source']['kind'] = 'weather-service',
): MissionEvidenceInput {
  return {
    version: 1,
    tenant: DEMO_TENANT,
    asset: { id: 'rov-harbor-1', kind: 'underwater-rov' },
    event: {
      id: `evt-demo-${seq}`,
      sequence: seq,
      observedAt: clock.iso(),
      ingestedAt: clock.iso(),
    },
    source: { kind: sourceKind, digest: `demo-digest-${seq}` },
    constraint,
    validity: { notAfter: new Date(clock.now().getTime() + 4 * 3_600_000).toISOString() },
  };
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'moterva-harbor-demo-'));
  const ledger: Ledger = openLedger(
    join(dir, 'harbor.sqlite'),
    new TunableClock('2026-11-06T08:00:00.000Z'),
  );
  const clock = ledger.clock as TunableClock;

  try {
    ledger.migrate();
    const org = ledger.organizations.createOrganization('Harbor Operator Demo');
    const mission = ledger.organizations.createMission(org.id, 'offshore turbine inspection');
    const operator = ledger.authority.createHumanActor({
      orgId: org.id,
      username: 'demo-operator',
      displayName: 'Demo Operator',
      role: 'operator',
      password: ['demo', 'only', 'fixture'].join('-'),
    });
    ledger.authority.createHumanActor({
      orgId: org.id,
      username: 'demo-approver',
      displayName: 'Demo Approver',
      role: 'approver',
      password: ['demo', 'only', 'fixture'].join('-'),
    });
    ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'USD',
      label: 'USD',
      protectedFloorMinor: 0,
    });
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 8_000_000,
      source: 'manual-seed', // honestly labeled operator input, NOT provider-verified funds
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(),
    });
    ledger.mandates.issue({
      orgId: org.id,
      missionId: mission.id,
      currency: 'USD',
      maxAmountMinor: 4_000_000,
      totalBudgetMinor: 4_000_000,
      permittedOperationKinds: ['airwallex_transfer'],
      allowedBeneficiaries: ['ben-harbor-drones', 'ben-marine-alt', 'ben-diag'],
      allowedPurposes: ['harbor inspection'],
      byActorId: operator.id,
      expiresAt: new Date(clock.now().getTime() + 12 * 3_600_000).toISOString(),
    });

    const tenant = { orgId: org.id, missionId: mission.id };
    DEMO_TENANT = tenant;
    const ctx = (deadlineAt = POLICY.missionDeadlineAt): GenerationContext => ({
      now: clock.now(),
      policyCurrency: 'USD',
      missionDeadlineAt: deadlineAt,
      incumbent: INCUMBENT,
      alternatives: [ALTERNATIVE],
      diagnosticService: DIAGNOSTIC,
    });
    const decide = (evidenceInputs: MissionEvidenceInput[]) => {
      const review = reviewEvidence(evidenceInputs, clock.now(), tenant);
      const facts = financialFacts(ledger, org.id, mission.id, 'USD');
      const candidates = generateCandidates(review.accepted, ctx());
      const decision = evaluate({
        now: clock.now(),
        policy: POLICY,
        facts,
        evidence: review,
        candidates,
        modelAdapterId: null,
      });
      return { decision, review, facts };
    };

    console.info('MOTERVA — Harbor/offshore turbine inspection (issue #8 demo)');
    console.info(`[${LABEL}]`);
    console.info(
      `ledger: real SQLite at ${join(dir, 'harbor.sqlite')} (balance provenance: manual-seed — operator input, not provider-verified funds)`,
    );

    // ---- 1. Initial plan: comfortable weather window covering the nominal flight.
    const initial = decide([
      ev(clock, 1, {
        kind: 'weather-window',
        windowOpensAt: new Date(clock.now().getTime() + 60 * 60_000).toISOString(),
        windowClosesAt: new Date(clock.now().getTime() + 700 * 60_000).toISOString(),
        confidence: 0.95,
      }),
    ]);
    printDecision(1, 'INITIAL — comfortable weather window (evt-demo-1)', initial.decision);
    journalDecision(ledger, initial.decision, tenant);

    // ---- 2. New timestamped evidence: the window MOVES past the nominal flight.
    const clock2 = new TunableClock(new Date(clock.now().getTime() + 30 * 60_000).toISOString());
    void clock2;
    clock.advance(30 * 60_000);
    const revised = decide([
      ev(clock, 2, {
        kind: 'weather-window',
        windowOpensAt: new Date(clock.now().getTime() + 270 * 60_000).toISOString(),
        windowClosesAt: new Date(clock.now().getTime() + 690 * 60_000).toISOString(),
        confidence: 0.95,
      }),
    ]);
    printDecision(
      2,
      'REVISED — window moved past the nominal flight (evt-demo-2)',
      revised.decision,
    );
    journalDecision(ledger, revised.decision, tenant);
    const changedDecision =
      revised.decision.selected?.candidate.id !== initial.decision.selected?.candidate.id;

    // ---- 3. Refusal: a low-severity diagnostic is NOT worth its price.
    clock.advance(15 * 60_000);
    const refusal = decide([
      ev(
        clock,
        3,
        {
          kind: 'diagnostic-finding',
          severity: 'low',
          detail: 'minor biofouling on sensor housing',
        },
        'diagnostic-report',
      ),
    ]);
    printDecision(
      3,
      'REFUSAL — low-severity finding; diagnostic not worth its price (evt-demo-3)',
      refusal.decision,
    );
    journalDecision(ledger, refusal.decision, tenant);

    // ---- 4. Escalation: contradictory accepted deadlines force a human decision.
    clock.advance(10 * 60_000);
    const contradictionA = ev(
      clock,
      4,
      { kind: 'deadline-change', newDeadline: '2026-11-06T16:00:00.000Z' },
      'operator-report',
    );
    const contradictionB = ev(
      clock,
      5,
      { kind: 'deadline-change', newDeadline: '2026-11-06T22:00:00.000Z' },
      'operator-report',
    );
    const escalation = decide([contradictionA, contradictionB]);
    printDecision(
      4,
      'ESCALATION — contradictory deadlines (evt-demo-4 vs evt-demo-5)',
      escalation.decision,
    );
    journalDecision(ledger, escalation.decision, tenant);

    // ---- 5. Replay from the append-only journal.
    line('REPLAY — planner decisions from the append-only evidence journal');
    const events = ledger.evidence.list(org.id, { topic: 'operational' });
    const plannerEvents = events.filter((e) => e.type === 'planner.decision');
    for (const e of [...plannerEvents].reverse()) {
      const stored = ledger.db
        .prepare('SELECT payload_json FROM evidence_events WHERE id = ?')
        .get(e.id) as { payload_json: string };
      const payload = JSON.parse(stored.payload_json) as {
        evaluationId: string;
        decision: string;
        selectedId: string | null;
      };
      console.info(
        `  seq=${String(e.seq).padStart(3)} ${payload.evaluationId} → ${payload.decision}${payload.selectedId ? ` (${payload.selectedId})` : ''} @ ${e.recordedAt}`,
      );
    }

    line('SUMMARY');
    console.info(
      `initial decision → revised decision changed selection: ${changedDecision ? 'YES' : 'NO'}`,
    );
    console.info(
      `refusal demonstrated (diagnostic declined): ${refusal.decision.trace.scores.some((s) => s.rejection?.code === 'INFORMATION_NOT_WORTH_PRICE') ? 'YES' : 'NO'}`,
    );
    console.info(
      `escalation demonstrated: ${escalation.decision.outcome === 'escalate' ? 'YES' : 'NO'}`,
    );
    console.info(`replayed planner events: ${String(plannerEvents.length)}`);
    console.info(
      `[${LABEL}] — no live model inference; no provider funds claimed; ledger is the sole financial authority.`,
    );
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
