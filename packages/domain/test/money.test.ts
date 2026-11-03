import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  addMoney,
  createMoney,
  currencyExponent,
  fromMajorString,
  subMoney,
  supportedCurrencies,
  toMajorString,
  zeroMoney,
} from '../src/index.js';

describe('createMoney', () => {
  it('accepts a safe integer amount of a supported currency', () => {
    expect(createMoney('USD', 1234)).toEqual({ currency: 'USD', minorUnits: 1234 });
  });

  it('normalizes currency case and surrounding whitespace', () => {
    expect(createMoney(' usd ', 5)).toEqual({ currency: 'USD', minorUnits: 5 });
  });

  it('rejects fractional minor units (float money is never valid)', () => {
    expect(() => createMoney('USD', 12.5)).toThrowError(MoneyError);
    expect(() => createMoney('USD', 0.1)).toThrowError(/must be an integer/);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => createMoney('USD', Number.NaN)).toThrowError(MoneyError);
    expect(() => createMoney('USD', Number.POSITIVE_INFINITY)).toThrowError(MoneyError);
  });

  it('rejects amounts beyond the safe integer range', () => {
    expect(() => createMoney('USD', Number.MAX_SAFE_INTEGER + 1)).toThrowError(/safe integer/);
    expect(() => createMoney('USD', -Number.MAX_SAFE_INTEGER - 1)).toThrowError(MoneyError);
  });

  it('fails closed on currencies outside the explicit table', () => {
    expect(() => createMoney('XXX', 100)).toThrowError(/UNSUPPORTED|not in the supported table/);
    expect(() => createMoney('', 100)).toThrowError(MoneyError);
  });

  it('exposes the currency exponent table used for parsing', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('BHD')).toBe(3);
    expect(supportedCurrencies()).toContain('USD');
  });
});

describe('fromMajorString (provider/human major units -> minor units)', () => {
  it('parses exact two-decimal currencies', () => {
    expect(fromMajorString('USD', '12.34')).toEqual({ currency: 'USD', minorUnits: 1234 });
    expect(fromMajorString('USD', '0.01')).toEqual({ currency: 'USD', minorUnits: 1 });
    expect(fromMajorString('USD', '100')).toEqual({ currency: 'USD', minorUnits: 10000 });
  });

  it('pads short fractions instead of using floats', () => {
    expect(fromMajorString('USD', '12.3')).toEqual({ currency: 'USD', minorUnits: 1230 });
    expect(fromMajorString('USD', '0.1')).toEqual({ currency: 'USD', minorUnits: 10 });
  });

  it('parses zero-decimal currencies and rejects fractions for them', () => {
    expect(fromMajorString('JPY', '5')).toEqual({ currency: 'JPY', minorUnits: 5 });
    expect(() => fromMajorString('JPY', '5.0')).toThrowError(/at most 0 decimal/);
    expect(() => fromMajorString('JPY', '5.5')).toThrowError(MoneyError);
  });

  it('parses three-decimal currencies', () => {
    expect(fromMajorString('BHD', '1.234')).toEqual({ currency: 'BHD', minorUnits: 1234 });
    expect(fromMajorString('KWD', '0.001')).toEqual({ currency: 'KWD', minorUnits: 1 });
    expect(() => fromMajorString('BHD', '1.2345')).toThrowError(/at most 3 decimal/);
  });

  it('rejects more decimals than the currency allows', () => {
    expect(() => fromMajorString('USD', '12.345')).toThrowError(/at most 2 decimal/);
  });

  it('keeps the sign', () => {
    expect(fromMajorString('USD', '-12.34').minorUnits).toBe(-1234);
    expect(fromMajorString('JPY', '-5').minorUnits).toBe(-5);
  });

  it('rejects malformed strings without ever calling parseFloat', () => {
    for (const bad of [
      '',
      '  ',
      '12.',
      '.5',
      '1,000',
      '1e3',
      'abc',
      '12.34.56',
      '+12.34',
      '12,34',
    ]) {
      expect(() => fromMajorString('USD', bad), `input "${bad}"`).toThrowError(MoneyError);
    }
  });

  it('rejects amounts that would overflow minor units', () => {
    expect(() => fromMajorString('USD', '90071992547409.93')).toThrowError(
      /safe minor-unit range|safe integer/,
    );
  });
});

describe('toMajorString (minor units -> exact decimal string)', () => {
  it('formats two-decimal currencies with exactly two digits', () => {
    expect(toMajorString({ currency: 'USD', minorUnits: 1234 })).toBe('12.34');
    expect(toMajorString({ currency: 'USD', minorUnits: 5 })).toBe('0.05');
    expect(toMajorString({ currency: 'USD', minorUnits: 0 })).toBe('0.00');
    expect(toMajorString({ currency: 'USD', minorUnits: -1234 })).toBe('-12.34');
  });

  it('formats zero- and three-decimal currencies exactly', () => {
    expect(toMajorString({ currency: 'JPY', minorUnits: 5 })).toBe('5');
    expect(toMajorString({ currency: 'JPY', minorUnits: -5 })).toBe('-5');
    expect(toMajorString({ currency: 'BHD', minorUnits: 1234 })).toBe('1.234');
    expect(toMajorString({ currency: 'BHD', minorUnits: 1 })).toBe('0.001');
  });

  it('round-trips every sample exactly (no float drift)', () => {
    const samples: Array<[string, string]> = [
      ['USD', '0.01'],
      ['USD', '123456.78'],
      ['USD', '-0.99'],
      ['JPY', '123456'],
      ['BHD', '999.999'],
      ['KWD', '0.125'],
    ];
    for (const [currency, major] of samples) {
      const money = fromMajorString(currency, major);
      expect(toMajorString(money)).toBe(major);
      expect(toMajorString(fromMajorString(currency, toMajorString(money)))).toBe(major);
    }
  });
});

describe('arithmetic invariants', () => {
  it('adds and subtracts in minor units', () => {
    const a = fromMajorString('USD', '1.00');
    const b = fromMajorString('USD', '2.50');
    expect(addMoney(a, b)).toEqual({ currency: 'USD', minorUnits: 350 });
    expect(subMoney(b, a)).toEqual({ currency: 'USD', minorUnits: 150 });
  });

  it('refuses to combine different currencies', () => {
    const usd = createMoney('USD', 100);
    const eur = createMoney('EUR', 100);
    expect(() => addMoney(usd, eur)).toThrowError(/Cannot combine USD with EUR/);
    expect(() => subMoney(usd, eur)).toThrowError(MoneyError);
  });

  it('detects overflow on addition', () => {
    const huge = createMoney('USD', Number.MAX_SAFE_INTEGER);
    expect(() => addMoney(huge, huge)).toThrowError(/overflows the safe range/);
  });

  it('zeroMoney is a valid neutral element', () => {
    const zero = zeroMoney('USD');
    const one = createMoney('USD', 1);
    expect(addMoney(zero, one)).toEqual(one);
    expect(subMoney(one, zero)).toEqual(one);
  });
});
