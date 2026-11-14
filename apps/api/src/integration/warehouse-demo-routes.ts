/**
 * C2 — the WAREHOUSE AMR financial journey (DEMO_AUTH scope only, exactly
 * like the harbor demo routes): a registered ground robot hits a blocked
 * aisle / charger fault during a time-sensitive inventory mission, and the
 * SAME planner/ledger/mandate machinery that serves harbor produces an
 * economically meaningful plan change.
 *
 * LAWS (per the C2 assignment):
 *  - The warehouse spec is REGISTERED (journaled once, idempotent) before
 *    any step — industry values live in the spec, not here.
 *  - Every admission is signed SERVER-SIDE by the spec's registered
 *    sources; the browser supplies only a step name — never readings, keys
 *    or money fields.
 *  - Ground policies never inherit UAV wind rules (structurally enforced:
 *    the spec has no aerial asset and the bridge FORBIDS a wind limit then).
 *  - A restored network connection must NOT imply physical route clearance:
 *    comms-restored alone leaves the aisle-obstructed verdict blocked.
 *  - Nothing here grants approval or moves money; decisions are
 *    PROPOSED_ONLY policy evaluations.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ledger } from '@moterva/ledger';
import { guard, csrfOk } from '../auth.js';
import { sourceSignature } from '../mission-events/src/digest.js';
import { streamKey } from '../mission-events/src/view.js';
import { fixtureSourceKey } from '../mission-events/src/rng.js';
import type { NormalizedEvent } from '../mission-events/src/schema.js';
import { decisionViewFor, resolveMissionSpec, snapshotServiceFor } from './decision-snapshots.js';
import {
  HttpMissionModelAdapter,
  modelAdapterConfigFromEnv,
  type ModelAdapterConfig,
} from './model-adapter.js';
import {
  currentMissionSpec,
  registerMissionSpec,
  MissionSpecError,
  type MissionSpecification,
} from './mission-spec.js';
import {
  warehouseBaselineEventIds,
  warehouseEventId,
  warehouseMissionSpec,
  type WarehouseStep,
} from './mission-catalogs.js';

const STEP_ORDER: readonly WarehouseStep[] = [
  'baseline',
  'aisle-obstruction',
  'charger-fault',
  'comms-loss',
  'comms-restored',
];

function suffixFor(orgId: string, missionId: string): string {
  return createHash('sha256')
    .update(orgId + ':' + missionId)
    .digest('hex')
    .slice(0, 16);
}

const whEventId = warehouseEventId;

/**
 * Step events with DYNAMIC per-stream sequences: the next sequence for each
 * (asset, source) stream is derived from the REPLAYED stream state (a new
 * stream starts at 1; ingest fails closed on gaps). Deterministic given the
 * journal — no module-level mutable state.
 */
