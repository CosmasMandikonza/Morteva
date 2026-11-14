import { describe, expect, it } from 'vitest';
import {
  formatMinorUnits,
  money,
  moneyAmount,
  parseMajorToMinor,
  safeMoney,
} from '../src/lib/format';

/**
 * R3 P0-1 regression contract: ONE exact minor-unit formatter with the
 * domain's fail-closed exponent table (USD 2, JPY 0, KWD/BHD 3, USDZ 2).
 * The old formatter divided by 100 with 2 forced decimals — JPY 100 minor
 * displayed "JPY 1.00" instead of "JPY 100", KWD 1000 minor displayed
 * "KWD 10.00" instead of "KWD 1.000". These tests fail against that code.
 */
describe('exact minor-unit formatting (R3 P0-1)', () => {
  it('USD uses 2 decimals', () => {
    expect(money('USD', 900_719_925_474)).toBe('USD 9,007,199,254.74');
    expect(money('usd', 1)).toBe('USD 0.01');
    expect(money('USD', 0)).toBe('USD 0.00');
  });

  it('JPY uses 0 decimals (100 minor = JPY 100, never JPY 1.00)', () => {
    expect(money('JPY', 100)).toBe('JPY 100');
    expect(money('JPY', 0)).toBe('JPY 0');
    expect(money('JPY', 1_000_000)).toBe('JPY 1,000,000');
    expect(money('jpy', -500)).toBe('JPY -500');
  });

  it('KWD and BHD use 3 decimals (1000 minor = 1.000, never 10.00)', () => {
    expect(money('KWD', 1000)).toBe('KWD 1.000');
    expect(money('kwd', 1)).toBe('KWD 0.001');
    expect(money('BHD', 1234)).toBe('BHD 1.234');
    expect(money('BHD', 100_000_000)).toBe('BHD 100,000.000');
  });

  it('USDZ uses the registered token precision (2, on-chain verified)', () => {
    expect(money('USDZ', 250_000)).toBe('USDZ 2,500.00');
    expect(money('USDZ', 1)).toBe('USDZ 0.01');
  });

  it('maximum safe integer renders exactly (no float loss)', () => {
    const max = Number.MAX_SAFE_INTEGER; // 9_007_199_254_740_991 minor units
    expect(money('USD', max)).toBe('USD 90,071,992,547,409.91');
    expect(formatMinorUnits(max, 2)).toBe('90,071,992,547,409.91');
    expect(formatMinorUnits(max, 0)).toBe('9,007,199,254,740,991');
    expect(formatMinorUnits(max, 3)).toBe('9,007,199,254,740.991');
  });

  it('negative and zero values render exactly with sign', () => {
    expect(money('USD', -12_345)).toBe('USD -123.45');
    expect(money('JPY', -7)).toBe('JPY -7');
    expect(money('KWD', 0)).toBe('KWD 0.000');
    expect(money('USD', -1)).toBe('USD -0.01');
  });

  it('unknown currency codes FAIL CLOSED — no invented 2-decimal render', () => {
    expect(() => money('XYZ', 100)).toThrow(/precision|integer/);
    expect(() => money('X', 100)).toThrow(/precision|integer/);
    // fail-open display wrapper renders an honest marker, never "XYZ 1.00"
    expect(safeMoney('XYZ', 100)).toBe('XYZ — unsupported currency precision');
    expect(safeMoney('USD', 100)).toBe('USD 1.00');
  });

  it('lowercase codes normalize to the canonical upper-case display', () => {
    expect(money('jpy', 5)).toBe('JPY 5');
    expect(money('usdz', 5)).toBe('USDZ 0.05');
  });

  it('moneyAmount honors the exponent for grouped envelope strings', () => {
    expect(moneyAmount('USD', 150_000_00)).toBe('150,000.00');
    expect(moneyAmount('JPY', 150_000)).toBe('150,000');
    expect(moneyAmount('KWD', 1_500_000)).toBe('1,500.000');
  });

  it('non-integer minor units are refused (no fractional minor units)', () => {
    expect(() => money('USD', 10.5)).toThrow(/precision|integer/);
    expect(() => formatMinorUnits(Number.NaN, 2)).toThrow(/precision|integer/);
  });

  it('parseMajorToMinor honors the exponent and never rounds', () => {
    expect(parseMajorToMinor('USD', '1,500.25')).toBe(150_025);
    expect(parseMajorToMinor('USD', '0.1')).toBe(10);
    expect(parseMajorToMinor('JPY', '150000')).toBe(150_000);
    expect(parseMajorToMinor('JPY', '150.5')).toBeNull(); // JPY has no decimals — reject, never round
    expect(parseMajorToMinor('KWD', '1.234')).toBe(1234);
    expect(parseMajorToMinor('KWD', '1.2345')).toBeNull(); // 4 decimals > KWD exponent
    expect(parseMajorToMinor('USD', '90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER); // exactly safe
    expect(parseMajorToMinor('USD', '900719925474099.1')).toBeNull(); // beyond safe integer
    expect(parseMajorToMinor('USD', '')).toBeNull();
    expect(parseMajorToMinor('USD', 'abc')).toBeNull();
    expect(parseMajorToMinor('USD', '-42.10')).toBe(-4210);
  });

  it('every rendered string keeps the currency code adjacent (ADR 0004)', () => {
    expect(money('EUR', 5).startsWith('EUR ')).toBe(true);
    expect(money('USDZ', 5).startsWith('USDZ ')).toBe(true);
  });
});

import { currencyExponent, supportedCurrencies } from '@moterva/domain';

/**
 * Parity contract: the browser-local EXPONENTS table must stay in lockstep
 * with the domain's fail-closed table (packages/domain/src/money.ts). The
 * domain barrel imports node:crypto and cannot ship to the browser, so this
 * test IS the drift guard — a table change on either side fails here first.
 */
describe('browser exponent table parity with the domain (R3 P0-1 drift guard)', () => {
  it('every domain-supported currency has the exact same exponent in the web table', () => {
    for (const code of supportedCurrencies()) {
      expect(
        (() => {
          try {
            return money(code, 1);
          } catch {
            return 'UNSUPPORTED';
          }
        })(),
      ).not.toBe('UNSUPPORTED');
      // money() renders via the web table; currencyExponent() is the domain truth:
      const exponent = currencyExponent(code);
      expect(
        money(code, 1).includes((1 / 10 ** exponent).toFixed(exponent).slice(2) || ''),
        `${code} exponent mismatch`,
      ).toBe(true);
    }
  });

  it('unknown codes are rejected identically by web and domain', () => {
    expect(() => money('NOPE', 1)).toThrow(/no registered minor-unit precision/); // fail-closed core
    expect(safeMoney('NOPE', 1)).toBe('NOPE — unsupported currency precision'); // fail-open display wrapper
    expect(() => currencyExponent('NOPE')).toThrow(/NOPE/);
  });

  it('spot-check the R3 counterexample currencies against the domain', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('BHD')).toBe(3);
    expect(currencyExponent('USDZ')).toBe(2);
    expect(money('JPY', 100)).toBe('JPY 100');
    expect(money('KWD', 1000)).toBe('KWD 1.000');
  });
});
