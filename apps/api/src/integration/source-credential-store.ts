/**
 * SOURCE-CREDENTIAL STORE — journal-backed, tenant-scoped, indexed credential
 * records and the boot-time custody verification (CTO review PR #64, comment
 * 6808560477).
 *
 * TENANT SCOPING (P1 keyId ambiguity): a credential has NO global identity.
 * It is addressed by (org, mission, source, keyId), and every read here is
 * scoped by the org (and, except for the one boot-time scan, the mission) and
 * served by the journal's `UNIQUE (org_id, event_key)` index — exact-key
 * equality or a half-open key-prefix range. There is no `LIKE`, no
 * payload-text search and no "latest match wins": a record that merely
 * CONTAINS another tenant's keyId can never shadow it, two tenants may hold
 * identically-named keys without interfering, and an unknown keyId costs one
 * indexed probe instead of a journal scan.
 *
 * LIFECYCLE: revocation, expiry and KEK availability are evaluated here, once,
 * for both the ingest registry and the machine routes, so they can never
 * disagree: `active | revoked | expired | quarantined`. `quarantined` means no
 * configured KEK can open the seal — the credential fails CLOSED (it cannot
 * authenticate) instead of taking its whole mission down.
 *
 * BOOT VERIFICATION (P0): `verifySourceKeyCustody` runs before any credential
 * route mounts. It re-seals credentials still under a PREVIOUS KEK
 * (rotation), and in production REFUSES to start when live credentials are
 * sealed under a KEK this process cannot open and the operator has not
 * explicitly acknowledged the loss — a KEK is never silently swapped under
 * existing ciphertext.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@moterva/domain';
import { isLedgerError, type Ledger } from '@moterva/ledger';
import type { RegisteredSource } from '../mission-events/src/registry.js';
import {
  SourceKeyCustodyError,
  isSealedKey,
  resolveKekRing,
  type CustodyPolicyContext,
  type KekRing,
  type SealedKey,
  type SourceKeyCustodyConfig,
} from './source-key-custody.js';

/** Journal record types for the credential lifecycle (metadata + sealed key only). */
export const SOURCE_CREDENTIAL_TYPE = 'mission.source.registered';
export const SOURCE_REVOCATION_TYPE = 'mission.source.revoked';
export const SOURCE_RESEAL_TYPE = 'mission.source.resealed';

/** Identifier shapes accepted at issuance (shared by the issuance and machine routes). */
export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
export const KEY_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/;

const CREDENTIAL_KEY_PREFIX = 'mission-source:v1:';
const REVOCATION_KEY_PREFIX = 'mission-source-revoked:v1:';
const RESEAL_KEY_PREFIX = 'mission-source-resealed:v1:';

/** Unique per (mission, source, keyId) within the org — enforced by the journal's UNIQUE index. */
export function credentialEventKey(missionId: string, sourceId: string, keyId: string): string {
  return `${CREDENTIAL_KEY_PREFIX}${missionId}:${sourceId}:${keyId}`;
}

export function revocationEventKey(missionId: string, sourceId: string, keyId: string): string {
  return `${REVOCATION_KEY_PREFIX}${missionId}:${sourceId}:${keyId}`;
}

function resealEventKey(missionId: string, sourceId: string, keyId: string, kekId: string): string {
  return `${RESEAL_KEY_PREFIX}${missionId}:${sourceId}:${keyId}:${kekId}`;
}

/** The credential journal record: metadata + key digest + SEALED key. NO plaintext. */
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

/** KEK-rotation record: the SAME key sealed under the current KEK (still no plaintext). */
export interface SourceResealRecord {
  readonly sourceId: string;
  readonly keyId: string;
  readonly keyDigest: string;
  readonly sealed: SealedKey;
  readonly previousKekId: string;
  readonly resealedAt: string;
  readonly reason: 'kek-rotation';
}

