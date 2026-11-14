/**
 * Issue #19: journal-backed, simulation-labeled physical safety evidence.
 * Consumes ONLY MissionEventIngestService.replay() output (which verifies
 * persisted digests and tenant scope); never raw HTTP or model prose.
 *
 * A wind observation may breach the documented UAV threshold; it does NOT
 * assert when a weather window reopens. Original per-source sequence survives
 * in source.physicalSequence, while the journal sequence is used as the
 * globally monotone planner event.sequence (independent sources can both
 * legitimately have source sequence 1).
 *
 * GROUND DOMAIN (planner-adapter-request extension 1 — ACCEPTED; Agent D's
 * `proposedGroundSafety` semantics, implemented live): a declared GROUND or
 * SURFACE asset NEVER consumes `wind_speed`/`weather_hold` for its verdict —
 * an aerial wind limit is not a ground constraint and a ground asset must
 * never inherit aerial clearance (or aerial blocking). Comms remains
 * domain-neutral for every asset. Ground precedence (first match wins):
 *   1. fresh comms offline      → blocked / comms-offline
 *   2. fresh aisle obstructed   → blocked / aisle-obstructed
 *   3. fresh charger fault      → blocked / charger-fault
 *   4. any fresh reading missing→ unknown / insufficient-evidence
 *      (degraded comms included — degraded is NOT a healthy-ground verdict)
 *   5. all fresh and healthy    → clear / nominal
 * A restored network connection does NOT by itself imply route clearance:
 * clearance requires FRESH aisle/charger readings inside the planning
 * window — stale readings are withheld (history, not current truth).
 */
import type { MissionEvidenceInput } from '@moterva/planner';
import type { MissionTimelineView } from '../mission-events/src/view.js';

export interface PhysicalSafetyPolicy {
  readonly orgId: string;
  readonly missionId: string;
  readonly asOf: Date;
  /**
   * Explicit operator-defined AERIAL limit, NOT measured or forecast weather.
   * REQUIRED when any asset uses aerial semantics (the historical default
   * treats every undeclared asset as aerial); FORBIDDEN when the declared
   * asset kinds contain no aerial asset (a ground-only policy never carries
   * a wind rule).
   */
  readonly uavWindLimitKt?: number;
  /**
   * Operator-declared physical domain per asset id (planner-adapter-request
   * extension 2). AERIAL and UNDECLARED assets keep the historical state
   * machine exactly (wind threshold + hold + comms). A declared GROUND or
   * SURFACE asset uses the ground precedence above.
   */
  readonly assetKinds?: Readonly<Record<string, 'aerial' | 'ground' | 'surface'>>;
}

export interface PhysicalSafetyBridgeResult {
  readonly evidence: readonly MissionEvidenceInput[];
  readonly withheldEventIds: readonly string[];
}

interface LatestReadings {
  windKt?: number;
  hold?: 'clear' | 'active';
  comms?: 'online' | 'degraded' | 'offline';
  aisle?: 'clear' | 'obstructed';
  charger?: 'docked_charging' | 'free' | 'fault';
}

