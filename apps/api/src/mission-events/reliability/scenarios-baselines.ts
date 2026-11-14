/**
 * Baseline-comparison scenarios (family BM, issue #15).
 *
 * Fair economic baselines over the SAME candidate set the constrained planner
 * saw, scored by the SAME planner math: cheapest-first (lowest gross among
 * paid offers — the naive procurement heuristic), earliest-deadline-first
 * (soonest finishing paid offer), static-safe (never spends). Wins, TIES and
 * LOSSES are all recorded honestly; the matrix deliberately includes cases
 * where a simple baseline matches the planner.
 */
import type { ScenarioCase } from './types.js';
import {
  compareBaselines,
  DEFAULT_POLICY,
  HARNESS_T0,
  UAV_INCUMBENT,
  VESSEL_ALTERNATIVE,
} from './harness.js';

const CLEAR_WIND = [
  { kind: 'wind_speed', unit: 'kt', value: '14.2' },
  { kind: 'weather_hold', unit: 'state', value: 'clear' },
  { kind: 'asset_comms', unit: 'state', value: 'online' },
] as const;
const GALE = [
  { kind: 'wind_speed', unit: 'kt', value: '24.6' },
  { kind: 'weather_hold', unit: 'state', value: 'active' },
] as const;

function m(minute: number): string {
  return new Date(Date.parse(HARNESS_T0) + minute * 60_000).toISOString();
}

