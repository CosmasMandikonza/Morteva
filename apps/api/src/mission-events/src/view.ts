/**
 * Mission timeline view: the normalized replay consumers (planner, operator
 * UI, Agent A) read. The state machine here is PURE over the ordered accepted
 * events — the live ingest path and the journal-replay path run the exact same
 * `applyEvent` function, so a restart reconstructs an identical view with no
 * side-channel state. Freshness is computed at READ time against the injected
 * clock: stale/expired evidence is still journaled (the journal is immutable)
 * but flagged `planningValid: false` so no consumer can treat it as current.
 */
import type { NormalizedEvent, NormalizedObservation } from './schema.js';
import { observationKindSpec } from './vocabulary.js';

export type Freshness = 'fresh' | 'stale' | 'expired';

export interface FreshnessPolicy {
  /** Observations older than this are `stale` — usable only with the flag. */
  readonly maxAgeMs: number;
  /** Observations older than this are `expired` — never planning-valid. */
  readonly expiredMs: number;
}

export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = {
  maxAgeMs: 15 * 60_000,
  expiredMs: 30 * 60_000,
};

export interface AcceptedEventView {
  readonly journalSeq: number;
  readonly eventId: string;
  readonly sequence: number;
  readonly assetId: string;
  readonly sourceId: string;
  readonly sourceType: string;
  readonly provenance: 'SYNTHETIC' | 'FIELD';
  readonly observedAt: string;
  readonly ingestedAt: string;
  readonly recordedAt: string;
  readonly eventDigest: string;
  readonly observations: readonly NormalizedObservation[];
  readonly freshness: Freshness;
  readonly planningValid: boolean;
}

export interface ObservationReading extends NormalizedObservation {
  readonly eventId: string;
  readonly observedAt: string;
  readonly freshness: Freshness;
}

export interface AssetStateView {
  readonly assetId: string;
  readonly comms: string | null;
  readonly positionStatus: string | null;
  /** Latest reading per observation kind, each with its evidence reference. */
  readonly latest: Readonly<Record<string, ObservationReading>>;
}

export interface StreamStateView {
  readonly sourceId: string;
  readonly assetId: string;
  readonly lastSequence: number;
  readonly lastEventId: string;
}

export interface MissionTimelineView {
  readonly orgId: string;
  readonly missionId: string;
  /** Clock ISO at read time — freshness is relative to this instant. */
  readonly asOf: string;
  readonly policy: FreshnessPolicy;
  readonly events: readonly AcceptedEventView[];
  readonly assets: Readonly<Record<string, AssetStateView>>;
  readonly streams: Readonly<Record<string, StreamStateView>>;
}

export function streamKey(missionId: string, assetId: string, sourceId: string): string {
  return `${missionId}:${assetId}:${sourceId}`;
}

export function freshnessOf(observedAt: string, nowMs: number, policy: FreshnessPolicy): Freshness {
  const age = nowMs - Date.parse(observedAt);
  if (age >= policy.expiredMs) return 'expired';
  if (age >= policy.maxAgeMs) return 'stale';
  return 'fresh';
}

// ---------------------------------------------------------------------------
// Incremental ingest state (pre-checks) — everything the validator needs to
// reject duplicates, regressions, offline telemetry and monotonic violations.
// ---------------------------------------------------------------------------

export interface IngestState {
  readonly eventIds: Set<string>;
  readonly streams: Map<string, { sequence: number; eventId: string }>;
  readonly assets: Map<string, Map<string, { value: unknown; eventId: string }>>;
}

export function newIngestState(): IngestState {
  return { eventIds: new Set(), streams: new Map(), assets: new Map() };
}

/** Pure transition: register one ACCEPTED event into the state. */
export function applyEvent(state: IngestState, event: NormalizedEvent): void {
  state.eventIds.add(event.eventId);
  const key = streamKey(event.missionId, event.assetId, event.source.sourceId);
  state.streams.set(key, { sequence: event.sequence, eventId: event.eventId });
  let perAsset = state.assets.get(event.assetId);
  if (perAsset === undefined) {
    perAsset = new Map();
    state.assets.set(event.assetId, perAsset);
  }
  for (const observation of event.observations) {
    perAsset.set(observation.kind, { value: observation.value, eventId: event.eventId });
  }
}

export function commsState(state: IngestState, assetId: string): string | null {
  const reading = state.assets.get(assetId)?.get('asset_comms');
  return reading === undefined ? null : String(reading.value);
}

export function lastObservation(
  state: IngestState,
  assetId: string,
  kind: string,
): { value: unknown; eventId: string } | undefined {
  return state.assets.get(assetId)?.get(kind);
}

// ---------------------------------------------------------------------------
// Read-model projection: IngestState + journal rows → MissionTimelineView
// ---------------------------------------------------------------------------

export interface JournaledEvent {
  readonly journalSeq: number;
  readonly event: NormalizedEvent;
  readonly eventDigest: string;
  readonly recordedAt: string;
}

export function projectTimeline(
  orgId: string,
  missionId: string,
  journaled: readonly JournaledEvent[],
  nowMs: number,
  policy: FreshnessPolicy,
): MissionTimelineView {
  const state = newIngestState();
  const events: AcceptedEventView[] = [];
  const streams: Record<string, StreamStateView> = {};
  const assets: Record<string, AssetStateView> = {};
  const rowsByEventId = new Map(journaled.map((row) => [row.event.eventId, row]));

  for (const row of journaled) {
    applyEvent(state, row.event);
    const event = row.event;
    const freshness = freshnessOf(event.observedAt, nowMs, policy);
    events.push({
      journalSeq: row.journalSeq,
      eventId: event.eventId,
      sequence: event.sequence,
      assetId: event.assetId,
      sourceId: event.source.sourceId,
      sourceType: event.source.sourceType,
      provenance: event.source.provenance,
      observedAt: event.observedAt,
      ingestedAt: event.ingestedAt,
      recordedAt: row.recordedAt,
      eventDigest: row.eventDigest,
      observations: event.observations,
      freshness,
      planningValid: freshness !== 'expired',
    });
    const key = streamKey(event.missionId, event.assetId, event.source.sourceId);
    streams[key] = {
      sourceId: event.source.sourceId,
      assetId: event.assetId,
      lastSequence: event.sequence,
      lastEventId: event.eventId,
    };
  }

  for (const [assetId, perKind] of state.assets) {
    const latest: Record<string, ObservationReading> = {};
    for (const [kind, reading] of perKind) {
      const owner = rowsByEventId.get(reading.eventId);
      if (owner === undefined) continue;
      const observation = owner.event.observations.find((o) => o.kind === kind);
      if (observation === undefined) continue;
      latest[kind] = {
        ...observation,
        eventId: reading.eventId,
        observedAt: owner.event.observedAt,
        freshness: freshnessOf(owner.event.observedAt, nowMs, policy),
      };
    }
    assets[assetId] = {
      assetId,
      comms: (latest['asset_comms']?.value as string | undefined) ?? null,
      positionStatus: (latest['asset_position_status']?.value as string | undefined) ?? null,
      latest,
    };
  }

  return {
    orgId,
    missionId,
    asOf: new Date(nowMs).toISOString(),
    policy,
    events,
    assets,
    streams,
  };
}

/** observationKindSpec re-export convenience for consumers building views. */
export { observationKindSpec };
