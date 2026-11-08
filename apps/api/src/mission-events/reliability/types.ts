/**
 * Reliability-matrix types (issue #15 evidence layer; issue #9/19 lanes).
 *
 * A scenario is a self-contained, seeded, deterministic case executed against
 * REAL services: a real temp SQLite ledger, the real mission-event ingest
 * service, the real planner public API and the real integration bridge
 * (read-only). Every case declares the fault/change it injects and collects
 * named expected-vs-actual checks; the matrix runner aggregates them into a
 * machine-readable result and a human summary.
 *
 * TRUTH LABEL: every scenario is SIMULATED_OPERATION with SYNTHETIC sources.
 * Financial interaction cases exercise the POLICY-ONLY planner over ledger
 * facts; no provider, bank or physical vehicle is ever contacted, and a
 * "side effect" count of >0 means durable ledger rows created through public
 * interfaces — never real money movement.
 */
import type { Ledger } from '@moterva/ledger';
import type {
  DecisionResult,
  EvidenceReview,
  FinancialFacts,
  FinancialPolicy,
  PlannerCandidate,
  SupplierOffer,
} from '@moterva/planner';
import type { MissionEventIngestService } from '../src/ingest.js';
import type { EnvelopeWire, NormalizedObservation } from '../src/schema.js';
import type { RegisteredSource } from '../src/registry.js';
import type { PhysicalSafetyBridgeResult } from '../../integration/physical-to-planner.js';

export type ScenarioFamily = 'physical-evidence' | 'financial-interaction' | 'baseline-comparison';

export type PhysicalDomain = 'offshore' | 'warehouse' | 'cross-domain' | 'none';

export interface SideEffectCounts {
  /** Ledger operations rows created by the scenario (public interfaces only). */
  readonly operations: number;
  readonly commitments: number;
  /** Approvals across v1/v2 tables. */
  readonly approvals: number;
  readonly providerReceipts: number;
  /** evidence_events rows with topic 'financial' (must stay 0 for physical cases). */
  readonly financialEvidence: number;
  /** evidence_events rows with topic 'operational'. */
  readonly operationalEvidence: number;
}

export interface CheckResult {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
}

export interface PlannerObservation {
  /** Decision outcome of the public planner evaluate(): select|decline|escalate. */
  readonly outcome: string;
  /** Selected candidate id, when outcome is select. */
  readonly selectedId: string | null;
  /** Rejection codes observed across scored candidates. */
  readonly rejectionCodes: readonly string[];
  /** Bridge evidence entries handed to the planner. */
  readonly bridgeEvidence: number;
  /** Event ids the bridge withheld (stale/expired/not-planning-valid). */
  readonly bridgeWithheld: number;
  /** Constraint states the bridge derived, in order. */
  readonly constraintStates: readonly string[];
  readonly note: string;
}

export interface BaselineComparison {
  readonly plannerPick: string;
  readonly plannerNetMinor: number;
  readonly cheapestFirst: { pick: string; netMinor: number };
  readonly earliestDeadlineFirst: { pick: string; netMinor: number };
  readonly staticSafe: { pick: string; netMinor: number };
  /** Honest verdict against the strongest baseline. */
  readonly verdict: 'planner-wins' | 'tie' | 'baseline-wins';
  readonly explanation: string;
}

export interface CaseResult {
  readonly id: string;
  readonly family: ScenarioFamily;
  readonly domain: PhysicalDomain;
  readonly seed: string;
  readonly summary: string;
  readonly fault: string;
  readonly checks: readonly CheckResult[];
  readonly planner?: PlannerObservation;
  readonly baseline?: BaselineComparison;
  readonly sideEffects: SideEffectCounts;
  readonly expectedSideEffects?: SideEffectCounts;
  readonly replayDeterministic: boolean | null;
  readonly replayNote: string;
  readonly pass: boolean;
  readonly explanation: string;
}