export function keyDigestOf(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

// ------------------------------------------------------------ indexed reads

interface JournalRow {
  readonly seq: number;
  readonly payload_digest: string;
  readonly payload_json: string;
}

/**
 * One mission's journal rows of one lifecycle type, via the UNIQUE
 * (org_id, event_key) index: the half-open range [prefix, prefix') where the
 * upper bound swaps the trailing ':' (0x3A) for ';' (0x3B). The org, mission
 * and type predicates stay in the query as exactness guards — the range is
 * only the access path.
 */
function missionRows(
  ledger: Ledger,
  orgId: string,
  missionId: string,
  keyPrefix: string,
  type: string,
): JournalRow[] {
  return ledger.db
    .prepare(
      `SELECT seq, payload_digest, payload_json FROM evidence_events
        WHERE org_id = ? AND event_key >= ? AND event_key < ?
          AND mission_id = ? AND type = ?
        ORDER BY seq ASC`,
    )
    .all(orgId, `${keyPrefix}${missionId}:`, `${keyPrefix}${missionId};`, missionId, type) as {
    seq: number;
    payload_digest: string;
    payload_json: string;
  }[];
}

function verifiedPayload<T>(row: JournalRow, label: string): T {
  let payload: unknown;
  let digest: string;
  try {
    payload = JSON.parse(row.payload_json);
    digest = createHash('sha256')
      .update(canonicalJson(payload as Record<string, unknown>))
      .digest('hex');
  } catch {
    digest = '';
  }
  if (digest !== row.payload_digest) {
    throw new SourceKeyCustodyError(
      'SOURCE_CREDENTIAL_INTEGRITY_VIOLATION',
      `${label} journal row ${String(row.seq)} failed its payload digest check`,
    );
  }
  return payload as T;
}

function sourceKeyIdentity(sourceId: string, keyId: string): string {
  return `${sourceId}\u0000${keyId}`;
}

/** keyIds revoked in this mission's journal (revocation is by keyId within the mission). */
export function revokedKeyIds(ledger: Ledger, orgId: string, missionId: string): Set<string> {
  const ids = new Set<string>();
  for (const row of missionRows(
    ledger,
    orgId,
    missionId,
    REVOCATION_KEY_PREFIX,
    SOURCE_REVOCATION_TYPE,
  )) {
    ids.add(verifiedPayload<SourceRevocationRecord>(row, 'SOURCE_REVOCATION').keyId);
  }
  return ids;
}

function resealsBySourceKey(
  ledger: Ledger,
  orgId: string,
  missionId: string,
): Map<string, SealedKey[]> {
  const byCredential = new Map<string, SealedKey[]>();
  for (const row of missionRows(ledger, orgId, missionId, RESEAL_KEY_PREFIX, SOURCE_RESEAL_TYPE)) {
    const record = verifiedPayload<SourceResealRecord>(row, 'SOURCE_RESEAL');
    if (!isSealedKey(record.sealed)) continue;
    const identity = sourceKeyIdentity(record.sourceId, record.keyId);
    byCredential.set(identity, [...(byCredential.get(identity) ?? []), record.sealed]);
  }
  return byCredential;
}

/** The issued credential record for a keyId in this (org, mission), live or revoked. */
export function findIssuedCredential(
  ledger: Ledger,
  orgId: string,
  missionId: string,
  keyId: string,
): SourceCredentialRecord | undefined {
  for (const row of missionRows(
    ledger,
    orgId,
    missionId,
    CREDENTIAL_KEY_PREFIX,
    SOURCE_CREDENTIAL_TYPE,
  )) {
    const record = verifiedPayload<SourceCredentialRecord>(row, 'SOURCE_CREDENTIAL');
    if (record.keyId === keyId) return record;
  }
  return undefined;
}

export function isKeyRevoked(
  ledger: Ledger,
  orgId: string,
  missionId: string,
  keyId: string,
): boolean {
  return revokedKeyIds(ledger, orgId, missionId).has(keyId);
}

// ---------------------------------------------------------- lifecycle views

export type CredentialState = 'active' | 'revoked' | 'expired' | 'quarantined';

export interface CredentialView {
  readonly orgId: string;
  readonly missionId: string;
  readonly record: SourceCredentialRecord;
  /** Seals in journal order: the original, then any KEK-rotation reseals. */
  readonly seals: readonly SealedKey[];
  readonly state: CredentialState;
}

/**
 * The seal to open with: the newest under the CURRENT KEK, else the newest
 * under any PREVIOUS KEK. Earlier seals stay in the append-only journal, so a
 * rollback to an older KEK keeps working.
 */
export function pickSeal(seals: readonly SealedKey[], ring: KekRing): SealedKey | undefined {
  for (let index = seals.length - 1; index >= 0; index -= 1) {
    if (seals[index]!.kekId === ring.current.id) return seals[index];
  }
  for (let index = seals.length - 1; index >= 0; index -= 1) {
    if (ring.find(seals[index]!.kekId) !== undefined) return seals[index];
  }
  return undefined;
}

/** Every credential of one (org, mission) with its lifecycle state. No key is opened here. */
export function loadMissionCredentials(
  ledger: Ledger,
  ring: KekRing,
  orgId: string,
  missionId: string,
  nowMs: number,
): CredentialView[] {
  const revoked = revokedKeyIds(ledger, orgId, missionId);
  const reseals = resealsBySourceKey(ledger, orgId, missionId);
  const views: CredentialView[] = [];
  for (const row of missionRows(
    ledger,
    orgId,
    missionId,
    CREDENTIAL_KEY_PREFIX,
    SOURCE_CREDENTIAL_TYPE,
  )) {
    const record = verifiedPayload<SourceCredentialRecord>(row, 'SOURCE_CREDENTIAL');
    const seals = [
      ...(isSealedKey(record.sealed) ? [record.sealed] : []),
      ...(reseals.get(sourceKeyIdentity(record.sourceId, record.keyId)) ?? []),
    ];
    let state: CredentialState;
    if (revoked.has(record.keyId)) state = 'revoked';
    else if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= nowMs) {
      state = 'expired';
    } else if (pickSeal(seals, ring) === undefined) state = 'quarantined';
    else state = 'active';
    views.push({ orgId, missionId, record, seals, state });
  }
  // A keyId that resolves to more than one live credential in a mission is
  // AMBIGUOUS (issuance can never produce it; only a hostile or legacy
  // journal can). Fail closed: none of them may authenticate.
  const liveByKeyId = new Map<string, number>();
  for (const view of views) {
    if (view.state === 'active') {
      liveByKeyId.set(view.record.keyId, (liveByKeyId.get(view.record.keyId) ?? 0) + 1);
    }
  }
  return views.map((view) =>
    view.state === 'active' && (liveByKeyId.get(view.record.keyId) ?? 0) > 1
      ? { ...view, state: 'quarantined' as const }
      : view,
  );
}

