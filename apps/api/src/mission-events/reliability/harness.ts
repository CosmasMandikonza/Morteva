/**
 * Reliability harness core (issue #15 evidence layer).
 *
 * Builds REAL worlds — temp SQLite ledger, deterministic clock, registered
 * synthetic sources — and drives the three public seams:
 *   1. mission-event ingestion (this module, including the accepted
 *      cross-source atomic admission correction),
 *   2. the integration bridge `physicalTimelineToPlannerSafety` (Agent A's,
 *      imported READ-ONLY here), and
 *   3. the @moterva/planner public API (reviewEvidence → generateCandidates
 *      → evaluate) plus @moterva/ledger public services for the financial
 *      interaction cases.
 *
 * Nothing in this file edits the planner, the bridge or the ledger. Side
 * effects are counted from the ledger itself. All content is SYNTHETIC /
 * SIMULATED_OPERATION.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluate,
  financialFacts,
  generateCandidates,
  reviewEvidence,
  type FinancialFacts,
  type FinancialPolicy,
  type ScoredCandidate,
  type SupplierOffer,
} from '@moterva/planner';
import { openLedger, TunableClock, type Ledger } from '@moterva/ledger';
import { physicalTimelineToPlannerSafety } from '../../integration/physical-to-planner.js';
import { MissionEventIngestService } from '../src/ingest.js';
import { SourceRegistry, type RegisteredSource } from '../src/registry.js';
import { sourceSignature } from '../src/digest.js';
import { fixtureSourceKey } from '../src/rng.js';
import type { EnvelopeWire, NormalizedObservation } from '../src/schema.js';
import type {
  BaselineComparison,
  CaseResult,
  CheckResult,
  EnvelopeSpec,
  HarnessApi,
  PlanChain,
  PlanInput,
  ScenarioCase,
  SideEffectCounts,
  WorldHandle,
} from './types.js';

export const HARNESS_T0 = '2026-11-06T09:00:00.000Z';

/** Deterministic default financial policy (explicit assumptions). */
export const DEFAULT_POLICY: FinancialPolicy = {
  version: 1,
  currency: 'USD',
  missionDeadlineAt: '2026-11-06T17:00:00.000Z',
  missionValueMinor: 5_000_000,
  failureCostMinor: 1_500_000,
  protectedReserveMinor: 400_000,
  maxProbabilityAssumption: 0.95,
  unconfirmedAvailabilityFactor: 0.7,
  diagnosticValueThreshold: 2,
  forbidUnconfirmedAvailability: false,
  escalationScoreGap: 100_000,
};

/** Grounded in the connected demo catalogue (demo-routes.ts): the same offers. */
export const UAV_INCUMBENT: SupplierOffer = {
  id: 'uav-inspection',
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
};

export const VESSEL_ALTERNATIVE: SupplierOffer = {
  id: 'vessel-inspection',
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
};

export const ROBOT_INCUMBENT: SupplierOffer = {
  id: 'robot-cycle-count',
  kind: 'inspection-service',
  beneficiary: 'warehouse-robotics',
  purpose: 'warehouse count',
  currency: 'USD',
  baseCostMinor: 300_000,
  feeMinor: 0,
  leadTimeMinutes: 30,
  durationMinutes: 120,
  probabilityOfSuccess: 0.95,
  availability: 'confirmed',
};

export const MANUAL_COUNT_ALTERNATIVE: SupplierOffer = {
  id: 'manual-cycle-count',
  kind: 'inspection-service',
  beneficiary: 'warehouse-crew',
  purpose: 'warehouse count',
  currency: 'USD',
  baseCostMinor: 750_000,
  feeMinor: 0,
  leadTimeMinutes: 90,
  durationMinutes: 240,
  probabilityOfSuccess: 0.9,
  availability: 'confirmed',
};

const count = (ledger: Ledger, sql: string): number =>
  (ledger.db.prepare(sql).get() as { c: number }).c;

/** Count a table only when the migrated schema actually has it. */
const countIfTable = (ledger: Ledger, table: string): number => {
  const row = ledger.db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return row === undefined ? 0 : count(ledger, `SELECT COUNT(*) AS c FROM ${table}`);
};

