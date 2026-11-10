/**
 * *USDZ money semantics — replicating the VERIFIED behavior of the official
 * `@metalntwx/metal-pay` (dist/networks.js `baseUnits`/`formatUsdz`):
 * 18 decimals, dollar-decimal strings → exact base units, and a HARD refusal
 * of more fractional digits than the token has ("money is never rounded").
 * Implemented as a pure local module so the invariant tests need no network
 * and no dependency; the official client enforces the same rules at signing.
 */

export class UsdzError extends Error {
  constructor(
    readonly code:
      'INVALID_DECIMAL' | 'TOO_MANY_DECIMALS' | 'NOT_POSITIVE' | 'NEGATIVE' | 'NOT_BASE_UNITS',
    message: string,
  ) {
    super(message);
    this.name = 'UsdzError';
  }
}

export const USDZ_DECIMALS = 18;

/** Decimal *USDZ string → exact base-unit decimal string. Extra fractional digits are REJECTED. */
export function usdzToBaseUnits(amount: string): string {
  const text = amount.trim().replace(/^\$/, '');
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) {
    throw new UsdzError('INVALID_DECIMAL', `not a decimal *USDZ amount: ${amount}`);
  }
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > USDZ_DECIMALS) {
    throw new UsdzError(
      'TOO_MANY_DECIMALS',
      `*USDZ has ${String(USDZ_DECIMALS)} decimals; ${text} has ${String(fraction.length)} — money is never rounded`,
    );
  }
  return (
    BigInt(whole) * 10n ** BigInt(USDZ_DECIMALS) +
    BigInt(fraction.padEnd(USDZ_DECIMALS, '0') || '0')
  ).toString();
}

/** Exact base-unit decimal string → human *USDZ decimal (trailing zeros trimmed). */
export function usdzFromBaseUnits(baseUnits: string): string {
  if (!/^\d+$/.test(baseUnits.trim())) {
    throw new UsdzError('NOT_BASE_UNITS', `not a base-unit amount: ${baseUnits}`);
  }
  const units = BigInt(baseUnits.trim());
  const scale = 10n ** BigInt(USDZ_DECIMALS);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(USDZ_DECIMALS, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/** A payment amount must be strictly positive: zero and negative are not payments. */
export function requirePositiveBaseUnits(baseUnits: string): string {
  if (!/^\d+$/.test(baseUnits.trim())) {
    throw new UsdzError('NOT_BASE_UNITS', `not a base-unit amount: ${baseUnits}`);
  }
  if (BigInt(baseUnits.trim()) <= 0n) {
    throw new UsdzError('NOT_POSITIVE', 'a payment amount must be strictly positive');
  }
  return baseUnits.trim();
}