export function physicalTimelineToPlannerSafety(
  timeline: MissionTimelineView,
  policy: PhysicalSafetyPolicy,
): PhysicalSafetyBridgeResult {
  const nowMs = policy.asOf.getTime();
  if (
    !Number.isFinite(nowMs) ||
    timeline.orgId !== policy.orgId ||
    timeline.missionId !== policy.missionId ||
    Date.parse(timeline.asOf) !== nowMs ||
    !Number.isFinite(timeline.policy.maxAgeMs) ||
    timeline.policy.maxAgeMs <= 0
  ) {
    throw new Error('INVALID_PHYSICAL_BRIDGE_SCOPE_OR_POLICY');
  }
  if (policy.assetKinds !== undefined) {
    for (const kind of Object.values(policy.assetKinds)) {
      if (kind !== 'aerial' && kind !== 'ground' && kind !== 'surface') {
        throw new Error('INVALID_PHYSICAL_BRIDGE_SCOPE_OR_POLICY');
      }
    }
  }
  // Aerial semantics exist when the policy does not declare kinds at all
  // (historical default: every asset is aerial) OR any asset is declared
  // aerial OR any event asset is UNDECLARED (undeclared keeps the historical
  // machine). A ground-only policy over fully-declared ground events carries
  // NO wind rule — and a wind limit there is refused (it would silently be
  // inherited by ground or apply to nothing).
  const declaredKinds = policy.assetKinds === undefined ? [] : Object.values(policy.assetKinds);
  const eventAssetIds = [...new Set(timeline.events.map((e) => e.assetId))];
  const hasAerialSemantics =
    policy.assetKinds === undefined ||
    declaredKinds.includes('aerial') ||
    eventAssetIds.some((id) => policy.assetKinds?.[id] === undefined);
  if (policy.uavWindLimitKt === undefined) {
    if (hasAerialSemantics) throw new Error('INVALID_PHYSICAL_BRIDGE_SCOPE_OR_POLICY');
  } else if (
    !Number.isFinite(policy.uavWindLimitKt) ||
    policy.uavWindLimitKt <= 0 ||
    policy.uavWindLimitKt > 200 ||
    !hasAerialSemantics
  ) {
    throw new Error('INVALID_PHYSICAL_BRIDGE_SCOPE_OR_POLICY');
  }
  const windLimitKt = policy.uavWindLimitKt;
  const isGroundAsset = (assetId: string): boolean => {
    const kind = policy.assetKinds?.[assetId];
    return kind !== undefined && kind !== 'aerial';
  };
  const latestByAsset = new Map<string, LatestReadings>();
  const evidence: MissionEvidenceInput[] = [];
  const withheldEventIds: string[] = [];

  for (const event of [...timeline.events].sort((a, b) => a.journalSeq - b.journalSeq)) {
    const observedMs = Date.parse(event.observedAt);
    // An admitted event can be honest historical evidence without being
    // currently eligible to influence a consequential financial decision.
    // PROVENANCE LAW (P0 productization): BOTH admitted provenance classes
    // are planning-eligible — SYNTHETIC (demo/simulator sources, HMAC-
    // signed with fixture keys) and FIELD (production server-to-server
    // sources, HMAC-signed with operator-issued credentials). Every event
    // here was already authenticated + sequence/freshness-checked by the
    // ingest boundary; provenance labels the CLAIM's origin class for the
    // decision record, it never weakens admission.
    if (
      !event.planningValid ||
      (event.provenance !== 'SYNTHETIC' && event.provenance !== 'FIELD') ||
      !Number.isFinite(observedMs) ||
      observedMs > nowMs ||
      nowMs - observedMs >= timeline.policy.maxAgeMs
    ) {
      withheldEventIds.push(event.eventId);
      continue;
    }
    const latest: LatestReadings = latestByAsset.get(event.assetId) ?? {};
    let touchedSafety = false;
    for (const observation of event.observations) {
      if (observation.kind === 'wind_speed') {
        if (
          observation.unit !== 'kt' ||
          typeof observation.value !== 'string' ||
          !/^[0-9]+[.][0-9]$/.test(observation.value)
        ) {
          throw new Error('INVALID_JOURNALED_WIND_OBSERVATION');
        }
        latest.windKt = Number(observation.value);
        touchedSafety = true;
      } else if (observation.kind === 'weather_hold') {
        if (
          observation.unit !== 'state' ||
          (observation.value !== 'active' && observation.value !== 'clear')
        ) {
          throw new Error('INVALID_JOURNALED_HOLD');
        }
        latest.hold = observation.value;
        touchedSafety = true;
      } else if (observation.kind === 'asset_comms') {
        if (
          observation.unit !== 'state' ||
          !['online', 'degraded', 'offline'].includes(String(observation.value))
        ) {
          throw new Error('INVALID_JOURNALED_COMMS');
        }
        latest.comms = observation.value as LatestReadings['comms'];
        touchedSafety = true;
      } else if (observation.kind === 'aisle_access') {
        if (
          observation.unit !== 'state' ||
          (observation.value !== 'clear' && observation.value !== 'obstructed')
        ) {
          throw new Error('INVALID_JOURNALED_AISLE');
        }
        latest.aisle = observation.value;
        touchedSafety = true;
      } else if (observation.kind === 'charger_status') {
        if (
          observation.unit !== 'state' ||
          !['docked_charging', 'free', 'fault'].includes(String(observation.value))
        ) {
          throw new Error('INVALID_JOURNALED_CHARGER');
        }
        latest.charger = String(observation.value) as LatestReadings['charger'];
        touchedSafety = true;
      }
    }
    latestByAsset.set(event.assetId, latest);
    if (!touchedSafety) continue;

    let state: 'clear' | 'blocked' | 'unknown';
    let reason:
      | 'wind-limit'
      | 'weather-hold'
      | 'comms-offline'
      | 'aisle-obstructed'
      | 'charger-fault'
      | 'insufficient-evidence'
      | 'nominal';
    let windParticipated: boolean;
    if (isGroundAsset(event.assetId)) {
      // GROUND domain — extension-1 precedence (see header). Wind and hold
      // are journaled facts but are INERT for this verdict.
      if (latest.comms === 'offline') {
        state = 'blocked';
        reason = 'comms-offline';
      } else if (latest.aisle === 'obstructed') {
        state = 'blocked';
        reason = 'aisle-obstructed';
      } else if (latest.charger === 'fault') {
        state = 'blocked';
        reason = 'charger-fault';
      } else if (
        latest.comms === undefined ||
        latest.aisle === undefined ||
        latest.charger === undefined ||
        latest.comms !== 'online'
      ) {
        state = 'unknown';
        reason = 'insufficient-evidence';
      } else {
        state = 'clear';
        reason = 'nominal';
      }
      windParticipated = false;
    } else if (windLimitKt === undefined) {
      throw new Error('INVALID_PHYSICAL_BRIDGE_SCOPE_OR_POLICY');
    } else if (latest.windKt !== undefined && latest.windKt > windLimitKt) {
      state = 'blocked';
      reason = 'wind-limit';
      windParticipated = true;
    } else if (latest.hold === 'active') {
      state = 'blocked';
      reason = 'weather-hold';
      windParticipated = true;
    } else if (latest.comms === 'offline') {
      state = 'blocked';
      reason = 'comms-offline';
      windParticipated = true;
    } else if (
      latest.windKt === undefined ||
      latest.hold !== 'clear' ||
      latest.comms !== 'online'
    ) {
      state = 'unknown';
      reason = 'insufficient-evidence';
      windParticipated = true;
    } else {
      state = 'clear';
      reason = 'nominal';
      windParticipated = true;
    }

    // No invented forecast, supplier price, payment event or physical control.
    evidence.push({
      version: 1,
      tenant: { orgId: timeline.orgId, missionId: timeline.missionId },
      asset: { id: event.assetId, kind: 'physical-asset' },
      event: {
        id: event.eventId,
        sequence: event.journalSeq,
        observedAt: event.observedAt,
        ingestedAt: event.ingestedAt,
      },
      source: {
        kind: event.sourceType === 'asset_telemetry' ? 'vehicle-telemetry' : 'operator-report',
        digest: event.eventDigest,
        physicalSourceId: event.sourceId,
        physicalSequence: event.sequence,
        provenance: event.provenance,
      },
      constraint: {
        kind: 'asset-safety',
        // The domain rides with the verdict so the planner can enforce
        // domain/reason coherence downstream.
        domain: isGroundAsset(event.assetId) ? 'ground' : 'aerial',
        state,
        reason,
        // Wind attribution is honest: a ground constraint never carries
        // aerial wind figures (they did not participate in the verdict).
        ...(windParticipated && windLimitKt !== undefined
          ? { observedWindKt: latest.windKt, maxWindKt: windLimitKt }
          : {}),
      },
      validity: {
        notAfter: new Date(observedMs + timeline.policy.maxAgeMs).toISOString(),
      },
    });
  }
  return { evidence, withheldEventIds };
}