/** Count durable ledger side effects through the database the ledger owns. */
export function sideEffectsOf(ledger: Ledger, orgId: string): SideEffectCounts {
  return {
    operations: countIfTable(ledger, 'operations'),
    commitments: countIfTable(ledger, 'commitments'),
    approvals: countIfTable(ledger, 'approvals') + countIfTable(ledger, 'approvals_v2'),
    providerReceipts: countIfTable(ledger, 'provider_receipts'),
    financialEvidence: count(
      ledger,
      `SELECT COUNT(*) AS c FROM evidence_events WHERE topic = 'financial'`,
    ),
    operationalEvidence: count(
      ledger,
      `SELECT COUNT(*) AS c FROM evidence_events WHERE topic = 'operational' AND org_id = '${sqlSafe(orgId)}'`,
    ),
  };
}

function sqlSafe(id: string): string {
  return id.replace(/'/g, "''");
}

/** Execute one scenario case on a fresh real world. */
export function runCase(scenario: ScenarioCase): {
  result: CaseResult;
  close: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'moterva-reliability-'));
  const clock = new TunableClock(HARNESS_T0);
  // The ledger shares the deterministic clock: mandate expiry, balance
  // freshness and journal recordedAt all follow scenario time.
  const ledger = openLedger(join(dir, 'ledger.sqlite'), clock);
  ledger.migrate();
  const seed = scenario.seed;

  const org = ledger.organizations.createOrganization(`reliability-${scenario.id}`);
  const mission = ledger.organizations.createMission(org.id, `${scenario.id} mission`);
  const asset = 'asset-uav-1';
  const telemetrySource: RegisteredSource = {
    orgId: org.id,
    missionId: mission.id,
    sourceId: 'src-telemetry',
    sourceType: 'asset_telemetry',
    keyId: `key-tel-${scenario.id}`,
    secretKey: fixtureSourceKey(seed, 'src-telemetry'),
    provenance: 'SYNTHETIC',
    assetIds: [asset],
    trustedForRecovery: false,
  };
  const gatewaySource: RegisteredSource = {
    orgId: org.id,
    missionId: mission.id,
    sourceId: 'src-gateway',
    sourceType: 'vessel_gateway',
    keyId: `key-gw-${scenario.id}`,
    secretKey: fixtureSourceKey(seed, 'src-gateway'),
    provenance: 'SYNTHETIC',
    assetIds: [asset],
    trustedForRecovery: true,
  };
  const mirrorOrgRow = ledger.organizations.createOrganization(`mirror-${scenario.id}`);
  const mirrorMission = ledger.organizations.createMission(mirrorOrgRow.id, 'mirror mission');
  const mirrorSource: RegisteredSource = {
    orgId: mirrorOrgRow.id,
    missionId: mirrorMission.id,
    sourceId: 'src-telemetry', // SAME id string, different org
    sourceType: 'asset_telemetry',
    keyId: `key-tel-mirror-${scenario.id}`,
    secretKey: fixtureSourceKey(seed, 'mirror'),
    provenance: 'SYNTHETIC',
    assetIds: [asset], // SAME asset id string
    trustedForRecovery: false,
  };
  const secondMissionRow = ledger.organizations.createMission(org.id, 'second mission');
  const secondMissionSource: RegisteredSource = {
    orgId: org.id,
    missionId: secondMissionRow.id,
    sourceId: 'src-telemetry', // SAME id string, same org, different mission
    sourceType: 'asset_telemetry',
    keyId: `key-tel-m2-${scenario.id}`,
    secretKey: fixtureSourceKey(seed, 'm2'),
    provenance: 'SYNTHETIC',
    assetIds: [asset],
    trustedForRecovery: false,
  };

  const registry = new SourceRegistry();
  registry.registerAll([telemetrySource, gatewaySource, mirrorSource, secondMissionSource]);

  const world: WorldHandle = {
    ledger,
    orgId: org.id,
    missionId: mission.id,
    telemetrySource,
    gatewaySource,
    mirrorOrg: { orgId: mirrorOrgRow.id, missionId: mirrorMission.id, source: mirrorSource },
    secondMission: { missionId: secondMissionRow.id, source: secondMissionSource },
    fund(options = {}) {
      const balance = options.balanceMinor ?? 3_000_000;
      ledger.accounts.ensureTreasuryAccount({
        orgId: org.id,
        currency: 'USD',
        label: 'USD',
        protectedFloorMinor: options.protectedFloorMinor ?? 0,
      });
      ledger.accounts.recordBalanceSnapshot({
        orgId: org.id,
        currency: 'USD',
        minorUnits: balance,
        source: 'manual-seed',
        observedAt: clock.iso(),
        expiresAt: new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(),
      });
      ledger.mandates.issue({
        orgId: org.id,
        missionId: mission.id,
        currency: 'USD',
        maxAmountMinor: options.mandateMaxMinor ?? 2_500_000,
        totalBudgetMinor: options.mandateMaxMinor ?? 2_500_000,
        permittedOperationKinds: ['airwallex_transfer'],
        expiresAt: new Date(
          clock.now().getTime() + (options.mandateExpiresInMs ?? 24 * 3_600_000),
        ).toISOString(),
      });
    },
  };

  const checks: CheckResult[] = [];
  const check = (name: string, expected: unknown, actual: unknown): void => {
    checks.push({
      name,
      expected: String(expected),
      actual: String(actual),
      pass: String(expected) === String(actual),
    });
  };

  const api: HarnessApi = {
    world,
    clock: {
      now: () => clock.now(),
      advanceMs: (ms) => void clock.advance(ms),
      setTo: (iso) => {
        clock.advance(Date.parse(iso) - clock.now().getTime());
      },
    },
    freshService: () => new MissionEventIngestService(ledger, clock, registry),
    env(spec: EnvelopeSpec): EnvelopeWire {
      const source = spec.source ?? telemetrySource;
      const observedAt = spec.observedAt ?? clock.iso();
      const ingestedAt = spec.ingestedAt ?? clock.iso();
      const anchor = Date.parse(ingestedAt);
      if (anchor > clock.now().getTime()) clock.advance(anchor - clock.now().getTime());
      const unsigned = {
        contractVersion: 1,
        eventId: spec.eventId ?? `mevt_r${Math.random().toString(16).slice(2, 10)}`,
        sequence: spec.sequence ?? 1,
        orgId: spec.orgId ?? org.id,
        missionId: spec.missionId ?? mission.id,
        assetId: spec.assetId ?? asset,
        observedAt,
        ingestedAt,
        source: {
          sourceId: source.sourceId,
          sourceType: source.sourceType,
          keyId: source.keyId,
          provenance: spec.provenance ?? source.provenance,
        },
        observations: (spec.observations ?? [
          { kind: 'battery_soc', unit: 'percent', value: 80 },
        ]) as NormalizedObservation[],
      };
      const signature = spec.signature ?? sourceSignature(unsigned as never, source.secretKey);
      return { ...unsigned, source: { ...unsigned.source, signature } } as EnvelopeWire;
    },
    submit(service, envelope) {
      try {
        service.ingest((envelope as { orgId: string }).orgId, envelope);
        return { status: 'accepted', code: undefined, message: undefined };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const match = /\[([A-Z_]+)\]/.exec(message);
        return {
          status: 'rejected',
          code: match?.[1] ?? 'UNKNOWN',
          message,
        };
      }
    },
    plan(input: PlanInput): PlanChain {
      const timeline = input.service.replay(input.orgId, input.missionId);
      const bridge = physicalTimelineToPlannerSafety(timeline, {
        orgId: input.orgId,
        missionId: input.missionId,
        asOf: clock.now(),
        uavWindLimitKt: input.uavWindLimitKt,
      });
      const review = reviewEvidence([...bridge.evidence], clock.now(), {
        orgId: input.orgId,
        missionId: input.missionId,
      });
      const policy: FinancialPolicy = { ...DEFAULT_POLICY, ...input.policy };
      const candidates = generateCandidates(review.accepted, {
        now: clock.now(),
        policyCurrency: policy.currency,
        missionDeadlineAt: policy.missionDeadlineAt,
        incumbent: input.incumbent ?? UAV_INCUMBENT,
        incumbentAssetId: input.incumbentAssetId,
        alternatives: input.alternatives ?? [],
        diagnosticService: input.diagnosticService,
        diagnosticInformationGain: input.diagnosticInformationGain,
      });
      const facts: FinancialFacts = input.factsFromLedger
        ? financialFacts(ledger, input.orgId, input.missionId, 'USD')
        : (input.facts ?? constructedFacts(input.orgId, input.missionId));
      const decision = evaluate({
        now: clock.now(),
        policy,
        facts,
        evidence: review,
        candidates,
        modelAdapterId: null,
      });
      return { bridge, review, candidates, decision };
    },
    check,
    sideEffects: () => sideEffectsOf(ledger, org.id),
  };

  let outcome: CaseResult;
  try {
    const partial = scenario.run(api);
    const pass = checks.every((c) => c.pass);
    outcome = {
      id: scenario.id,
      family: scenario.family,
      domain: scenario.domain,
      seed: scenario.seed,
      summary: scenario.summary,
      fault: scenario.fault,
      checks,
      planner: partial.planner,
      baseline: partial.baseline,
      sideEffects: partial.sideEffects,
      expectedSideEffects: partial.expectedSideEffects,
      replayDeterministic: partial.replayDeterministic ?? null,
      replayNote: partial.replayNote ?? '',
      pass: pass && partial.pass !== false,
      explanation: partial.explanation,
    };
  } finally {
    // caller closes via returned handle
  }
  return {
    result: outcome,
    close: () => {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Fresh constructed facts (pure planner path — no ledger rows created). */
export function constructedFacts(orgId: string, missionId: string): FinancialFacts {
  return {
    orgId,
    missionId,
    currency: 'USD',
    balanceStatus: 'ok',
    balanceMinor: 3_000_000,
    spendableMinor: 3_000_000,
    outstandingCommittedMinor: 0,
    ambiguousCommittedMinor: 0,
    protectedFloorMinor: 0,
    mandate: {
      id: 'mandate-constructed',
      version: 1,
      expiresAt: '2026-11-07T09:00:00.000Z',
      maxPerPaymentMinor: 2_500_000,
      remainingBudgetMinor: 2_500_000,
      permittedKinds: ['airwallex_transfer'],
      allowedBeneficiaries: [],
      allowedPurposes: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Fair economic baselines (issue #15): computed over the SAME candidate set
// the constrained planner saw, scored by the SAME scoreCandidate math.
// ---------------------------------------------------------------------------

export function compareBaselines(
  scored: readonly ScoredCandidate[],
  plannerPick: ScoredCandidate,
): BaselineComparison {
  const paid = scored.filter((s) => s.candidate.costMinor + s.candidate.feeMinor > 0);
  const finishOf = (s: ScoredCandidate): number =>
    Date.parse(s.candidate.earliestStartAt) + s.candidate.durationMinutes * 60_000;
  const deadline = Number.MAX_SAFE_INTEGER; // candidates already deadline-gated by the planner

  // cheapest-first: lowest gross among paid offers (the naive procurement
  // heuristic); physically blocked/riskier picks keep their true score.
  const cheapest =
    paid.length > 0
      ? [...paid].sort(
          (a, b) =>
            a.grossCostMinor - b.grossCostMinor || a.candidate.id.localeCompare(b.candidate.id),
        )[0]!
      : undefined;
  // earliest-deadline-first: paid offer that finishes soonest.
  const earliest =
    paid.length > 0
      ? [...paid].sort(
          (a, b) => finishOf(a) - finishOf(b) || a.candidate.id.localeCompare(b.candidate.id),
        )[0]!
      : undefined;
  void deadline;
  // static-safe: never spends — no-action, scored by the same model.
  const staticSafe = scored.find((s) => s.candidate.kind === 'no-action');

  const net = (s: ScoredCandidate | undefined): number => s?.expectedNetMinor ?? Number.NaN;
  const bestBaseline = Math.max(net(cheapest), net(earliest), net(staticSafe));
  const plannerNet = plannerPick.expectedNetMinor;
  const verdict: BaselineComparison['verdict'] =
    plannerNet > bestBaseline
      ? 'planner-wins'
      : plannerNet === bestBaseline
        ? 'tie'
        : 'baseline-wins';
  return {
    plannerPick: plannerPick.candidate.id,
    plannerNetMinor: plannerNet,
    cheapestFirst: { pick: cheapest?.candidate.id ?? '(none)', netMinor: net(cheapest) },
    earliestDeadlineFirst: { pick: earliest?.candidate.id ?? '(none)', netMinor: net(earliest) },
    staticSafe: { pick: staticSafe?.candidate.id ?? '(none)', netMinor: net(staticSafe) },
    verdict,
    explanation:
      verdict === 'planner-wins'
        ? 'constrained planner achieved a strictly higher expected net than every baseline'
        : verdict === 'tie'
          ? 'a simpler baseline matched the planner exactly — recorded honestly'
          : 'a simpler baseline matched or beat the planner on this scenario — recorded honestly',
  };
}
