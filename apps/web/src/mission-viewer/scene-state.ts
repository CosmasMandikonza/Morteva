/**
 * Pure, deterministic scene-state projection (MTV-09/12).
 *
 * `projectSceneState(snapshot, selection)` maps the authoritative physical
 * view + host selection to everything the renderer draws. NO I/O, no clocks
 * beyond the snapshot's own `asOf`, no randomness: the same snapshot and
 * selection render the same state across reloads (acceptance #27).
 *
 * Truth separation enforced here:
 *   - OBSERVED: typed readings from admitted events (wind, hold, comms,
 *     position status) — the only facts.
 *   - INFERRED: the per-asset operational constraint (modeled limit vs
 *     observed wind) — clearly labeled inference.
 *   - ILLUSTRATIVE: spatial poses (no coordinates exist in the contract).
 *   - FINANCIAL: absent — the viewer never evaluates money; S3 is a HOST
 *     signal (decisionAvailable) that only adds a link, never a result.
 *
 * Domain scoping (documented in contract/planner-adapter-request.v1.md):
 * the modeled wind limit applies to the AERIAL asset only; surface/ground
 * assets are constrained by comms state alone. A warehouse robot event can
 * therefore never inherit a UAV wind rule (acceptance #11).
 */
import type {
  AssetPose,
  EventMarkerView,
  PhysicalConstraintView,
  PhysicalViewEvent,
  PhysicalViewSnapshot,
  PoseName,
  SceneState,
  SelectedEventView,
} from './contract.js';

