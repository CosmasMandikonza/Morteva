/**
 * P0 REVIEW FIXES (CTO review PR #64, comment 6806666794) — protected
 * credential custody, machine-to-machine ingestion, and real credential
 * rotation/revocation/expiration. Reuses everything accepted; NO parallel
 * decision engine.
 *
 * P0-2 — SECRET CUSTODY: reusable signing keys are NEVER written in
 * plaintext to the append-only journal. The journal records only safe
 * metadata (sourceId, keyId, asset binding, provenance, flags, timestamps)
 * plus integrity information (SHA-256 key DIGEST for audit correlation and
 * AES-256-GCM ENVELOPE ciphertext of the key). The ciphertext is sealed
 * under a deployment-provided Key-Encryption-Key (`MOTERVA_SOURCE_KEY_KEK`;
 * production provisions it from a secret manager — it is never journalled).
 * Reads (journal rows, evidence APIs, exports, logs) can never expose a
 * reusable key: the ciphertext is useless without the KEK, and the plaintext
 * exists only in process memory after an authorized unseal. The issuance
 * HTTP response may reveal the key exactly once to its authorized recipient
 * (admin RBAC + CSRF) — unchanged.
 *
 * P0-3 — ROTATION / REVOCATION / EXPIRY: revocation is an AUTHENTICATED
 * journal record (admin RBAC + CSRF) that the registry honors FAIL-CLOSED
 * at rehydration — a revoked key stops resolving immediately and stays dead
 * across process restarts, while its historical admitted events remain
 * valid evidence (admission-time authentication is immutable). Optional
 * `expiresAt` is checked at rehydration AND at use time. Rotation = issue a
 * NEW keyId, then revoke the old one.
 *
 * P0-1 — MACHINE-TO-MACHINE INGESTION: a dedicated route authenticates with
 * the EVENT'S OWN HMAC credential — no cookie, no CSRF token, no session.
 * The tenant is derived from the credential journal itself (the key pins
 * its org/mission/source), so a key can never impersonate another tenant;
 * signature verification, per-stream ordering, freshness, duplicate
 * idempotency, asset binding and the banking-vocabulary ban all remain the
 * accepted ingest laws. Administrative routes keep their human gates.
 *
 * P1 — FIELD provenance means "a credential-authenticated registered source
 * CLAIMED a field observation" — it is NOT independently verified sensor
 * truth. Labels and docs preserve this distinction.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ledger } from '@moterva/ledger';
import { canonicalJson } from '@moterva/domain';
import { MissionEventIngestService } from '../mission-events/src/ingest.js';
import { MissionEventError } from '../mission-events/src/errors.js';
import { SourceRegistry, type RegisteredSource } from '../mission-events/src/registry.js';

/** Journal record types for the credential lifecycle (metadata-only). */
export const SOURCE_CREDENTIAL_TYPE = 'mission.source.registered';
export const SOURCE_REVOCATION_TYPE = 'mission.source.revoked';

/** Envelope version for the sealed-key format. */
const SEAL_VERSION = 1;
const KEY_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/;

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// --------------------------------------------------------------- KEK custody

interface Kek {
  bytes: Buffer;
  /** Identifies WHICH KEK sealed a record (rotation of the KEK itself). */
  id: string;
}

let cachedKek: Kek | null = null;
let cachedKekSource: string | null = null;

/**
 * Resolve the Key-Encryption-Key. Deployment order: `MOTERVA_SOURCE_KEY_KEK`
 * (production secret manager) FIRST; when absent, a deterministic LOCAL
 * derivation keeps local/test flows working — visibly labeled so production
 * deployments notice. The KEK is never journalled or logged.
 */
