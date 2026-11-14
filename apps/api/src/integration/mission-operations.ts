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
 *    secret (32 bytes CSPRNG) and returns it EXACTLY ONCE to the managing
 *    operator (same one-time-display contract as identity API credentials;
 *    the response is `Cache-Control: no-store`). At rest the key exists ONLY
 *    as an AES-256-GCM envelope seal under the deployment KEK plus a SHA-256
 *    audit digest — never in plaintext (see source-key-custody.ts; production
 *    refuses to run without a real 32-byte KEK). Registration binds source →
 *    assets → tenant exactly like the spec declares; a credential is scoped to
 *    (org, mission, source, keyId) and has no global identity.
 *
 * 3. Event INGESTION is a machine act and is NOT on this surface: it lives at
 *    `POST /api/machine/missions/:missionId/events` (source-credentials.ts),
 *    authenticated by the event's own HMAC credential with no cookie/CSRF. The
 *    former session route here answers 410 — a session path would be a
 *    parallel, weaker authentication for the same act. Every ingest law is the
 *    accepted one: unregistered/revoked keys refused, per-stream monotonicity,
 *    duplicate idempotency, future/stale bounds, offline-recovery trust rule,
 *    banking-vocabulary ban. Ingress NEVER mutates money: zero financial rows
 *    is proven by test. Credential REVOCATION (below) stays an authenticated
 *    human act (`manageAuthority` + CSRF).
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
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ledger } from '@moterva/ledger';
import { isLedgerError } from '@moterva/ledger';
import { guard, csrfOk } from '../auth.js';
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
import {
  KEY_ID_RE,
  SOURCE_CREDENTIAL_TYPE,
  SOURCE_ID_RE,
  SOURCE_REVOCATION_TYPE,
  credentialEventKey,
  findIssuedCredential,
  isKeyRevoked,
  keyDigestOf,
  revocationEventKey,
  type SourceCredentialRecord,
  type SourceRevocationRecord,
} from './source-credential-store.js';
import { replayServiceFor } from './source-credentials.js';
import type { KekRing } from './source-key-custody.js';

// ------------------------------------------------------------------- routes

/**
 * `ring` is the KEK ring `buildApp` established (fail-closed policy + boot
 * verification) BEFORE this scope mounted; issuance seals new credentials
 * under its current KEK. Reads never open a key — the replay service carries
 * an empty registry.
 */
