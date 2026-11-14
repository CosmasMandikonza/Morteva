/**
 * OFFLINE TESTS — token money semantics (issue #6; task D2 for the metal
 * rail). Internal representation is integer token minor units; conversions
 * are exact string/BigInt math with fail-closed rejection of every
 * non-exact value.
 */
import { describe, expect, it } from 'vitest';
import {
  amountToBaseUnits,
  majorStringToMinor,
  minorToMajorString,
  TokenMoneyError,
} from '../src/money.js';

describe('token minor/major conversion (exact, fail-closed)', () => {
  it('round-trips zero-, two-, six- and eighteen-decimal amounts exactly', () => {
    for (const decimals of [0, 2, 6, 18]) {
      const minor = 123456789;
      const major = minorToMajorString(minor, decimals);
      expect(majorStringToMinor(major, decimals)).toBe(minor);
    }
    expect(minorToMajorString(1, 6)).toBe('0.000001');
    expect(minorToMajorString(2_500_000, 6)).toBe('2.500000');
    expect(minorToMajorString(1, 0)).toBe('1');
    expect(minorToMajorString(50, 2)).toBe('0.50');
  });

  it('rejects fractional minor units and float artifacts (never silently rounds a financial authorization)', () => {
    expect(() => minorToMajorString(2.5, 6)).toThrow(TokenMoneyError);
    expect(() => minorToMajorString(0.30000000000000004 * 1e6, 6)).toThrow(TokenMoneyError);
    expect(() => majorStringToMinor('1.0000005', 6)).toThrow(TokenMoneyError);
    expect(() => majorStringToMinor('0.30000000000000004', 6)).toThrow(TokenMoneyError);
  });

  it('rejects zero and negative transfer amounts at the movement boundary', () => {
    expect(() => amountToBaseUnits(0)).toThrow(TokenMoneyError);
    expect(() => amountToBaseUnits(-1)).toThrow(TokenMoneyError);
    expect(() => amountToBaseUnits(2.5)).toThrow(TokenMoneyError);
    expect(amountToBaseUnits(2_500_000)).toBe(2_500_000n);
  });

  it('rejects values beyond the safe-integer money domain on both sides', () => {
    const beyondSafe = Number.MAX_SAFE_INTEGER + 1;
    expect(() => minorToMajorString(beyondSafe, 6)).toThrow(TokenMoneyError);
    expect(() => amountToBaseUnits(beyondSafe)).toThrow(TokenMoneyError);
    // 10^16 major with 6 decimals = 10^22 minor > 2^53
    expect(() => majorStringToMinor('10000000000000000', 6)).toThrow(TokenMoneyError);
  });

  it('rejects malformed decimal strings', () => {
    expect(() => majorStringToMinor('', 6)).toThrow(TokenMoneyError);
    expect(() => majorStringToMinor('1,5', 6)).toThrow(TokenMoneyError);
    expect(() => majorStringToMinor('0x10', 6)).toThrow(TokenMoneyError);
    expect(() => majorStringToMinor('1e6', 6)).toThrow(TokenMoneyError);
  });

  it('handles negative display strings symmetrically (accounting, never transfers)', () => {
    expect(majorStringToMinor('-2.50', 2)).toBe(-250);
    expect(minorToMajorString(-250, 2)).toBe('-2.50');
  });
});
