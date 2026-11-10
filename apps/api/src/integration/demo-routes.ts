/**
 * Issue #19 — the smallest connected DEMO_ONLY mission-to-finance experience.
 * Registered exclusively inside loopback DEMO_AUTH (never production).
 * Signed SYNTHETIC observations enter the real operational journal; the
 * policy-only planner reads the admitted and verified timeline and ledger
 * financial facts. Nothing in this module grants approval or moves money.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ledger } from '@moterva/ledger';
import { guard, csrfOk } from '../auth.js';
import { MissionEventIngestService } from '../mission-events/src/ingest.js';
import { SourceRegistry, type RegisteredSource } from '../mission-events/src/registry.js';
import { sourceSignature } from '../mission-events/src/digest.js';
import { fixtureSourceKey } from '../mission-events/src/rng.js';
import type { NormalizedEvent } from '../mission-events/src/schema.js';
import type { MissionTimelineView } from '../mission-events/src/view.js';
import { decisionViewFor, resolveMissionSpec, snapshotServiceFor } from './decision-snapshots.js';

// Harbor demo constants (frozen scope): the signed synthetic-step route
// below journals THIS asset's readings. The DECISION side is spec-driven via
// decisionViewFor; this asset id remains drift-equal to the harbor spec
// (asserted by test) and is used only for event ADMISSION here.
const ASSET_ID = 'uav-seeker-1';

function sourceFor(orgId: string, missionId: string): RegisteredSource {
  const suffix = createHash('sha256')
    .update(orgId + ':' + missionId)
    .digest('hex')
    .slice(0, 16);
  return {
    orgId,
    missionId,
    sourceId: 'ops-console',
    sourceType: 'mission_control',
    keyId: 'key_demo_' + suffix,
    secretKey: fixtureSourceKey('synthetic-demo-only-' + suffix, 'ops-console'),
    provenance: 'SYNTHETIC',
    assetIds: [ASSET_ID],
    trustedForRecovery: false,
  };
}

function serviceFor(ledger: Ledger, orgId: string, missionId: string) {
  const registry = new SourceRegistry();
  const source = sourceFor(orgId, missionId);
  registry.register(source);
  return { source, service: new MissionEventIngestService(ledger, ledger.clock, registry) };
}

export function stepEventId(orgId: string, missionId: string, step: 'baseline' | 'incident') {
  return (
    'evt_demo_' +
    step +
    '_' +
    createHash('sha256')
      .update(orgId + ':' + missionId)
      .digest('hex')
      .slice(0, 20)
  );
}

/**
 * REPLAY registry for the demo read surface — SPEC-DRIVEN (C1): the
 * mission's registered sources, not a hardcoded harbor one, so warehouse
 * events signed by warehouse sources verify here too.
 */
function replayServiceFor(ledger: Ledger, orgId: string, missionId: string) {
  // snapshotServiceFor registers exactly the spec's sources with the same
  // deterministic fixture-key derivation the step routes sign with.
  return snapshotServiceFor(ledger, orgId, missionId);
}

function decisionFor(ledger: Ledger, timeline: MissionTimelineView) {
  // C1: the decision view is SPEC-DRIVEN — the mission's registered
  // specification supplies domain policy, economics and offers, so this
  // single function serves harbor AND warehouse missions with no domain
  // branch. Harbor missions without a journaled spec default to the harbor
  // spec (identical values to the historical inline constants).
  return decisionViewFor(ledger, timeline);
}

/** Human-readable, observation-derived reading summary (no free text). */
function readingSummary(event: {
  observations: readonly { kind: string; unit: string; value: string | number }[];
}): string {
  return event.observations.map((o) => `${o.kind} ${String(o.value)} ${o.unit}`).join('; ');
}

function inspect(ledger: Ledger, orgId: string, missionId: string) {
  const timeline = replayServiceFor(ledger, orgId, missionId).replay(orgId, missionId);
  const baselineId = stepEventId(orgId, missionId, 'baseline');
  const incidentId = stepEventId(orgId, missionId, 'incident');
  const baseline = timeline.events.find((e) => e.eventId === baselineId);
  const incident = timeline.events.find((e) => e.eventId === incidentId);
  const beforeTimeline = {
    ...timeline,
    events: timeline.events.filter((e) => e.eventId === baselineId),
  };
  return {
    missionId,
    stage: incident !== undefined ? 'incident' : baseline !== undefined ? 'baseline' : 'empty',
    before: baseline === undefined ? null : decisionFor(ledger, beforeTimeline),
    after: incident === undefined ? null : decisionFor(ledger, timeline),
    admittedEventIds: timeline.events.map((e) => e.eventId),
    incident:
      incident === undefined
        ? null
        : {
            eventId: incident.eventId,
            sourceId: incident.sourceId,
            eventDigest: incident.eventDigest,
            observedAt: incident.observedAt,
            reading: readingSummary(incident),
            provenance: incident.provenance,
          },
    disclaimer:
      'SYNTHETIC physical observations; manually seeded internal ledger, never verified Airwallex funds. No money sent.',
  };
}

