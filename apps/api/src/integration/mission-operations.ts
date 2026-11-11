/**
 * P0 PRODUCTIZATION — the production mission-operations pathway (CTO
 * execution comment, Nov 11 2026). This module eliminates dependence on
 * predefined demo scenarios for NORMAL product operation, reusing — never
 * rewriting — the accepted infrastructure: `MissionSpecification` +
 * `registerMissionSpec` (C1), `SourceRegistry` + `MissionEventIngestService`
 * (issue #9), the physical→planner bridge, the planner evaluation and the
 * `HttpMissionModelAdapter` (C3).
 *
 * THREE guarded surfaces, all RBAC + CSRF protected (production scope —
 * mounted OUTSIDE the DEMO_AUTH gate):
 *
 * 1. `POST /api/missions/:missionId/mission-spec` — authenticated admin/
 *    operator REGISTRATION of a versioned, immutable MissionSpecification
 *    from ARBITRARY validated input (assets, domain safety policy, trusted
 *    sources, deadline, economics, offers, beneficiaries). Org/mission/role
 *    binding is enforced; identity fields are re-stamped SERVER-SIDE (the
 *    browser can never register a spec for another org/mission).
 *
 * 2. `POST /api/missions/:missionId/sources/:sourceId/secret` — secure
 *    non-demo source credential issuance. The server GENERATES the HMAC
 *    secret (32 bytes CSPRNG), persists it in the append-only operational
 *    journal under a type reserved to trusted code, and returns it EXACTLY
 *    ONCE to the managing operator (same one-time-display contract as
 *    identity API credentials). Server-to-server sources sign their events
 *    with it; the browser never sees a telemetry credential twice and can
 *    never mint one. Registration binds source → assets → tenant exactly
 *    like the spec declares.
 *
 * 3. `POST /api/missions/:missionId/events` — PRODUCTION event ingestion:
 *    the operator (or a server-to-server integration holding the source
 *    secret) submits the typed envelope; the event MUST carry a valid HMAC
 *    `signature` computed with the source's secret over the canonical form.
 *    Every existing ingest law applies unchanged: unregistered/revoked keys
 *    refused, per-stream monotonicity, duplicate idempotency, future/stale
 *    bounds, offline-recovery trust rule, banking-vocabulary ban. A browser
 *    session can NEVER authorize telemetry by session alone — no secret, no
 *    admission. Ingress NEVER mutates money: zero financial rows is proven
 *    by test.
 *
 * 4. `POST /api/missions/:missionId/operations/evaluate` — generalized
 *    evidence-driven planning for ANY registered mission: baseline/incident
 *    STAGES ARE DERIVED FROM THE JOURNAL (first admitted event(s) =
 *    baseline window; latest admitted event = the incident), with NO demo
 *    event-id knowledge. The durable snapshot machinery, the plan-proposal
 *    bridge, the mandate/facts revalidation and the idempotency laws are
 *    the accepted ones, unchanged.
 *
 * 5. `POST /api/missions/:missionId/model-interpretation` — the bounded
 *    live model adapter extended from the DEMO warehouse route to ANY
 *    registered mission (operate + CSRF; report size bounded; output
 *    strictly validated; journal-recorded with full provenance; MODEL
 *    degradation visible; authority untouched).
 *
 * TRUTH BOUNDARY (unchanged): synthetic fixtures (`demo-routes.ts`,
 * `warehouse-demo-routes.ts`) remain test/demo-only pathways. A production
 * mission's decisions draw ONLY on registered sources' signed events plus
 * optional model-derived typed evidence — never on fixture catalogs.
 */
import { randomBytes, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ledger } from '@moterva/ledger';
import { isLedgerError } from '@moterva/ledger';
import { canonicalJson } from '@moterva/domain';
import { guard, csrfOk } from '../auth.js';
import { MissionEventIngestService } from '../mission-events/src/ingest.js';
import { MissionEventError } from '../mission-events/src/errors.js';
import { SourceRegistry, type RegisteredSource } from '../mission-events/src/registry.js';
import type { MissionTimelineView } from '../mission-events/src/view.js';
import { registerMissionSpec, validateMissionSpec, MissionSpecError } from './mission-spec.js';
import {
  decisionViewFor,
  loadSnapshots,
  recordGeneralizedSnapshot,
  resolveMissionSpec,
  snapshotServiceFor,
} from './decision-snapshots.js';
import {
  HttpMissionModelAdapter,
  modelAdapterConfigFromEnv,
  type ModelAdapterConfig,
} from './model-adapter.js';