/**
 * Open the signing key for a credential, verifying it against the journalled
 * digest. Returns null when no configured KEK can open it (quarantined).
 * Tampering throws — an integrity violation must never degrade to "unknown".
 */
export function openCredentialSecret(view: CredentialView, ring: KekRing): string | null {
  const seal = pickSeal(view.seals, ring);
  if (seal === undefined) return null;
  const plaintext = ring.find(seal.kekId)!.open(seal);
  if (keyDigestOf(plaintext) !== view.record.keyDigest) {
    throw new SourceKeyCustodyError(
      'SOURCE_KEY_DIGEST_MISMATCH',
      `sealed key for credential ${view.record.keyId} does not match its journalled digest`,
    );
  }
  return plaintext;
}

// ----------------------------------------------------- boot-time verification

export interface CustodyBootReport {
  readonly credentialsScanned: number;
  /** Live credentials already sealed under the current KEK. */
  readonly sealedUnderCurrent: number;
  /** Live credentials re-sealed under the current KEK during THIS boot (rotation). */
  readonly resealed: number;
  /** Revoked or expired credentials — dead, custody no longer matters for them. */
  readonly inactive: number;
  /** Live credentials no configured KEK can open that the operator explicitly retired. */
  readonly quarantinedAcknowledged: number;
  /** Live credentials no configured KEK can open and nobody acknowledged (production refuses to boot). */
  readonly quarantinedUnacknowledged: number;
  /** Credential rows without a valid seal (legacy/malformed) — never honored. */
  readonly malformed: number;
  /** Fingerprints no configured KEK can open and nobody acknowledged. */
  readonly unrecoverableKekIds: readonly string[];
}

interface ScanRow extends JournalRow {
  readonly org_id: string;
  readonly mission_id: string | null;
  readonly type: string;
}

