import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, TunableClock, type Ledger } from '@moterva/ledger';
import {
  generateCandidates,
  evaluate,
  reviewEvidence,
  financialFacts,
  type DecisionResult,
  type MissionEvidenceInput,
} from '@moterva/planner';
import {
  MissionEventIngestService,
  offshoreScenario,
  SourceRegistry,
  warehouseInterruptScenario,
  runScenario,
  type ScenarioDefinition,
} from '../../src/mission-events/index.js';
import type { ScenarioBuild } from '../../src/mission-events/src/scenarios/types.js';
import { physicalTimelineToPlannerSafety } from '../../src/integration/physical-to-planner.js';

/**
 * TWO-DOMAIN DECISION TRACES (MTV-07, issue #9; audit gaps G2/G4).
 *
 * Trace A (harbor) and Trace B (warehouse) are each derived from their
 * committed scenario's JOURNAL through the SAME chain:
 *   MissionEventIngestService.replay → physicalTimelineToPlannerSafety →
 *   reviewEvidence → generateCandidates → evaluate.
 * There is no domain branch anywhere in this chain: the only domain input is
 * the operator-declared `assetKinds` policy map, and outcomes track the
 * OBSERVATIONS (proven by the id-swap tests).
 *
 * Financial isolation is asserted against real ledger tables after every
 * trace: decisions are PROPOSED_ONLY policy evaluations — zero operations,
 * zero commitments, zero provider receipts, zero financial-topic evidence.
 */

const HARBOR_WIND_LIMIT_KT = 22;
const HARBOR_ORG = 'org_fixture_reference';
const HARBOR_MISSION = 'msn_fixture_reference';

interface ScenarioWorld {
  readonly ledger: Ledger;
  readonly clock: TunableClock;
  readonly orgId: string;
  readonly missionId: string;
  readonly service: MissionEventIngestService;
  readonly build: ScenarioBuild;
}

