/**
 * Scenario builder: constructs signed wire envelopes from short specs.
 * Sequences, event ids, timestamps and observation jitter all derive from the
 * scenario seed, so `build(world, seed)` is a pure function.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@moterva/domain';
import { MISSION_EVENT_CONTRACT_VERSION } from '../version.js';
import { deterministicEventId, fixtureSourceKey, SeededRandom } from '../rng.js';
import { sourceSignature } from '../digest.js';
import type { EnvelopeWire, NormalizedObservation } from '../schema.js';
import type { RegisteredSource } from '../registry.js';
import type { ScenarioWorld, ScriptedSubmission, ExpectedOutcome } from './types.js';

export interface SubmissionSpec {
  readonly source: RegisteredSource;
  readonly assetId: string;
  readonly sequence: number;
  /** Minutes after scenario T0 when the observation was made. */
  readonly observedMin: number;
  /** Seconds after observedAt when the source emitted the event (>= 0). */
  readonly emitDelaySec?: number;
  readonly observations: readonly NormalizedObservation[];
  readonly expect: ExpectedOutcome;
  readonly beat?: string;
  readonly economicEffect?: string;
  /** Override the deterministic event id (used for exact-replay beats). */
  readonly eventId?: string;
  /** Override the signature key: a rogue/unregistered source beat. */
  readonly signatureHex?: string;
}

export class ScenarioBuilder {
  private readonly random: SeededRandom;

  constructor(
    private readonly world: ScenarioWorld,
    readonly seed: string,
    private readonly t0Ms: number,
  ) {
    this.random = new SeededRandom(`jitter|${seed}`);
  }

  submission(spec: SubmissionSpec): ScriptedSubmission {
    const observedMs = this.t0Ms + Math.round(spec.observedMin * 60_000);
    const delaySec = spec.emitDelaySec ?? this.random.nextInt(1, 5);
    const ingestedMs = observedMs + delaySec * 1000;
    const eventId =
      spec.eventId ??
      deterministicEventId(this.seed, spec.assetId, spec.sequence, spec.observedMin);
    const envelope = {
      contractVersion: MISSION_EVENT_CONTRACT_VERSION,
      eventId,
      sequence: spec.sequence,
      orgId: this.world.orgId,
      missionId: this.world.missionId,
      assetId: spec.assetId,
      observedAt: new Date(observedMs).toISOString(),
      ingestedAt: new Date(ingestedMs).toISOString(),
      source: {
        sourceId: spec.source.sourceId,
        sourceType: spec.source.sourceType,
        keyId: spec.source.keyId,
        provenance: spec.source.provenance,
        signature: '',
      },
      observations: spec.observations.map((o) => ({ ...o })),
    };
    envelope.source.signature =
      spec.signatureHex ??
      sourceSignature(toNormalized(envelope), fixtureSourceKey(this.seed, spec.source.sourceId));
    return {
      envelope,
      at: envelope.ingestedAt,
      expect: spec.expect,
      beat: spec.beat,
      economicEffect: spec.economicEffect,
    };
  }
}

function toNormalized(envelope: EnvelopeWire) {
  return {
    contractVersion: envelope.contractVersion,
    eventId: envelope.eventId,
    sequence: envelope.sequence,
    orgId: envelope.orgId,
    missionId: envelope.missionId,
    assetId: envelope.assetId,
    observedAt: envelope.observedAt,
    ingestedAt: envelope.ingestedAt,
    source: {
      sourceId: envelope.source.sourceId,
      sourceType: envelope.source.sourceType,
      keyId: envelope.source.keyId,
      provenance: envelope.source.provenance,
    },
    observations: envelope.observations,
  };
}

/** Deterministic fingerprint over the exact submitted envelopes. */
export function scriptDigest(submissions: readonly ScriptedSubmission[]): string {
  const canonical = submissions.map((s) => s.envelope);
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}