function refusalMessage(ring: KekRing, report: CustodyBootReport): string {
  const ids = report.unrecoverableKekIds.join(', ');
  // The env assignment must be copy-pastable: comma-joined, no spaces.
  const retiredValue = report.unrecoverableKekIds.join(',');
  const previous = ring.previous.map((kek) => kek.id);
  return (
    `${String(report.quarantinedUnacknowledged)} live machine-source credential(s) are sealed under KEK ` +
    `fingerprint(s) [${ids}] that this process cannot open (current KEK ${ring.current.id}; ` +
    `previous [${previous.join(', ')}]). Refusing to start rather than silently orphaning them. ` +
    `Recovery: (1) restore the original KEK and add it to MOTERVA_SOURCE_KEY_KEK_PREVIOUS — boot re-seals ` +
    `the credentials under the current KEK; or (2) if that KEK is unrecoverable, acknowledge the loss with ` +
    `MOTERVA_SOURCE_KEY_KEK_RETIRED=${retiredValue} — those credentials stay quarantined (they can never ` +
    `authenticate) and must be re-issued with new keyIds. Key material is never printed.`
  );
}

/**
 * Scan every credential in the journal (all tenants) against the KEK ring:
 *  - sealed under the current KEK → nothing to do;
 *  - sealed under a PREVIOUS KEK → re-seal under the current KEK (journaled,
 *    metadata-only, idempotent) — this IS the rotation step;
 *  - sealed under nothing this process holds → quarantine; in production, a
 *    refusal unless every such KEK fingerprint was explicitly retired.
 * Revoked and expired credentials are ignored (they cannot authenticate).
 */
export function verifySourceKeyCustody(
  ledger: Ledger,
  ring: KekRing,
  options: { production: boolean },
): CustodyBootReport {
  const nowMs = Date.parse(ledger.clock.iso());
  const rows = ledger.db
    .prepare(
      `SELECT seq, org_id, mission_id, type, payload_digest, payload_json FROM evidence_events
        WHERE type IN (?, ?, ?) ORDER BY seq ASC`,
    )
    .all(SOURCE_CREDENTIAL_TYPE, SOURCE_REVOCATION_TYPE, SOURCE_RESEAL_TYPE) as ScanRow[];

  const revoked = new Set<string>();
  const reseals = new Map<string, SealedKey[]>();
  const credentials: { row: ScanRow; record: SourceCredentialRecord }[] = [];
  for (const row of rows) {
    const scope = `${row.org_id}\u0000${row.mission_id ?? ''}`;
    if (row.type === SOURCE_REVOCATION_TYPE) {
      const record = verifiedPayload<SourceRevocationRecord>(row, 'SOURCE_REVOCATION');
      revoked.add(`${scope}\u0000${record.keyId}`);
    } else if (row.type === SOURCE_RESEAL_TYPE) {
      const record = verifiedPayload<SourceResealRecord>(row, 'SOURCE_RESEAL');
      if (!isSealedKey(record.sealed)) continue;
      const identity = `${scope}\u0000${sourceKeyIdentity(record.sourceId, record.keyId)}`;
      reseals.set(identity, [...(reseals.get(identity) ?? []), record.sealed]);
    } else {
      credentials.push({
        row,
        record: verifiedPayload<SourceCredentialRecord>(row, 'SOURCE_CREDENTIAL'),
      });
    }
  }

  let sealedUnderCurrent = 0;
  let resealed = 0;
  let inactive = 0;
  let quarantinedAcknowledged = 0;
  let malformed = 0;
  const unacknowledgedKekIds = new Set<string>();
  let quarantinedUnacknowledged = 0;

  for (const { row, record } of credentials) {
    const scope = `${row.org_id}\u0000${row.mission_id ?? ''}`;
    if (revoked.has(`${scope}\u0000${record.keyId}`)) {
      inactive += 1;
      continue;
    }
    if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= nowMs) {
      inactive += 1;
      continue;
    }
    const seals = [
      ...(isSealedKey(record.sealed) ? [record.sealed] : []),
      ...(reseals.get(`${scope}\u0000${sourceKeyIdentity(record.sourceId, record.keyId)}`) ?? []),
    ];
    if (seals.length === 0 || row.mission_id === null) {
      malformed += 1;
      continue;
    }
    const seal = pickSeal(seals, ring);
    if (seal === undefined) {
      const ids = [...new Set(seals.map((candidate) => candidate.kekId))];
      if (ids.every((id) => ring.retiredKekIds.has(id))) {
        quarantinedAcknowledged += 1;
      } else {
        quarantinedUnacknowledged += 1;
        for (const id of ids) if (!ring.retiredKekIds.has(id)) unacknowledgedKekIds.add(id);
      }
      continue;
    }
    if (seal.kekId === ring.current.id) {
      sealedUnderCurrent += 1;
      continue;
    }
    // Sealed under a PREVIOUS KEK: rotate it under the current one.
    const plaintext = ring.find(seal.kekId)!.open(seal);
    if (keyDigestOf(plaintext) !== record.keyDigest) {
      throw new SourceKeyCustodyError(
        'SOURCE_KEY_DIGEST_MISMATCH',
        `sealed key for credential ${record.keyId} does not match its journalled digest`,
      );
    }
    const payload: SourceResealRecord = {
      sourceId: record.sourceId,
      keyId: record.keyId,
      keyDigest: record.keyDigest,
      sealed: ring.current.seal(plaintext),
      previousKekId: seal.kekId,
      resealedAt: ledger.clock.iso(),
      reason: 'kek-rotation',
    };
    try {
      ledger.evidence.append({
        orgId: row.org_id,
        missionId: row.mission_id,
        topic: 'operational',
        type: SOURCE_RESEAL_TYPE,
        eventKey: resealEventKey(row.mission_id, record.sourceId, record.keyId, ring.current.id),
        payload: payload as unknown as Record<string, unknown>,
      });
    } catch (error) {
      // A concurrent boot already re-sealed this credential: nothing to do.
      if (!(isLedgerError(error) && error.code === 'DUPLICATE_EVENT')) throw error;
    }
    resealed += 1;
  }

  const report: CustodyBootReport = {
    credentialsScanned: credentials.length,
    sealedUnderCurrent,
    resealed,
    inactive,
    quarantinedAcknowledged,
    quarantinedUnacknowledged,
    malformed,
    unrecoverableKekIds: [...unacknowledgedKekIds].sort(),
  };
  if (options.production && quarantinedUnacknowledged > 0) {
    throw new SourceKeyCustodyError('SOURCE_KEK_UNRECOVERABLE', refusalMessage(ring, report));
  }
  return report;
}

