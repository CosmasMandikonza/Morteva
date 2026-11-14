/**
 * SOURCE-KEY CUSTODY — the Key-Encryption-Key (KEK) that protects machine-source
 * signing credentials at rest (CTO review PR #64, comment 6808560477, P0).
 *
 * THE RULE THIS MODULE ENFORCES: a predictable, repository-derivable key must
 * never protect a production credential. A deployment that serves the
 * credential surface (production identity configured) MUST provision exactly
 * 32 random bytes as `MOTERVA_SOURCE_KEY_KEK`; the deterministic local
 * derivation exists ONLY so loopback development and tests can run without a
 * secret store, and is refused outright in `NODE_ENV=production` — as the
 * current key, as a previous key, and as a configured value.
 *
 * Pure crypto + policy: no ledger access, no `process.env` reads (the
 * environment is parsed once, in `loadConfig`, and the validated material is
 * passed down explicitly). Journal-backed boot verification and the rotation
 * / recovery protocol live in `source-credential-store.ts`.
 *
 * KEY MATERIAL HYGIENE: key bytes live only inside `Kek` (an ES-private field).
 * `JSON.stringify`, `util.inspect`, structured logging and test diffs of any
 * object holding a `Kek` print only its non-secret fingerprint. Error messages
 * name environment variables and key FINGERPRINTS — never values.
 *
 * ROTATION / RECOVERY PROTOCOL (operators; see docs/STATE.md "Source key custody"):
 *  - `MOTERVA_SOURCE_KEY_KEK`           current KEK; seals every NEW credential.
 *  - `MOTERVA_SOURCE_KEY_KEK_PREVIOUS`  retired-but-recoverable KEK(s); decrypt-only.
 *    Booting with the new key in CURRENT and the old in PREVIOUS re-seals every
 *    live credential under the new key (journaled, metadata-only); once the boot
 *    log reports zero credentials left under the previous key, drop PREVIOUS.
 *  - `MOTERVA_SOURCE_KEY_KEK_RETIRED`   fingerprints of KEKs the operator
 *    declares UNRECOVERABLE. Credentials sealed only under those stay
 *    quarantined (they can never authenticate) and must be re-issued. Without
 *    this explicit acknowledgement a production boot REFUSES — a KEK is never
 *    silently replaced under existing ciphertext.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

export type SourceKeyCustodyErrorCode =
  | 'SOURCE_KEK_REQUIRED'
  | 'SOURCE_KEK_INVALID'
  | 'SOURCE_KEK_PUBLIC_DERIVATION_REFUSED'
  | 'SOURCE_KEK_UNRECOVERABLE'
  | 'SOURCE_KEY_SEAL_MISMATCH'
  | 'SOURCE_KEY_SEAL_TAMPERED'
  | 'SOURCE_KEY_DIGEST_MISMATCH'
  | 'SOURCE_CREDENTIAL_INTEGRITY_VIOLATION';

/** Typed custody failure. Messages carry env-var names and fingerprints only. */
export class SourceKeyCustodyError extends Error {
  constructor(
    readonly code: SourceKeyCustodyErrorCode,
    message: string,
    /** The environment variable at fault, when the failure is a configuration one. */
    readonly variable?: string,
  ) {
    super(variable === undefined ? `${code}: ${message}` : `${variable}: ${message} [${code}]`);
    this.name = 'SourceKeyCustodyError';
  }
}

const KEK_BYTES = 32;
const SEAL_VERSION = 1;
const GCM_TAG_BYTES = 16;
const GCM_IV_BYTES = 12;
/** Fingerprint stamped on seals made with the public local derivation. */
export const PUBLIC_DERIVATION_KEK_ID = 'local-derived';
/**
 * The PUBLIC derivation input. This string is in the repository on purpose:
 * it is the very value production must never rely on, kept so local
 * development and tests need no secret store and so production can detect and
 * refuse it.
 */
