/**
 * Financial display formatting (ADR 0004 + R3 P0-1): explicit currency codes
 * always, tabular mono numerals (the .mv-num class), integer minor units in,
 * major units out — via ONE shared exact minor-unit contract:
 *
 *  - the exponent comes from the domain's fail-closed ISO-4217 table
 *    (USD 2, JPY 0, KWD/BHD 3, USDZ 2 — see packages/domain/src/money.ts,
 *    which also anchors the server-side ledger);
 *  - minor→major conversion is string/BigInt arithmetic — binary floating
 *    point never touches a displayed amount, so amounts up to (and beyond)
 *    the maximum safe integer render exactly;
 *  - unknown currency codes fail closed: no exponent is guessed, no amount
 *    is rendered with an invented precision;
 *  - no rounding that could change the apparent authorized amount (the
 *    minor-unit integer IS the authorized amount; formatting is exact).
 */
/**
 * Browser-local mirror of the domain exponent table
 * (packages/domain/src/money.ts — USD 2, JPY 0, KWD/BHD 3, USDZ 2 …).
 * The domain barrel imports node:crypto and cannot ship to the browser, so
 * the table is mirrored here and KEPT IN LOCKSTEP BY TEST:
 * apps/web/test/format.test.ts asserts parity with the domain table for
 * every supported code and identical fail-closed behavior for unknown ones
 * — drift fails CI before any user sees a wrong amount.
 */
const EXPONENTS: Readonly<Record<string, number>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  AUD: 2,
  CAD: 2,
  CHF: 2,
  SGD: 2,
  HKD: 2,
  NZD: 2,
  MXN: 2,
  AED: 2,
  SAR: 2,
  INR: 2,
  CNY: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  PLN: 2,
  ZAR: 2,
  JPY: 0,
  USDZ: 2,
  KWD: 3,
  BHD: 3,
};

class CurrencyPrecisionError extends Error {
  constructor(
    readonly code: 'UNSUPPORTED_CURRENCY' | 'NOT_AN_INTEGER' | 'INVALID_EXPONENT',
    message: string,
  ) {
    super(message);
    this.name = 'CurrencyPrecisionError';
  }
}

/** Fail-closed exponent lookup (mirrors domain currencyExponent). */
function exponentFor(code: string): number {
  const normalized = code.trim().toUpperCase();
  const exponent = EXPONENTS[normalized];
  if (exponent === undefined) {
    throw new CurrencyPrecisionError(
      'UNSUPPORTED_CURRENCY',
      `Currency "${code}" has no registered minor-unit precision; refusing to render an invented one.`,
    );
  }
  return exponent;
}

const GROUPER = new Intl.NumberFormat('en-US', { useGrouping: true, maximumFractionDigits: 0 });

/** Group the whole-part digits with thousands separators (digits only in). */
function groupDigits(digits: string): string {
  return GROUPER.format(BigInt(digits));
}

/** Exact minor-units → major-units string for a KNOWN exponent.
 *  Non-integer minor values and out-of-range exponents are refused. */
export function formatMinorUnits(minor: number, exponent: number): string {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 8) {
    throw new CurrencyPrecisionError(
      'INVALID_EXPONENT',
      `currency exponent must be an integer in [0..8] (got ${String(exponent)})`,
    );
  }
  if (!Number.isInteger(minor)) {
    throw new CurrencyPrecisionError(
      'NOT_AN_INTEGER',
      `minorUnits must be an integer (got ${String(minor)}); fractional minor units are never valid`,
    );
  }
  const sign = minor < 0 ? '-' : '';
  const abs = BigInt(Math.abs(minor)); // exact: |minor| ≤ MAX_SAFE_INTEGER
  const scale = 10n ** BigInt(exponent);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(exponent, '0');
  if (exponent === 0) return `${sign}${groupDigits(whole.toString())}`;
  return `${sign}${groupDigits(whole.toString())}.${frac}`;
}

/** `CODE d.dd(dd)` with the domain's exponent for the code.
 *  Unknown/unsupported codes FAIL CLOSED (throws) — never renders an
 *  invented precision. */
export function money(currency: string, minor: number): string {
  const exponent = exponentFor(currency);
  return `${currency.toUpperCase()} ${formatMinorUnits(minor, exponent)}`;
}

/** Fail-open wrapper for server-driven display paths (rows rendered from
 *  persisted data whose currency set may grow before this table does):
 *  an unknown code renders an honest unrenderable marker instead of an
 *  invented precision, and never throws into a blank component. */
export function safeMoney(currency: string, minor: number): string {
  try {
    return money(currency, minor);
  } catch (error) {
    if (error instanceof CurrencyPrecisionError && error.code === 'UNSUPPORTED_CURRENCY') {
      return `${currency.toUpperCase()} — unsupported currency precision`;
    }
    throw error;
  }
}

/** Grouped major string for a currency (e.g. envelope `150,000.00`). */
export function moneyAmount(currency: string, minor: number): string {
  return formatMinorUnits(minor, exponentFor(currency));
}

/** Parse a user-entered MAJOR-unit string into exact minor units for a
 *  currency, honoring its exponent: more decimals than the exponent is
 *  rejected (never rounded), no floats. Returns null for empty/invalid input. */
export function parseMajorToMinor(currency: string, majorText: string): number | null {
  const exponent = exponentFor(currency);
  const text = majorText.trim().replace(/,/g, '');
  if (text === '') return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) return null;
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2] ?? '0';
  const fracRaw = match[3] ?? '';
  if (fracRaw.length > exponent) return null; // reject rather than round
  const frac = fracRaw.padEnd(exponent, '0');
  const minor = sign * BigInt(whole + frac);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < -BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(minor);
}

export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.round((part / whole) * 100));
}

export function parseJsonArray(raw: string | null): readonly string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return (
    new Intl.DateTimeFormat('en-GB', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    }).format(date) + ' UTC'
  );
}

/** Compact display form for long ledger IDs; the full ID stays one hover away. */
export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 11)}…` : id;
}
