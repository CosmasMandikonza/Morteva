/**
 * Event identity digests and source authentication.
 *
 * - `eventDigest`: sha256 over the canonical JSON of the normalized event
 *   (signature excluded). Stable across processes because canonicalJson sorts
 *   keys and forbids floats — the same event always digests identically.
 * - source signature: HMAC-SHA256 over the same canonical form with the
 *   source's registered key. Ingress-only: signatures are verified once and
 *   never persisted; the journal stores the digest, which replay recomputes.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '@moterva/domain';
import type { NormalizedEvent } from './schema.js';
import { signedEvent } from './schema.js';

export function eventDigest(event: NormalizedEvent): string {
  return createHash('sha256')
    .update(canonicalJson(signedEvent(event)), 'utf8')
    .digest('hex');
}

export function sourceSignature(event: NormalizedEvent, secretKey: string): string {
  return createHmac('sha256', secretKey)
    .update(canonicalJson(signedEvent(event)), 'utf8')
    .digest('hex');
}

/** Constant-time comparison; never throws on length mismatch. */
export function signatureMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