const PUBLIC_DERIVATION_INPUT = 'moterva-local-source-kek:v1:default-local-derivation';
const KEK_ID_RE = /^(?:[0-9a-f]{12}|local-derived)$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_PREVIOUS_KEKS = 4;
const MAX_RETIRED_IDS = 32;

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function publicDerivationBytes(): Buffer {
  return createHash('sha256').update(PUBLIC_DERIVATION_INPUT, 'utf8').digest();
}

/** AES-256-GCM envelope of one signing key (journal-safe: useless without the KEK). */
export interface SealedKey {
  readonly v: typeof SEAL_VERSION;
  /** Fingerprint of the KEK that sealed this record. */
  readonly kekId: string;
  readonly iv: string;
  readonly ct: string;
  readonly tag: string;
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Structural guard — journal rows from older/foreign builds may not be sealed at all. */
export function isSealedKey(value: unknown): value is SealedKey {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === SEAL_VERSION &&
    typeof v.kekId === 'string' &&
    KEK_ID_RE.test(v.kekId) &&
    typeof v.iv === 'string' &&
    B64URL_RE.test(v.iv) &&
    Buffer.from(v.iv, 'base64url').length === GCM_IV_BYTES &&
    typeof v.ct === 'string' &&
    B64URL_RE.test(v.ct) &&
    typeof v.tag === 'string' &&
    B64URL_RE.test(v.tag) &&
    Buffer.from(v.tag, 'base64url').length === GCM_TAG_BYTES
  );
}

export class Kek {
  readonly #bytes: Buffer;
  /** Non-secret fingerprint, stamped on every seal this key produces. */
  readonly id: string;
  /** True when the bytes equal the public, repository-derivable value. */
  readonly publicDerivation: boolean;

  private constructor(bytes: Buffer, id: string, publicDerivation: boolean) {
    this.#bytes = bytes;
    this.id = id;
    this.publicDerivation = publicDerivation;
  }

  static fromBytes(bytes: Buffer): Kek {
    if (bytes.length !== KEK_BYTES) {
      throw new SourceKeyCustodyError('SOURCE_KEK_INVALID', 'a KEK must be exactly 32 bytes');
    }
    const copy = Buffer.from(bytes);
    const isPublic = copy.equals(publicDerivationBytes());
    const id = isPublic
      ? PUBLIC_DERIVATION_KEK_ID
      : sha256Hex(copy.toString('base64url')).slice(0, 12);
    return new Kek(copy, id, isPublic);
  }

  /** The PUBLIC deterministic derivation — loopback development/tests only. */
  static localDerived(): Kek {
    return Kek.fromBytes(publicDerivationBytes());
  }

  seal(plaintext: string): SealedKey {
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#bytes, iv, { authTagLength: GCM_TAG_BYTES });
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      v: SEAL_VERSION,
      kekId: this.id,
      iv: iv.toString('base64url'),
      ct: ct.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    };
  }

  open(sealed: SealedKey): string {
    if (sealed.kekId !== this.id) {
      throw new SourceKeyCustodyError(
        'SOURCE_KEY_SEAL_MISMATCH',
        `record sealed under KEK "${sealed.kekId}" but this KEK is "${this.id}"`,
      );
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.#bytes,
        Buffer.from(sealed.iv, 'base64url'),
        { authTagLength: GCM_TAG_BYTES },
      );
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.ct, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Deliberately generic: do not distinguish wrong-key from bit-flip.
      throw new SourceKeyCustodyError(
        'SOURCE_KEY_SEAL_TAMPERED',
        `sealed key under KEK "${sealed.kekId}" failed authentication`,
      );
    }
  }

  /** Serialization (logs, config dumps, JSON responses) exposes the fingerprint only. */
  toJSON(): { kekId: string } {
    return { kekId: this.id };
  }

  [inspect.custom](): string {
    return `Kek(${this.id})`;
  }
}

// ----------------------------------------------------------------- parsing

