/**
 * Physical-view contract v1 (viewer-side types) — MTV-09/12.
 *
 * The viewer consumes the versioned snapshot defined in
 * `apps/api/src/mission-events/contract/physical-view.v1.md` (Agent C's
 * contract). The HOST (Decision Room or the standalone harness) owns mission
 * data and selection; the viewer renders it. These types are viewer-owned so
 * the web bundle never imports server code.
 *
 * TRUTH BOUNDARY: a snapshot carries typed observations, identities,
 * timestamps, provenance and freshness ONLY. It never carries free text,
 * raw journal payloads, financial terms or provider data. Scene placement is
 * ILLUSTRATIVE (the contract has no continuously sampled coordinates).
 */

export interface PhysicalViewTenant {
  readonly orgId: string;
  readonly missionId: string;
}

/** Asset domain — determines which modeled operational rules apply. */
export type PhysicalAssetKind = 'aerial' | 'surface' | 'ground';

export interface PhysicalViewAsset {
  readonly assetId: string;
  readonly kind: PhysicalAssetKind;
  /** Optional human label (e.g. "Inspection UAV"). Never free text from events. */
  readonly label?: string;
}

export type PhysicalProvenance = 'SYNTHETIC' | 'FIELD';
export type PhysicalFreshness = 'fresh' | 'stale' | 'expired';

export interface PhysicalViewObservation {
  readonly kind: string;
  readonly unit: string;
  readonly value: number | string;
}

export interface PhysicalViewEvent {
  /** Unique admitted event identity (journal key `mevt:{eventId}`). */
  readonly eventId: string;
  /** Append-only journal order (authoritative global ordering). */
  readonly journalSeq: number;
  /** The source's own per-stream sequence (independent across sources). */
  readonly sequence: number;
  readonly assetId: string;
  readonly sourceId: string;
  readonly sourceType: string;
  readonly provenance: PhysicalProvenance;
  readonly observedAt: string;
  readonly ingestedAt: string;
  readonly recordedAt: string;
  readonly eventDigest: string;
  readonly observations: readonly PhysicalViewObservation[];
  /** Evaluated at the snapshot's asOf by the host's read model
   *  (wire name: freshnessAtSnapshot — canonical = accepted backend schema). */
  readonly freshnessAtSnapshot: PhysicalFreshness;
  readonly planningValidAtSnapshot: boolean;
}

/**
 * Operational constraint for one asset — mirrors the planner bridge's
 * state machine (Agent A, `physical-to-planner.ts`) with the viewer's
 * documented per-domain scoping: the modeled wind limit applies to the
 * AERIAL asset only (see contract/planner-adapter-request.v1.md).
 */
export interface PhysicalConstraintView {
  readonly assetId: string;
  readonly state: 'clear' | 'blocked' | 'unknown';
  readonly reason:
    'nominal' | 'wind-limit' | 'weather-hold' | 'comms-offline' | 'insufficient-evidence';
  /** The fresh readings the constraint derives from (empty for unknown). */
  readonly basisEventIds: readonly string[];
}

export interface PhysicalViewPolicy {
  /** ≥ this age → stale (never planning-valid). */
  readonly maxAgeMs: number;
  /** ≥ this age → expired (history only). */
  readonly expiredMs: number;
  /** The aerial asset the modeled wind limit applies to. */
  readonly uavAssetId: string;
  /** Operator-defined modeled limit in knots — NOT a measurement. */
  readonly uavWindLimitKt: number;
}

export interface PhysicalViewSnapshot {
  readonly contractVersion: 1;
  readonly tenant: PhysicalViewTenant;
  /** Read clock of the snapshot (freshness/staleness are relative to this). */
  readonly asOf: string;
  readonly truthLabel: string;
  readonly policy: PhysicalViewPolicy;
  readonly assets: readonly PhysicalViewAsset[];
  /** Journal-ordered accepted events (oldest first), bounded to the 50 most
   * recent by the server — the journal remains the full durable history. */
  readonly events: readonly PhysicalViewEvent[];
}

// ---------------------------------------------------------------------------
// Scene state — the PURE projection output the renderer consumes.
// ---------------------------------------------------------------------------

/** Viewer lifecycle states mapping to the brief's S0–S5. */
export type ScenePhase =
  | 'S0-initial' // no admitted evidence yet — environment + assets only
  | 'S1-nominal' // fresh evidence, modeled limits respected
  | 'S2-restricted' // fresh evidence breaches the modeled limit
  | 'S3-restricted-escalated' // S2 + host signaled a financial consequence link
  | 'S4-historical' // an earlier event is selected (evidence replay)
  | 'S5-uncertain'; // stale/expired/insufficient evidence — fail closed

export type PoseName =
  'on_station' | 'transit' | 'returning' | 'docked' | 'off_station' | 'unknown';

/** ILLUSTRATIVE placement — no coordinates exist in the contract. */
export interface AssetPose {
  readonly assetId: string;
  readonly pose: PoseName;
  /** Which admitted event established this pose (evidence reference). */
  readonly evidenceEventId: string | null;
  /** True when no position_status was ever observed (pose is ambient only). */
  readonly unobserved: boolean;
}

export interface EventMarkerView {
  readonly eventId: string;
  readonly journalSeq: number;
  readonly assetId: string;
  /** Marker severity derived from the event's typed observations. */
  readonly severity: 'nominal' | 'breach' | 'hold' | 'offline' | 'recovery';
  readonly selected: boolean;
  /** True when this marker duplicates an earlier event id (render once). */
  readonly duplicateOfEarlier: boolean;
}

export interface SelectedEventView {
  readonly event: PhysicalViewEvent;
  readonly isHistoricalReplay: boolean;
  /** Constraint the evidence supported AS OF this event (replay semantics). */
  readonly constraintAtEvent: PhysicalConstraintView;
}

export interface SceneState {
  readonly phase: ScenePhase;
  readonly tenant: PhysicalViewTenant;
  readonly asOf: string;
  readonly policy: PhysicalViewPolicy;
  /** Current (latest-evidence) constraint per asset. */
  readonly constraints: readonly PhysicalConstraintView[];
  /** Illustrative pose per asset (from latest position_status). */
  readonly poses: readonly AssetPose[];
  /** Latest position_status per asset, if observed ('unknown' otherwise). */
  readonly positionStatus: Readonly<Record<string, PoseName>>;
  /** Latest comms state per asset, if observed. */
  readonly comms: Readonly<Record<string, string>>;
  readonly markers: readonly EventMarkerView[];
  readonly selected: SelectedEventView | null;
  /** Selected asset id (host-controlled), when it maps to a known asset. */
  readonly selectedAssetId: string | null;
  /** Total accepted events and how many are currently planning-valid. */
  readonly eventCount: number;
  readonly planningValidCount: number;
  /** True when ≥1 fresh wind reading exceeds the modeled limit (aerial asset). */
  readonly windBreached: boolean;
  /** Latest fresh aerial wind reading in kt, when one exists. */
  readonly aerialWindKt: number | null;
}