export interface SceneSelection {
  /** Host-controlled selected event (evidence replay). */
  readonly selectedEventId?: string | null;
  /** Host-controlled selected asset (focus). */
  readonly selectedAssetId?: string | null;
  /**
   * HOST-SIGNAL ONLY: when true and the current constraint restricts an
   * activity, the phase escalates S2→S3 so the HUD shows the consequence
   * link. The viewer performs NO financial evaluation of its own.
   */
  readonly decisionAvailable?: boolean;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function numObservation(event: PhysicalViewEvent, kind: string): number | null {
  const o = event.observations.find((x) => x.kind === kind);
  if (o === undefined) return null;
  const parsed = typeof o.value === 'number' ? o.value : Number(o.value);
  return isFiniteNumber(parsed) ? parsed : null;
}

function strObservation(event: PhysicalViewEvent, kind: string): string | null {
  const o = event.observations.find((x) => x.kind === kind);
  return o === undefined || typeof o.value !== 'string' ? null : o.value;
}

/**
 * Events for one asset in journal order — the journal seq (not the
 * per-source sequence) is the authoritative ordering key; independent
 * sources can legitimately share per-source sequences.
 */
function eventsForAsset(
  events: readonly PhysicalViewEvent[],
  assetId: string,
): PhysicalViewEvent[] {
  return events.filter((e) => e.assetId === assetId);
}

/** Severity of an event for marker coloring, from its typed observations. */
function severityOf(
  event: PhysicalViewEvent,
  policy: PhysicalViewSnapshot['policy'],
): EventMarkerView['severity'] {
  const comms = strObservation(event, 'asset_comms');
  if (comms === 'offline') return 'offline';
  if (comms === 'online' && eventsMentionOfflineRecovery(event)) return 'recovery';
  // Ground interrupts are verdict-relevant facts: obstructed aisle or charger
  // fault marks the event as a breach-class marker (same class as a wind
  // breach — a real physical restriction, never a forecast).
  const aisle = strObservation(event, 'aisle_access');
  const charger = strObservation(event, 'charger_status');
  if (aisle === 'obstructed' || charger === 'fault') return 'breach';
  if (event.assetId === policy.uavAssetId) {
    const hold = strObservation(event, 'weather_hold');
    const wind = numObservation(event, 'wind_speed');
    if (hold === 'active') return 'hold';
    if (wind !== null && wind > policy.uavWindLimitKt) return 'breach';
  }
  return 'nominal';
}

function eventsMentionOfflineRecovery(event: PhysicalViewEvent): boolean {
  // A recovery marker is an explicit comms=online reading delivered by a
  // non-telemetry source (the authorized recovery path in the ingest
  // contract). Source types are contract enums, never free text.
  return event.sourceType !== 'asset_telemetry';
}

/**
 * Constraint for one asset as a PREFIX of its journal events (the events
 * list must already be filtered/ordered by journal seq).
 *
 * MATCHED-VERDICT LAW (CTO P0-B): the verdict emitted here MUST equal the
 * accepted backend `constraintFor` (apps/api/src/integration/physical-view.ts)
 * and Agent D's `physicalTimelineToPlannerSafety` on the same journal state:
 *
 *  - ground/surface (COMPLETED ground contract, extension 1): fresh comms
 *    OFFLINE → blocked; fresh aisle OBSTRUCTED → blocked; fresh charger
 *    FAULT → blocked; CLEAR only with fresh comms online + aisle clear +
 *    charger healthy; everything else → unknown. Wind/hold are INERT.
 *  - aerial precedence: fresh wind-limit → fresh active hold → fresh offline
 *    comms → degraded comms = unknown → clear ONLY with explicitly fresh
 *    comms online + hold clear + wind within the modeled limit.
 *
 * Matched-verdict tests pin both domains per S-beat and historical replay;
 * stale/expired evidence never yields clear (the caller filters the current
 * constraint to planning-valid events; replay uses the as-of-event prefix).
 */
function constraintFromPrefix(
  assetId: string,
  kind: PhysicalViewSnapshot['assets'][number]['kind'],
  prefix: readonly PhysicalViewEvent[],
  policy: PhysicalViewSnapshot['policy'],
): PhysicalConstraintView {
  const basis: string[] = [];
  let windKt: number | null = null;
  let hold: 'clear' | 'active' | null = null;
  let comms: string | null = null;
  let aisle: 'clear' | 'obstructed' | null = null;
  let charger: 'docked_charging' | 'free' | 'fault' | null = null;

  for (const event of prefix) {
    const wind = numObservation(event, 'wind_speed');
    const h = strObservation(event, 'weather_hold');
    const c = strObservation(event, 'asset_comms');
    const a = strObservation(event, 'aisle_access');
    const ch = strObservation(event, 'charger_status');
    if (wind !== null) {
      windKt = wind;
      basis.push(event.eventId);
    }
    if (h === 'clear' || h === 'active') {
      hold = h;
      basis.push(event.eventId);
    }
    if (c !== null) {
      comms = c;
      basis.push(event.eventId);
    }
    if (a === 'clear' || a === 'obstructed') {
      aisle = a;
      basis.push(event.eventId);
    }
    if (ch === 'docked_charging' || ch === 'free' || ch === 'fault') {
      charger = ch;
      basis.push(event.eventId);
    }
  }

  // GROUND/SURFACE (any non-aerial asset): matched to the backend ground
  // branch exactly — the COMPLETED ground contract, same precedence.
  if (kind !== 'aerial' || assetId !== policy.uavAssetId) {
    if (comms === 'offline') {
      return { assetId, state: 'blocked', reason: 'comms-offline', basisEventIds: dedupe(basis) };
    }
    if (aisle === 'obstructed') {
      return {
        assetId,
        state: 'blocked',
        reason: 'aisle-obstructed',
        basisEventIds: dedupe(basis),
      };
    }
    if (charger === 'fault') {
      return { assetId, state: 'blocked', reason: 'charger-fault', basisEventIds: dedupe(basis) };
    }
    if (
      comms === 'online' &&
      aisle === 'clear' &&
      (charger === 'free' || charger === 'docked_charging')
    ) {
      return { assetId, state: 'clear', reason: 'nominal', basisEventIds: dedupe(basis) };
    }
    return {
      assetId,
      state: 'unknown',
      reason: 'insufficient-evidence',
      basisEventIds: dedupe(basis),
    };
  }

  // AERIAL — matched to the backend aerial precedence exactly:
  // wind-limit → weather-hold → comms-offline → degraded → clear.
  if (windKt !== null && windKt > policy.uavWindLimitKt) {
    return { assetId, state: 'blocked', reason: 'wind-limit', basisEventIds: dedupe(basis) };
  }
  if (hold === 'active') {
    return { assetId, state: 'blocked', reason: 'weather-hold', basisEventIds: dedupe(basis) };
  }
  if (comms === 'offline') {
    return { assetId, state: 'blocked', reason: 'comms-offline', basisEventIds: dedupe(basis) };
  }
  if (comms === 'degraded') {
    return {
      assetId,
      state: 'unknown',
      reason: 'insufficient-evidence',
      basisEventIds: dedupe(basis),
    };
  }
  if (windKt !== null && hold === 'clear' && comms === 'online') {
    return { assetId, state: 'clear', reason: 'nominal', basisEventIds: dedupe(basis) };
  }
  return {
    assetId,
    state: 'unknown',
    reason: 'insufficient-evidence',
    basisEventIds: dedupe(basis),
  };
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function latestPoseName(prefix: readonly PhysicalViewEvent[]): {
  pose: PoseName;
  eventId: string | null;
} {
  for (let i = prefix.length - 1; i >= 0; i--) {
    const pose = strObservation(prefix[i]!, 'asset_position_status');
    if (
      pose === 'on_station' ||
      pose === 'transit' ||
      pose === 'returning' ||
      pose === 'docked' ||
      pose === 'off_station'
    ) {
      return { pose, eventId: prefix[i]!.eventId };
    }
  }
  return { pose: 'unknown', eventId: null };
}

/**
 * The projection. Same inputs → same output, always.
 */
export function projectSceneState(
  snapshot: PhysicalViewSnapshot,
  selection: SceneSelection = {},
): SceneState {
  const { policy } = snapshot;
  const events = [...snapshot.events].sort((a, b) => a.journalSeq - b.journalSeq);

  // ---- per-asset current state (latest evidence, journal order) ------------
  const constraints: PhysicalConstraintView[] = [];
  const poses: AssetPose[] = [];
  const positionStatus: Record<string, PoseName> = {};
  const comms: Record<string, string> = {};

  for (const asset of snapshot.assets) {
    const prefix = eventsForAsset(events, asset.assetId);
    // CURRENT constraints draw ONLY on planning-valid evidence: stale or
    // expired readings are journal history and can never masquerade as
    // current clearance (brief case 2/3). Historical replay (below) uses the
    // full prefix — that is the point of replay.
    const eligible = prefix.filter((e) => e.planningValidAtSnapshot);
    constraints.push(constraintFromPrefix(asset.assetId, asset.kind, eligible, policy));
    const pose = latestPoseName(prefix);
    positionStatus[asset.assetId] = pose.pose;
    poses.push({
      assetId: asset.assetId,
      pose: pose.pose,
      evidenceEventId: pose.eventId,
      unobserved: pose.eventId === null,
    });
    for (let i = prefix.length - 1; i >= 0; i--) {
      const c = strObservation(prefix[i]!, 'asset_comms');
      if (c !== null) {
        comms[asset.assetId] = c;
        break;
      }
    }
  }

  // ---- markers (one per distinct eventId; duplicates never duplicate) ------
  const seen = new Set<string>();
  const markers: EventMarkerView[] = [];
  for (const event of events) {
    const duplicateOfEarlier = seen.has(event.eventId);
    seen.add(event.eventId);
    if (duplicateOfEarlier) continue; // acceptance #8: dedupe by identity
    markers.push({
      eventId: event.eventId,
      journalSeq: event.journalSeq,
      assetId: event.assetId,
      severity: severityOf(event, policy),
      selected: event.eventId === (selection.selectedEventId ?? null),
      duplicateOfEarlier,
    });
  }

  // ---- selected event + historical replay ----------------------------------
  let selected: SelectedEventView | null = null;
  const selectedId = selection.selectedEventId ?? null;
  if (selectedId !== null) {
    const event = events.find((e) => e.eventId === selectedId);
    if (event !== undefined) {
      const prefix = eventsForAsset(events, event.assetId).filter(
        (e) => e.journalSeq <= event.journalSeq,
      );
      const asset = snapshot.assets.find((a) => a.assetId === event.assetId);
      const constraintAtEvent = constraintFromPrefix(
        event.assetId,
        asset?.kind ?? 'surface',
        prefix,
        policy,
      );
      const isHistoricalReplay = event.journalSeq < maxJournalSeq(events);
      selected = { event, isHistoricalReplay, constraintAtEvent };
    }
  }

  // ---- aerial wind evaluation (latest PLANNING-VALID evidence) -------------
  const uavPrefix = eventsForAsset(events, policy.uavAssetId);
  let aerialWindKt: number | null = null;
  for (let i = uavPrefix.length - 1; i >= 0; i--) {
    if (!uavPrefix[i]!.planningValidAtSnapshot) continue;
    const wind = numObservation(uavPrefix[i]!, 'wind_speed');
    if (wind !== null) {
      aerialWindKt = wind;
      break;
    }
  }
  const uavConstraint = constraints.find((c) => c.assetId === policy.uavAssetId);
  const windBreached = uavConstraint?.reason === 'wind-limit';

  // ---- phase ----------------------------------------------------------------
  let phase: SceneState['phase'];
  const anyEvidence = events.length > 0;
  const uavUnknown = uavConstraint === undefined || uavConstraint.state === 'unknown';
  // Any BLOCKED asset (aerial wind breach OR a ground interrupt — obstructed
  // aisle, charger fault, offline comms) restricts the mission: S2, escalated
  // to S3 only by the host's verified decision signal (P1-C law).
  const anyBlocked = constraints.some((c) => c.state === 'blocked');
  if (!anyEvidence) {
    phase = 'S0-initial';
  } else if (selected !== null && selected.isHistoricalReplay) {
    phase = 'S4-historical';
  } else if (anyBlocked) {
    phase = selection.decisionAvailable === true ? 'S3-restricted-escalated' : 'S2-restricted';
  } else if (uavUnknown || Object.values(comms).includes('offline')) {
    phase = 'S5-uncertain';
  } else {
    phase = 'S1-nominal';
  }

  return {
    phase,
    tenant: snapshot.tenant,
    asOf: snapshot.asOf,
    policy,
    constraints,
    poses,
    positionStatus,
    comms,
    markers,
    selected,
    selectedAssetId: selection.selectedAssetId ?? null,
    eventCount: events.length,
    planningValidCount: events.filter((e) => e.planningValidAtSnapshot).length,
    windBreached,
    aerialWindKt,
  };
}

function maxJournalSeq(events: readonly PhysicalViewEvent[]): number {
  let max = -Infinity;
  for (const e of events) max = Math.max(max, e.journalSeq);
  return max;
}

/** Camera storyboard framing (docs/04): deterministic from scene state. */
export type Framing = 'overview' | 'asset' | 'event';

export function framingFor(state: SceneState, previous: Framing = 'overview'): Framing {
  if (state.selected !== null) return 'event';
  if (state.selectedAssetId !== null) return 'asset';
  return previous;
}
