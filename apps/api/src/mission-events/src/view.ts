/**
 * Mission timeline view: the normalized replay consumers (planner, operator
 * UI, Agent A) read. The state machine here is PURE over the ordered accepted
 * events — the live ingest path and the journal-replay path run the exact same
 * `applyEvent` function, so a restart reconstructs an identical view with no
 * side-channel state. Freshness is computed at READ time against the injected
 * clock.
 *
 * PLANNING ELIGIBILITY (CTO correction C): `planningValid` is TRUE ONLY for
 * `fresh` evidence. Stale and expired events stay in the view (and the
 * journal) as historical truth for audit/replay, but must never influence
 * consequential planning without a fresh refresh event or an explicit,
 * separately-reviewed override policy — this is issue #9's fail-closed rule
 * that stale telemetry may not drive financial reasoning.
 *
 * TENANT SAFETY (CTO correction A): all in-memory validation state is keyed by
 * composite identities (org+mission+asset, org+mission+asset+source) built
 * with JSON tuple encoding, so organizations and missions that reuse the same
 * asset or source id strings can never contaminate one another — regardless of
 * which characters an id contains.
 */
import type { NormalizedEvent, NormalizedObservation } from './schema.js';
import { observationKindSpec } from './vocabulary.js';

export type Freshness = 'fresh' | 'stale' | 'expired';

export interface FreshnessPolicy {
  /** Observations at least this old are `stale` — history only, not planning-valid. */
  readonly maxAgeMs: number;
  /** Observations at least this old are `expired` — history only, not planning-valid. */
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
  /**
   * Planning eligibility for consequential decisions — TRUE ONLY WHILE FRESH.
   * Stale/expired events remain listed as journaled history (digest-verifiable)
   * but carry `planningValid: false`; consumers must not act on them.
   */
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

/**
 * Composite state keys are JSON tuple encodings: collision-proof even if an
 * identifier contains delimiters or quote characters (a plain `a:b:c` join is
 * not). Ids are also schema-constrained, but the encoding makes the guarantee
 * structural rather than accidental.
 */
export function assetStateKey(orgId: string, missionId: string, assetId: string): string {
  return JSON.stringify([orgId, missionId, assetId]);
}

export function streamKey(
  orgId: string,
  missionId: string,
  assetId: string,
  sourceId: string,
): string {
  return JSON.stringify([orgId, missionId, assetId, sourceId]);
}

export function freshnessOf(observedAt: string, nowMs: number, policy: FreshnessPolicy): Freshness {
  const observedMs = Date.parse(observedAt);
  if (Number.isNaN(observedMs)) return 'expired'; // unparseable time is never planning-eligible
  const age = nowMs - observedMs;
  if (age >= policy.expiredMs) return 'expired';
  if (age >= policy.maxAgeMs) return 'stale';
  return 'fresh';
}

// ---------------------------------------------------------------------------
// Incremental ingest state (pre-checks) — everything the validator needs to
// reject duplicates, regressions, offline telemetry and monotonic violations.
// Every entry is scoped by composite identity (correction A): an asset id is
// only meaningful within one (org, mission), an event id within one org
// (matching the journal's org-scoped key uniqueness), and a stream additionally
// within one source.
// ---------------------------------------------------------------------------

export interface IngestState {
  /** Event ids already admitted, per organization (journal keys are org-scoped). */
  readonly eventIdsByOrg: Map<string, Set<string>>;
  /** Stream tails keyed by [org, mission, asset, source]. */
  readonly streams: Map<string, { sequence: number; eventId: string }>;
  /** Latest per-kind readings keyed by [org, mission, asset]. */
  readonly assets: Map<string, Map<string, { value: unknown; eventId: string }>>;
}

export function newIngestState(): IngestState {
  return { eventIdsByOrg: new Map(), streams: new Map(), assets: new Map() };
}

/** Pure transition: register one ACCEPTED event into the state. */
export function applyEvent(state: IngestState, event: NormalizedEvent): void {
  let eventIds = state.eventIdsByOrg.get(event.orgId);
  if (eventIds === undefined) {
    eventIds = new Set();
    state.eventIdsByOrg.set(event.orgId, eventIds);
  }
  eventIds.add(event.eventId);
  const stream = streamKey(event.orgId, event.missionId, event.assetId, event.source.sourceId);
  state.streams.set(stream, { sequence: event.sequence, eventId: event.eventId });
  const asset = assetStateKey(event.orgId, event.missionId, event.assetId);
  let perAsset = state.assets.get(asset);
  if (perAsset === undefined) {
    perAsset = new Map();
    state.assets.set(asset, perAsset);
  }
  for (const observation of event.observations) {
    perAsset.set(observation.kind, { value: observation.value, eventId: event.eventId });
  }
}

export function commsState(
  state: IngestState,
  orgId: string,
  missionId: string,
  assetId: string,
): string | null {
  const reading = state.assets.get(assetStateKey(orgId, missionId, assetId))?.get('asset_comms');
  return reading === undefined ? null : String(reading.value);
}

export function lastObservation(
  state: IngestState,
  orgId: string,
  missionId: string,
  assetId: string,
  kind: string,
): { value: unknown; eventId: string } | undefined {
  return state.assets.get(assetStateKey(orgId, missionId, assetId))?.get(kind);
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
      // Correction C: ONLY fresh evidence is planning-valid. Stale/expired
      // rows stay listed as digest-verifiable history, never as eligibility.
      planningValid: freshness === 'fresh',
    });
    const key = streamKey(orgId, missionId, event.assetId, event.source.sourceId);
    streams[key] = {
      sourceId: event.source.sourceId,
      assetId: event.assetId,
      lastSequence: event.sequence,
      lastEventId: event.eventId,
    };
  }

  for (const [assetStateKeyId, perKind] of state.assets) {
    // Composite key [org, mission, asset] → the mission-scoped view reports by
    // bare assetId (unique within one mission's replay).
    const assetId = (JSON.parse(assetStateKeyId) as string[])[2]!;
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
