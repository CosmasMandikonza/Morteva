/**
 * MACHINE-TO-MACHINE INGESTION over protected credential custody — the ingest
 * registry and the two machine routes (CTO reviews PR #64: comment 6806666794
 * P0-1/2/3 and comment 6808560477 P1 keyId ambiguity + key enumeration).
 * Reuses everything accepted; NO parallel decision engine.
 *
 * AUTHENTICATION IS POSSESSION. A telemetry integration holds one thing: the
 * HMAC key it was issued. No cookie, no CSRF token, no session. The tenant is
 * NOT taken from a global keyId lookup (that was the ambiguity defect: a
 * credential has no global identity). It is derived from the mission row the
 * URL names, the event's declared tenant must equal it, and the credential is
 * resolved INSIDE that (org, mission) scope by exact indexed read — so two
 * tenants may use identically named keys without interfering, nothing can
 * shadow another tenant's credential, and a key can only ever speak for the
 * mission it was issued for (the signed event covers orgId, missionId, sourceId
 * and keyId, so a captured event cannot be re-targeted).
 *
 * NO ORACLE BEFORE PROOF. Credential lifecycle (`revoked` / `expired`) is
 * released only to a caller that proves possession of that credential's key by
 * a valid signature. Anyone else — unknown key, wrong tenant, forged
 * signature — falls through to the accepted ingest laws exactly like an
 * unknown key. The credential-status check requires a signed possession proof
 * and answers every failure identically.
 *
 * P0-2 custody and P0-3 lifecycle (sealed keys, revocation, expiry, rotation)
 * live in `source-key-custody.ts` / `source-credential-store.ts`; this module
 * only consumes them, FAIL-CLOSED: revoked, expired and un-openable
 * (quarantined) credentials are never registered with the ingest service.
 *
 * P1 — FIELD provenance means "a credential-authenticated registered source
 * CLAIMED a field observation" — it is NOT independently verified sensor
 * truth. Labels and docs preserve this distinction.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ledger } from '@moterva/ledger';
import { canonicalJson } from '@moterva/domain';
import { MissionEventIngestService } from '../mission-events/src/ingest.js';
import { MissionEventError } from '../mission-events/src/errors.js';
import { SourceRegistry } from '../mission-events/src/registry.js';
import { signatureMatches, sourceSignature } from '../mission-events/src/digest.js';
import { parseEnvelope, type NormalizedEvent } from '../mission-events/src/schema.js';
import {
  KEY_ID_RE,
  loadMissionCredentials,
  openCredentialSecret,
  type CredentialView,
} from './source-credential-store.js';
import type { KekRing } from './source-key-custody.js';

/**
 * Ingest registry over a mission's PROTECTED credentials: only `active`
 * credentials are opened and registered. Revoked, expired and quarantined
 * ones are never registered, so they stop authenticating immediately and stay
 * dead across restarts; their historical events remain valid journal evidence.
 */
export class ProtectedSourceRegistry extends SourceRegistry {
  constructor(views: readonly CredentialView[], ring: KekRing) {
    super();
    for (const view of views) {
      if (view.state !== 'active') continue;
      const secretKey = openCredentialSecret(view, ring);
      if (secretKey === null) continue;
      this.register({
        orgId: view.orgId,
        missionId: view.missionId,
        sourceId: view.record.sourceId,
        sourceType: view.record.sourceType,
        keyId: view.record.keyId,
        secretKey,
        provenance: view.record.provenance,
        assetIds: [...view.record.assetIds],
        trustedForRecovery: view.record.trustedForRecovery,
      });
    }
  }
}

/**
 * Read/replay service: the journal projection never consults the credential
 * registry (only admission does), so reads get an EMPTY registry — decision,
 * evaluation and interpretation reads never open a signing key.
 */
export function replayServiceFor(ledger: Ledger): MissionEventIngestService {
  return new MissionEventIngestService(ledger, ledger.clock, new SourceRegistry());
}

// --------------------------------------------------------------- M2M surface

/** The org a mission belongs to — server truth (`missions.id` is the primary key). */
function missionOrg(ledger: Ledger, missionId: string): string | undefined {
  const row = ledger.db.prepare('SELECT org_id FROM missions WHERE id = ?').get(missionId) as
    { org_id: string } | undefined;
  return row?.org_id;
}

interface MachineClaim {
  readonly orgId: string;
  readonly missionId: string;
  readonly sourceId: string;
  readonly keyId: string;
}

