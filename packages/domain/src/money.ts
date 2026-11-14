/**
 * Money — integer minor units paired with an ISO 4217 currency.
 *
 * Invariants (docs/05, "Non-negotiable invariants" #3):
 *  - internal amounts are safe integers in minor units;
 *  - major-unit conversion happens only via explicit string parsing/formatting
 *    (provider payloads such as Airwallex's use major units);
 *  - binary floating point is never used for money math.
 *
 * The currency table is intentionally explicit and fail-closed: an unknown
 * currency throws instead of guessing an exponent. Extend the table deliberately.
 */

export type CurrencyCode = string;

export type MoneyErrorCode =
  | 'UNSUPPORTED_CURRENCY'
  | 'NOT_AN_INTEGER'
  | 'UNSAFE_INTEGER'
  | 'INVALID_DECIMAL_STRING'
  | 'TOO_MANY_DECIMAL_PLACES'
  | 'CURRENCY_MISMATCH'
  | 'OVERFLOW';

export class MoneyError extends Error {
  constructor(
    readonly code: MoneyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}

interface CurrencySpec {
  readonly exponent: number;
}

/** Common ISO 4217 currencies for the hackathon scope; exponent = minor-unit digits. */
const CURRENCIES: Readonly<Record<string, CurrencySpec>> = {
  USD: { exponent: 2 },
  EUR: { exponent: 2 },
  GBP: { exponent: 2 },
  AUD: { exponent: 2 },
  CAD: { exponent: 2 },
  CHF: { exponent: 2 },
  SGD: { exponent: 2 },
  HKD: { exponent: 2 },
  NZD: { exponent: 2 },
  MXN: { exponent: 2 },
  AED: { exponent: 2 },
  SAR: { exponent: 2 },
  INR: { exponent: 2 },
  CNY: { exponent: 2 },
  SEK: { exponent: 2 },
  NOK: { exponent: 2 },
  DKK: { exponent: 2 },
  PLN: { exponent: 2 },
  ZAR: { exponent: 2 },
  JPY: { exponent: 0 },
  // Token ledger (MTV-19 / ADR 0007): Metal testnet USDZ, 2 decimals as
  // verified on-chain by the adapter before registration.
  USDZ: { exponent: 2 },
  KWD: { exponent: 3 },
  BHD: { exponent: 3 },
};

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export function supportedCurrencies(): readonly CurrencyCode[] {
  return Object.keys(CURRENCIES).sort();
}

function normalizeCode(code: string): CurrencyCode {
  return code.trim().toUpperCase();
}

export function currencyExponent(code: string): number {
  const normalized = normalizeCode(code);
  const spec = CURRENCIES[normalized];
  if (!spec) {
    throw new MoneyError(
      'UNSUPPORTED_CURRENCY',
      `Currency "${code}" is not in the supported table [${supportedCurrencies().join(', ')}]. Add it deliberately with its exact exponent.`,
    );
  }
  return spec.exponent;
}

/** A monetary amount: integer minor units of a supported currency. */
export interface Money {
  readonly currency: CurrencyCode;
  readonly minorUnits: number;
}

export function createMoney(currency: string, minorUnits: number): Money {
  const normalized = normalizeCode(currency);
  currencyExponent(normalized);
  if (!Number.isInteger(minorUnits)) {
    throw new MoneyError(
      'NOT_AN_INTEGER',
      `minorUnits must be an integer (got ${String(minorUnits)}); fractional minor units or non-numbers are never valid.`,
    );
  }
  if (Math.abs(minorUnits) > MAX_SAFE) {
    throw new MoneyError(
      'UNSAFE_INTEGER',
      `minorUnits ${String(minorUnits)} exceeds the safe integer range; refuse to represent money lossily.`,
    );
  }
  return { currency: normalized, minorUnits };
}

/**
 * Parse a human/provider-style major-unit decimal string (e.g. "12.34" USD)
 * into minor units. Uses string math only; parseFloat/Number on the whole
 * string is forbidden here because binary floats cannot represent 0.01.
 */
export function fromMajorString(currency: string, value: string): Money {
  const normalized = normalizeCode(currency);
  const exponent = currencyExponent(normalized);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MoneyError(
      'INVALID_DECIMAL_STRING',
      `Expected a decimal string like "12.34", got: ${String(value)}`,
    );
  }
  const match = /^(-?)(\d{1,15})(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    throw new MoneyError(
      'INVALID_DECIMAL_STRING',
      `"${value}" is not a plain decimal number like "12.34" (no thousands separators, no exponent notation).`,
    );
  }
  const sign = match[1] ?? '';
  const integerPart = match[2] ?? '0';
  const fractionPart = match[3];
  if (fractionPart !== undefined && fractionPart.length > exponent) {
    throw new MoneyError(
      'TOO_MANY_DECIMAL_PLACES',
      `${normalized} allows at most ${exponent} decimal place(s); "${value}" has ${fractionPart.length}.`,
    );
  }
  const fraction = (fractionPart ?? '').padEnd(exponent, '0');
  const minorUnitsAbs =
    Number(integerPart) * 10 ** exponent + (fraction === '' ? 0 : Number(fraction));
  if (minorUnitsAbs > MAX_SAFE) {
    throw new MoneyError(
      'OVERFLOW',
      `"${value}" ${normalized} exceeds the safe minor-unit range; refusing lossy representation.`,
    );
  }
  return createMoney(normalized, sign === '-' ? -minorUnitsAbs : minorUnitsAbs);
}

/** Format minor units as an exact major-unit decimal string (never a float). */
export function toMajorString(money: Money): string {
  const exponent = currencyExponent(money.currency);
  if (exponent === 0) {
    return String(money.minorUnits);
  }
  const sign = money.minorUnits < 0 ? '-' : '';
  const abs = Math.abs(money.minorUnits);
  const scale = 10 ** exponent;
  const major = Math.floor(abs / scale);
  const fraction = (abs % scale).toString().padStart(exponent, '0');
  return `${sign}${major}.${fraction}`;
}

function requireSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError('CURRENCY_MISMATCH', `Cannot combine ${a.currency} with ${b.currency}.`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  requireSameCurrency(a, b);
  const sum = a.minorUnits + b.minorUnits;
  if (!Number.isSafeInteger(sum)) {
    throw new MoneyError(
      'OVERFLOW',
      `Adding ${a.minorUnits} + ${b.minorUnits} ${a.currency} overflows the safe range.`,
    );
  }
  return { currency: a.currency, minorUnits: sum };
}

export function subMoney(a: Money, b: Money): Money {
  requireSameCurrency(a, b);
  const difference = a.minorUnits - b.minorUnits;
  if (!Number.isSafeInteger(difference)) {
    throw new MoneyError(
      'OVERFLOW',
      `Subtracting ${a.minorUnits} - ${b.minorUnits} ${a.currency} overflows the safe range.`,
    );
  }
  return { currency: a.currency, minorUnits: difference };
}

export function zeroMoney(currency: string): Money {
  return createMoney(currency, 0);
}
