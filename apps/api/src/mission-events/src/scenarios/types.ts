/**
 * Scenario framework: a scenario is a SCRIPTED, SEEDED sequence of submissions
 * with expected outcomes. The script is the reproducible artifact — the same
 * seed + world always yields the same envelopes, signatures, timestamps and
 * expectations. Narrative `beat`/`economicEffect` strings are SYNTHETIC
 * SCENARIO ANNOTATIONS for humans reading a trace; they are never journaled
 * and never evidence.
 */
import type { MissionEventErrorCode } from '../errors.js';
import type { EnvelopeWire } from '../schema.js';
import type { RegisteredSource } from '../registry.js';

export interface ScenarioWorld {
  readonly orgId: string;
  readonly missionId: string;
}

export interface ExpectedOutcome {
  readonly status: 'accepted' | 'rejected';
  readonly code?: MissionEventErrorCode;
}

export interface ScriptedSubmission {
  readonly envelope: EnvelopeWire;
  /** Wall anchor for the ingest clock when this submission runs. */
  readonly at: string;
  readonly expect: ExpectedOutcome;
  /** Human-facing SYNTHETIC annotation (never journaled). */
  readonly beat?: string;
  /** What should change in downstream financial REASONING (planner-facing annotation; not authority). */
  readonly economicEffect?: string;
}

export interface ScenarioBuild {
  readonly id: string;
  readonly seed: string;
  readonly title: string;
  readonly world: ScenarioWorld;
  readonly sources: readonly RegisteredSource[];
  readonly assets: readonly string[];
  readonly script: readonly ScriptedSubmission[];
  /** One-paragraph SYNTHETIC provenance statement printed with the trace. */
  readonly provenanceStatement: string;
}

export interface ScenarioDefinition {
  readonly id: string;
  readonly title: string;
  readonly defaultSeed: string;
  build(world: ScenarioWorld, seed?: string): ScenarioBuild;
}

export interface SubmissionResult {
  readonly index: number;
  readonly eventId: string;
  readonly at: string;
  readonly expect: ExpectedOutcome;
  readonly actual: ExpectedOutcome;
  readonly matched: boolean;
  readonly message?: string;
  readonly journalSeq?: number;
  readonly eventDigest?: string;
  readonly beat?: string;
  readonly economicEffect?: string;
}

export interface ScenarioRunReport {
  readonly scenarioId: string;
  readonly seed: string;
  readonly title: string;
  readonly provenanceStatement: string;
  readonly submissions: readonly SubmissionResult[];
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly allExpectationsMatched: boolean;
  /** Deterministic fingerprint of the submitted envelopes (stable per seed+world). */
  readonly scriptDigest: string;
}