const INVALID_KEK_MESSAGE =
  'must be exactly 32 bytes encoded as 64 hex characters, a 43-character base64url string or a 44-character base64 string (the value is never shown)';

/**
 * Strict KEK decode: exactly 32 decoded bytes in one of three CANONICAL
 * encodings. Node's lenient decoders silently skip invalid characters, so
 * each format is matched by shape first and round-tripped afterwards.
 */
export function parseKek(encoded: string, variable: string): Kek {
  const value = encoded.trim();
  let bytes: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    bytes = Buffer.from(value, 'hex');
  } else if (/^[A-Za-z0-9_-]{43}$/.test(value)) {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') === value) bytes = decoded;
  } else if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') === value) bytes = decoded;
  }
  if (bytes === undefined || bytes.length !== KEK_BYTES) {
    throw new SourceKeyCustodyError('SOURCE_KEK_INVALID', INVALID_KEK_MESSAGE, variable);
  }
  const key: Buffer = bytes;
  if (key.every((byte) => byte === key[0])) {
    throw new SourceKeyCustodyError(
      'SOURCE_KEK_INVALID',
      'is degenerate (one repeated byte) — provision 32 bytes from a CSPRNG',
      variable,
    );
  }
  return Kek.fromBytes(key);
}

/** Validated custody configuration (what `loadConfig` carries on `AppConfig`). */
export interface SourceKeyCustodyConfig {
  readonly current: Kek | null;
  readonly previous: readonly Kek[];
  /** Fingerprints the operator explicitly declared unrecoverable. */
  readonly retiredKekIds: readonly string[];
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? '').split(/[\s,]+/).filter((part) => part !== '');
}

/**
 * Parse the three custody variables. Format problems fail here, in EVERY
 * environment — a malformed KEK is never ignored. Whether a KEK is REQUIRED
 * is a separate policy question (`resolveKekRing`).
 */
export function parseSourceKeyCustodyEnv(
  env: Readonly<Record<string, string | undefined>>,
): SourceKeyCustodyConfig {
  const currentRaw = (env.MOTERVA_SOURCE_KEY_KEK ?? '').trim();
  const current = currentRaw === '' ? null : parseKek(currentRaw, 'MOTERVA_SOURCE_KEY_KEK');

  const previousRaw = splitList(env.MOTERVA_SOURCE_KEY_KEK_PREVIOUS);
  if (previousRaw.length > MAX_PREVIOUS_KEKS) {
    throw new SourceKeyCustodyError(
      'SOURCE_KEK_INVALID',
      `lists more than ${String(MAX_PREVIOUS_KEKS)} previous KEKs — finish the rotation before adding more`,
      'MOTERVA_SOURCE_KEY_KEK_PREVIOUS',
    );
  }
  const previous: Kek[] = [];
  for (const entry of previousRaw) {
    const kek = parseKek(entry, 'MOTERVA_SOURCE_KEY_KEK_PREVIOUS');
    if (kek.id === current?.id || previous.some((existing) => existing.id === kek.id)) continue;
    previous.push(kek);
  }

  const retiredRaw = splitList(env.MOTERVA_SOURCE_KEY_KEK_RETIRED);
  if (retiredRaw.length > MAX_RETIRED_IDS) {
    throw new SourceKeyCustodyError(
      'SOURCE_KEK_INVALID',
      `lists more than ${String(MAX_RETIRED_IDS)} KEK fingerprints`,
      'MOTERVA_SOURCE_KEY_KEK_RETIRED',
    );
  }
  const retiredKekIds: string[] = [];
  for (const id of retiredRaw) {
    if (!KEK_ID_RE.test(id)) {
      throw new SourceKeyCustodyError(
        'SOURCE_KEK_INVALID',
        'entries must be KEK fingerprints (12 lowercase hex characters, or "local-derived") as printed by the boot refusal — never key material',
        'MOTERVA_SOURCE_KEY_KEK_RETIRED',
      );
    }
    if (!retiredKekIds.includes(id)) retiredKekIds.push(id);
  }
  const live = [current, ...previous].filter((kek): kek is Kek => kek !== null);
  const contradiction = live.find((kek) => retiredKekIds.includes(kek.id));
  if (contradiction !== undefined) {
    throw new SourceKeyCustodyError(
      'SOURCE_KEK_INVALID',
      `lists fingerprint ${contradiction.id}, which is also configured as a usable KEK — a key cannot be both retired and in service`,
      'MOTERVA_SOURCE_KEY_KEK_RETIRED',
    );
  }
  return { current, previous, retiredKekIds };
}

