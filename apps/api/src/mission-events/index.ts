/**
 * Mission-event ingestion module — public surface (issue #9, Agent C lane).
 *
 * Consumers (planner, replay tooling, future routes) import from here. The
 * module owns: the versioned typed envelope contract, source authentication,
 * validation/rejection taxonomy, deterministic seeded scenario fixtures, and
 * persistence/replay through the EXISTING append-only evidence journal
 * (topic `operational`). It deliberately does NOT expose any financial
 * operation: nothing here can approve, reserve, settle or dispatch money.
 */
export { MISSION_EVENT_CONTRACT_VERSION, INGEST_VALIDATOR_VERSION } from './src/version.js';
export { MISSION_EVENT_ERROR_CODES, MissionEventError, isMissionEventError } from './src/errors.js';
export type { MissionEventErrorCode } from './src/errors.js';
export {
  OBSERVATION_KINDS,
  SOURCE_TYPES,
  PROVENANCE_LABELS,
  FINANCIAL_AUTHORITY_TERMS,
  containsAuthorityTerm,
  observationKindSpec,
} from './src/vocabulary.js';
export type {
  ObservationKind,
  ObservationValue,
  ProvenanceLabel,
  SourceType,
} from './src/vocabulary.js';
export {
  envelopeSchema,
  normalizedEventSchema,
  parseEnvelope,
  parseNormalizedEvent,
} from './src/schema.js';
export type {
  EnvelopeWire,
  NormalizedEvent,
  NormalizedEventWire,
  NormalizedObservation,
  NormalizedSource,
  ObservationWire,
} from './src/schema.js';
export { eventDigest, sourceSignature, signatureMatches } from './src/digest.js';
export { SourceRegistry } from './src/registry.js';
export type { RegisteredSource } from './src/registry.js';
export {
  DEFAULT_FRESHNESS_POLICY,
  applyEvent,
  assetStateKey,
  commsState,
  freshnessOf,
  newIngestState,
  projectTimeline,
  streamKey,
} from './src/view.js';
export type {
  AcceptedEventView,
  AssetStateView,
  Freshness,
  FreshnessPolicy,
  IngestState,
  JournaledEvent,
  MissionTimelineView,
  ObservationReading,
  StreamStateView,
} from './src/view.js';
export { JOURNAL_EVENT_TYPE, MissionEventIngestService } from './src/ingest.js';
export type {
  IngestAccepted,
  IngestOptions,
  IngestOutcome,
  IngestRejection,
} from './src/ingest.js';
export { SeededRandom, fnv1a32, deterministicEventId, fixtureSourceKey } from './src/rng.js';
export { offshoreScenario, OFFSHORE_SCENARIO_T0_MS } from './src/scenarios/offshore.js';
export { warehouseScenario, WAREHOUSE_SCENARIO_T0_MS } from './src/scenarios/warehouse.js';
export { warehouseInterruptScenario, WAREHOUSE_INTERRUPT_T0_MS } from './src/scenarios/warehouse-interrupt.js';
export { runScenario } from './src/scenarios/runner.js';
export { scriptDigest } from './src/scenarios/builder.js';
export type {
  ExpectedOutcome,
  ScenarioBuild,
  ScenarioDefinition,
  ScenarioRunReport,
  ScenarioWorld,
  ScriptedSubmission,
  SubmissionResult,
} from './src/scenarios/types.js';
export { runDemo, type DemoReport, type DemoScenarioReport } from './demo/run.js';