/**
 * Authenticated, CSRF-protected local demo endpoints. The browser may request
 * a step but cannot send its own trusted sensor readings, keys, price or
 * money fields. Every admission is signed SERVER-SIDE and journaled once.
 */
export function registerDemoDecisionRoutes(app: FastifyInstance, ledger: Ledger): void {
  app.get('/api/missions/:missionId/physical-decision', async (request, reply) => {
    const g = guard(request, reply, 'read');
    if ('blocked' in g) return reply;
    const missionId = (request.params as { missionId: string }).missionId;
    try {
      ledger.organizations.getMission(g.actor.orgId, missionId);
      return inspect(ledger, g.actor.orgId, missionId);
    } catch (error) {
      request.log.error({ err: error }, 'physical decision read failed');
      return reply.code(404).send({ error: { code: 'NOT_FOUND_OR_UNAVAILABLE' } });
    }
  });

  app.post('/api/missions/:missionId/synthetic-step', async (request, reply) => {
    const g = guard(request, reply, 'operate');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const missionId = (request.params as { missionId: string }).missionId;
    const step = (request.body as { step?: unknown } | null)?.step;
    if (step !== 'baseline' && step !== 'incident') {
      return reply.code(400).send({ error: { code: 'INVALID_STEP' } });
    }
    try {
      ledger.organizations.getMission(g.actor.orgId, missionId);
      // Domain honesty: this route journals HARBOR (aerial UAV) readings.
      // A mission registered under a DIFFERENT spec must never receive
      // harbor events — fail closed with an explicit code (the warehouse
      // journey has its own step route).
      if (
        resolveMissionSpec(ledger, g.actor.orgId, missionId).spec.specId !== 'harbor-inspection-v1'
      ) {
        return reply.code(409).send({ error: { code: 'MISSION_SPEC_MISMATCH' } });
      }
      const { source, service } = serviceFor(ledger, g.actor.orgId, missionId);
      const existing = service.replay(g.actor.orgId, missionId);
      const id = stepEventId(g.actor.orgId, missionId, step);
      if (existing.events.some((event) => event.eventId === id)) {
        return inspect(ledger, g.actor.orgId, missionId); // idempotent repeat
      }
      if (
        step === 'incident' &&
        !existing.events.some(
          (event) => event.eventId === stepEventId(g.actor.orgId, missionId, 'baseline'),
        )
      ) {
        return reply.code(409).send({ error: { code: 'BASELINE_REQUIRED' } });
      }
      const now = ledger.clock.iso();
      const event: NormalizedEvent = {
        contractVersion: 1,
        eventId: id,
        sequence: step === 'baseline' ? 1 : 2,
        orgId: g.actor.orgId,
        missionId,
        assetId: ASSET_ID,
        observedAt: now,
        ingestedAt: now,
        source: {
          sourceId: source.sourceId,
          sourceType: source.sourceType,
          keyId: source.keyId,
          provenance: source.provenance,
        },
        observations:
          step === 'baseline'
            ? [
                { kind: 'wind_speed', unit: 'kt', value: '14.2' },
                { kind: 'weather_hold', unit: 'state', value: 'clear' },
                { kind: 'asset_comms', unit: 'state', value: 'online' },
              ]
            : [
                { kind: 'wind_speed', unit: 'kt', value: '24.6' },
                { kind: 'weather_hold', unit: 'state', value: 'active' },
              ],
      };
      service.ingest(g.actor.orgId, {
        ...event,
        source: { ...event.source, signature: sourceSignature(event, source.secretKey) },
      });
      return inspect(ledger, g.actor.orgId, missionId);
    } catch (error) {
      request.log.error({ err: error }, 'synthetic step rejected');
      return reply.code(409).send({ error: { code: 'SYNTHETIC_ADMISSION_REJECTED' } });
    }
  });
}
