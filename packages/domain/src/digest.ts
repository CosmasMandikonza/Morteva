/**
 * Canonical digests for immutable financial identities (docs/05 #4).
 *
 * A candidate plan's economic terms are hashed canonically so that any change
 * — beneficiary, amount, currency, purpose, quote, expiry — produces a new
 * identity. Approvals bind the digest they approved; changed terms therefore
 * cannot ride an old approval.
 *
 * Canonicalization: JSON with recursively sorted object keys, no whitespace.
 * Numbers must be integers (money is minor units); this file never formats
 * floats into a digest.
 */
import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new TypeError(
        'canonicalJson: non-integer number in financial terms (floats forbidden)',
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v));
    return '{' + entries.join(',') + '}';
  }
  throw new TypeError('canonicalJson: unsupported type ' + typeof value);
}

/** Stable identity of an immutable terms object. */
export function termsDigest(terms: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(terms), 'utf8').digest('hex');
}