function stepEvents(
  orgId: string,
  missionId: string,
  step: WarehouseStep,
  spec: MissionSpecification,
  nowIso: string,
  suffix: string,
  timeline: { streams: Readonly<Record<string, { lastSequence: number }>> },
): NormalizedEvent[] {
  const wms = spec.sources.find((s) => s.sourceId === 'warehouse-wms')!;
  const gateway = spec.sources.find((s) => s.sourceId === 'facility-gateway')!;
  const nextSeq = (assetId: string, sourceId: string): number => {
    const key = streamKey(orgId, missionId, assetId, sourceId);
    return (timeline.streams[key]?.lastSequence ?? 0) + 1;
  };
  const mk = (
    source: MissionSpecification['sources'][number],
    assetId: string,
    observations: NormalizedEvent['observations'],
  ): NormalizedEvent => ({
    contractVersion: 1,
    eventId: whEventId(orgId, missionId, step, assetId, source.sourceId),
    sequence: nextSeq(assetId, source.sourceId),
    orgId,
    missionId,
    assetId,
    observedAt: nowIso,
    ingestedAt: nowIso,
    source: {
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      keyId: `key_demo_${suffix}_${source.sourceId}`,
      provenance: source.provenance,
    },
    observations,
  });
  switch (step) {
    case 'baseline':
      return [
        mk(wms, 'amr-runner-1', [
          { kind: 'aisle_access', unit: 'state', value: 'clear' },
          { kind: 'charger_status', unit: 'state', value: 'free' },
        ]),
        mk(wms, 'amr-backup-2', [
          { kind: 'aisle_access', unit: 'state', value: 'clear' },
          { kind: 'charger_status', unit: 'state', value: 'free' },
        ]),
        mk(gateway, 'amr-runner-1', [{ kind: 'asset_comms', unit: 'state', value: 'online' }]),
        mk(gateway, 'amr-backup-2', [{ kind: 'asset_comms', unit: 'state', value: 'online' }]),
      ];
    case 'aisle-obstruction':
      return [
        mk(wms, 'amr-runner-1', [{ kind: 'aisle_access', unit: 'state', value: 'obstructed' }]),
      ];
    case 'charger-fault':
      return [mk(wms, 'amr-runner-1', [{ kind: 'charger_status', unit: 'state', value: 'fault' }])];
    case 'comms-loss':
      return [
        mk(gateway, 'amr-runner-1', [{ kind: 'asset_comms', unit: 'state', value: 'offline' }]),
      ];
    case 'comms-restored':
      return [
        mk(gateway, 'amr-runner-1', [{ kind: 'asset_comms', unit: 'state', value: 'online' }]),
      ];
  }
}

/** Human-readable, observation-derived reading summary (no free text). */
function readingSummary(event: {
  observations: readonly { kind: string; unit: string; value: string | number }[];
}): string {
  return event.observations.map((o) => `${o.kind} ${String(o.value)} ${o.unit}`).join('; ');
}

function inspectWarehouse(
  ledger: Ledger,
  orgId: string,
  missionId: string,
  spec: MissionSpecification,
) {
  const timeline = snapshotServiceFor(ledger, orgId, missionId).replay(orgId, missionId);
  const baselineIds = warehouseBaselineEventIds(orgId, missionId, spec);
  const beforeTimeline = {
    ...timeline,
    events: timeline.events.filter((e) => baselineIds.includes(e.eventId)),
  };
  const last = timeline.events.at(-1) ?? null;
  const has = (step: WarehouseStep): boolean =>
    spec.assets.some((a) =>
      timeline.events.some((e) =>
        spec.sources.some(
          (src) => e.eventId === whEventId(orgId, missionId, step, a.assetId, src.sourceId),
        ),
      ),
    );
  const stage: WarehouseStep | 'empty' = has('comms-restored')
    ? 'comms-restored'
    : has('comms-loss')
      ? 'comms-loss'
      : has('charger-fault')
        ? 'charger-fault'
        : has('aisle-obstruction')
          ? 'aisle-obstruction'
          : has('baseline')
            ? 'baseline'
            : 'empty';
  return {
    missionId,
    specId: spec.specId,
    industry: spec.industry,
    stage,
    before: beforeTimeline.events.length === 0 ? null : decisionViewFor(ledger, beforeTimeline),
    after: timeline.events.length === 0 ? null : decisionViewFor(ledger, timeline),
    admittedEventIds: timeline.events.map((e) => e.eventId),
    lastEvent:
      last === null
        ? null
        : {
            eventId: last.eventId,
            assetId: last.assetId,
            sourceId: last.sourceId,
            eventDigest: last.eventDigest,
            observedAt: last.observedAt,
            reading: readingSummary(last),
            provenance: last.provenance,
          },
    disclaimer:
      'SYNTHETIC warehouse observations; manually seeded internal ledger, never verified Airwallex funds. No money sent.',
  };
}

/**
 * Authenticated, CSRF-protected warehouse demo endpoints. Mirrors the harbor
 * demo contract exactly; the DECISION side is the shared spec-driven view.
 */