export function registerMissionOperationsRoutes(
  app: FastifyInstance,
  ledger: Ledger,
  ring: KekRing,
): void {
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
    // The response may carry the one-time key: never cacheable, on any outcome.
    void reply.header('cache-control', 'no-store');
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
      expiresAt?: unknown;
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
      // A keyId already issued in THIS mission — live, revoked, expired or
      // quarantined — is never re-issuable (rotation = a NEW keyId). The check
      // is scoped to this (org, mission): credentials have no global identity,
      // so other tenants' keys are neither visible here nor able to collide.
      if (findIssuedCredential(ledger, g.actor.orgId, missionId, body.keyId) !== undefined) {
        return reply.code(409).send({ error: { code: 'KEY_ID_ALREADY_REGISTERED' } });
      }
      // CSPRNG secret, server-generated: shown to the authorized recipient
      // EXACTLY ONCE. At rest it exists ONLY as an AES-256-GCM envelope
      // seal under the deployment KEK plus a SHA-256 audit digest — the
      // journal never contains plaintext key bytes (P0-2).
      const secretKey = randomBytes(32).toString('base64url');
      const payload: SourceCredentialRecord = {
        sourceId,
        sourceType: declared.sourceType,
        keyId: body.keyId,
        keyDigest: keyDigestOf(secretKey),
        sealed: ring.current.seal(secretKey),
        assetIds: [...declared.assetIds],
        trustedForRecovery: declared.trustedForRecovery,
        provenance: declared.provenance,
        issuedBy: g.actor.id,
        issuedAt: ledger.clock.iso(),
        // Optional expiry from the operator (rotation hygiene).
        ...(typeof body.expiresAt === 'string' && Number.isFinite(Date.parse(body.expiresAt))
          ? { expiresAt: body.expiresAt }
          : {}),
      };
      try {
        ledger.evidence.append({
          orgId: g.actor.orgId,
          missionId,
          topic: 'operational',
          type: SOURCE_CREDENTIAL_TYPE,
          eventKey: credentialEventKey(missionId, sourceId, body.keyId),
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
        ...(payload.expiresAt !== undefined ? { expiresAt: payload.expiresAt } : {}),
        // ONE-TIME DISPLAY: the only place the plaintext key ever appears.
        secret: secretKey,
        machineIngest: {
          endpoint: `/api/machine/missions/${missionId}/events`,
          auth: 'HMAC-SHA256 signature over canonicalJson(event); NO cookie, NO CSRF token',
          tenantBinding:
            'credentials are scoped to org+mission+source — this key authenticates only events for this mission and source',
        },
        custody:
          ring.posture === 'configured'
            ? 'sealed at rest (AES-256-GCM envelope under the deployment key-encryption key); the journal stores a digest + ciphertext only'
            : 'sealed under the PUBLIC local derivation — loopback development/test only; a production deployment refuses this posture',
        warning:
          'This secret grants NO financial authority: it authenticates operational observations only. FIELD provenance = a credential-authenticated source CLAIMED a reading, not independently verified sensor truth.',
      };
    } catch (error) {
      request.log.error({ err: error }, 'source credential issuance failed');
      return reply.code(409).send({ error: { code: 'SOURCE_REGISTRATION_REJECTED' } });
    }
  });

  // ------------------------------------------------------ credential revocation (P0-3)
  app.post(
    '/api/missions/:missionId/sources/:sourceId/keys/:keyId/revoke',
    async (request, reply) => {
      const g = guard(request, reply, 'manageAuthority');
      if ('blocked' in g) return reply;
      if (!csrfOk(ledger, request, reply)) return reply;
      const { missionId, sourceId, keyId } = request.params as {
        missionId: string;
        sourceId: string;
        keyId: string;
      };
      const body = (request.body ?? {}) as { reason?: unknown };
      const reason =
        typeof body.reason === 'string' && body.reason.trim() !== ''
          ? body.reason.slice(0, 300)
          : 'rotated-or-compromised';
      try {
        ledger.organizations.getMission(g.actor.orgId, missionId);
        // The key must have been issued in THIS mission for THIS source.
        const issued = findIssuedCredential(ledger, g.actor.orgId, missionId, keyId);
        if (issued === undefined || issued.sourceId !== sourceId) {
          return reply.code(404).send({ error: { code: 'KEY_NOT_FOUND' } });
        }
        if (isKeyRevoked(ledger, g.actor.orgId, missionId, keyId)) {
          return reply.code(409).send({ error: { code: 'KEY_ALREADY_REVOKED' } });
        }
        const payload: SourceRevocationRecord = {
          sourceId,
          keyId,
          revokedBy: g.actor.id,
          revokedAt: ledger.clock.iso(),
          reason,
        };
        try {
          ledger.evidence.append({
            orgId: g.actor.orgId,
            missionId,
            topic: 'operational',
            type: SOURCE_REVOCATION_TYPE,
            eventKey: revocationEventKey(missionId, sourceId, keyId),
            payload: payload as unknown as Record<string, unknown>,
          });
        } catch (error) {
          if (isLedgerError(error) && error.code === 'DUPLICATE_EVENT') {
            return reply.code(409).send({ error: { code: 'KEY_ALREADY_REVOKED' } });
          }
          throw error;
        }
        return {
          missionId,
          sourceId,
          keyId,
          revoked: true,
          effect:
            'the key stops authenticating NEW events immediately — including after process restart (fail-closed rehydration); already-admitted events remain valid historical evidence',
          note: 'rotation = issue a NEW keyId, then revoke the old one',
        };
      } catch (error) {
        request.log.error({ err: error }, 'source revocation failed');
        return reply.code(409).send({ error: { code: 'REVOCATION_REJECTED' } });
      }
    },
  );

  // ------------------------------------------------------ production ingestion
  // P0-1 (CTO review): ingestion is a MACHINE act — moved to
  // `/api/machine/missions/:id/events` (source-credentials.ts), authenticated
  // by the event's own HMAC credential with NO cookie/CSRF. The previous
  // session-based route here WAS the defect (P0-1) and is intentionally NOT
  // replaced by a session route: telemetry has no browser session, and a
  // session path would be a parallel, weaker auth for the same act. Operator
  // journeys that want to admit evidence do so through their registered
  // machine source (the credential is issued to the operator's integration).
  app.post('/api/missions/:missionId/events', async (_request, reply) => {
    return reply.code(410).send({
      error: {
        code: 'EVENTS_ROUTE_MOVED',
        message:
          'event ingestion moved to POST /api/machine/missions/:missionId/events — machine sources authenticate with their issued HMAC credential (no session/CSRF); administrative configuration/issuance/evaluation keep human RBAC + CSRF',
      },
    });
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
      const timeline = replayServiceFor(ledger).replay(g.actor.orgId, missionId);
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
      const timeline = replayServiceFor(ledger).replay(g.actor.orgId, missionId);
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
      replayServiceFor,
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
    replayServiceFor,
  );
}
