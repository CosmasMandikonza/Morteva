/**
 * Airwallex webhook signature verification (issue #5; D4 adversarial set).
 *
 * VERIFIED against the current official builder guide (airwallexdev.com/guide,
 * checked 2026-11-08): "Verify the HMAC-SHA256 signature against the raw bytes
 * rather than a re-serialized body"; delivery is at-least-once; dedupe on the
 * event id. The guide page available at audit time does not document the
 * exact header names, so this module verifies (rawBody, signature, timestamp)
 * tuples — the HTTP layer maps headers; it must pass the RAW request bytes,
 * never a re-serialized object (a JSON round-trip can reorder keys and break
 * the HMAC).
 *
 * Semantics (fail closed):
 *  - signature compare is timing-safe (crypto.timingSafeEqual over equal-length
 *    buffers; length mismatch never reaches the comparison);
 *  - signatures are computed over `rawBody` bytes with the webhook secret as
 *    the key, hex- and base64-encoded forms both accepted (the exact encoding
 *    is verified against live provider behavior when credentials exist — the
 *    verifier accepts the encodings and the smoke records which matched);
 *  - a `timestamp` (unix seconds) older than `maxAgeSeconds` is STALE → reject
 *    (replay-window defense); a timestamp in the future beyond a small skew
 *    allowance is also rejected;
 *  - a replayed (signature-valid, stale) event is rejected here; the durable
 *    event-id dedupe remains the webhook sink's job (see dispatcher.ts).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookSignatureVerdict =
  'valid' | 'signature-mismatch' | 'stale-timestamp' | 'future-timestamp' | 'malformed-input';

const FUTURE_SKEW_SECONDS = 300;

export interface WebhookVerificationInput {
  /** The RAW request body bytes exactly as received (never re-serialized). */
  readonly rawBody: Buffer | string | null | undefined;
  /** The provider's signature header value (hex or base64), as received. */
  readonly signature: string | undefined | null;
  /** Unix-seconds timestamp header value, as received. */
  readonly timestamp: string | number | undefined | null;
  /** The webhook signing secret (server-only). */
  readonly secret: string;
  /** Replay window in seconds (default 300 — five minutes). */
  readonly maxAgeSeconds?: number;
  /** "now" in unix seconds (injectable for tests). */
  readonly nowSeconds?: number;
}

function hmacCandidates(rawBody: Buffer | string | null | undefined, secret: string): Buffer[] {
  // Independent HMAC instances (digest() is consuming); header values are
  // strings, so compare the hex- and base64-encoded digests as UTF-8 bytes.
  const hex = createHmac('sha256', secret)
    .update(rawBody ?? '')
    .digest('hex');
  const base64 = createHmac('sha256', secret)
    .update(rawBody ?? '')
    .digest('base64');
  return [Buffer.from(hex, 'utf8'), Buffer.from(base64, 'utf8')];
}

function equalInLengthSafeTime(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyWebhookSignature(input: WebhookVerificationInput): WebhookSignatureVerdict {
  const {
    rawBody,
    signature,
    timestamp,
    secret,
    maxAgeSeconds = 300,
    nowSeconds = Math.floor(Date.now() / 1000),
  } = input;
  if (
    typeof secret !== 'string' ||
    secret === '' ||
    typeof signature !== 'string' ||
    signature.trim() === '' ||
    timestamp === undefined ||
    timestamp === null ||
    rawBody === undefined ||
    rawBody === null
  ) {
    return 'malformed-input';
  }
  const timestampValue =
    typeof timestamp === 'number' ? timestamp : Number(String(timestamp).trim());
  if (!Number.isFinite(timestampValue)) return 'malformed-input';
  if (timestampValue > nowSeconds + FUTURE_SKEW_SECONDS) return 'future-timestamp';
  if (nowSeconds - timestampValue > maxAgeSeconds) return 'stale-timestamp';

  const provided = Buffer.from(signature.trim(), 'utf8');
  for (const candidate of hmacCandidates(rawBody, secret)) {
    if (equalInLengthSafeTime(provided, candidate)) return 'valid';
  }
  return 'signature-mismatch';
}