export function registerWarehouseDemoRoutes(app: FastifyInstance, ledger: Ledger): void {
  app.get('/api/missions/:missionId/warehouse-decision', async (request, reply) => {
    const g = guard(request, reply, 'read');
    if ('blocked' in g) return reply;
    const missionId = (request.params as { missionId: string }).missionId;
    try {
      ledger.organizations.getMission(g.actor.orgId, missionId);
    } catch {
      return reply.code(404).send({ error: { code: 'NOT_FOUND_OR_UNAVAILABLE' } });
    }
    const { spec } = resolveMissionSpec(ledger, g.actor.orgId, missionId);
    if (spec.specId !== 'warehouse-inventory-v1') {
      return reply.code(409).send({ error: { code: 'MISSION_SPEC_MISMATCH' } });
    }
    return inspectWarehouse(ledger, g.actor.orgId, missionId, spec);
  });

  app.post('/api/missions/:missionId/warehouse-step', async (request, reply) => {
    const g = guard(request, reply, 'operate');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const missionId = (request.params as { missionId: string }).missionId;
    const step = (request.body as { step?: unknown } | null)?.step;
    if (typeof step !== 'string' || !STEP_ORDER.includes(step as WarehouseStep)) {
      return reply.code(400).send({ error: { code: 'INVALID_STEP' } });
    }
    try {
      ledger.organizations.getMission(g.actor.orgId, missionId);
      // Industries never mix inside one mission's journal: a mission that
      // already carries a REGISTERED non-warehouse spec, or unregistered
      // harbor demo events, is refused with an explicit code.
      const registered = currentMissionSpec(ledger, g.actor.orgId, missionId);
      if (registered !== null && registered.spec.specId !== 'warehouse-inventory-v1') {
        return reply.code(409).send({ error: { code: 'MISSION_SPEC_CONFLICT' } });
      }
      if (registered === null) {
        const harborRows = ledger.db
          .prepare(
            `SELECT COUNT(*) AS n FROM evidence_events
              WHERE org_id = ? AND mission_id = ? AND event_key LIKE 'mevt:evt_demo_%'`,
          )
          .get(g.actor.orgId, missionId) as { n: number };
        if (harborRows.n > 0) {
          return reply.code(409).send({ error: { code: 'MISSION_SPEC_CONFLICT' } });
        }
      }
      // C1: register the warehouse spec ONCE (idempotent journal append).
      let spec: MissionSpecification;
      try {
        const registration = registerMissionSpec(
          ledger,
          warehouseMissionSpec(g.actor.orgId, missionId),
        );
        spec = registration.spec;
      } catch (error) {
        if (error instanceof MissionSpecError && error.code === 'SPEC_ID_COLLISION') {
          return reply.code(409).send({ error: { code: 'MISSION_SPEC_CONFLICT' } });
        }
        throw error;
      }
      const suffix = suffixFor(g.actor.orgId, missionId);
      const service = snapshotServiceFor(ledger, g.actor.orgId, missionId);
      const existingTimeline = service.replay(g.actor.orgId, missionId);
      const admittedIds = existingTimeline.events.map((e) => e.eventId);
      const stepEventsList = stepEvents(
        g.actor.orgId,
        missionId,
        step as WarehouseStep,
        spec,
        ledger.clock.iso(),
        suffix,
        existingTimeline,
      );
      if (stepEventsList.every((e) => admittedIds.includes(e.eventId))) {
        return inspectWarehouse(ledger, g.actor.orgId, missionId, spec); // idempotent repeat
      }
      const baselineIds = warehouseBaselineEventIds(g.actor.orgId, missionId, spec);
      if (step !== 'baseline' && !baselineIds.every((id) => admittedIds.includes(id))) {
        return reply.code(409).send({ error: { code: 'BASELINE_REQUIRED' } });
      }
      if (
        step === 'comms-restored' &&
        !admittedIds.includes(
          whEventId(g.actor.orgId, missionId, 'comms-loss', 'amr-runner-1', 'facility-gateway'),
        )
      ) {
        return reply.code(409).send({ error: { code: 'COMMS_LOSS_REQUIRED' } });
      }
      for (const event of stepEventsList) {
        const source = spec.sources.find((s) => s.sourceId === event.source.sourceId)!;
        service.ingest(g.actor.orgId, {
          ...event,
          source: {
            ...event.source,
            signature: sourceSignature(
              event,
              fixtureSourceKey('synthetic-demo-only-' + suffix, source.sourceId),
            ),
          },
        });
      }
      return inspectWarehouse(ledger, g.actor.orgId, missionId, spec);
    } catch (error) {
      request.log.error({ err: error }, 'warehouse step rejected');
      return reply.code(409).send({
        error: {
          code: 'SYNTHETIC_ADMISSION_REJECTED',
          message: error instanceof Error ? error.message : 'admission failed',
        },
      });
    }
  });

  /**
   * C3 — model interpretation of an UNTRUSTED natural-language incident
   * report. Requires founder-provisioned provider access (env); without it,
   * the honest answer is 503 MODEL_NOT_CONFIGURED with the deterministic
   * engine still fully operational (visible degradation, never a fabrication).
   * A successful interpretation is journaled with full provenance and feeds
   * ONLY typed, validated evidence into the next decision — never authority.
   */
  app.post('/api/missions/:missionId/warehouse-interpret', async (request, reply) => {
    const g = guard(request, reply, 'operate');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const missionId = (request.params as { missionId: string }).missionId;
    const report = (request.body as { report?: unknown } | null)?.report;
    if (typeof report !== 'string' || report.trim() === '' || report.length > 4000) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_INPUT', message: 'report must be a 1-4000 char string' } });
    }
    try {
      ledger.organizations.getMission(g.actor.orgId, missionId);
      const { spec } = resolveMissionSpec(ledger, g.actor.orgId, missionId);
      if (spec.specId !== 'warehouse-inventory-v1') {
        return reply.code(409).send({ error: { code: 'MISSION_SPEC_MISMATCH' } });
      }
      let config: ModelAdapterConfig;
      try {
        const resolved = modelAdapterConfigFromEnv();
        if (resolved === null) {
          return reply.code(503).send({
            error: {
              code: 'MODEL_NOT_CONFIGURED',
              message:
                'no founder-provisioned model provider is configured (MOTERVA_MODEL_* env); the deterministic POLICY-ONLY engine remains fully operational',
            },
          });
        }
        config = resolved;
      } catch (configError) {
        return reply.code(500).send({
          error: {
            code: 'MODEL_CONFIG_INVALID',
            message:
              configError instanceof Error ? configError.message : 'invalid model configuration',
          },
        });
      }
      const adapter = new HttpMissionModelAdapter(config);
      const record = await adapter.interpretIncidentReport(
        ledger,
        g.actor.orgId,
        missionId,
        spec,
        report,
      );
      return {
        missionId,
        interpretation: {
          status: record.status,
          adapterId: record.adapterId,
          modelId: record.modelId,
          promptTemplateVersion: record.promptTemplateVersion,
          inputDigest: record.inputDigest,
          providerInvoked: record.providerInvoked,
          latencyMs: record.latencyMs,
          confidenceBps: record.confidence === null ? null : Math.round(record.confidence * 10_000),
          errorCode: record.errorCode,
          evidenceCount: record.evidence.length,
          causality: record.status === 'accepted' ? 'MODEL_DERIVED' : 'MODEL_ATTEMPT',
        },
        decision: inspectWarehouse(ledger, g.actor.orgId, missionId, spec),
        authorization:
          'PROPOSED_ONLY — model text never sets mandates, approvals, clearance or amounts',
      };
    } catch (error) {
      request.log.error({ err: error }, 'model interpretation failed');
      return reply.code(409).send({ error: { code: 'MODEL_INTERPRETATION_REJECTED' } });
    }
  });
}
