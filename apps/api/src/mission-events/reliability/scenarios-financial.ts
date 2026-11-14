/**
 * Financial-interaction reliability scenarios (family F).
 *
 * Every case drives the FULL public chain: signed synthetic physical events →
 * real ingest/journal → Agent A's integration bridge (read-only) → public
 * @moterva/planner (reviewEvidence → generateCandidates → evaluate) over
 * REAL ledger facts (financialFacts) →, where an action is selected, the
 * public ledger proposal/reservation flows. Nothing edits the planner, the
 * bridge or the ledger. Side effects are counted from the ledger itself.
 *
 * SIMULATED_OPERATION / POLICY-ONLY throughout: no provider is contacted; a
 * "side effect" is a durable ledger row created through a public interface.
 */
import { financialFacts, journalDecision, recordDecisionPlan } from '@moterva/planner';
import type { PlanEconomicTerms } from '@moterva/ledger';
import type { PlanChain, ScenarioCase } from './types.js';
import {
  HARNESS_T0,
  MANUAL_COUNT_ALTERNATIVE,
  ROBOT_INCUMBENT,
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

/** Planner observation from a chain, with the trace's rejection codes. */
function observe(chain: PlanChain, note: string) {
  return {
    outcome: chain.decision.outcome,
    selectedId: chain.decision.selected?.candidate.id ?? null,
    rejectionCodes: chain.decision.trace.scores.flatMap((s) =>
      s.rejection ? [s.rejection.code] : [],
    ),
    bridgeEvidence: chain.bridge.evidence.length,
    bridgeWithheld: chain.bridge.withheldEventIds.length,
    constraintStates: chain.bridge.evidence.map(
      (e) => (e.constraint as { state?: string }).state ?? e.constraint.kind,
    ),
    note,
  };
}

export const financialScenarios: readonly ScenarioCase[] = [
  {
    id: 'FI-01',
    family: 'financial-interaction',
    domain: 'offshore',
    seed: 'FI-01-evidence-restriction',
    summary:
      'A valid gale event forces an operational restriction: the UAV incumbent becomes infeasible and the vessel alternative wins.',
    fault: 'wind 24.6kt exceeds the 22kt UAV limit mid-mission',
    run(h) {
      h.world.fund();
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: CLEAR_WIND }),
      );
      h.submit(
        service,
        h.env({ sequence: 2, observedAt: m(5), ingestedAt: m(5), observations: GALE }),
      );
      const chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbent: UAV_INCUMBENT,
        incumbentAssetId: 'asset-uav-1',
        alternatives: [VESSEL_ALTERNATIVE],
        factsFromLedger: true,
      });
      h.check(
        'decision selects a paid alternative or escalates',
        true,
        chain.decision.outcome !== 'decline',
      );
      h.check(
        'UAV incumbent physically blocked',
        true,
        chain.decision.trace.scores.some((s) => s.rejection?.code === 'ASSET_SAFETY_BLOCKED'),
      );
      h.check(
        'selected is not the blocked UAV incumbent',
        true,
        chain.decision.selected?.candidate.id !== 'continue-uav-inspection',
      );
      // Evidence alone creates ZERO financial rows (planning is proposal-only).
      h.check('zero operations from evidence', 0, h.sideEffects().operations);
      h.check('zero commitments from evidence', 0, h.sideEffects().commitments);
      return {
        sideEffects: h.sideEffects(),
        planner: observe(
          chain,
          'verified wind evidence flipped the economic choice to the vessel alternative',
        ),
        explanation: 'operational restriction caused by authenticated evidence, not by model prose',
      };
    },
  },
  {
    id: 'FI-02',
    family: 'financial-interaction',
    domain: 'offshore',
    seed: 'FI-02-unsafe-uav-unselectable',
    summary:
      'The unsafe UAV candidate can never be SELECTED while the block is fresh — even if it is the cheapest.',
    fault: 'blocked asset remains the cheapest option',
    run(h) {
      h.world.fund();
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
        factsFromLedger: true,
      });
      h.check(
        'no selected candidate requires the blocked asset',
        true,
        chain.decision.selected === null ||
          chain.decision.selected.candidate.requiresAssetId === undefined,
      );
      h.check(
        'asset-blocked rejection present',
        true,
        chain.decision.trace.scores.some((s) => s.rejection?.code === 'ASSET_SAFETY_BLOCKED'),
      );
      return {
        sideEffects: h.sideEffects(),
        planner: observe(chain, 'ASSET_SAFETY_BLOCKED enforced at candidate scoring'),
        explanation: 'physical safety precedes economics',
      };
    },
  },
  {
    id: 'FI-03',
    family: 'financial-interaction',
    domain: 'offshore',
    seed: 'FI-03-unknown-clearance',
    summary:
      'Unknown clearance (only a comms reading, no wind/hold) fails closed: asset-dependent spend is refused.',
    fault: 'insufficient physical evidence',
    run(h) {
      h.world.fund();
      const service = h.freshService();
      h.submit(
        service,
        h.env({
          sequence: 1,
          observedAt: m(1),
          ingestedAt: m(1),
          observations: [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
        }),
      );
      const chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbent: UAV_INCUMBENT,
        incumbentAssetId: 'asset-uav-1',
        alternatives: [VESSEL_ALTERNATIVE],
        factsFromLedger: true,
      });
      h.check(
        'no asset-dependent selection under unknown clearance',
        true,
        chain.decision.selected === null ||
          chain.decision.selected.candidate.requiresAssetId === undefined,
      );
      h.check(
        'insufficient-evidence or asset-block recorded',
        true,
        chain.bridge.evidence.some(
          (e) => (e.constraint as { reason?: string }).reason === 'insufficient-evidence',
        ) || chain.decision.trace.scores.some((s) => s.rejection?.code === 'ASSET_SAFETY_BLOCKED'),
      );
      return {
        sideEffects: h.sideEffects(),
        planner: observe(
          chain,
          'uncertainty refuses asset-dependent spend — never a favorable guess',
        ),
        explanation: 'fail closed on insufficient evidence',
      };
    },
  },
  {
    id: 'FI-04',
    family: 'financial-interaction',
    domain: 'offshore',
    seed: 'FI-04-vessel-not-uav-blocked',
    summary:
      'When the UAV is wind-blocked, the vessel alternative (no UAV asset dependency) is NOT blocked by the UAV-only rule.',
    fault: 'domain rule scoping',
    run(h) {
      h.world.fund();
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
        factsFromLedger: true,
      });
      const vessel = chain.decision.trace.scores.find((s) => s.candidate.id.includes('vessel'));
      h.check('vessel candidate present', true, vessel !== undefined);
      h.check('vessel not asset-blocked', true, vessel?.rejection?.code !== 'ASSET_SAFETY_BLOCKED');
      return {
        sideEffects: h.sideEffects(),
        planner: observe(
          chain,
          'UAV-only clearance rule does not leak onto the vessel alternative',
        ),
        explanation: 'constraint scoping is per-asset',
      };
    },
  },
  {
    id: 'FI-05',
    family: 'financial-interaction',
    domain: 'offshore',
    seed: 'FI-05-insufficient-funds',
    summary:
      'Insufficient funds: spendable below the vessel cost → INSUFFICIENT_SPENDABLE, decline, zero operations.',
    fault: 'funded below the alternative’s cost',
    run(h) {
      h.world.fund({ balanceMinor: 900_000, mandateMaxMinor: 2_500_000 });
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
        factsFromLedger: true,
      });
      h.check(
        'insufficient-spendable recorded',
        true,
        chain.decision.trace.scores.some((s) => s.rejection?.code === 'INSUFFICIENT_SPENDABLE'),
      );
      h.check(
        'no paid candidate selected',
        true,
        chain.decision.selected === null || chain.decision.selected.candidate.costMinor === 0,
      );
      h.check('zero operations', 0, h.sideEffects().operations);
      return {
        sideEffects: h.sideEffects(),
        planner: observe(
          chain,
          'the ledger refuses to commit against unverified/insufficient funds',
        ),
        explanation: 'money gates precede selection',
      };
    },
  },
  {
    id: 'FI-06',
    family: 'financial-interaction',
    domain: 'offshore',
    seed: 'FI-06-unknown-balance',
    summary:
      'No balance snapshot at all → facts.balanceStatus no_snapshot → every paid candidate refused.',
    fault: 'unknown balance',
    run(h) {
      // Fund issues a mandate but we skip the balance snapshot: issue directly.
      h.world.fund({ balanceMinor: 3_000_000 });
      h.world.ledger.db.prepare('DELETE FROM balance_snapshots').run();
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
        factsFromLedger: true,
      });
      const facts = financialFacts(h.world.ledger, h.world.orgId, h.world.missionId, 'USD');
      h.check('balance carried as no_snapshot', 'no_snapshot', facts.balanceStatus);
      h.check('spendable null', 'null', String(facts.spendableMinor));
      h.check(
        'paid candidates refused',
        true,
        chain.decision.trace.scores
          .filter((s) => s.candidate.costMinor > 0)
          .every((s) => !s.feasible),
      );
      h.check('zero operations', 0, h.sideEffects().operations);
      return {
        sideEffects: h.sideEffects(),
        planner: observe(chain, 'unknown funds never become a selection'),
        explanation: 'stale/missing snapshots are carried, never coerced',
      };
    },
  },
  {
    id: 'FI-07',
    family: 'financial-interaction',
    domain: 'offshore',
    seed: 'FI-07-expired-mandate',
    summary: 'Expired mandate → MANDATE_EXPIRED for every paid candidate; abstention only.',
    fault: 'lapsed authority',
    run(h) {
      h.world.fund({ mandateExpiresInMs: 60_000 });
      h.clock.advanceMs(2 * 60_000); // mandate now expired
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(3), ingestedAt: m(3), observations: GALE }),
      );
      const chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbent: UAV_INCUMBENT,
        incumbentAssetId: 'asset-uav-1',
        alternatives: [VESSEL_ALTERNATIVE],
        factsFromLedger: true,
      });
      h.check(
        'mandate-expired recorded',
        true,
        chain.decision.trace.scores.some((s) => s.rejection?.code === 'MANDATE_EXPIRED'),
      );
      h.check(
        'no paid selection',
        true,
        chain.decision.selected === null || chain.decision.selected.candidate.costMinor === 0,
      );
      return {
        sideEffects: h.sideEffects(),
        planner: observe(chain, 'lapsed authority blocks spend even with funds present'),
        explanation: 'authority expiry is a hard gate',
      };
    },
  },
  {
    id: 'FI-08',
    family: 'financial-interaction',
    domain: 'offshore',
    seed: 'FI-08-no-provider-success',
    summary:
      'No provider access exists: a PAID selection (gale forces the vessel switch) is only a PROPOSAL — zero operations, zero receipts, no success claim.',
    fault: 'missing sponsor/provider access',
    run(h) {
      h.world.fund();
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
        factsFromLedger: true,
      });
      h.check(
        'a PAID selection exists to propose',
        true,
        (chain.decision.selected?.candidate.costMinor ?? 0) > 0,
      );
      const { plan } = recordDecisionPlan(h.world.ledger, chain.decision, {
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        proposedBy: null,
      });
      journalDecision(h.world.ledger, chain.decision, {
        orgId: h.world.orgId,
        missionId: h.world.missionId,
      });
      h.check('plan proposed', true, plan !== null);
      const effects = h.sideEffects();
      h.check('zero operations', 0, effects.operations);
      h.check('zero provider receipts', 0, effects.providerReceipts);
      h.check('zero approvals', 0, effects.approvals);
      h.check('decision journaled as operational evidence', true, effects.operationalEvidence > 0);
      return {
        sideEffects: effects,
        planner: observe(
          chain,
          'POLICY-ONLY selection journals a decision and proposes a plan — nothing executes without human/provider gates',
        ),
        explanation: 'no provider credentials → no fabricated receipt, ever',
      };
    },
  },
  {
    id: 'FI-09',
    family: 'financial-interaction',
    domain: 'offshore',
    seed: 'FI-09-no-blind-retry',
    summary:
      'Approved + reserved operation with NO registered dispatcher: stays RESERVED (not settled), no receipt, and the same requestId cannot create a second operation.',
    fault: 'ambiguous external action / disabled rail',
    run(h) {
      h.world.fund();
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
        factsFromLedger: true,
      });
      const { plan } = recordDecisionPlan(h.world.ledger, chain.decision, {
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        proposedBy: null,
      });
      h.check(
        'paid plan proposed',
        true,
        (plan?.terms as { amountMinor?: number } | undefined)?.amountMinor !== undefined &&
          (plan!.terms as { amountMinor: number }).amountMinor > 0,
      );
      const approver = h.world.ledger.authority.createHumanActor({
        orgId: h.world.orgId,
        username: 'fi09-approver',
        displayName: 'FI09',
        role: 'approver',
        password: ['fixture', 'only'].join('-'),
      });
      const approval = h.world.ledger.approvals.record({
        orgId: h.world.orgId,
        plan: plan!,
        decidedByActorId: approver.id,
        kind: 'airwallex_transfer',
        expiresAt: m(120),
      });
      const reserve = h.world.ledger.reservations.reserve({
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        kind: 'airwallex_transfer',
        requestId: 'fi09-op-1',
        planId: plan!.id,
        planVersion: plan!.version,
        approvalId: approval.id,
      });
      h.check(
        'first reservation succeeds',
        'reserved',
        String(reserve.operation.state).toLowerCase(),
      );
      const duplicateBehavior: 'threw' | 'idempotent' | 'created-second-operation' = (() => {
        try {
          const again = h.world.ledger.reservations.reserve({
            orgId: h.world.orgId,
            missionId: h.world.missionId,
            kind: 'airwallex_transfer',
            requestId: 'fi09-op-1',
            planId: plan!.id,
            planVersion: plan!.version,
            approvalId: approval.id,
          });
          return again.operation.id === reserve.operation.id
            ? 'idempotent'
            : 'created-second-operation';
        } catch {
          return 'threw';
        }
      })();
      h.check(
        'same requestId is refused or idempotently returns the SAME operation',
        true,
        duplicateBehavior !== 'created-second-operation',
      );
      h.check('no provider receipt fabricated', 0, h.sideEffects().providerReceipts);
      h.check('exactly one operation', 1, h.sideEffects().operations);
      h.check(
        'no settlement (no dispatcher registered)',
        true,
        (
          h.world.ledger.db
            .prepare(`SELECT COUNT(*) AS c FROM operations WHERE state = 'SETTLED'`)
            .get() as { c: number }
        ).c === 0,
      );
      return {
        sideEffects: h.sideEffects(),
        planner: observe(
          chain,
          'submitted ≠ settled: the reserved operation waits; retry by the same request id is idempotent',
        ),
        explanation: 'ambiguous external action never permits a blind duplicate',
      };
    },
  },
  {
    id: 'FI-10',
    family: 'financial-interaction',
    domain: 'offshore',
    seed: 'FI-10-changed-intent',
    summary:
      'A second, economically different decision is a NEW immutable plan version: the old approval cannot authorize it.',
    fault: 'changed terms after approval',
    run(h) {
      h.world.fund();
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: GALE }),
      );
      const decision1 = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbent: UAV_INCUMBENT,
        incumbentAssetId: 'asset-uav-1',
        alternatives: [VESSEL_ALTERNATIVE],
        factsFromLedger: true,
      });
      const { plan: planV1 } = recordDecisionPlan(h.world.ledger, decision1.decision, {
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        proposedBy: null,
      });
      const approver = h.world.ledger.authority.createHumanActor({
        orgId: h.world.orgId,
        username: 'fi10-approver',
        displayName: 'FI10',
        role: 'approver',
        password: ['fixture', 'only'].join('-'),
      });
      const approvalV1 = h.world.ledger.approvals.record({
        orgId: h.world.orgId,
        plan: planV1!,
        decidedByActorId: approver.id,
        kind: 'airwallex_transfer',
        expiresAt: m(120),
      });
      // Economically different terms → NEW version of the same plan identity.
      const v1Terms = planV1!.terms as PlanEconomicTerms;
      const planV2 = h.world.ledger.plans.recordVersion({
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        planId: planV1!.id,
        proposedBy: null,
        terms: { ...v1Terms, amountMinor: v1Terms.amountMinor + 250_000 },
      });
      h.check('v2 is a new version', true, planV2.version > planV1!.version);
      h.check('v2 digest differs', true, planV2.digest !== planV1!.digest);
      let mismatchRefused = false;
      try {
        h.world.ledger.reservations.reserve({
          orgId: h.world.orgId,
          missionId: h.world.missionId,
          kind: 'airwallex_transfer',
          requestId: 'fi10-op-1',
          planId: planV2.id,
          planVersion: planV2.version,
          approvalId: approvalV1.id,
        });
      } catch {
        mismatchRefused = true;
      }
      h.check('old approval cannot authorize v2', true, mismatchRefused);
      h.check('zero operations', 0, h.sideEffects().operations);
      return {
        sideEffects: h.sideEffects(),
        planner: observe(decision1, 'changed terms structurally cannot ride an old approval'),
        explanation: 'immutable intent identity is digest-bound',
      };
    },
  },
  {
    id: 'FI-11',
    family: 'financial-interaction',
    domain: 'offshore',
    seed: 'FI-11-evidence-invalidates',
    summary:
      'Changed evidence invalidates the earlier decision world: clear-weather selection flips to blocked after the gale event, and both decisions journal separately.',
    fault: 'evidence change between evaluations',
    run(h) {
      h.world.fund();
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: CLEAR_WIND }),
      );
      const before = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbent: UAV_INCUMBENT,
        incumbentAssetId: 'asset-uav-1',
        alternatives: [VESSEL_ALTERNATIVE],
        factsFromLedger: true,
      });
      journalDecision(h.world.ledger, before.decision, {
        orgId: h.world.orgId,
        missionId: h.world.missionId,
      });
      h.submit(
        service,
        h.env({ sequence: 2, observedAt: m(5), ingestedAt: m(5), observations: GALE }),
      );
      const after = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbent: UAV_INCUMBENT,
        incumbentAssetId: 'asset-uav-1',
        alternatives: [VESSEL_ALTERNATIVE],
        factsFromLedger: true,
      });
      journalDecision(h.world.ledger, after.decision, {
        orgId: h.world.orgId,
        missionId: h.world.missionId,
      });
      h.check(
        'decisions differ',
        true,
        before.decision.trace.evaluationId !== after.decision.trace.evaluationId,
      );
      h.check(
        'before: no asset block',
        false,
        before.decision.trace.scores.some((s) => s.rejection?.code === 'ASSET_SAFETY_BLOCKED'),
      );
      h.check(
        'after: asset blocked',
        true,
        after.decision.trace.scores.some((s) => s.rejection?.code === 'ASSET_SAFETY_BLOCKED'),
      );
      h.check(
        'two separate decision records',
        2,
        (
          h.world.ledger.db
            .prepare(`SELECT COUNT(*) AS c FROM evidence_events WHERE type = 'planner.decision'`)
            .get() as { c: number }
        ).c,
      );
      h.check('zero operations', 0, h.sideEffects().operations);
      return {
        sideEffects: h.sideEffects(),
        planner: observe(
          after,
          'the same mission re-evaluated on new verified evidence reaches a materially different, journaled decision',
        ),
        explanation: 'changed evidence → changed decision, both replayable',
      };
    },
  },
  {
    id: 'FI-12',
    family: 'financial-interaction',
    domain: 'warehouse',
    seed: 'FI-12-warehouse-economics',
    summary:
      'Warehouse domain economics: robot incumbent remains selectable; the manual alternative stays available; zero financial rows from evidence.',
    fault: 'second-domain financial probe (no fault injected)',
    run(h) {
      h.world.fund({ mandateMaxMinor: 2_000_000 });
      const service = h.freshService();
      h.submit(
        service,
        h.env({
          sequence: 1,
          observedAt: m(1),
          ingestedAt: m(1),
          observations: [
            { kind: 'asset_comms', unit: 'state', value: 'online' },
            { kind: 'aisle_access', unit: 'state', value: 'obstructed' },
          ],
        }),
      );
      const chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbent: ROBOT_INCUMBENT,
        incumbentAssetId: 'asset-uav-1',
        alternatives: [MANUAL_COUNT_ALTERNATIVE],
        factsFromLedger: true,
      });
      h.check(
        'no wind constraint invented',
        true,
        chain.bridge.evidence.every(
          (e) => (e.constraint as { observedWindKt?: number }).observedWindKt === undefined,
        ),
      );
      h.check('zero operations', 0, h.sideEffects().operations);
      h.check('zero commitments', 0, h.sideEffects().commitments);
      return {
        sideEffects: h.sideEffects(),
        planner: observe(
          chain,
          'warehouse catalogue evaluated; conservative clearance applies pending the domain adapter request to Agent A',
        ),
        explanation: 'second domain exercises the same financial gates',
      };
    },
  },
];