/** What a scenario's run() returns; the harness fills identity fields. */
export interface CaseRunOutput {
  readonly planner?: PlannerObservation;
  readonly baseline?: BaselineComparison;
  readonly sideEffects: SideEffectCounts;
  readonly expectedSideEffects?: SideEffectCounts;
  /** Filled by the matrix runner (two full runs compared); scenarios leave it unset. */
  readonly replayDeterministic?: boolean | null;
  readonly replayNote?: string;
  /** Extra aggregate pass flag beyond the recorded checks. */
  readonly pass?: boolean;
  readonly explanation: string;
}

export interface ScenarioCase {
  readonly id: string;
  readonly family: ScenarioFamily;
  readonly domain: PhysicalDomain;
  readonly seed: string;
  readonly summary: string;
  readonly fault: string;
  run(h: HarnessApi): CaseRunOutput;
}

/**
 * The per-scenario API the harness hands to each case. Everything routes
 * through public services; nothing here bypasses a boundary.
 */
export interface HarnessApi {
  /** Real migrated temp-ledger world (org + mission + registered sources). */
  readonly world: WorldHandle;
  /** Advance/reset helpers over the deterministic clock. */
  readonly clock: {
    now(): Date;
    advanceMs(ms: number): void;
    setTo(iso: string): void;
  };
  /** A fresh service instance over the same ledger (simulates a restart). */
  freshService(): MissionEventIngestService;
  /** Signed wire envelope; advances the clock to the ingest anchor. */
  env(spec: EnvelopeSpec): EnvelopeWire;
  /** Submit + classify one envelope through a service instance. */
  submit(
    service: MissionEventIngestService,
    envelope: EnvelopeWire,
  ): { status: 'accepted' | 'rejected'; code?: string; message?: string };
  /** The public planner chain: replay → bridge → review → generate → evaluate. */
  plan(input: PlanInput): PlanChain;
  /** Record a named expected-vs-actual check. */
  check(name: string, expected: unknown, actual: unknown): void;
  /** Ledger side-effect snapshot (operations/commitments/approvals/receipts/evidence). */
  sideEffects(): SideEffectCounts;
}

export interface WorldHandle {
  readonly ledger: Ledger;
  readonly orgId: string;
  readonly missionId: string;
  readonly telemetrySource: RegisteredSource;
  readonly gatewaySource: RegisteredSource;
  /** A second org reusing the same source/asset id STRINGS (tenant cases). */
  readonly mirrorOrg: {
    orgId: string;
    missionId: string;
    source: RegisteredSource;
  };
  /** A second mission in the same org reusing the same asset/source strings. */
  readonly secondMission: {
    missionId: string;
    source: RegisteredSource;
  };
  /** Fund the org treasury + issue a mandate through public ledger services. */
  fund(options?: {
    balanceMinor?: number;
    protectedFloorMinor?: number;
    mandateMaxMinor?: number;
    mandateExpiresInMs?: number;
  }): void;
}

export interface EnvelopeSpec {
  source?: RegisteredSource;
  orgId?: string;
  missionId?: string;
  assetId?: string;
  eventId?: string;
  sequence?: number;
  observedAt?: string;
  ingestedAt?: string;
  provenance?: 'SYNTHETIC' | 'FIELD';
  signature?: string;
  observations?: readonly NormalizedObservation[];
}

export interface PlanInput {
  readonly service: MissionEventIngestService;
  readonly orgId: string;
  readonly missionId: string;
  readonly uavWindLimitKt: number;
  /** Defaults to the connected-demo UAV incumbent. */
  readonly incumbent?: SupplierOffer;
  readonly alternatives?: readonly SupplierOffer[];
  readonly incumbentAssetId?: string;
  readonly diagnosticService?: SupplierOffer;
  readonly diagnosticInformationGain?: number;
  readonly policy?: Partial<FinancialPolicy>;
  /** Use real ledger facts (financial cases) instead of constructed facts. */
  readonly factsFromLedger?: boolean;
  readonly facts?: FinancialFacts;
}

export interface PlanChain {
  readonly bridge: PhysicalSafetyBridgeResult;
  readonly decision: DecisionResult;
  readonly review: EvidenceReview;
  readonly candidates: readonly PlannerCandidate[];
}
