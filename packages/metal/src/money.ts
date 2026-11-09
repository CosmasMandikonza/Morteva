/**
 * Token money helpers for the metal rail (issue #6).
 *
 * DIFFERENCE FROM AIRWALLEX, PRESERVED EXPLICITLY (task D7): Airwallex
 * exchanges amounts as JSON numbers in MAJOR units. A blockchain ERC-20
 * transfer has no provider-side unit convention — the token contract itself
 * defines base units through its on-chain `decimals()`. The metal rail's
 * INTERNAL representation is token minor units with the exponent equal to
 * the chain-verified token decimals (config-expected and on-chain
 * cross-checked at connect — see erc20.discoverToken). Conversions are exact
 * BigInt integer math; fractional minor units, zero/negative amounts and
 * values beyond 2^53-1 (the ledger's safe-integer money domain) fail closed.
 */
export class TokenMoneyError extends Error {
  constructor(
    readonly code:
      | 'NOT_AN_INTEGER'
      | 'UNSAFE_INTEGER'
      | 'NON_POSITIVE'
      | 'TOO_MANY_DECIMALS'
      | 'INVALID_DECIMAL_STRING',
    message: string,
  ) {
    super(message);
    this.name = 'TokenMoneyError';
  }
}

/** Formats a major-unit decimal string from minor units at `decimals`. */
export function minorToMajorString(minorUnits: number, decimals: number): string {
  if (!Number.isInteger(minorUnits)) {
    throw new TokenMoneyError(
      'NOT_AN_INTEGER',
      `minor units ${String(minorUnits)} is not an integer`,
    );
  }
  if (minorUnits > Number.MAX_SAFE_INTEGER || minorUnits < -Number.MAX_SAFE_INTEGER) {
    throw new TokenMoneyError(
      'UNSAFE_INTEGER',
      `minor units ${String(minorUnits)} exceeds the safe-integer money domain`,
    );
  }
  const negative = minorUnits < 0;
  const abs = BigInt(Math.abs(minorUnits));
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(decimals, '0');
  const sign = negative ? '-' : '';
  return decimals === 0 ? `${sign}${whole.toString()}` : `${sign}${whole.toString()}.${fraction}`;
}

/** Parses a major-unit decimal string into exact minor units (string math). */
export function majorStringToMinor(value: string, decimals: number): number {
  const match = /^(-?)(\d{1,15})(?:\.(\d+))?$/.exec(value);
  if (match === null) {
    throw new TokenMoneyError(
      'INVALID_DECIMAL_STRING',
      `"${value}" is not a finite decimal string`,
    );
  }
  const sign = match[1] === '-' ? -1 : 1;
  const whole = match[2] ?? '0';
  const fraction = match[3] ?? '';
  if (fraction.length > decimals) {
    throw new TokenMoneyError(
      'TOO_MANY_DECIMALS',
      `"${value}" has ${String(fraction.length)} decimals; the token supports ${String(decimals)}`,
    );
  }
  const padded = fraction.padEnd(decimals, '0');
  const minorString = (whole === '' ? '0' : whole) + padded;
  const minor = Number(minorString === '' ? '0' : minorString);
  if (minor > Number.MAX_SAFE_INTEGER) {
    throw new TokenMoneyError('UNSAFE_INTEGER', `"${value}" exceeds the safe-integer money domain`);
  }
  return sign * minor;
}

/**
 * Guards a token amount the adapter is about to move: positive integer minor
 * units within the safe-integer domain. Returns the exact base-unit BigInt
 * for the transfer calldata (internal minor exponent === token decimals).
 */
export function amountToBaseUnits(amountMinor: number): bigint {
  if (!Number.isInteger(amountMinor)) {
    throw new TokenMoneyError('NOT_AN_INTEGER', `amount ${String(amountMinor)} is not an integer`);
  }
  if (amountMinor <= 0) {
    throw new TokenMoneyError('NON_POSITIVE', `amount ${String(amountMinor)} must be positive`);
  }
  if (amountMinor > Number.MAX_SAFE_INTEGER) {
    throw new TokenMoneyError(
      'UNSAFE_INTEGER',
      `amount ${String(amountMinor)} exceeds the safe-integer money domain`,
    );
  }
  return BigInt(amountMinor);
}