/** The (unauthenticated) identity an event CLAIMS — used only to pick the verifier scope. */
function claimOf(rawEvent: unknown): MachineClaim | undefined {
  if (typeof rawEvent !== 'object' || rawEvent === null) return undefined;
  const event = rawEvent as {
    orgId?: unknown;
    missionId?: unknown;
    source?: { sourceId?: unknown; keyId?: unknown } | null;
  };
  const sourceId = event.source?.sourceId;
  const keyId = event.source?.keyId;
  if (
    typeof event.orgId !== 'string' ||
    typeof event.missionId !== 'string' ||
    typeof sourceId !== 'string' ||
    sourceId.length > 64 ||
    typeof keyId !== 'string' ||
    !KEY_ID_RE.test(keyId)
  ) {
    return undefined;
  }
  return { orgId: event.orgId, missionId: event.missionId, sourceId, keyId };
}

/** Does this wire event carry a valid signature under `secret`? (Mirrors ingest's normalisation.) */
function eventSignatureVerifies(rawEvent: unknown, secret: string): boolean {
  try {
    const envelope = parseEnvelope(rawEvent);
    const event: NormalizedEvent = {
      contractVersion: envelope.contractVersion,
      eventId: envelope.eventId,
      sequence: envelope.sequence,
      orgId: envelope.orgId,
      missionId: envelope.missionId,
      assetId: envelope.assetId,
      observedAt: envelope.observedAt,
      ingestedAt: envelope.ingestedAt,
      source: {
        sourceId: envelope.source.sourceId,
        sourceType: envelope.source.sourceType,
        keyId: envelope.source.keyId,
        provenance: envelope.source.provenance,
      },
      observations: envelope.observations,
    };
    return signatureMatches(sourceSignature(event, secret), envelope.source.signature);
  } catch {
    return false;
  }
}

/** Open a credential's key for a possession check; custody failures mean "not proven". */
function openForProof(view: CredentialView, ring: KekRing): string | null {
  if (view.state === 'quarantined') return null;
  try {
    return openCredentialSecret(view, ring);
  } catch {
    return null;
  }
}

/** Freshness window for credential-status proofs (matches the ingest future-skew tolerance). */
const STATUS_PROOF_WINDOW_MS = 120_000;
const HEX_64_LOWER = /^[0-9a-f]{64}$/;
/** Burned when a credential does not exist, so unknown and known keys cost the same crypto. */
const DECOY_SECRET = randomBytes(32).toString('base64url');

/**
 * The signed possession proof for a credential-status check:
 * hex HMAC-SHA256 under the credential's key over
 * canonicalJson({ contractVersion: 1, purpose: 'credential-status', missionId, sourceId, keyId, issuedAt }).
 */
function statusProof(
  secret: string,
  fields: { missionId: string; sourceId: string; keyId: string; issuedAt: string },
): string {
  return createHmac('sha256', secret)
    .update(canonicalJson({ contractVersion: 1, purpose: 'credential-status', ...fields }), 'utf8')
    .digest('hex');
}

const FIELD_CLAIM_NOTE =
  'FIELD provenance = a credential-authenticated registered source CLAIMED a field observation; it is NOT independently verified sensor truth.';