export const SOURCE_SECRET_TYPE = 'mission.source.registered';
const MAX_INGEST_ENVELOPES = 10;
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const KEY_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/;

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Production credential registry: reads the journaled source credentials
 * (digest-verified) into the SAME SourceRegistry shape the demo pathway
 * uses — ingest code is unchanged; only the key CUSTODY differs (CSPRNG
 * secrets issued by trusted code vs deterministic fixture keys).
 */
export class JournaledSourceRegistry extends SourceRegistry {
  constructor(ledger: Ledger, orgId: string, missionId: string) {
    super();
    const rows = ledger.db
      .prepare(
        `SELECT seq, payload_digest, payload_json FROM evidence_events
          WHERE org_id = ? AND mission_id = ? AND type = ?
          ORDER BY seq ASC`,
      )
      .all(orgId, missionId, SOURCE_SECRET_TYPE) as {
      seq: number;
      payload_digest: string;
      payload_json: string;
    }[];
    for (const row of rows) {
      const payload: unknown = JSON.parse(row.payload_json);
      const digest = sha(canonicalJson(payload as Record<string, unknown>));
      if (digest !== row.payload_digest) {
        throw new Error(`SOURCE_CREDENTIAL_INTEGRITY_VIOLATION:${String(row.seq)}`);
      }
      const record = payload as {
        sourceId: string;
        sourceType: RegisteredSource['sourceType'];
        keyId: string;
        secretKey: string;
        assetIds: string[];
        trustedForRecovery: boolean;
        provenance: RegisteredSource['provenance'];
      };
      this.register({
        orgId,
        missionId,
        sourceId: record.sourceId,
        sourceType: record.sourceType,
        keyId: record.keyId,
        // The journal stores the key material TRUSTED-SIDE (server-to-server
        // custody). It is never returned by any GET; only the issuance
        // response shows it once.
        secretKey: record.secretKey,
        provenance: record.provenance,
        assetIds: [...record.assetIds],
        trustedForRecovery: record.trustedForRecovery,
      });
    }
  }
}

/** Production-scoped ingest service (journaled credentials, not fixtures). */
export function productionServiceFor(ledger: Ledger, orgId: string, missionId: string) {
  const registry = new JournaledSourceRegistry(ledger, orgId, missionId);
  return new MissionEventIngestService(ledger, ledger.clock, registry);
}

// ------------------------------------------------------------------- routes

