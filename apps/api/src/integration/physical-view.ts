/**
 * Sanitized live physical-view read API (MTV-19, Agent C contract
 * `physical-view.v1`) — GET /api/missions/:missionId/physical-view.
 *
 * The payload matches Agent C's LIVE strict viewer adapter
 * (`apps/web/src/mission-viewer/adapter.ts::snapshotFromServerPayload`)
 * EXACTLY: policy {maxAgeMs, expiredMs, uavAssetId, uavWindLimitKt}, assets
 * [{assetId, kind: 'aerial'|'surface'|'ground'}], events [{eventId,
 * journalSeq, sequence, assetId, sourceId, sourceType, provenance,
 * observedAt, ingestedAt, recordedAt, eventDigest (64-hex), observations,
 * freshnessAtSnapshot, planningValidAtSnapshot}] — including the pose-relevant
 * typed `asset_position_status` observations. A separate `constraints` block
 * (extra field, ignored by the adapter) carries the Agent A state machine for
 * Agent B's UI.
 *
 * Reconciles EXACTLY against `MissionEventIngestService.replay()`: every
 * field is derived from the verified timeline; nothing is invented, nothing
 * is read from raw journal payload JSON, and GET never mutates state, never
 * journals, never recomputes financial authority. Tenant-scoped: another
 * org's mission is indistinguishable from a missing one (404).
 *
 * HONEST SCOPE (P1): asset domains come from the FIXED SYNTHETIC DEMO
 * CATALOG (uav-seeker-1 = aerial, registered by trusted code, never guessed
 * from asset names). This is NOT general physical-domain support: no
 * per-mission asset-domain registry is wired in this repo (separate contract
 * request). Any admitted asset outside the demo catalog fail-closes 409
 * ASSET_DOMAIN_UNAVAILABLE, and if the catalog does not designate exactly
 * one aerial asset the endpoint fail-closes UAV_POLICY_UNRESOLVABLE — no
 * fabricated domain class is ever emitted.
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
import { snapshotServiceFor, resolveMissionSpec } from './decision-snapshots.js';
import type { MissionSpecification } from './mission-spec.js';
import { guard } from '../auth.js';

const MAX_RECENT_EVENTS = 50;
const MAX_ASSETS = 20;

/**
 * Pose-relevant kinds join the safety kinds in the allowlist: the strict
 * adapter consumes `asset_position_status` for the 3D pose, and the values
 * are schema-validated enums at ingest (never free-form).
 */
const ALLOWED_KINDS = new Set([
  'wind_speed',
  'weather_hold',
  'asset_comms',
  'asset_position_status',
  'aisle_access',
  'charger_status',
]);

/** The modeled wind limit — applies to the AERIAL asset only (contract law). */
const UAV_WIND_LIMIT_KT = 22;

type AssetDomain = 'aerial' | 'surface' | 'ground';