function makeScenarioWorld(
  definition: ScenarioDefinition,
  label: string,
  mandate: { beneficiaries: readonly string[]; purposes: readonly string[] },
): ScenarioWorld {
  const path = join(mkdtempSync(join(tmpdir(), `moterva-${label}-`)), 'ledger.sqlite');
  const ledger = openLedger(path);
  ledger.migrate();
  const org = ledger.organizations.createOrganization(`${label}-org`);
  const mission = ledger.organizations.createMission(org.id, `${label}-mission`);
  // The same seeded funding shape the reliability harness uses (clearly
  // labeled demo data): treasury + snapshot + an active mandate so the paid
  // candidates are policy-evaluable. The decision remains PROPOSED_ONLY and
  // the whole trace writes zero financial rows.
  ledger.accounts.ensureTreasuryAccount({
    orgId: org.id,
    currency: 'USD',
    label: 'USD',
    protectedFloorMinor: 10_000,
  });
  ledger.accounts.recordBalanceSnapshot({
    orgId: org.id,
    currency: 'USD',
    minorUnits: 5_000_000,
    source: 'manual-seed',
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const admin = ledger.authority.createHumanActor({
    orgId: org.id,
    username: `${label}-admin`,
    displayName: 'Admin',
    role: 'admin',
    password: [label, 'fixture'].join('-'),
  });
  ledger.mandates.issue({
    orgId: org.id,
    missionId: mission.id,
    currency: 'USD',
    maxAmountMinor: 5_000_000,
    totalBudgetMinor: 5_000_000,
    permittedOperationKinds: ['airwallex_transfer'],
    allowedBeneficiaries: [...mandate.beneficiaries],
    allowedPurposes: [...mandate.purposes],
    byActorId: admin.id,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const build = definition.build({ orgId: org.id, missionId: mission.id });
  const registry = new SourceRegistry();
  registry.registerAll(build.sources);
  const clock = new TunableClock(build.script[0]!.at);
  const service = new MissionEventIngestService(ledger, clock, registry);
  return { ledger, clock, orgId: org.id, missionId: mission.id, service, build };
}

/** The index of the scripted submission carrying an observation kind+value. */
function indexOfEnvelopeWith(
  build: ScenarioBuild,
  match: (envelope: ScenarioBuild['script'][number]['envelope']) => boolean,
): number {
  return build.script.findIndex((s) => match(s.envelope));
}

/**
 * Ingests envelopes[fromInclusive..toInclusive] with the clock anchored per
 * beat. The cursor is explicit: re-ingesting an already-journaled envelope
 * would (correctly) refuse it as a duplicate.
 */
function ingestRange(world: ScenarioWorld, fromInclusive: number, toInclusive: number): void {
  for (let i = fromInclusive; i <= toInclusive; i += 1) {
    const submission = world.build.script[i]!;
    const anchorMs = Date.parse(submission.at);
    if (anchorMs > world.clock.now().getTime()) {
      world.clock.advance(anchorMs - world.clock.now().getTime());
    }
    try {
      const outcome = world.service.ingest(world.orgId, submission.envelope);
      expect(outcome.status).toBe(submission.expect.status);
    } catch (error) {
      // Rejections THROW; the scripted expectation records the code.
      const message = error instanceof Error ? error.message : String(error);
      expect(submission.expect.status).toBe('rejected');
      expect(message).toContain(`[${submission.expect.code ?? ''}]`);
    }
  }
}

function ingestPrefix(world: ScenarioWorld, upToInclusive: number): void {
  ingestRange(world, 0, upToInclusive);
}

function bridgeFor(
  world: ScenarioWorld,
  assetKinds: Readonly<Record<string, 'aerial' | 'ground'>>,
  asOfMs: number,
) {
  const delta = asOfMs - world.clock.now().getTime();
  if (delta > 0) world.clock.advance(delta);
  const timeline = world.service.replay(world.orgId, world.missionId);
  return physicalTimelineToPlannerSafety(timeline, {
    orgId: world.orgId,
    missionId: world.missionId,
    asOf: new Date(asOfMs),
    uavWindLimitKt: HARBOR_WIND_LIMIT_KT,
    assetKinds,
  });
}

function decide(
  world: ScenarioWorld,
  evidence: readonly MissionEvidenceInput[],
  incumbent: SupplierOffer,
  alternative: SupplierOffer,
  incumbentAssetId: string,
): DecisionResult {
  const asOf = new Date(world.clock.now());
  const review = reviewEvidence([...evidence], asOf, {
    orgId: world.orgId,
    missionId: world.missionId,
  });
  const candidates = generateCandidates(review.accepted, {
    now: asOf,
    incumbent,
    incumbentAssetId,
    alternatives: [alternative],
    policyCurrency: 'USD',
    missionDeadlineAt: new Date(world.clock.now().getTime() + 86_400_000).toISOString(),
  });
  return evaluate({
    now: asOf,
    policy: {
      version: 1,
      currency: 'USD',
      missionDeadlineAt: new Date(world.clock.now().getTime() + 86_400_000).toISOString(),
      missionValueMinor: 5_000_000,
      failureCostMinor: 1_500_000,
      protectedReserveMinor: 400_000,
      maxProbabilityAssumption: 0.95,
      unconfirmedAvailabilityFactor: 0.7,
      diagnosticValueThreshold: 2,
      forbidUnconfirmedAvailability: false,
      escalationScoreGap: 100_000,
    },
    facts: financialFacts(world.ledger, world.orgId, world.missionId, 'USD'),
    evidence: review,
    candidates,
    modelAdapterId: null,
  });
}

function financialRowCounts(ledger: Ledger): Record<string, number> {
  const count = (sql: string): number => (ledger.db.prepare(sql).get() as { c: number }).c;
  return {
    financialEvidence: count(`SELECT COUNT(*) AS c FROM evidence_events WHERE topic = 'financial'`),
    operations: count('SELECT COUNT(*) AS c FROM operations'),
    commitments: count('SELECT COUNT(*) AS c FROM commitments'),
    outbox: count('SELECT COUNT(*) AS c FROM outbox_dispatches'),
    providerReceipts: count('SELECT COUNT(*) AS c FROM provider_receipts'),
  };
}

/**
 * The seeded funding (treasury, snapshot, mandate) is pre-existing demo
 * state — the assertion is that the PHYSICAL SCENARIO and the decision
 * derivation changed NONE of it: no operation, commitment, outbox row,
 * provider receipt, and no financial-topic evidence beyond the setup.
 */
function assertNoFinancialMutation(
  ledger: Ledger,
  label: string,
  before: Record<string, number>,
): void {
  expect(
    financialRowCounts(ledger),
    `${label}: physical events must never write financial rows`,
  ).toEqual(before);
}

describe('Trace A — harbor inspection (journal-derived decision, existing fixture)', () => {
  it('baseline is clear; the 24.6 kt incident blocks the UAV; the decision refuses the incumbent and names the alternative', () => {
    const world = makeScenarioWorld(offshoreScenario, 'traceA-harbor', {
      beneficiaries: ['harbor-diagnostics', 'harbor-marine'],
      purposes: ['harbor inspection'],
    });
    const financialBaseline = financialRowCounts(world.ledger);
    const incidentIdx = indexOfEnvelopeWith(world.build, (e) =>
      e.observations.some((o) => o.kind === 'wind_speed' && o.value === '24.6'),
    );
    expect(incidentIdx).toBeGreaterThan(0);

    // Baseline prefix (everything up to and including the pre-incident state).
    ingestPrefix(world, incidentIdx - 1);
    const clearBridge = bridgeFor(world, { 'uav-seeker-1': 'aerial' }, world.clock.now().getTime());
    const uavClear = [...clearBridge.evidence].reverse().find((e) => e.asset.id === 'uav-seeker-1');
    expect(uavClear?.constraint).toMatchObject({
      kind: 'asset-safety',
      state: 'clear',
      reason: 'nominal',
    });

    // The incident lands: measured 24.6 kt against the operator's 22 kt limit.
    ingestRange(world, incidentIdx, incidentIdx);
    const blockedBridge = bridgeFor(
      world,
      { 'uav-seeker-1': 'aerial' },
      world.clock.now().getTime(),
    );
    const uavBlocked = [...blockedBridge.evidence]
      .reverse()
      .find((e) => e.asset.id === 'uav-seeker-1');
    expect(uavBlocked?.constraint).toMatchObject({
      kind: 'asset-safety',
      state: 'blocked',
      reason: 'wind-limit',
      observedWindKt: 24.6,
      maxWindKt: 22,
    });

    // The SAME planner contract: UAV incumbent is gated, the vessel is not.
    const decision = decide(
      world,
      blockedBridge.evidence,
      {
        id: 'uav-seeker-1-flight',
        kind: 'inspection-service',
        beneficiary: 'harbor-diagnostics',
        purpose: 'harbor inspection',
        currency: 'USD',
        baseCostMinor: 1_200_000,
        feeMinor: 0,
        leadTimeMinutes: 60,
        durationMinutes: 180,
        probabilityOfSuccess: 0.9,
        availability: 'confirmed',
      },
      {
        id: 'vessel-transfer-crew',
        kind: 'inspection-service',
        beneficiary: 'harbor-marine',
        purpose: 'harbor inspection',
        currency: 'USD',
        baseCostMinor: 1_800_000,
        feeMinor: 50_000,
        leadTimeMinutes: 45,
        durationMinutes: 180,
        probabilityOfSuccess: 0.85,
        availability: 'confirmed',
      },
      'uav-seeker-1',
    );
    const uavScore = decision.trace.scores.find(
      (sc) => sc.candidate.id === 'continue-uav-seeker-1-flight',
    );
    expect(uavScore?.feasible).toBe(false);
    expect(uavScore?.rejection?.code).toBe('ASSET_SAFETY_BLOCKED');
    expect(decision.outcome).toBe('select');
    expect(decision.selected?.candidate.id).toBe('hire-vessel-transfer-crew');
    assertNoFinancialMutation(world.ledger, 'traceA-after-decision', financialBaseline);
    world.ledger.close();
  });
});

describe('Trace B — warehouse ground-robot interrupt (journal-derived decision, new fixture)', () => {
  it('comms loss blocks the robot; recovery restores telemetry but the ground verdict stays unknown; nothing is paid', () => {
    const world = makeScenarioWorld(warehouseInterruptScenario, 'traceB-warehouse', {
      beneficiaries: ['warehouse-robotics', 'warehouse-crew'],
      purposes: ['warehouse replenishment'],
    });
    const financialBaseline = financialRowCounts(world.ledger);
    const GROUND = { 'picker-bot-7': 'ground' } as const;

    // Running state: comms online → ground verdict is unknown (never clear).
    const runningIdx = indexOfEnvelopeWith(world.build, (e) =>
      e.observations.some((o) => o.kind === 'asset_comms' && o.value === 'degraded'),
    );
    ingestPrefix(world, runningIdx - 1);
    const running = bridgeFor(world, GROUND, world.clock.now().getTime());
    expect(running.evidence.at(-1)?.constraint).toMatchObject({
      state: 'unknown',
      reason: 'insufficient-evidence',
    });
    expect(running.evidence.at(-1)?.constraint.observedWindKt).toBeUndefined();

    // The comms loss lands: blocked/comms-offline (the supported ground block).
    const offlineIdx = indexOfEnvelopeWith(
      world.build,
      (e) =>
        e.source.sourceId === 'wms-supervisor' &&
        e.observations.some((o) => o.kind === 'asset_comms' && o.value === 'offline'),
    );
    ingestRange(world, runningIdx, offlineIdx);
    const blocked = bridgeFor(world, GROUND, world.clock.now().getTime());
    expect(blocked.evidence.at(-1)?.constraint).toMatchObject({
      state: 'blocked',
      reason: 'comms-offline',
    });

    // The planner contract: the robot incumbent is refused; a manual
    // alternative that does NOT require the asset stays selectable.
    const decision = decide(
      world,
      blocked.evidence,
      {
        id: 'picker-bot-7-replenish',
        kind: 'inspection-service',
        beneficiary: 'warehouse-robotics',
        purpose: 'warehouse replenishment',
        currency: 'USD',
        baseCostMinor: 300_000,
        feeMinor: 0,
        leadTimeMinutes: 30,
        durationMinutes: 120,
        probabilityOfSuccess: 0.95,
        availability: 'confirmed',
      },
      {
        id: 'manual-night-crew',
        kind: 'inspection-service',
        beneficiary: 'warehouse-crew',
        purpose: 'warehouse replenishment',
        currency: 'USD',
        baseCostMinor: 750_000,
        feeMinor: 0,
        leadTimeMinutes: 90,
        durationMinutes: 240,
        probabilityOfSuccess: 0.9,
        availability: 'confirmed',
      },
      'picker-bot-7',
    );
    const robotScore = decision.trace.scores.find(
      (sc) => sc.candidate.id === 'continue-picker-bot-7-replenish',
    );
    expect(robotScore?.feasible).toBe(false);
    expect(robotScore?.rejection?.code).toBe('ASSET_SAFETY_BLOCKED');
    expect(robotScore?.rejection?.reason).toContain('comms-offline');

    // Full arc to the end: recovery + healthy ground facts journaled — yet the
    // verdict is STILL unknown (no supported ground clearance; Agent A request).
    ingestRange(world, offlineIdx + 1, world.build.script.length - 1);
    const final = bridgeFor(world, GROUND, world.clock.now().getTime());
    expect(final.evidence.at(-1)?.constraint).toMatchObject({
      state: 'unknown',
      reason: 'insufficient-evidence',
    });
    const finalDecision = decide(
      world,
      final.evidence,
      {
        id: 'picker-bot-7-replenish',
        kind: 'inspection-service',
        beneficiary: 'warehouse-robotics',
        purpose: 'warehouse replenishment',
        currency: 'USD',
        baseCostMinor: 300_000,
        feeMinor: 0,
        leadTimeMinutes: 30,
        durationMinutes: 120,
        probabilityOfSuccess: 0.95,
        availability: 'confirmed',
      },
      {
        id: 'manual-night-crew',
        kind: 'inspection-service',
        beneficiary: 'warehouse-crew',
        purpose: 'warehouse replenishment',
        currency: 'USD',
        baseCostMinor: 750_000,
        feeMinor: 0,
        leadTimeMinutes: 90,
        durationMinutes: 240,
        probabilityOfSuccess: 0.9,
        availability: 'confirmed',
      },
      'picker-bot-7',
    );
    const finalRobot = finalDecision.trace.scores.find(
      (sc) => sc.candidate.id === 'continue-picker-bot-7-replenish',
    );
    expect(finalRobot?.feasible).toBe(false);
    expect(finalRobot?.rejection?.code).toBe('ASSET_SAFETY_BLOCKED');
    expect(finalRobot?.rejection?.reason).toContain('unknown');

    // Recovery proved payment-free and the whole arc wrote zero financial rows.
    assertNoFinancialMutation(world.ledger, 'traceB-full-arc', financialBaseline);
    world.ledger.close();
  });

  it('deriving the decision twice from the same journal yields identical evidence and decisions (duplicates can never duplicate proposals)', () => {
    const world = makeScenarioWorld(warehouseInterruptScenario, 'traceB-idempotent', {
      beneficiaries: ['warehouse-robotics', 'warehouse-crew'],
      purposes: ['warehouse replenishment'],
    });
    const financialBaseline = financialRowCounts(world.ledger);
    ingestRange(world, 0, world.build.script.length - 1);
    const first = bridgeFor(world, { 'picker-bot-7': 'ground' }, world.clock.now().getTime());
    const second = bridgeFor(world, { 'picker-bot-7': 'ground' }, world.clock.now().getTime());
    expect(JSON.stringify(first.evidence)).toBe(JSON.stringify(second.evidence));
    expect(first.withheldEventIds).toEqual(second.withheldEventIds);
    const d1 = decide(
      world,
      first.evidence,
      {
        id: 'picker-bot-7-replenish',
        kind: 'inspection-service',
        beneficiary: 'warehouse-robotics',
        purpose: 'warehouse replenishment',
        currency: 'USD',
        baseCostMinor: 300_000,
        feeMinor: 0,
        leadTimeMinutes: 30,
        durationMinutes: 120,
        probabilityOfSuccess: 0.95,
        availability: 'confirmed',
      },
      {
        id: 'manual-night-crew',
        kind: 'inspection-service',
        beneficiary: 'warehouse-crew',
        purpose: 'warehouse replenishment',
        currency: 'USD',
        baseCostMinor: 750_000,
        feeMinor: 0,
        leadTimeMinutes: 90,
        durationMinutes: 240,
        probabilityOfSuccess: 0.9,
        availability: 'confirmed',
      },
      'picker-bot-7',
    );
    const d2 = decide(
      world,
      second.evidence,
      {
        id: 'picker-bot-7-replenish',
        kind: 'inspection-service',
        beneficiary: 'warehouse-robotics',
        purpose: 'warehouse replenishment',
        currency: 'USD',
        baseCostMinor: 300_000,
        feeMinor: 0,
        leadTimeMinutes: 30,
        durationMinutes: 120,
        probabilityOfSuccess: 0.95,
        availability: 'confirmed',
      },
      {
        id: 'manual-night-crew',
        kind: 'inspection-service',
        beneficiary: 'warehouse-crew',
        purpose: 'warehouse replenishment',
        currency: 'USD',
        baseCostMinor: 750_000,
        feeMinor: 0,
        leadTimeMinutes: 90,
        durationMinutes: 240,
        probabilityOfSuccess: 0.9,
        availability: 'confirmed',
      },
      'picker-bot-7',
    );
    expect(d1.trace.inputDigest).toBe(d2.trace.inputDigest);
    expect(d1.trace.scores).toEqual(d2.trace.scores);
    world.ledger.close();
  });
});