export const baselineScenarios: readonly ScenarioCase[] = [
  {
    id: 'BM-01',
    family: 'baseline-comparison',
    domain: 'offshore',
    seed: 'BM-01-calm-abstention-tie',
    summary:
      'Calm weather, healthy funds: nothing is broken, so the economically dominant action is to buy NOTHING — planner TIES static-safe.',
    fault: 'none (baseline fairness anchor)',
    run(h) {
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: CLEAR_WIND }),
      );
      const chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbent: UAV_INCUMBENT,
        incumbentAssetId: 'asset-uav-1',
        alternatives: [VESSEL_ALTERNATIVE],
      });
      h.check(
        'planner abstained',
        'no-action',
        chain.decision.selected?.candidate.id ?? chain.decision.outcome,
      );
      const baseline = compareBaselines(chain.decision.trace.scores, chain.decision.selected!);
      h.check('static-safe ties the planner', 'tie', baseline.verdict);
      return {
        sideEffects: h.sideEffects(),
        baseline,
        explanation:
          'no adverse evidence → spending for the same outcome only destroys value; the naive procurement heuristics lose here, static-safe ties',
      };
    },
  },
  {
    id: 'BM-02',
    family: 'baseline-comparison',
    domain: 'offshore',
    seed: 'BM-02-gale-planner-wins',
    summary:
      'Gale blocks the cheap UAV: cheapest-first buys a physically unusable service; the planner switches to the vessel.',
    fault: 'wind above the UAV limit',
    run(h) {
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: GALE }),
      );
      const chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbent: UAV_INCUMBENT,
        incumbentAssetId: 'asset-uav-1',
        alternatives: [VESSEL_ALTERNATIVE],
      });
      h.check(
        'planner did not pick the blocked UAV',
        true,
        chain.decision.selected?.candidate.requiresAssetId === undefined,
      );
      const baseline = compareBaselines(chain.decision.trace.scores, chain.decision.selected!);
      h.check(
        'cheapest-first picked the blocked offer',
        'continue-uav-inspection',
        baseline.cheapestFirst.pick,
      );
      return {
        sideEffects: h.sideEffects(),
        baseline,
        explanation: 'evidence-constrained choice beats naive cheap procurement',
      };
    },
  },
  {
    id: 'BM-03',
    family: 'baseline-comparison',
    domain: 'offshore',
    seed: 'BM-03-low-value-static-safe',
    summary:
      'Low mission value: every paid alternative has negative expected net — abstaining is optimal and static-safe TIES (or wins).',
    fault: 'weak economics (mission value below service cost)',
    run(h) {
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: CLEAR_WIND }),
      );
      const chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbent: UAV_INCUMBENT,
        incumbentAssetId: 'asset-uav-1',
        alternatives: [VESSEL_ALTERNATIVE],
        policy: {
          missionValueMinor: 400_000,
          failureCostMinor: 0,
          protectedReserveMinor: 0,
        },
      });
      h.check(
        'planner abstained (no-action selected)',
        'no-action',
        chain.decision.selected?.candidate.id ?? chain.decision.outcome,
      );
      const baseline = compareBaselines(chain.decision.trace.scores, chain.decision.selected!);
      h.check(
        'static-safe verdict is tie or baseline-wins',
        true,
        ['tie', 'baseline-wins'].includes(baseline.verdict),
      );
      return {
        sideEffects: h.sideEffects(),
        baseline,
        explanation:
          'spending money is not always the answer — the honest anchor where doing nothing wins',
      };
    },
  },
  {
    id: 'BM-04',
    family: 'baseline-comparison',
    domain: 'offshore',
    seed: 'BM-04-useless-diagnostics',
    summary:
      'A cheap diagnostic with negligible information value: cheapest-first buys it; the planner declines (not worth the price).',
    fault: 'low-value information purchase',
    run(h) {
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: CLEAR_WIND }),
      );
      const cheapDiagnostic = {
        id: 'cheap-diagnostic',
        kind: 'diagnostic-service' as const,
        beneficiary: 'harbor-diagnostics',
        purpose: 'harbor inspection',
        currency: 'USD',
        baseCostMinor: 150_000,
        feeMinor: 0,
        leadTimeMinutes: 10,
        durationMinutes: 20,
        probabilityOfSuccess: 0.5,
        availability: 'confirmed' as const,
      };
      const chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbent: UAV_INCUMBENT,
        incumbentAssetId: 'asset-uav-1',
        alternatives: [VESSEL_ALTERNATIVE],
        diagnosticService: cheapDiagnostic,
        diagnosticInformationGain: 0.01, // nearly useless information
        policy: { diagnosticValueThreshold: DEFAULT_POLICY.diagnosticValueThreshold },
      });
      h.check(
        'diagnostic declined as not worth the price',
        true,
        chain.decision.trace.scores.some(
          (s) => s.rejection?.code === 'INFORMATION_NOT_WORTH_PRICE',
        ),
      );
      const baseline = compareBaselines(chain.decision.trace.scores, chain.decision.selected!);
      h.check(
        'cheapest offer was the useless diagnostic',
        'diagnostics-cheap-diagnostic',
        baseline.cheapestFirst.pick,
      );
      return {
        sideEffects: h.sideEffects(),
        baseline,
        explanation: 'a diagnostic that costs money and proves nothing is refused',
      };
    },
  },
  {
    id: 'BM-05',
    family: 'baseline-comparison',
    domain: 'offshore',
    seed: 'BM-05-equal-offers-tie',
    summary:
      'Two alternatives with identical cost and probability: planner and cheapest-first pick the same offer — TIE by construction.',
    fault: 'none (symmetry anchor)',
    run(h) {
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: CLEAR_WIND }),
      );
      const equalVessel = {
        ...VESSEL_ALTERNATIVE,
        baseCostMinor: UAV_INCUMBENT.baseCostMinor,
        probabilityOfSuccess: UAV_INCUMBENT.probabilityOfSuccess,
        leadTimeMinutes: UAV_INCUMBENT.leadTimeMinutes,
      };
      const chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbent: UAV_INCUMBENT,
        incumbentAssetId: 'asset-uav-1',
        alternatives: [equalVessel],
      });
      const baseline = compareBaselines(chain.decision.trace.scores, chain.decision.selected!);
      h.check(
        'same pick as cheapest-first',
        true,
        baseline.cheapestFirst.pick === baseline.plannerPick || baseline.verdict === 'tie',
      );
      return {
        sideEffects: h.sideEffects(),
        baseline,
        explanation: 'symmetric offers: a tie is the correct, honestly-recorded result',
      };
    },
  },
  {
    id: 'BM-06',
    family: 'baseline-comparison',
    domain: 'offshore',
    seed: 'BM-06-planner-wins',
    summary:
      'Gale blocks the UAV; a fast-but-poor rush alternative tempts earliest-deadline-first while the planner picks the balanced vessel — PLANNER WINS.',
    fault: 'wind above the UAV limit + a tempting fast rush offer',
    run(h) {
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: GALE }),
      );
      const rushAlternative = {
        ...VESSEL_ALTERNATIVE,
        id: 'helicopter-rush',
        beneficiary: 'harbor-air',
        leadTimeMinutes: 10,
        baseCostMinor: 3_500_000,
        probabilityOfSuccess: 0.6,
      };
      const chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbent: UAV_INCUMBENT,
        incumbentAssetId: 'asset-uav-1',
        alternatives: [VESSEL_ALTERNATIVE, rushAlternative],
      });
      h.check(
        'planner picked the vessel',
        true,
        chain.decision.selected?.candidate.id.includes('vessel') === true,
      );
      const baseline = compareBaselines(chain.decision.trace.scores, chain.decision.selected!);
      h.check('planner strictly wins', 'planner-wins', baseline.verdict);
      return {
        sideEffects: h.sideEffects(),
        baseline,
        explanation:
          'balanced expected-value choice beats both the naive rush (EDF) and the blocked cheap incumbent',
      };
    },
  },
  {
    id: 'BM-07',
    family: 'baseline-comparison',
    domain: 'offshore',
    seed: 'BM-07-escalation-baseline-wins',
    summary:
      'Two materially different actions near-tied (vessel vs high-value diagnostic) → the planner ESCALATES to a human; cheapest-first just buys — BASELINE WINS on immediate expected net.',
    fault: 'genuine near-tie between different action kinds',
    run(h) {
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: GALE }),
      );
      const tunedVessel = {
        ...VESSEL_ALTERNATIVE,
        baseCostMinor: 2_750_000, // net ≈ 1.275M — deliberately close to the diagnostic's value
      };
      const valuableDiagnostic = {
        id: 'hull-diagnostic',
        kind: 'diagnostic-service' as const,
        beneficiary: 'harbor-diagnostics',
        purpose: 'harbor inspection',
        currency: 'USD',
        baseCostMinor: 225_000,
        feeMinor: 0,
        leadTimeMinutes: 20,
        durationMinutes: 30,
        probabilityOfSuccess: 0.5,
        availability: 'confirmed' as const,
      };
      const chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbent: UAV_INCUMBENT,
        incumbentAssetId: 'asset-uav-1',
        alternatives: [tunedVessel],
        diagnosticService: valuableDiagnostic,
        diagnosticInformationGain: 1.0, // full avoided-failure value → net ≈ 1.275M
        facts: {
          orgId: h.world.orgId,
          missionId: h.world.missionId,
          currency: 'USD',
          balanceStatus: 'ok',
          balanceMinor: 4_000_000,
          spendableMinor: 4_000_000,
          outstandingCommittedMinor: 0,
          ambiguousCommittedMinor: 0,
          protectedFloorMinor: 0,
          mandate: {
            id: 'mandate-bm07',
            version: 1,
            expiresAt: '2026-11-07T09:00:00.000Z',
            maxPerPaymentMinor: 3_000_000,
            remainingBudgetMinor: 3_000_000,
            permittedKinds: ['airwallex_transfer'],
            allowedBeneficiaries: [],
            allowedPurposes: [],
          },
        },
      });
      h.check('planner escalated the near-tie', 'escalate', chain.decision.outcome);
      h.check('no autonomous selection', true, chain.decision.selected === null);
      // Honest scoring of what the planner DID (defer to a human, commit nothing)
      // against what naive baselines would have done.
      const vessel = chain.decision.trace.scores.find((s) => s.candidate.id.includes('vessel'));
      const diagnostic = chain.decision.trace.scores.find((s) =>
        s.candidate.id.includes('diagnostic'),
      );
      h.check(
        'both near-tied actions are economically real',
        true,
        vessel !== undefined && diagnostic !== undefined,
      );
      const baselineNets = [
        { pick: 'cheapest: hull-diagnostic', net: diagnostic?.expectedNetMinor ?? 0 },
        { pick: 'edf: hull-diagnostic (fastest)', net: diagnostic?.expectedNetMinor ?? 0 },
        {
          pick: 'static-safe: no-action',
          net:
            chain.decision.trace.scores.find((s) => s.candidate.kind === 'no-action')
              ?.expectedNetMinor ?? 0,
        },
      ];
      const bestBaseline = Math.max(...baselineNets.map((b) => b.net));
      const verdict: 'tie' | 'baseline-wins' = bestBaseline > 0 ? 'baseline-wins' : 'tie';
      const baseline = {
        plannerPick: '(escalated — no autonomous action)',
        plannerNetMinor: 0,
        cheapestFirst: {
          pick: 'diagnostics-hull-diagnostic',
          netMinor: diagnostic?.expectedNetMinor ?? 0,
        },
        earliestDeadlineFirst: {
          pick: 'diagnostics-hull-diagnostic',
          netMinor: diagnostic?.expectedNetMinor ?? 0,
        },
        staticSafe: {
          pick: 'no-action',
          netMinor:
            chain.decision.trace.scores.find((s) => s.candidate.kind === 'no-action')
              ?.expectedNetMinor ?? 0,
        },
        verdict,
        explanation:
          "escalation deliberately defers a materially different near-tied choice to a human; an automaton that just bought would have captured the diagnostic's expected value — an honest baseline win recorded, not hidden",
      } as const;
      h.check('baseline-wins recorded honestly', 'baseline-wins', baseline.verdict);
      return {
        sideEffects: h.sideEffects(),
        baseline,
        explanation: 'governance costs expected value by design — measured, not spun',
      };
    },
  },
];