/** Constraint derivation for ONE asset (P0-2 semantics). */
export function constraintFor(input: {
  assetId: string;
  domain: AssetDomain;
  latest: Readonly<Record<string, ObservationReading>>;
  windLimitKt: number;
}): {
  assetId: string;
  kind: 'asset-safety';
  state: 'clear' | 'blocked' | 'unknown';
  reason:
    | 'nominal'
    | 'wind-limit'
    | 'weather-hold'
    | 'comms-offline'
    | 'aisle-obstructed'
    | 'charger-fault'
    | 'insufficient-evidence';
  basis: string;
} {
  const { assetId, domain, windLimitKt } = input;
  const latest = input.latest;
  const wind = latest['wind_speed'];
  const hold = latest['weather_hold'];
  const comms = latest['asset_comms'];
  const fresh = (r?: ObservationReading) => r !== undefined && r.freshness === 'fresh';

  // GROUND + SURFACE domains — the COMPLETED ground contract (extension 1,
  // identical to the bridge and the viewer): fresh comms OFFLINE → blocked;
  // fresh aisle OBSTRUCTED → blocked; fresh charger FAULT → blocked; any
  // missing reading or non-online comms (degraded included) → unknown; all
  // fresh and healthy → clear. Wind and weather-hold are journaled facts but
  // are INERT for this verdict — an aerial wind limit is not a ground/surface
  // constraint, and a ground/surface asset must never inherit aerial
  // clearance (or aerial blocking).
  if (domain === 'ground' || domain === 'surface') {
    const aisle = latest['aisle_access'];
    const charger = latest['charger_status'];
    if (fresh(comms) && comms!.value === 'offline') {
      return {
        assetId,
        kind: 'asset-safety',
        state: 'blocked',
        reason: 'comms-offline',
        basis: 'fresh comms report offline (ground/surface-interrupting condition)',
      };
    }
    if (fresh(aisle) && aisle!.value === 'obstructed') {
      return {
        assetId,
        kind: 'asset-safety',
        state: 'blocked',
        reason: 'aisle-obstructed',
        basis: 'fresh aisle reading reports the path obstructed (ground-interrupting condition)',
      };
    }
    if (fresh(charger) && charger!.value === 'fault') {
      return {
        assetId,
        kind: 'asset-safety',
        state: 'blocked',
        reason: 'charger-fault',
        basis: 'fresh charger reading reports a fault (ground-interrupting condition)',
      };
    }
    const healthy =
      fresh(comms) &&
      comms!.value === 'online' &&
      fresh(aisle) &&
      aisle!.value === 'clear' &&
      fresh(charger) &&
      (charger!.value === 'free' || charger!.value === 'docked_charging');
    if (healthy) {
      return {
        assetId,
        kind: 'asset-safety',
        state: 'clear',
        reason: 'nominal',
        basis: 'fresh comms online, aisle clear, charger healthy (completed ground contract)',
      };
    }
    return {
      assetId,
      kind: 'asset-safety',
      state: 'unknown',
      reason: 'insufficient-evidence',
      basis:
        'ground/surface verdict needs fresh comms online + aisle clear + charger healthy; degraded or missing readings are never a healthy verdict',
    };
  }

  // AERIAL domain — precedence matches Agent D's physicalTimelineToPlannerSafety
  // aerial chain EXACTLY (wind-limit → weather-hold → comms-offline →
  // unknown/clear) so both engines emit identical verdicts on the same
  // journal state.
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
  // Comms is domain-neutral: fresh OFFLINE is a genuine interrupting
  // condition — blocked, fail-closed.
  if (fresh(comms) && comms!.value === 'offline') {
    return {
      assetId,
      kind: 'asset-safety',
      state: 'blocked',
      reason: 'comms-offline',
      basis: 'fresh comms report offline',
    };
  }
  // CLEAR requires explicitly-fresh comms ONLINE, explicitly-fresh hold
  // CLEAR, and fresh wind within the modeled limit. Degraded comms is NOT a
  // healthy-aerial verdict: unknown, never clear.
  const commsOnline = fresh(comms) && comms!.value === 'online';
  const holdClear = fresh(hold) && hold!.value === 'clear';
  const windOk = fresh(wind) && Number(wind!.value) <= windLimitKt;
  if (commsOnline && holdClear && windOk) {
    return {
      assetId,
      kind: 'asset-safety',
      state: 'clear',
      reason: 'nominal',
      basis: 'fresh comms online, hold clear, wind within the modeled limit',
    };
  }
  if (fresh(comms) && comms!.value === 'degraded') {
    return {
      assetId,
      kind: 'asset-safety',
      state: 'unknown',
      reason: 'insufficient-evidence',
      basis: 'fresh comms DEGRADED — degraded communications never yield a clear state',
    };
  }
  return {
    assetId,
    kind: 'asset-safety',
    state: 'unknown',
    reason: 'insufficient-evidence',
    basis: 'no fresh, explicitly-online comms/clear-hold evidence as of this snapshot',
  };
}

