/**
 * Wire envelope validation (contract v1) — the ONLY shape an external source
 * may submit. Strict: unknown keys are rejected (never silently stripped), so
 * an injected `note`, `instruction` or authority-shaped field cannot enter.
 * No field in this envelope is free text; every string is an id, an enum word,
 * a timestamp or a hex digest, each additionally scanned for the financial
 * authority vocabulary (vocabulary.ts).
 */
import { z } from 'zod';
import { MISSION_EVENT_CONTRACT_VERSION } from './version.js';
import { observationKindSpec, type ObservationValue } from './vocabulary.js';
import { MissionEventError } from './errors.js';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX_64 = /^[0-9a-f]{64}$/;

const observationSchema = z.strictObject({
  kind: z.string().min(1),
  unit: z.string().min(1),
  value: z.union([z.number(), z.string()]),
});

export const envelopeSchema = z.strictObject({
  contractVersion: z.literal(MISSION_EVENT_CONTRACT_VERSION),
  eventId: z.string().regex(ID),
  sequence: z.number().int().min(1),
  orgId: z.string().regex(ID),
  missionId: z.string().regex(ID),
  assetId: z.string().regex(ID),
  observedAt: z.string().regex(ISO_UTC),
  ingestedAt: z.string().regex(ISO_UTC),
  source: z.strictObject({
    sourceId: z.string().regex(ID),
    sourceType: z.string().min(1),
    keyId: z.string().regex(ID),
    provenance: z.enum(['SYNTHETIC', 'FIELD']),
    signature: z.string().regex(HEX_64),
  }),
  observations: z.array(observationSchema).min(1).max(16),
});

export type ObservationWire = z.infer<typeof observationSchema>;
export type EnvelopeWire = z.infer<typeof envelopeSchema>;

export const normalizedSourceSchema = z.strictObject({
  sourceId: z.string().regex(ID),
  sourceType: z.string().min(1),
  keyId: z.string().regex(ID),
  provenance: z.enum(['SYNTHETIC', 'FIELD']),
});

/** The journaled event shape: the envelope without the (never-stored) signature. */
export const normalizedEventSchema = envelopeSchema
  .omit({ source: true })
  .extend({ source: normalizedSourceSchema });

export type NormalizedEventWire = z.infer<typeof normalizedEventSchema>;

/** Post-validation, pre-journal normalized event — the contract Agent A consumes. */
export interface NormalizedObservation {
  readonly kind: string;
  readonly unit: string;
  readonly value: ObservationValue;
}

export interface NormalizedSource {
  readonly sourceId: string;
  readonly sourceType: string;
  readonly keyId: string;
  readonly provenance: 'SYNTHETIC' | 'FIELD';
}

export interface NormalizedEvent {
  readonly contractVersion: number;
  readonly eventId: string;
  readonly sequence: number;
  readonly orgId: string;
  readonly missionId: string;
  readonly assetId: string;
  readonly observedAt: string;
  readonly ingestedAt: string;
  readonly source: NormalizedSource;
  readonly observations: readonly NormalizedObservation[];
}

/**
 * Validate the wire shape and every observation against the typed vocabulary.
 * Deterministic first-failure: envelope shape, then per-observation kind/unit/
 * value in declaration order.
 */
export function parseEnvelope(raw: unknown): EnvelopeWire {
  const first = (raw as { contractVersion?: unknown })?.contractVersion;
  if (first !== MISSION_EVENT_CONTRACT_VERSION) {
    throw new MissionEventError(
      'UNSUPPORTED_CONTRACT',
      `contractVersion must be ${MISSION_EVENT_CONTRACT_VERSION} (received ${String(first)})`,
    );
  }
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new MissionEventError(
      'INVALID_ENVELOPE',
      `${issue.path.join('.') || 'envelope'}: ${issue.message}`,
    );
  }
  for (const [index, observation] of parsed.data.observations.entries()) {
    const spec = observationKindSpec(observation.kind);
    if (spec === undefined) {
      throw new MissionEventError(
        'INVALID_ENVELOPE',
        `observations[${index}]: unknown kind "${observation.kind}"`,
      );
    }
    if (observation.unit !== spec.unit) {
      throw new MissionEventError(
        'INVALID_UNIT',
        `observations[${index}]: kind "${observation.kind}" carries unit "${spec.unit}", received "${observation.unit}"`,
        { kind: observation.kind, expectedUnit: spec.unit, receivedUnit: observation.unit },
      );
    }
    if (typeof observation.value === 'number' && !Number.isInteger(observation.value)) {
      throw new MissionEventError(
        'INVALID_VALUE',
        `observations[${index}]: float values are forbidden; decimals travel as strings (kind "${observation.kind}")`,
      );
    }
    if (!spec.validate(observation.value)) {
      throw new MissionEventError(
        'INVALID_VALUE',
        `observations[${index}]: value ${JSON.stringify(observation.value)} is not valid for kind "${observation.kind}"`,
        { kind: observation.kind },
      );
    }
  }
  return parsed.data;
}

/** The digest-signed subset of a normalized event (signature excluded). */
export function signedEvent(event: NormalizedEvent): Record<string, unknown> {
  return {
    contractVersion: event.contractVersion,
    eventId: event.eventId,
    sequence: event.sequence,
    orgId: event.orgId,
    missionId: event.missionId,
    assetId: event.assetId,
    observedAt: event.observedAt,
    ingestedAt: event.ingestedAt,
    source: { ...event.source },
    observations: event.observations.map((o) => ({ ...o })),
  };
}

/** Shape check for events read back from the journal (replay path). */
export function parseNormalizedEvent(raw: unknown): NormalizedEventWire {
  const parsed = normalizedEventSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new MissionEventError(
      'INVALID_ENVELOPE',
      `journaled event is not contract-shaped: ${issue.path.join('.') || 'event'}: ${issue.message}`,
    );
  }
  return parsed.data;
}