// ------------------------------------------------------------------- policy

export interface CustodyPolicyContext {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
}

/** The KEK ring in force for one process: seals with `current`, opens with `current` or `previous`. */
export class KekRing {
  constructor(
    readonly current: Kek,
    readonly previous: readonly Kek[],
    readonly retiredKekIds: ReadonlySet<string>,
    /** `local-derived` = the PUBLIC derivation (loopback development/tests only). */
    readonly posture: 'configured' | 'local-derived',
  ) {}

  /** The KEK able to open a seal stamped with this fingerprint, if any. */
  find(kekId: string): Kek | undefined {
    if (this.current.id === kekId) return this.current;
    return this.previous.find((kek) => kek.id === kekId);
  }
}

/**
 * Decide which KEK ring this process may run with, FAIL-CLOSED:
 *  - production: a configured KEK is mandatory; the public derivation is refused
 *    in every role (current, previous, or configured-by-value).
 *  - non-production: the public derivation is a convenience restricted to a
 *    LOOPBACK host (the repository already treats `NODE_ENV=development` on a
 *    public host as a realistic cloud mistake — see DEMO_AUTH); a network-
 *    reachable deployment must provision a real KEK.
 */
export function resolveKekRing(
  custody: SourceKeyCustodyConfig | undefined,
  context: CustodyPolicyContext,
): KekRing {
  const production = context.nodeEnv === 'production';
  const current = custody?.current ?? null;
  const previous = custody?.previous ?? [];
  const retired = new Set(custody?.retiredKekIds ?? []);
  if (production) {
    if (current === null) {
      throw new SourceKeyCustodyError(
        'SOURCE_KEK_REQUIRED',
        'required when production identity is configured: machine-source signing credentials are sealed under this 32-byte Key-Encryption-Key, and the predictable local derivation is NEVER used in production. Provision 32 random bytes (64 hex characters or base64url) from your secret manager and keep the value stable across redeploys and rollbacks — see docs/STATE.md "Source key custody"',
        'MOTERVA_SOURCE_KEY_KEK',
      );
    }
    const publicOne = [current, ...previous].find((kek) => kek.publicDerivation);
    if (publicOne !== undefined) {
      throw new SourceKeyCustodyError(
        'SOURCE_KEK_PUBLIC_DERIVATION_REFUSED',
        'is the PUBLIC deterministic local derivation (identical in every deployment and readable in the repository); production refuses it — provision a random 32-byte key',
        'MOTERVA_SOURCE_KEY_KEK',
      );
    }
    return new KekRing(current, previous, retired, 'configured');
  }
  if (current === null) {
    if (!LOOPBACK_HOSTS.has(context.host)) {
      throw new SourceKeyCustodyError(
        'SOURCE_KEK_REQUIRED',
        `required outside loopback development: HOST "${context.host}" is network-reachable and the local derivation is public — provision a random 32-byte key (or bind HOST to 127.0.0.1)`,
        'MOTERVA_SOURCE_KEY_KEK',
      );
    }
    return new KekRing(Kek.localDerived(), previous, retired, 'local-derived');
  }
  return new KekRing(
    current,
    previous,
    retired,
    current.publicDerivation ? 'local-derived' : 'configured',
  );
}
