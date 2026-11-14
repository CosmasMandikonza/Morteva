/**
 * OFFLINE TESTS — money-boundary gap matrix for the Airwallex rail (issue #5;
 * task D2). Complements adapter-basics' round-trip property tests with the
 * explicit rejection cases the financial-security docs require: zero/negative
 * transfers, fractional minor units, integer overflow, unsupported currencies
 * and binary-float artifacts — every one fails closed, never rounds.
 */
import { describe, expect, it } from 'vitest';
import { majorUnitsToMinor, minorToMajorUnits, transferAmountMinorToMajor } from '../src/money.js';

describe('airwallex money boundary — rejection matrix (D2)', () => {
  it('rejects zero and negative TRANSFER amounts (a transfer must be positive; balances may be zero)', () => {
    expect(() => transferAmountMinorToMajor('USD', 0)).toThrow(/not a positive integer/);
    expect(() => transferAmountMinorToMajor('USD', -500)).toThrow(/not a positive integer/);
    expect(() => transferAmountMinorToMajor('USD', 12.5)).toThrow(/not a positive integer/);
    // The general converter stays balance-friendly:
    expect(minorToMajorUnits('USD', 0)).toBe(0);
  });

  it('rejects fractional minor units (the ledger never holds fractions of a minor unit)', () => {
    expect(() => minorToMajorUnits('USD', 12.5)).toThrow();
    expect(() => minorToMajorUnits('USD', 0.1 + 0.2)).toThrow();
  });

  it('rejects binary-float artifacts on the inbound side (0.30000000000000004 fails closed)', () => {
    expect(() => majorUnitsToMinor('USD', 0.30000000000000004)).toThrow();
    expect(() => majorUnitsToMinor('USD', 1.0000000000000002)).toThrow();
    expect(() => majorUnitsToMinor('USD', Number.NaN)).toThrow();
    expect(() => majorUnitsToMinor('USD', Number.POSITIVE_INFINITY)).toThrow();
    expect(() => majorUnitsToMinor('USD', '12.34' as unknown as number)).toThrow();
  });

  it('rejects amounts beyond the safe-integer money domain (integer overflow)', () => {
    expect(() => minorToMajorUnits('USD', Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => majorUnitsToMinor('USD', 1e16)).toThrow(); // 1e16 minor > 2^53-1
  });

  it('rejects currency codes the domain does not support (no silent exponent guess)', () => {
    expect(() => minorToMajorUnits('XYZ', 100)).toThrow(/not in the supported table/);
    expect(() => majorUnitsToMinor('QQQ', 100)).toThrow(/not in the supported table/);
    // USDZ was added DELIBERATELY to the supported table (MTV-19 token ledger,
    // exponent 2) for the metal rail; the Airwallex boundary is unchanged —
    // a USDZ-denominated authorization is refused by the metal/airwallex rail
    // isolation long before any Airwallex money conversion could run.
    expect(minorToMajorUnits('USDZ', 100)).toBe(1); // exponent 2, exact
  });

  it('keeps zero-, two- and three-decimal currencies exact (JPY/KWD/USD documented exponents)', () => {
    expect(minorToMajorUnits('JPY', 1)).toBe(1); // exponent 0
    expect(minorToMajorUnits('USD', 1)).toBe(0.01); // exponent 2
    expect(minorToMajorUnits('KWD', 1)).toBe(0.001); // exponent 3
    expect(majorUnitsToMinor('JPY', 1)).toBe(1);
    expect(majorUnitsToMinor('USD', 0.01)).toBe(1);
    expect(majorUnitsToMinor('KWD', 0.001)).toBe(1);
    // A major-unit value with more decimals than the exponent allows is rejected:
    expect(() => majorUnitsToMinor('JPY', 1.5)).toThrow();
    expect(() => majorUnitsToMinor('USD', 0.001)).toThrow();
  });

  it('round-trips the exact authorized total for typical mandate amounts (no hidden rounding)', () => {
    for (const [currency, minor] of [
      ['USD', 500], // the default smoke amount
      ['USD', 2_000], // the smoke hard cap
      ['EUR', 128_500],
      ['BHD', 7],
    ] as const) {
      expect(majorUnitsToMinor(currency, minorToMajorUnits(currency, minor))).toBe(minor);
    }
  });
});
