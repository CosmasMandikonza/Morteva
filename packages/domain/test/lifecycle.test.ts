import { describe, expect, it } from 'vitest';
import {
  allowedOperationTransitions,
  canTransitionOperation,
  isOperationState,
  isTerminalOperationState,
} from '../src/operations.js';
import { commitmentConsumesCapacity, commitmentStateFor } from '../src/commitments.js';
import { canonicalJson, termsDigest } from '../src/digest.js';

describe('operation lifecycle transitions', () => {
  it('follows the documented happy path', () => {
    for (const [from, to] of [
      ['PROPOSED', 'RESERVED'],
      ['RESERVED', 'SUBMITTING'],
      ['SUBMITTING', 'IN_FLIGHT'],
      ['IN_FLIGHT', 'SETTLED'],
      ['SETTLED', 'RECONCILED'],
    ] as const) {
      expect(canTransitionOperation(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it('rejects regressions and skips', () => {
    expect(canTransitionOperation('SETTLED', 'RESERVED')).toBe(false);
    expect(canTransitionOperation('RECONCILED', 'SETTLED')).toBe(false);
    expect(canTransitionOperation('PROPOSED', 'SETTLED')).toBe(false);
    expect(canTransitionOperation('IN_FLIGHT', 'RESERVED')).toBe(false);
    expect(canTransitionOperation('CANCELLED', 'SUBMITTING')).toBe(false);
  });

  it('STATUS_UNKNOWN can resolve but never silently resets to a clean pre-reservation state', () => {
    expect(canTransitionOperation('STATUS_UNKNOWN', 'SETTLED')).toBe(true);
    expect(canTransitionOperation('STATUS_UNKNOWN', 'CANCELLED')).toBe(true);
    expect(canTransitionOperation('STATUS_UNKNOWN', 'PROPOSED')).toBe(false);
    expect(canTransitionOperation('STATUS_UNKNOWN', 'RESERVED')).toBe(false);
  });

  it('treats terminal states as terminal', () => {
    for (const state of ['RECONCILED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const) {
      expect(isTerminalOperationState(state)).toBe(true);
      expect(allowedOperationTransitions(state)).toEqual([]);
    }
    expect(isTerminalOperationState('RESERVED')).toBe(false);
  });

  it('validates state strings', () => {
    expect(isOperationState('RESERVED')).toBe(true);
    expect(isOperationState('reserved')).toBe(false);
    expect(isOperationState('HACKED')).toBe(false);
  });
});

describe('commitment mapping from operation state', () => {
  it('pending and in-flight operations hold a reserved commitment', () => {
    for (const state of ['RESERVED', 'SUBMITTING', 'IN_FLIGHT'] as const) {
      expect(commitmentStateFor(state)).toBe('reserved');
    }
  });

  it('ambiguous and escalated operations retain exposure as unknown', () => {
    expect(commitmentStateFor('STATUS_UNKNOWN')).toBe('unknown');
    expect(commitmentStateFor('REQUIRES_HUMAN')).toBe('unknown');
  });

  it('finality maps to settled; abandonment releases', () => {
    expect(commitmentStateFor('SETTLED')).toBe('settled');
    expect(commitmentStateFor('RECONCILED')).toBe('settled');
    for (const state of ['REJECTED', 'EXPIRED', 'CANCELLED'] as const) {
      expect(commitmentStateFor(state)).toBe('released');
    }
  });

  it('reserved, unknown and settled all consume capacity; released does not', () => {
    expect(commitmentConsumesCapacity('reserved')).toBe(true);
    expect(commitmentConsumesCapacity('unknown')).toBe(true);
    expect(commitmentConsumesCapacity('settled')).toBe(true);
    expect(commitmentConsumesCapacity('released')).toBe(false);
  });
});

describe('canonical digests for immutable terms', () => {
  it('is key-order independent', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(termsDigest({ amount: 100, currency: 'USD' })).toBe(
      termsDigest({ currency: 'USD', amount: 100 }),
    );
  });

  it('nests canonically', () => {
    expect(canonicalJson({ x: { b: 1, a: [2, { z: 3, y: 4 }] } })).toBe(
      canonicalJson({ x: { a: [2, { y: 4, z: 3 }], b: 1 } }),
    );
  });

  it('changes identity when any economic term changes', () => {
    const base = { beneficiary: 'vendor-a', amountMinor: 1200, currency: 'USD', purpose: 'repair' };
    for (const mutated of [
      { ...base, beneficiary: 'vendor-b' },
      { ...base, amountMinor: 1201 },
      { ...base, currency: 'EUR' },
      { ...base, purpose: 'different' },
      { ...base, quote: { rate: '0.99', expiresAt: '2026-11-04T00:00:00Z' } },
    ]) {
      expect(termsDigest(mutated)).not.toBe(termsDigest(base));
    }
  });

  it('forbids non-integer numbers (float money can never enter a digest)', () => {
    expect(() => canonicalJson({ amount: 12.5 })).toThrowError(/non-integer/);
    expect(() => termsDigest({ amount: 0.1 })).toThrowError(TypeError);
  });

  it('drops undefined but keeps explicit null', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });

  it('produces stable sha256 hex digests', () => {
    const digest = termsDigest({ amountMinor: 1, currency: 'USD' });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(termsDigest({ amountMinor: 1, currency: 'USD' })).toBe(digest);
  });
});
