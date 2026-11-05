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
import {
  evaluate,
  financialFacts,
  generateCandidates,
  reviewEvidence,
  type FinancialPolicy,
  type SupplierOffer,
} from '@moterva/planner';
import { guard, csrfOk } from '../auth.js';
import { MissionEventIngestService } from '../mission-events/src/ingest.js';
import { SourceRegistry, type RegisteredSource } from '../mission-events/src/registry.js';
import { sourceSignature } from '../mission-events/src/digest.js';
import { fixtureSourceKey } from '../mission-events/src/rng.js';
import type { NormalizedEvent } from '../mission-events/src/schema.js';
import type { MissionTimelineView } from '../mission-events/src/view.js';
import { physicalTimelineToPlannerSafety } from './physical-to-planner.js';

const ASSET_ID = 'uav-seeker-1';
const WIND_LIMIT_KT = 22;
const INCUMBENT: SupplierOffer = {
  id: 'uav-inspection',
  kind: 'inspection-service',
  beneficiary: 'harbor-diagnostics',
  purpose: 'harbor inspection',
  currency: 'USD',
  baseCostMinor: 1_200_000,
  feeMinor: 0,
  leadTimeMinutes: 60,
  durationMinutes: 180,
  probabilityOfSuccess: 0.9,
  availability: 'confirmed',
};
const VESSEL: SupplierOffer = {
  id: 'vessel-inspection',
  kind: 'inspection-service',
  beneficiary: 'harbor-marine',
  purpose: 'harbor inspection',
  currency: 'USD',
  baseCostMinor: 1_800_000,
  feeMinor: 50_000,
  leadTimeMinutes: 45,
  durationMinutes: 180,
  probabilityOfSuccess: 0.85,
  availability: 'confirmed',
};

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

function stepEventId(orgId: string, missionId: string, step: 'baseline' | 'incident') {
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

function decisionFor(ledger: Ledger, timeline: MissionTimelineView) {
  // A single injected replay clock must govern both C freshness and A evidence validity.
  const now = new Date(timeline.asOf);
  const tenant = { orgId: timeline.orgId, missionId: timeline.missionId };
  const safety = physicalTimelineToPlannerSafety(timeline, {
    ...tenant,
    asOf: now,
    uavWindLimitKt: WIND_LIMIT_KT,
  });
  const reviewed = reviewEvidence([...safety.evidence], now, tenant);
  const policy: FinancialPolicy = {
    version: 1,
    currency: 'USD',
    missionDeadlineAt: new Date(now.getTime() + 12 * 3_600_000).toISOString(),
    missionValueMinor: 5_000_000,
    failureCostMinor: 1_500_000,
    protectedReserveMinor: 50_000,
    maxProbabilityAssumption: 0.95,
    unconfirmedAvailabilityFactor: 0.5,
    diagnosticValueThreshold: 1,
    forbidUnconfirmedAvailability: false,
    escalationScoreGap: 10_000,
  };
  const facts = financialFacts(ledger, tenant.orgId, tenant.missionId, 'USD');
  const candidates = generateCandidates(reviewed.accepted, {
    now,
    policyCurrency: 'USD',
    missionDeadlineAt: policy.missionDeadlineAt,
    incumbent: INCUMBENT,
    incumbentAssetId: ASSET_ID,
    alternatives: [VESSEL],
  });
  const decision = evaluate({
    now,
    policy,
    facts,
    evidence: reviewed,
    candidates,
    modelAdapterId: null,
  });
  return {
    evaluationId: decision.trace.evaluationId,
    outcome: decision.outcome,
    selected:
      decision.selected === null
        ? null
        : {
            candidateId: decision.selected.candidate.id,
            label: decision.selected.candidate.label,
            kind: decision.selected.candidate.kind,
            grossMinor: decision.selected.grossCostMinor,
            expectedNetMinor: decision.selected.expectedNetMinor,
          },
    alternatives: decision.trace.scores.map((scored) => ({
      id: scored.candidate.id,
      label: scored.candidate.label,
      kind: scored.candidate.kind,
      feasible: scored.feasible,
      grossMinor: scored.grossCostMinor,
      expectedNetMinor: scored.expectedNetMinor,
      rejection: scored.rejection?.code ?? null,
    })),
    reasons: decision.reasons.map((r) => ({
      code: r.code,
      message: r.message,
      evidenceIds: r.evidenceIds,
    })),
    evidenceIds: decision.trace.evidenceAcceptedIds,
    withheldEventIds: safety.withheldEventIds,
    currentBalanceStatus: facts.balanceStatus,
    currentSpendableMinor: facts.spendableMinor,
    authorization: 'PROPOSED_ONLY — requires separate human approval and ledger recheck',
    providerVerified: false,
    mode: 'SIMULATED_OPERATION — POLICY-ONLY',
  };
}

function inspect(ledger: Ledger, orgId: string, missionId: string) {
  const { service } = serviceFor(ledger, orgId, missionId);
  const timeline = service.replay(orgId, missionId);
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
            reading: '24.6 kt wind exceeds modeled 22 kt UAV limit; weather hold active',
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