export function registerMachineIngestRoutes(
  app: FastifyInstance,
  ledger: Ledger,
  ring: KekRing,
): void {
  /**
   * M2M INGESTION — NO session, NO CSRF. Authentication IS the event's HMAC
   * credential, resolved inside the mission the URL names. Explicitly REFUSES
   * cookie-bearing requests to keep this surface disjoint from the human
   * routes (a browser session gains nothing here, and a machine cannot ride a
   * session).
   */
  app.post('/api/machine/missions/:missionId/events', async (request, reply) => {
    if (request.headers.cookie !== undefined) {
      return reply.code(401).send({
        error: {
          code: 'MACHINE_SURFACE_BROWSER_FORBIDDEN',
          message:
            'this endpoint authenticates machine sources by HMAC credential only; browser sessions are refused here by design',
        },
      });
    }
    const body = (request.body ?? {}) as { events?: unknown };
    const rawEvents = Array.isArray(body.events) ? body.events : [body.events];
    if (rawEvents.length === 0 || rawEvents.length > 10) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_INPUT', message: '1-10 events required' } });
    }
    const claim = claimOf(rawEvents[0]);
    if (claim === undefined) {
      return reply.code(401).send({ error: { code: 'MACHINE_AUTH_MISSING' } });
    }
    // Tenant = the mission row the URL names (server truth). The event's
    // declared tenant must match it; a missing mission and a mismatched claim
    // are indistinguishable by design.
    const missionId = (request.params as { missionId: string }).missionId;
    const orgId = missionOrg(ledger, missionId);
    if (orgId === undefined || claim.orgId !== orgId || claim.missionId !== missionId) {
      return reply.code(401).send({ error: { code: 'MACHINE_TENANT_MISMATCH' } });
    }
    const nowMs = Date.parse(ledger.clock.iso());
    const views = loadMissionCredentials(ledger, ring, orgId, missionId, nowMs);
    // Credential LIFECYCLE (P0-3) is disclosed ONLY to a caller that proves
    // possession of that credential's key. Everyone else proceeds into the
    // accepted ingest laws, where a revoked/expired/unknown key is simply
    // unregistered — an unauthenticated probe learns nothing about key state.
    const target = views.find(
      (view) => view.record.sourceId === claim.sourceId && view.record.keyId === claim.keyId,
    );
    if (target !== undefined && (target.state === 'revoked' || target.state === 'expired')) {
      const secret = openForProof(target, ring);
      if (secret !== null && eventSignatureVerifies(rawEvents[0], secret)) {
        return reply.code(403).send({
          error: { code: target.state === 'revoked' ? 'CREDENTIAL_REVOKED' : 'CREDENTIAL_EXPIRED' },
        });
      }
    }
    const service = new MissionEventIngestService(
      ledger,
      ledger.clock,
      new ProtectedSourceRegistry(views, ring),
    );
    const outcomes: unknown[] = [];
    let anyAccepted = false;
    let anyRejected = false;
    for (const raw of rawEvents) {
      try {
        const outcome = service.ingest(orgId, raw);
        outcomes.push(outcome);
        if (outcome.status === 'accepted') anyAccepted = true;
        else anyRejected = true;
      } catch (error) {
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
    const status = anyAccepted ? 200 : anyRejected ? 422 : 200;
    return reply.code(status).send({
      missionId,
      outcomes,
      admitted: anyAccepted,
      refused: anyRejected,
      auth: 'machine-hmac',
      note: FIELD_CLAIM_NOTE,
    });
  });

  /**
   * M2M CREDENTIAL STATUS — a headless client asks "is my key still usable?"
   * Authenticated by a SIGNED POSSESSION PROOF (see `statusProof`): without
   * the key there is no answer, so the route cannot be used to enumerate keys,
   * missions or lifecycle state. EVERY failure — unknown mission/source/key,
   * quarantined credential, forged or stale proof — returns the identical 401.
   * The metadata returned to a proven possessor is its own credential's state.
   */
  app.post(
    '/api/machine/missions/:missionId/sources/:sourceId/keys/:keyId/status',
    async (request, reply) => {
      if (request.headers.cookie !== undefined) {
        return reply.code(401).send({ error: { code: 'MACHINE_SURFACE_BROWSER_FORBIDDEN' } });
      }
      const { missionId, sourceId, keyId } = request.params as {
        missionId: string;
        sourceId: string;
        keyId: string;
      };
      const body = (request.body ?? {}) as { issuedAt?: unknown; signature?: unknown };
      // Shape checks depend only on the request itself, never on server state,
      // so they leak nothing.
      if (
        typeof body.issuedAt !== 'string' ||
        body.issuedAt.length > 40 ||
        !Number.isFinite(Date.parse(body.issuedAt)) ||
        typeof body.signature !== 'string' ||
        !HEX_64_LOWER.test(body.signature) ||
        !KEY_ID_RE.test(keyId) ||
        sourceId.length > 64
      ) {
        return reply.code(400).send({
          error: {
            code: 'INVALID_INPUT',
            message:
              'a fresh ISO issuedAt and a 64-hex signature (HMAC proof of possession) are required',
          },
        });
      }
      const nowMs = Date.parse(ledger.clock.iso());
      const orgId = missionOrg(ledger, missionId);
      let view: CredentialView | undefined;
      let secret: string | null = null;
      if (orgId !== undefined) {
        view = loadMissionCredentials(ledger, ring, orgId, missionId, nowMs).find(
          (candidate) => candidate.record.sourceId === sourceId && candidate.record.keyId === keyId,
        );
        if (view !== undefined) secret = openForProof(view, ring);
      }
      // Identical work whether or not the credential exists.
      const expected = statusProof(secret ?? DECOY_SECRET, {
        missionId,
        sourceId,
        keyId,
        issuedAt: body.issuedAt,
      });
      const fresh = Math.abs(nowMs - Date.parse(body.issuedAt)) <= STATUS_PROOF_WINDOW_MS;
      const proven = signatureMatches(expected, body.signature) && secret !== null && fresh;
      if (!proven || view === undefined) {
        return reply.code(401).send({
          error: { code: 'MACHINE_AUTH_FAILED', message: 'credential proof rejected' },
        });
      }
      return reply
        .code(200)
        .header('cache-control', 'no-store')
        .send({
          missionId,
          sourceId,
          keyId,
          status: view.state,
          issuedAt: view.record.issuedAt,
          ...(view.record.expiresAt !== undefined ? { expiresAt: view.record.expiresAt } : {}),
          note: 'Possession of the key is not financial authority; it authenticates operational observations only.',
        });
    },
  );
}