/** Minimal structured-logger surface (Fastify/pino loggers satisfy it). */
export interface CustodyLog {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
}

/**
 * The single custody gate `buildApp` runs BEFORE any credential route can
 * mount: resolve the KEK ring under the fail-closed policy, then verify (and
 * rotate) every sealed credential against it. Logs fingerprints and counts —
 * never key material.
 */
export function establishSourceKeyCustody(
  ledger: Ledger,
  context: CustodyPolicyContext & { custody: SourceKeyCustodyConfig | undefined },
  log: CustodyLog,
): KekRing {
  const ring = resolveKekRing(context.custody, context);
  const report = verifySourceKeyCustody(ledger, ring, {
    production: context.nodeEnv === 'production',
  });
  log.info(
    {
      custody: {
        posture: ring.posture,
        currentKekId: ring.current.id,
        previousKekIds: ring.previous.map((kek) => kek.id),
        ...report,
      },
    },
    'source-key custody verified',
  );
  if (ring.posture === 'local-derived') {
    log.warn(
      { custody: { posture: ring.posture } },
      'source credentials are sealed under the PUBLIC local derivation (loopback development/test only) — never deploy this way',
    );
  }
  if (report.quarantinedUnacknowledged + report.quarantinedAcknowledged + report.malformed > 0) {
    log.warn(
      {
        custody: {
          quarantinedUnacknowledged: report.quarantinedUnacknowledged,
          quarantinedAcknowledged: report.quarantinedAcknowledged,
          malformed: report.malformed,
          unrecoverableKekIds: report.unrecoverableKekIds,
        },
      },
      'some source credentials cannot authenticate (no usable KEK / no valid seal); they fail closed and must be re-issued',
    );
  }
  return ring;
}