export function registerMissionOperationsRoutes(app: FastifyInstance, ledger: Ledger): void {
  // ---------------------------------------------------------- spec registration
  app.post('/api/missions/:missionId/mission-spec', async (request, reply) => {
    const g = guard(request, reply, 'operate');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const missionId = (request.params as { missionId: string }).missionId;
    const body = (request.body ?? {}) as { spec?: unknown };
    if (typeof body.spec !== 'object' || body.spec === null) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_INPUT', message: 'spec object is required' } });
    }
    try {
      ledger.organizations.getMission(g.actor.orgId, missionId);
    } catch {
      return reply.code(404).send({ error: { code: 'NOT_FOUND_OR_UNAVAILABLE' } });
    }
    try {
      // Re-stamp identity SERVER-SIDE: the caller can never bind a spec to
      // another org/mission regardless of what the body claims.
      const candidate = validateMissionSpec({
        ...(body.spec as Record<string, unknown>),
        identity: {
          ...(body.spec as { identity?: Record<string, unknown> }).identity,
          orgId: g.actor.orgId,
          missionId,
        },
      });
      const registration = registerMissionSpec(ledger, candidate);
      return {
        missionId,
        specId: registration.spec.specId,
        digest: registration.digest.slice(0, 32),
        replayed: registration.replayed,
        industry: registration.spec.industry,
        registeredBy: g.actor.id,
        authorization:
          'READ-BACK of journaled configuration — authority lives only in ledger mandates',
      };
    } catch (error) {
      if (error instanceof MissionSpecError) {
        return reply.code(400).send({
          error: { code: error.code, message: error.message },
        });
      }
      if (
        isLedgerError(error) &&
        (error.code === 'CROSS_ORG_ACCESS' || error.code === 'MISSION_NOT_FOUND')
      ) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND_OR_UNAVAILABLE' } });
      }
      request.log.error({ err: error }, 'mission spec registration failed');
      return reply.code(409).send({ error: { code: 'SPEC_REGISTRATION_REJECTED' } });
    }
  });

  // ------------------------------------------------------ source credential issuance
  app.post('/api/missions/:missionId/sources/:sourceId/secret', async (request, reply) => {
    const g = guard(request, reply, 'operate');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const { missionId, sourceId } = request.params as {
      missionId: string;
      sourceId: string;
    };
    const body = (request.body ?? {}) as {
      keyId?: unknown;
      trustedForRecovery?: unknown;
    };
    if (typeof sourceId !== 'string' || !SOURCE_ID_RE.test(sourceId)) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'sourceId must be kebab/host-case (3-64 chars)' },
      });
    }
    if (typeof body.keyId !== 'string' || !KEY_ID_RE.test(body.keyId)) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'keyId must be a 3-64 char identifier' },
      });
    }
    try {
      ledger.organizations.getMission(g.actor.orgId, missionId);
    } catch {
      return reply.code(404).send({ error: { code: 'NOT_FOUND_OR_UNAVAILABLE' } });
    }
    try {
      // The mission's REGISTERED spec is the trust configuration: the source
      // must be declared there (sourceId, type, assets, recovery flag,
      // provenance) before a credential can exist. A source absent from the
      // spec is never provisionable.
      const { spec } = resolveMissionSpec(ledger, g.actor.orgId, missionId);
      const declared = spec.sources.find((s) => s.sourceId === sourceId);
      if (declared === undefined) {
        return reply.code(409).send({
          error: {
            code: 'SOURCE_NOT_IN_SPEC',
            message: `source ${sourceId} is not declared in the mission specification; register the spec first`,
          },
        });
      }
      const trustedForRecovery = body.trustedForRecovery === true;
      if (trustedForRecovery !== declared.trustedForRecovery) {
        return reply.code(409).send({
          error: {
            code: 'SOURCE_RECOVERY_FLAG_MISMATCH',
            message: 'the recovery flag must match the registered specification',
          },
        });
      }
      const already = new JournaledSourceRegistry(ledger, g.actor.orgId, missionId);
      if (already.findByKeyId(body.keyId) !== undefined) {
        return reply.code(409).send({ error: { code: 'KEY_ID_ALREADY_REGISTERED' } });
      }
      // CSPRNG secret, server-generated: the browser receives it ONCE.
      const secretKey = randomBytes(32).toString('base64url');
      const payload = {
        sourceId,
        sourceType: declared.sourceType,
        keyId: body.keyId,
        secretKey,
        assetIds: [...declared.assetIds],
        trustedForRecovery: declared.trustedForRecovery,
        provenance: declared.provenance,
        issuedBy: g.actor.id,
        issuedAt: ledger.clock.iso(),
      };
      try {
        ledger.evidence.append({
          orgId: g.actor.orgId,
          missionId,
          topic: 'operational',
          type: SOURCE_SECRET_TYPE,
          eventKey: `mission-source:v1:${missionId}:${sourceId}:${body.keyId}`,
          payload: payload as unknown as Record<string, unknown>,
        });
      } catch (error) {
        if (isLedgerError(error) && error.code === 'DUPLICATE_EVENT') {
          // Re-issuance for the SAME (source, keyId) is refused — rotation
          // means a NEW keyId; the old secret is never re-displayed.
          return reply.code(409).send({ error: { code: 'KEY_ID_ALREADY_REGISTERED' } });
        }
        throw error;
      }
      return {
        missionId,
        sourceId,
        keyId: body.keyId,
        assetIds: payload.assetIds,
        trustedForRecovery: payload.trustedForRecovery,
        provenance: payload.provenance,
        // ONE-TIME DISPLAY: this is the only response that ever contains the
        // secret. Store it in your integration's secret custody now.
        secret: secretKey,
        signing: 'HMAC-SHA256 over canonicalJson(event) — see mission-events contract v1',
        warning:
          'This secret grants NO financial authority: it authenticates operational observations only.',
      };
    } catch (error) {
      request.log.error({ err: error }, 'source credential issuance failed');
      return reply.code(409).send({ error: { code: 'SOURCE_REGISTRATION_REJECTED' } });
    }
  });

  // ------------------------------------------------------ production ingestion
  app.post('/api/missions/:missionId/events', async (request, reply) => {
    const g = guard(request, reply, 'operate');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const missionId = (request.params as { missionId: string }).missionId;
    const body = (request.body ?? {}) as { events?: unknown };
    const rawEvents = Array.isArray(body.events) ? body.events : [body.events];
    if (rawEvents.length === 0 || rawEvents.length > MAX_INGEST_ENVELOPES) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_INPUT',
          message: `1-${String(MAX_INGEST_ENVELOPES)} events required`,
        },
      });
    }
    try {
      ledger.organizations.getMission(g.actor.orgId, missionId);
    } catch {
      return reply.code(404).send({ error: { code: 'NOT_FOUND_OR_UNAVAILABLE' } });
    }
    const service = productionServiceFor(ledger, g.actor.orgId, missionId);
    const outcomes: unknown[] = [];
    let anyAccepted = false;
    let anyRejected = false;
    for (const raw of rawEvents) {
      try {
        // HMAC verification happens INSIDE service.ingest against the
        // journaled credential — an envelope without a valid signature over
        // its canonical form is refused regardless of session strength.
        const outcome = service.ingest(g.actor.orgId, raw);
        outcomes.push(outcome);
        if (outcome.status === 'accepted') anyAccepted = true;
        else anyRejected = true;
      } catch (error) {
        // Typed ingest errors (signature, tenancy, ordering, staleness,
        // vocabulary) surface their REAL machine codes; only schema-level
        // throws map to INVALID_ENVELOPE.
        if (error instanceof MissionEventError) {
          outcomes.push({
            status: 'rejected',
            eventId: null,
            code: error.code,
            message: error.message,
          });
        } else {
          outcomes.push({
            status: 'rejected',
            eventId: null,
            code: 'INVALID_ENVELOPE',
            message: error instanceof Error ? error.message : 'malformed event',
          });
        }
        anyRejected = true;
      }
    }
    return {
      missionId,
      outcomes,
      admitted: anyAccepted,
      refused: anyRejected,
      note: 'Admission requires a registered source credential (HMAC over the canonical event). Events authenticate SOURCES, never browsers; a session alone authorizes nothing.',
    };
  });

  // ------------------------------------------------- generalized evaluation
  app.post('/api/missions/:missionId/operations/evaluate', async (request, reply) => {
    const g = guard(request, reply, 'operate');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const missionId = (request.params as { missionId: string }).missionId;
    const body = (request.body ?? {}) as { stage?: unknown };
    const stage = body.stage === 'incident' ? 'incident' : 'baseline';
    try {
      ledger.organizations.getMission(g.actor.orgId, missionId);
    } catch {
      return reply.code(404).send({ error: { code: 'NOT_FOUND_OR_UNAVAILABLE' } });
    }
    try {
      const { snapshot, replayed } = recordProductionSnapshot(
        ledger,
        g.actor.orgId,
        missionId,
        stage,
      );
      const payload = snapshot.payload as Record<string, unknown>;
      return {
        missionId,
        replayed,
        snapshot: {
          evaluationId: payload.evaluationId,
          caseId: payload.caseId,
          stage: payload.stage,
          recordedAt: payload.recordedAt,
          spec: payload.spec,
          causality: payload.causality,
          decision: payload.decision,
          linkage: payload.linkage,
          // Per-candidate score summary (feasibility + typed rejection code)
          // — the operator sees WHY each option was refused, not just the
          // winner. Amounts come from the journaled payload only.
          candidates: payload.candidates,
          acceptedEvents: payload.acceptedEvents,
          withheldEventIds: payload.withheldEventIds,
        },
        authorization:
          'PROPOSED_ONLY — approval, reservation and provider settlement are separate authority gates',
        providerVerified: false,
      };
    } catch (error) {
      if (
        isLedgerError(error) &&
        (error.code === 'CROSS_ORG_ACCESS' || error.code === 'MISSION_NOT_FOUND')
      ) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND_OR_UNAVAILABLE' } });
      }
      if (error instanceof Error && STAGE_ERRORS.has(error.message)) {
        return reply.code(409).send({ error: { code: error.message } });
      }
      request.log.error({ err: error }, 'production evaluation failed');
      return reply.code(409).send({ error: { code: 'EVALUATION_REJECTED' } });
    }
  });

  // ------------------------------------------------- bounded model assistance (production)
  app.post('/api/missions/:missionId/model-interpretation', async (request, reply) => {
    const g = guard(request, reply, 'operate');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const missionId = (request.params as { missionId: string }).missionId;
    const body = (request.body ?? {}) as { report?: unknown };
    const report = body.report;
    if (typeof report !== 'string' || report.trim() === '' || report.length > 4000) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_INPUT', message: 'report must be a 1-4000 char string' } });
    }
    try {
      ledger.organizations.getMission(g.actor.orgId, missionId);
      const { spec } = resolveMissionSpec(ledger, g.actor.orgId, missionId);
      let config: ModelAdapterConfig;
      try {
        const resolved = modelAdapterConfigFromEnv();
        if (resolved === null) {
          // Honest optional-provider contract: POLICY-ONLY fixture fallback.
          return reply.code(503).send({
            error: {
              code: 'MODEL_NOT_CONFIGURED',
              message:
                'no model provider is configured (MOTERVA_MODEL_* env); the deterministic POLICY-ONLY engine remains fully operational — this is the labeled fixture fallback, not a live inference claim',
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
      // The journaled, validated interpretation feeds the NEXT evaluation
      // automatically (evaluateMission reads journaled interpretations);
      // nothing here grants authority of any kind.
      const timeline = productionServiceFor(ledger, g.actor.orgId, missionId).replay(
        g.actor.orgId,
        missionId,
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
        admittedEvidence: timeline.events.length,
        authorization:
          'PROPOSED_ONLY — model text never sets mandates, approvals, clearance or amounts',
      };
    } catch (error) {
      request.log.error({ err: error }, 'model interpretation failed');
      return reply.code(409).send({ error: { code: 'MODEL_INTERPRETATION_REJECTED' } });
    }
  });

  // ------------------------------------------------- production decision read
  app.get('/api/missions/:missionId/operations/decision', async (request, reply) => {
    const g = guard(request, reply, 'read');
    if ('blocked' in g) return reply;
    const missionId = (request.params as { missionId: string }).missionId;
    try {
      ledger.organizations.getMission(g.actor.orgId, missionId);
    } catch {
      return reply.code(404).send({ error: { code: 'NOT_FOUND_OR_UNAVAILABLE' } });
    }
    try {
      const timeline = productionServiceFor(ledger, g.actor.orgId, missionId).replay(
        g.actor.orgId,
        missionId,
      );
      const view = decisionViewFor(ledger, timeline);
      return {
        missionId,
        eventCount: timeline.events.length,
        stage: stageOf(timeline),
        decision: view,
        mode: 'SIMULATED_OPERATION — POLICY-ONLY',
        authorization: 'PROPOSED_ONLY — the physical source does not control banking authority',
        providerVerified: false,
      };
    } catch (error) {
      request.log.error({ err: error }, 'production decision read failed');
      return reply.code(409).send({ error: { code: 'DECISION_READ_REJECTED' } });
    }
  });
}

const STAGE_ERRORS = new Set([
  'NO_PHYSICAL_EVENT_ADMITTED',
  'INCIDENT_PHYSICAL_EVENT_REQUIRED',
  'BASELINE_SNAPSHOT_BEFORE_INCIDENT_REQUIRED',
  'BASELINE_WINDOW_CLOSED',
]);

/** The journal-derived stage label for a timeline (no demo event ids). */
function stageOf(timeline: MissionTimelineView): 'empty' | 'baseline' | 'incident' {
  if (timeline.events.length === 0) return 'empty';
  return timeline.events.length === 1 ? 'baseline' : 'incident';
}

/**
 * GENERALIZED durable snapshot for ANY registered mission — stage events
 * derive from THE JOURNAL (first admitted event = baseline; latest = the
 * incident), never from demo event-id knowledge. The accepted snapshot
 * machinery (evaluateMission, intent-keyed idempotency, baseline linkage,
 * digest-verified journaling) is reused unchanged via
 * `recordGeneralizedSnapshot`.
 */
export function recordProductionSnapshot(
  ledger: Ledger,
  orgId: string,
  missionId: string,
  stage: 'baseline' | 'incident',
): { snapshot: ReturnType<typeof recordGeneralizedSnapshot>['snapshot']; replayed: boolean } {
  const service = snapshotServiceFor(ledger, orgId, missionId);
  const timeline = service.replay(orgId, missionId);
  const ordered = [...timeline.events].sort((a, b) => a.journalSeq - b.journalSeq);
  if (ordered.length === 0) {
    throw new Error('NO_PHYSICAL_EVENT_ADMITTED');
  }
  if (stage === 'baseline') {
    if (ordered.length > 1) {
      // The baseline window is the FIRST event only; after further evidence
      // exists, never re-describe the post-evidence world as baseline.
      const prior = loadSnapshots(ledger, orgId, missionId).find(
        (s) => s.payload.stage === 'baseline',
      );
      if (prior !== undefined) return { snapshot: prior, replayed: true };
      throw new Error('BASELINE_WINDOW_CLOSED');
    }
    return recordGeneralizedSnapshot(
      ledger,
      orgId,
      missionId,
      'baseline',
      { ...timeline, events: [ordered[0]!] },
      productionServiceFor,
    );
  }
  // Incident: ALL evidence up to and including the latest event.
  if (ordered.length < 2) {
    throw new Error('INCIDENT_PHYSICAL_EVENT_REQUIRED');
  }
  return recordGeneralizedSnapshot(
    ledger,
    orgId,
    missionId,
    'incident',
    timeline,
    productionServiceFor,
  );
}
