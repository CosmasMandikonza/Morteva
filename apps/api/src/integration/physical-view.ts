/**
 * Sanitized live physical-view read API (MTV-19, Agent C contract
 * `physical-view.v1`) — GET /api/missions/:missionId/physical-view.
 *
 * Reconciles EXACTLY against `MissionEventIngestService.replay()`: every
 * field is derived from the verified timeline; nothing is invented, nothing
 * is read from raw journal payload JSON, and GET never mutates state, never
 * journals, never recomputes financial authority. Tenant-scoped: another
 * org's mission is indistinguishable from a missing one (404).
 *
 * Response bounds: at most 50 recent events, at most 20 assets, observation
 * values only from the typed allowlist — no free-form strings, no provider
 * credentials, no financial authorization data anywhere.
 */
import type { FastifyInstance } from 'fastify';
import type { Ledger } from '@moterva/ledger';
import type {
  AcceptedEventView,
  MissionTimelineView,
  ObservationReading,
} from '../mission-events/src/view.js';
import { snapshotServiceFor } from './decision-snapshots.js';
import { guard } from '../auth.js';

const MAX_RECENT_EVENTS = 50;
const MAX_ASSETS = 20;

/** Typed observation kinds admitted to the projection (allowlist). */
const ALLOWED_KINDS = new Set(['wind_speed', 'weather_hold', 'asset_comms']);

export interface PhysicalViewPayload {
  contractVersion: 1;
  tenant: { orgId: string; missionId: string };
  asOf: string;
  truthLabel: string;
  assets: {
    assetId: string;
    comms: string | null;
    positionStatus: string | null;
    latest: Record<
      string,
      { value: string; unit: string; eventId: string; observedAt: string; freshness: string }
    >;
  }[];
  recentEvents: {
    eventId: string;
    journalSeq: number;
    assetId: string;
    sourceId: string;
    sourceType: string;
    provenance: string;
    observedAt: string;
    eventDigest: string;
    observations: { kind: string; unit: string; value: string }[];
    freshness: string;
    planningValid: boolean;
  }[];
  constraints: {
    assetId: string;
    kind: 'asset-safety';
    state: 'clear' | 'blocked' | 'unknown';
    reason: string;
    basis: string;
  }[];
}

/** Deterministic per-asset constraint derived from FRESH readings only. */
function constraintFor(
  assetId: string,
  latest: Readonly<Record<string, ObservationReading>>,
  windLimitKt: number,
): PhysicalViewPayload['constraints'][number] {
  const wind = latest['wind_speed'];
  const hold = latest['weather_hold'];
  const comms = latest['asset_comms'];
  const fresh = (r?: ObservationReading) => r !== undefined && r.freshness === 'fresh';
  if (fresh(wind) && Number(wind!.value) > windLimitKt) {
    return {
      assetId,
      kind: 'asset-safety',
      state: 'blocked',
      reason: 'wind-limit',
      basis: `fresh wind ${wind!.value} kt exceeds the modeled ${windLimitKt} kt limit`,
    };
  }
  if (fresh(hold) && hold!.value === 'active') {
    return {
      assetId,
      kind: 'asset-safety',
      state: 'blocked',
      reason: 'weather-hold',
      basis: 'fresh weather hold is active (present-tense block, not a forecast)',
    };
  }
  if (fresh(comms) && comms!.value === 'offline') {
    return {
      assetId,
      kind: 'asset-safety',
      state: 'blocked',
      reason: 'comms-offline',
      basis: 'fresh comms report offline',
    };
  }
  if (fresh(wind) && fresh(hold) && fresh(comms)) {
    return {
      assetId,
      kind: 'asset-safety',
      state: 'clear',
      reason: 'nominal',
      basis: 'fresh wind, hold and comms readings all nominal',
    };
  }
  return {
    assetId,
    kind: 'asset-safety',
    state: 'unknown',
    reason: 'insufficient-evidence',
    basis: 'no fresh wind/hold/comms readings as of this snapshot',
  };
}

function projectView(
  timeline: MissionTimelineView,
  truthLabel: string,
  windLimitKt: number,
): PhysicalViewPayload {
  const events = [...timeline.events].sort((a, b) => a.journalSeq - b.journalSeq);
  const recent = events.slice(-MAX_RECENT_EVENTS);

  const assetIds = Object.keys(timeline.assets).slice(0, MAX_ASSETS);
  const assets = assetIds.map((assetId) => {
    const state = timeline.assets[assetId]!;
    const latest: PhysicalViewPayload['assets'][number]['latest'] = {};
    for (const [kind, reading] of Object.entries(state.latest)) {
      if (!ALLOWED_KINDS.has(kind)) continue;
      latest[kind] = {
        value: String(reading.value),
        unit: reading.unit,
        eventId: reading.eventId,
        observedAt: reading.observedAt,
        freshness: reading.freshness,
      };
    }
    return {
      assetId,
      comms: state.comms,
      positionStatus: state.positionStatus,
      latest,
    };
  });

  const recentEvents = recent.map((event: AcceptedEventView) => ({
    eventId: event.eventId,
    journalSeq: event.journalSeq,
    assetId: event.assetId,
    sourceId: event.sourceId,
    sourceType: event.sourceType,
    provenance: event.provenance,
    observedAt: event.observedAt,
    eventDigest: event.eventDigest,
    observations: event.observations
      .filter((o) => ALLOWED_KINDS.has(o.kind))
      .map((o) => ({ kind: o.kind, unit: o.unit, value: String(o.value) })),
    freshness: event.freshness,
    planningValid: event.planningValid,
  }));

  const constraints = assetIds.map((assetId) =>
    constraintFor(assetId, timeline.assets[assetId]!.latest, windLimitKt),
  );

  return {
    contractVersion: 1,
    tenant: { orgId: timeline.orgId, missionId: timeline.missionId },
    asOf: timeline.asOf,
    truthLabel,
    assets,
    recentEvents,
    constraints,
  };
}

export function registerPhysicalViewRoute(app: FastifyInstance, ledger: Ledger): void {
  app.get('/api/missions/:missionId/physical-view', async (request, reply) => {
    const g = guard(request, reply, 'read');
    if ('blocked' in g) return reply;
    const missionId = (request.params as { missionId: string }).missionId;
    try {
      ledger.organizations.getMission(g.actor.orgId, missionId);
    } catch {
      return reply.code(404).send({ error: { code: 'NOT_FOUND_OR_UNAVAILABLE' } });
    }
    try {
      // Read-only reconciliation against the verified timeline replay.
      const service = snapshotServiceFor(ledger, g.actor.orgId, missionId);
      const timeline = service.replay(g.actor.orgId, missionId);
      return projectView(timeline, 'SIMULATED_OPERATION — POLICY-ONLY', 22);
    } catch (error) {
      request.log.error({ err: error }, 'physical view read failed');
      return reply.code(500).send({ error: { code: 'INTERNAL' } });
    }
  });
}