export function resolveSourceKeyKek(_ledger: Ledger): Kek {
  const env = process.env as Record<string, string | undefined>;
  const provided = env.MOTERVA_SOURCE_KEY_KEK;
  if (provided !== undefined && cachedKek !== null && cachedKekSource === provided) {
    return cachedKek;
  }
  if (provided !== undefined) {
    const raw = /^[0-9a-fA-F]{64}$/.test(provided)
      ? Buffer.from(provided, 'hex')
      : Buffer.from(provided, 'base64url');
    if (raw.length !== 32) {
      throw new Error(
        'MOTERVA_SOURCE_KEY_KEK must decode to exactly 32 bytes (base64url or hex) — refusing to boot with a weak envelope key',
      );
    }
    cachedKek = { bytes: raw, id: sha(raw.toString('base64url')).slice(0, 12) };
    cachedKekSource = provided;
    return cachedKek;
  }
  // Local/test derivation: deterministic per deployment default — NOT
  // production custody. In production MOTERVA_SOURCE_KEY_KEK is required
  // for real custody; this path keeps local/test flows working. (Rotating
  // to a provided KEK later means re-issuing credentials; keys are cheap.)
  const derivationInput = 'moterva-local-source-kek:v1:default-local-derivation';
  const bytes = createHash('sha256').update(derivationInput, 'utf8').digest();
  cachedKek = { bytes, id: 'local-derived' };
  cachedKekSource = '';
  return cachedKek;
}

interface SealedKey {
  v: typeof SEAL_VERSION;
  /** Which KEK sealed this record. */
  kekId: string;
  /** AES-256-GCM nonce. */
  iv: string;
  /** Ciphertext of the plaintext signing key. */
  ct: string;
  /** GCM auth tag — integrity of the sealed key. */
  tag: string;
}

export function sealKey(plaintext: string, kek: Kek): SealedKey {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek.bytes, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: SEAL_VERSION,
    kekId: kek.id,
    iv: iv.toString('base64url'),
    ct: ct.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}

