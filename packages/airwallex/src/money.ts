/**
 * Major/minor unit conversion at the Airwallex boundary (issue #5).
 *
 * The Airwallex API exchanges amounts as JSON numbers in MAJOR units
 * ("100 is one hundred dollars" — builder guide). Internal ledger money is
 * integer MINOR units. Conversion rules:
 *
 *  - outbound: minor → exact decimal string via the domain (no float math),
 *    then to a JS number ONLY at the JSON serialization edge (JS numbers
 *    round-trip through JSON.stringify via their shortest representation, so
 *    12.34 serializes as "12.34" — the provider parses the exact decimal);
 *  - inbound: provider number → String() → domain fromMajorString, which
 *    REJECTS more decimals than the currency exponent allows and any
 *    non-canonical decimal (e.g. 0.30000000000000004 fails closed).
 */
import { createMoney, currencyExponent, fromMajorString, toMajorString } from '@moterva/domain';
import type { Money } from '@moterva/domain';

/** Minor units → Airwallex major-unit payload value. Throws on unsafe amounts. */
export function minorToMajorUnits(currency: string, minorUnits: number): number {
  const money = createMoney(currency, minorUnits);
  const majorString = toMajorString(money);
  const value = Number(majorString);
  if (!Number.isFinite(value)) {
    throw new Error(
      `converted major amount ${majorString} ${currency} is not finite; refusing to send`,
    );
  }
  return value;
}

/** Airwallex major-unit value → exact minor units. Fails closed on drift. */
export function majorUnitsToMinor(currency: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`provider amount for ${currency} is not a finite number: ${String(value)}`);
  }
  // String(number) yields the shortest round-trip decimal; fromMajorString
  // then enforces the currency exponent exactly.
  return fromMajorString(currency, String(value)).minorUnits;
}

/** Convenience: provider value → domain Money. */
export function majorUnitsToMoney(currency: string, value: unknown): Money {
  return createMoney(currency, majorUnitsToMinor(currency, value));
}

/** Sanity for tests: exponent table reachable. */
export function exponentOf(currency: string): number {
  return currencyExponent(currency);
}