export function projectPhysicalView(
  timeline: MissionTimelineView,
  truthLabel: string,
  assetDomains: ReadonlyMap<string, AssetDomain>,
  spec: MissionSpecification,
): { payload: Record<string, unknown>; unresolvableAssets: string[] } {
  const events = [...timeline.events].sort((a, b) => a.journalSeq - b.journalSeq);
  const recent = events.slice(-MAX_RECENT_EVENTS);

  const unresolvableAssets: string[] = [];
  const assetIds = Object.keys(timeline.assets).slice(0, MAX_ASSETS);
  for (const assetId of assetIds) {
    if (!assetDomains.has(assetId)) unresolvableAssets.push(assetId);
  }
  // Honest fail-closed flow: an admitted asset WITHOUT authoritative domain
  // metadata cannot be given a fabricated class, and the strict adapter
  // requires a complete, consistent asset set. The host receives an explicit
  // machine code instead of a half-trusted scene.
  if (unresolvableAssets.length > 0) {
    return {
      payload: {
        error: { code: 'ASSET_DOMAIN_UNAVAILABLE', assetIds: unresolvableAssets },
      },
      unresolvableAssets,
    };
  }

  // S0 — zero admitted events: emit the server-authoritative EMPTY-EVIDENCE
  // snapshot (CTO P0-A). The FIRST REGISTERED spec asset is included with an
  // empty reading set and an explicitly-unknown constraint; tenant, asOf and
  // policy are all real server values. No observation is invented and the
  // client renders S0-initial from THIS payload — never from a locally
  // fabricated snapshot. Missions with admitted non-registered or multi-aerial
  // assets still fail closed below.
  if (assetIds.length === 0) {
    const s0Asset = spec.assets[0]!;
    return {
      payload: {
        contractVersion: 1,
        tenant: { orgId: timeline.orgId, missionId: timeline.missionId },
        asOf: timeline.asOf,
        truthLabel,
        policy: {
          maxAgeMs: timeline.policy.maxAgeMs,
          expiredMs: timeline.policy.expiredMs,
          uavAssetId: s0Asset.assetId,
          // Ground-only specs carry no wind rule; the legacy wire field keeps
          // the modeled default for shape compatibility — it is INERT for
          // ground verdicts (the client branches on the asset KIND, and the
          // server's constraint block carries the authoritative verdicts).
          uavWindLimitKt: spec.safetyPolicy.uavWindLimitKt ?? UAV_WIND_LIMIT_KT,
        },
        assets: [
          {
            assetId: s0Asset.assetId,
            kind: s0Asset.domainKind,
            latest: {},
          },
        ],
        events: [],
        constraints: [
          {
            assetId: s0Asset.assetId,
            kind: 'asset-safety',
            state: 'unknown',
            reason: 'insufficient-evidence',
            basis: 'no admitted physical evidence yet — operating status unknown by design',
          },
        ],
      },
      unresolvableAssets,
    };
  }

  const aerialAssets = assetIds.filter((id) => assetDomains.get(id) === 'aerial');
  if (aerialAssets.length > 1) {
    // The wind policy can only be attributed honestly when the registry
    // designates AT MOST ONE aerial asset for the mission. A ground-only
    // mission (zero aerial) is a valid projection shape.
    return {
      payload: {
        error: {
          code: 'UAV_POLICY_UNRESOLVABLE',
          aerialAssets,
        },
      },
      unresolvableAssets,
    };
  }
  const uavAssetId = aerialAssets[0]!;

  const assets = assetIds.map((assetId) => {
    const state = timeline.assets[assetId]!;
    const latest: Record<
      string,
      {
        value: string | number;
        unit: string;
        eventId: string;
        observedAt: string;
        freshness: string;
      }
    > = {};
    for (const [kind, reading] of Object.entries(state.latest)) {
      if (!ALLOWED_KINDS.has(kind)) continue;
      // Value passes through EXACTLY as admitted (number or decimal-string) —
      // the strict adapter accepts both; no stringification.
      latest[kind] = {
        value: reading.value as string | number,
        unit: reading.unit,
        eventId: reading.eventId,
        observedAt: reading.observedAt,
        freshness: reading.freshness,
      };
    }
    return {
      assetId,
      kind: assetDomains.get(assetId)!,
      latest,
    };
  });

  const recentEvents = recent.map((event: AcceptedEventView) => ({
    eventId: event.eventId,
    journalSeq: event.journalSeq,
    sequence: event.sequence,
    assetId: event.assetId,
    sourceId: event.sourceId,
    sourceType: event.sourceType,
    provenance: event.provenance,
    observedAt: event.observedAt,
    ingestedAt: event.ingestedAt,
    recordedAt: event.recordedAt,
    eventDigest: event.eventDigest,
    observations: event.observations
      .filter((o) => ALLOWED_KINDS.has(o.kind))
      .map((o) => ({ kind: o.kind, unit: o.unit, value: o.value as string | number })),
    freshnessAtSnapshot: event.freshness,
    planningValidAtSnapshot: event.planningValid,
  }));

  const constraints = assetIds.map((assetId) =>
    constraintFor({
      assetId,
      domain: assetDomains.get(assetId)!,
      latest: timeline.assets[assetId]!.latest,
      windLimitKt: spec.safetyPolicy.uavWindLimitKt ?? UAV_WIND_LIMIT_KT,
    }),
  );

  return {
    payload: {
      contractVersion: 1,
      tenant: { orgId: timeline.orgId, missionId: timeline.missionId },
      asOf: timeline.asOf,
      truthLabel,
      policy: {
        maxAgeMs: timeline.policy.maxAgeMs,
        expiredMs: timeline.policy.expiredMs,
        uavAssetId,
        uavWindLimitKt: spec.safetyPolicy.uavWindLimitKt ?? UAV_WIND_LIMIT_KT,
      },
      assets,
      events: recentEvents,
      constraints,
    },
    unresolvableAssets,
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
      // REGISTERED mission specification (C1) — the honest scope of this
      // route: asset domains come from the mission's journaled spec
      // (registered by trusted code, never inferred from names). Assets
      // outside the spec fail closed above (ASSET_DOMAIN_UNAVAILABLE).
      const { spec } = resolveMissionSpec(ledger, g.actor.orgId, missionId);
      const domains = new Map<string, AssetDomain>(
        spec.assets.map((a) => [a.assetId, a.domainKind]),
      );
      const { payload } = projectPhysicalView(
        timeline,
        'SIMULATED_OPERATION — POLICY-ONLY',
        domains,
        spec,
      );
      if ('error' in payload && payload.error !== undefined) {
        return reply.code(409).send(payload);
      }
      return payload;
    } catch (error) {
      request.log.error({ err: error }, 'physical view read failed');
      return reply.code(500).send({ error: { code: 'INTERNAL' } });
    }
  });
}
