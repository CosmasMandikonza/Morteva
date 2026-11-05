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
 */
import type { MissionEvidenceInput } from '@moterva/planner';
import type { MissionTimelineView } from '../mission-events/src/view.js';

export interface PhysicalSafetyPolicy {
  readonly orgId: string;
  readonly missionId: string;
  readonly asOf: Date;
  /** Explicit operator-defined limit, NOT measured or forecast weather. */
  readonly uavWindLimitKt: number;
}

export interface PhysicalSafetyBridgeResult {
  readonly evidence: readonly MissionEvidenceInput[];
  readonly withheldEventIds: readonly string[];
}

interface LatestReadings {
  windKt?: number;
  hold?: 'clear' | 'active';
  comms?: 'online' | 'degraded' | 'offline';
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
    !Number.isFinite(policy.uavWindLimitKt) ||
    policy.uavWindLimitKt <= 0 ||
    policy.uavWindLimitKt > 200 ||
    !Number.isFinite(timeline.policy.maxAgeMs) ||
    timeline.policy.maxAgeMs <= 0
  ) {
    throw new Error('INVALID_PHYSICAL_BRIDGE_SCOPE_OR_POLICY');
  }
  const latestByAsset = new Map<string, LatestReadings>();
  const evidence: MissionEvidenceInput[] = [];
  const withheldEventIds: string[] = [];

  for (const event of [...timeline.events].sort((a, b) => a.journalSeq - b.journalSeq)) {
    const observedMs = Date.parse(event.observedAt);
    // An admitted event can be honest historical evidence without being
    // currently eligible to influence a consequential financial decision.
    if (
      !event.planningValid ||
      event.provenance !== 'SYNTHETIC' ||
      !Number.isFinite(observedMs) ||
      observedMs > nowMs ||
      nowMs - observedMs >= timeline.policy.maxAgeMs
    ) {
      withheldEventIds.push(event.eventId);
      continue;
    }
    const latest = latestByAsset.get(event.assetId) ?? {};
    let touchedSafety = false;
    for (const observation of event.observations) {
      if (observation.kind === 'wind_speed') {
        if (observation.unit !== 'kt' || typeof observation.value !== 'string' ||
            !/^\\d+\\.\\d$/.test(observation.value)) {
          throw new Error('INVALID_JOURNALED_WIND_OBSERVATION');
        }
        latest.windKt = Number(observation.value);
        touchedSafety = true;
      } else if (observation.kind === 'weather_hold') {
        if (observation.unit !== 'state' ||
            (observation.value !== 'active' && observation.value !== 'clear')) {
          throw new Error('INVALID_JOURNALED_HOLD');
        }
        latest.hold = observation.value;
        touchedSafety = true;
      } else if (observation.kind === 'asset_comms') {
        if (observation.unit !== 'state' ||
            !['online', 'degraded', 'offline'].includes(String(observation.value))) {
          throw new Error('INVALID_JOURNALED_COMMS');
        }
        latest.comms = observation.value as LatestReadings['comms'];
        touchedSafety = true;
      }
    }
    latestByAsset.set(event.assetId, latest);
    if (!touchedSafety) continue;

    let state: 'clear' | 'blocked' | 'unknown';
    let reason: 'wind-limit' | 'weather-hold' | 'comms-offline' | 'insufficient-evidence' | 'nominal';
    if (latest.windKt !== undefined && latest.windKt > policy.uavWindLimitKt) {
      state = 'blocked'; reason = 'wind-limit';
    } else if (latest.hold === 'active') {
      state = 'blocked'; reason = 'weather-hold';
    } else if (latest.comms === 'offline') {
      state = 'blocked'; reason = 'comms-offline';
    } else if (latest.windKt === undefined || latest.hold !== 'clear' || latest.comms !== 'online') {
      state = 'unknown'; reason = 'insufficient-evidence';
    } else {
      state = 'clear'; reason = 'nominal';
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
        state, reason,
        observedWindKt: latest.windKt,
        maxWindKt: policy.uavWindLimitKt,
      },
      validity: {
        notAfter: new Date(observedMs + timeline.policy.maxAgeMs).toISOString(),
      },
    });
  }
  return { evidence, withheldEventIds };
}