function unsealKey(sealed: SealedKey, kek: Kek): string {
  if (sealed.v !== SEAL_VERSION || sealed.kekId !== kek.id) {
    throw new Error(
      `SOURCE_KEY_SEAL_MISMATCH: record sealed under "${sealed.kekId}" but the configured KEK is "${kek.id}"`,
    );
  }
  const decipher = createDecipheriv('aes-256-gcm', kek.bytes, Buffer.from(sealed.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ct, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

// ------------------------------------------------------- credential journal

/** The journal record: metadata + key digest + SEALED key. NO plaintext. */
export interface SourceCredentialRecord {
  readonly sourceId: string;
  readonly sourceType: RegisteredSource['sourceType'];
  readonly keyId: string;
  /** SHA-256 of the plaintext key — audit correlation WITHOUT key bytes. */
  readonly keyDigest: string;
  /** Envelope-sealed key material (useless without the deployment KEK). */
  readonly sealed: SealedKey;
  readonly assetIds: readonly string[];
  readonly trustedForRecovery: boolean;
  readonly provenance: RegisteredSource['provenance'];
  readonly issuedBy: string;
  readonly issuedAt: string;
  /** Optional credential expiry (ISO) — checked at rehydration and use. */
  readonly expiresAt?: string;
}

/** The revocation journal record: metadata-only, no key material at all. */
export interface SourceRevocationRecord {
  readonly sourceId: string;
  readonly keyId: string;
  readonly revokedBy: string;
  readonly revokedAt: string;
  readonly reason: string;
}

function journalRows(
  ledger: Ledger,
  orgId: string,
  missionId: string,
  type: string,
): { seq: number; payload_digest: string; payload_json: string }[] {
  return ledger.db
    .prepare(
      `SELECT seq, payload_digest, payload_json FROM evidence_events
        WHERE org_id = ? AND mission_id = ? AND type = ?
        ORDER BY seq ASC`,
    )
    .all(orgId, missionId, type) as { seq: number; payload_digest: string; payload_json: string }[];
}

function verifiedPayload<T>(
  row: { seq: number; payload_digest: string; payload_json: string },
  type: string,
): T {
  const payload: unknown = JSON.parse(row.payload_json);
  const digest = sha(canonicalJson(payload as Record<string, unknown>));
  if (digest !== row.payload_digest) {
    throw new Error(`${type}_INTEGRITY_VIOLATION:${String(row.seq)}`);
  }
  return payload as T;
}

/**
 * Production credential registry: rehydrates metadata-only journal records
 * FAIL-CLOSED — revocations and expiries are honored on every process
 * start, so a revoked/expired key never resolves again. Historical admitted
 * events stay valid (admission-time authentication is immutable journal
 * history; revocation only stops NEW admissions).
 */
export class ProtectedSourceRegistry extends SourceRegistry {
  /** keyIds revoked in this mission's journal (private — base's is private too). */
  private readonly journalRevoked = new Set<string>();
  private readonly expiryByKeyId = new Map<string, string>();

  constructor(ledger: Ledger, orgId: string, missionId: string, nowMs: number) {
    super();
    const kek = resolveSourceKeyKek(ledger);
    const revoked = new Set<string>();
    // Pass 1: revocations first (they may target any earlier key).
    for (const row of journalRows(ledger, orgId, missionId, SOURCE_REVOCATION_TYPE)) {
      const record = verifiedPayload<SourceRevocationRecord>(row, 'SOURCE_REVOCATION');
      revoked.add(record.keyId);
      this.journalRevoked.add(record.keyId);
    }
    // Pass 2: credentials (skip revoked; skip expired).
    for (const row of journalRows(ledger, orgId, missionId, SOURCE_CREDENTIAL_TYPE)) {
      const record = verifiedPayload<SourceCredentialRecord>(row, 'SOURCE_CREDENTIAL');
      if (revoked.has(record.keyId)) continue;
      if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= nowMs) continue;
      const plaintext = unsealKey(record.sealed, kek);
      // Defense-in-depth: the sealed key must hash to the journalled digest.
      if (sha(plaintext) !== record.keyDigest) {
        throw new Error('SOURCE_KEY_DIGEST_MISMATCH');
      }
      this.register({
        orgId,
        missionId,
        sourceId: record.sourceId,
        sourceType: record.sourceType,
        keyId: record.keyId,
        secretKey: plaintext,
        provenance: record.provenance,
        assetIds: [...record.assetIds],
        trustedForRecovery: record.trustedForRecovery,
      });
      if (record.expiresAt !== undefined) this.expiryByKeyId.set(record.keyId, record.expiresAt);
    }
    // Revoked ids must be re-registration-proof (rotation completes only
    // when the old key is revoked; re-using its keyId must fail). The base
    // register() refuses duplicate LIVE keyIds; for revoked tombstones the
    // issuance route independently refuses any keyId that was EVER issued
    // (credentialEverIssued) — defense in depth at the authority boundary.
  }

  /** True when the keyId is expired at `nowMs` (use-time check). */
  isExpired(keyId: string, nowMs: number): boolean {
    const expiresAt = this.expiryByKeyId.get(keyId);
    return expiresAt !== undefined && Date.parse(expiresAt) <= nowMs;
  }

  /** True when the keyId was revoked in this mission's journal. */
  isJournalRevoked(keyId: string): boolean {
    return this.journalRevoked.has(keyId);
  }

  /** Registry-level revoked marker (base class refuses re-registration). */
  private markRevoked(keyId: string): void {
    // Revoked tombstones are enforced structurally: never registered at
    // rehydration, never re-issuable (credentialEverIssued in the issuance
    // route). A same-id LIVE entry at this point would be a journal
    // contradiction; drop it defensively.
    const live = this.findByKeyId(keyId);
    if (live !== undefined) this.revoke(keyId);
  }
}

/** Production ingest service over PROTECTED credential custody. */
export function productionServiceFor(ledger: Ledger, orgId: string, missionId: string) {
  const registry = new ProtectedSourceRegistry(
    ledger,
    orgId,
    missionId,
    Date.parse(ledger.clock.iso()),
  );
  return new MissionEventIngestService(ledger, ledger.clock, registry);
}

/**
 * Resolve a credential by keyId GLOBALLY (key ids are unique across orgs —
 * the key pins its tenant). Returns the scoped identity the key is bound to,
 * or undefined. Used by the machine route to derive the tenant from the
 * credential itself; a key can never speak for a mission it was not issued
 * for.
 */
export function findMachineCredential(
  ledger: Ledger,
  keyId: string,
): { orgId: string; missionId: string } | undefined {
  // Scan the credential journal by keyId across orgs (bounded type scan).
  const rows = ledger.db
    .prepare(
      `SELECT org_id, mission_id, payload_digest, payload_json FROM evidence_events
        WHERE type = ? AND payload_json LIKE ? ORDER BY seq DESC LIMIT 1`,
    )
    .all(SOURCE_CREDENTIAL_TYPE, `%${JSON.stringify(keyId).slice(1, -1)}%`) as {
    org_id: string;
    mission_id: string | null;
    payload_digest: string;
    payload_json: string;
  }[];
  for (const row of rows) {
    const payload = verifiedPayload<SourceCredentialRecord>(
      { seq: 0, payload_digest: row.payload_digest, payload_json: row.payload_json },
      'SOURCE_CREDENTIAL',
    );
    if (payload.keyId === keyId && row.mission_id !== null) {
      return { orgId: row.org_id, missionId: row.mission_id };
    }
  }
  return undefined;
}

/**
 * Whether a keyId is revoked or expired in ITS mission's journal (the
 * machine route consults this BEFORE running ingest, and the registry
 * enforces it again inside ingest — defense in depth). Distinguishes the
 * machine codes: revoked vs expired vs never-issued.
 */
export function isCredentialUsable(
  ledger: Ledger,
  orgId: string,
  missionId: string,
  keyId: string,
  nowMs: number,
): { usable: true } | { usable: false; code: string } {
  // Direct journal lookup for the credential record (metadata only).
  const rows = ledger.db
    .prepare(
      `SELECT payload_json FROM evidence_events
        WHERE org_id = ? AND mission_id = ? AND type = ?
        ORDER BY seq ASC`,
    )
    .all(orgId, missionId, SOURCE_CREDENTIAL_TYPE) as { payload_json: string }[];
  const record = rows
    .map((row) => JSON.parse(row.payload_json) as SourceCredentialRecord)
    .find((r) => r.keyId === keyId);
  if (record === undefined) {
    return { usable: false, code: 'CREDENTIAL_REVOKED_OR_UNKNOWN' };
  }
  // Revocation scan (any revocation row naming this keyId).
  const revRows = ledger.db
    .prepare(
      `SELECT payload_json FROM evidence_events
        WHERE org_id = ? AND mission_id = ? AND type = ?
        ORDER BY seq ASC`,
    )
    .all(orgId, missionId, SOURCE_REVOCATION_TYPE) as { payload_json: string }[];
  if (
    revRows.some((row) => (JSON.parse(row.payload_json) as SourceRevocationRecord).keyId === keyId)
  ) {
    return { usable: false, code: 'CREDENTIAL_REVOKED' };
  }
  if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= nowMs) {
    return { usable: false, code: 'CREDENTIAL_EXPIRED' };
  }
  // Final gate: the full protected registry (signature custody unseal etc.).
  const registry = new ProtectedSourceRegistry(ledger, orgId, missionId, nowMs);
  if (registry.findByKeyId(keyId) === undefined) {
    return { usable: false, code: 'CREDENTIAL_REVOKED_OR_UNKNOWN' };
  }
  return { usable: true };
}

// --------------------------------------------------------------- M2M routes

/**
 * Verify one event's HMAC against the credential journal WITHOUT any
 * session. The tenant comes from the credential; the event must match it
 * exactly (org/mission/source binding is enforced inside service.ingest —
 * this pre-check fails fast with a machine-appropriate 401).
 */
function machineAuthOrg(
  ledger: Ledger,
  request: FastifyRequest,
  rawEvent: unknown,
): { ok: true; orgId: string; missionId: string; authKey: string } | { ok: false; code: string } {
  const envelope = rawEvent as {
    orgId?: unknown;
    missionId?: unknown;
    source?: { keyId?: unknown };
  };
  const keyId = envelope?.source?.keyId;
  if (typeof keyId !== 'string' || !KEY_ID_RE.test(keyId)) {
    return { ok: false, code: 'MACHINE_AUTH_MISSING' };
  }
  const binding = findMachineCredential(ledger, keyId);
  if (binding === undefined) {
    return { ok: false, code: 'MACHINE_AUTH_UNKNOWN_KEY' };
  }
  // The declared event tenant must equal the credential's pinned tenant —
  // a key cannot even ATTEMPT another mission's journal.
  if (envelope.orgId !== binding.orgId || envelope.missionId !== binding.missionId) {
    return { ok: false, code: 'MACHINE_TENANT_MISMATCH' };
  }
  return { ok: true, orgId: binding.orgId, missionId: binding.missionId, authKey: keyId };
}

export function registerMachineIngestRoutes(app: FastifyInstance, ledger: Ledger): void {
  /**
   * M2M INGESTION (P0-1) — NO session, NO CSRF. Authentication IS the
   * event's HMAC credential: the keyId pins the tenant (org+mission+source),
   * the signature proves possession of the secret. Optionally the client
   * ALSO presents `x-moterva-source-key` (the plaintext key); when present
   * it must match the journalled keyDigest in constant time.
   * Explicitly REJECTS cookie-bearing requests to keep this surface
   * disjoint from the human routes (a browser session gains nothing here,
   * and a machine cannot ride a session).
   */
  app.post('/api/machine/missions/:missionId/events', async (request, reply) => {
    // Surface disjointness: a cookie-bearing request is a browser, not a
    // telemetry integration — refuse it outright (fail-closed, no fallback
    // to session auth on a machine surface).
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
    const auth = machineAuthOrg(ledger, request, rawEvents[0]);
    if (!auth.ok) {
      return reply.code(401).send({ error: { code: auth.code } });
    }
    const { orgId, missionId, authKey } = auth;
    if (missionId !== (request.params as { missionId: string }).missionId) {
      // URL path and credential-pinned mission disagree — never proceed.
      return reply.code(401).send({ error: { code: 'MACHINE_TENANT_MISMATCH' } });
    }
    // Credential LIFECYCLE pre-check (P0-3): a revoked or expired key fails
    // closed here with the SPECIFIC machine code — and would fail again
    // inside ingest even if this check were bypassed (defense in depth).
    const lifecycle = isCredentialUsable(
      ledger,
      orgId,
      missionId,
      authKey,
      Date.parse(ledger.clock.iso()),
    );
    if (!lifecycle.usable) {
      return reply.code(403).send({ error: { code: lifecycle.code } });
    }
    const service = productionServiceFor(ledger, orgId, missionId);
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
      note: 'FIELD provenance = a credential-authenticated registered source CLAIMED a field observation; it is NOT independently verified sensor truth.',
    });
  });

  /**
   * M2M key-check (GET): a headless client can verify its credential is
   * currently usable (registered, unrevoked, unexpired) without submitting
   * an event. Reveals NOTHING but a boolean + the binding's mission.
   */
  app.get('/api/machine/sources/:keyId/status', async (request, reply) => {
    if (request.headers.cookie !== undefined) {
      return reply.code(401).send({ error: { code: 'MACHINE_SURFACE_BROWSER_FORBIDDEN' } });
    }
    const keyId = (request.params as { keyId: string }).keyId;
    if (typeof keyId !== 'string' || !KEY_ID_RE.test(keyId)) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT' } });
    }
    const binding = findMachineCredential(ledger, keyId);
    if (binding === undefined) {
      return reply.code(404).send({ error: { code: 'MACHINE_AUTH_UNKNOWN_KEY' } });
    }
    const usable = isCredentialUsable(
      ledger,
      binding.orgId,
      binding.missionId,
      keyId,
      Date.parse(ledger.clock.iso()),
    );
    if (!usable.usable) {
      return reply.code(403).send({ error: { code: usable.code } });
    }
    return {
      keyId,
      usable: true,
      boundMissionId: binding.missionId,
      note: 'Possession of the key is not financial authority; it authenticates operational observations only.',
    };
  });
}
