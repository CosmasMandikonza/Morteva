/**
 * MOTERVA financial domain — pure, typed, no I/O.
 * Single owner of money representation and shared read-model contracts (docs/07).
 */
export type { CurrencyCode, Money, MoneyErrorCode } from './money.js';
export {
  MoneyError,
  addMoney,
  createMoney,
  currencyExponent,
  fromMajorString,
  subMoney,
  supportedCurrencies,
  toMajorString,
  zeroMoney,
} from './money.js';

export type {
  ProviderEnvironment,
  ProviderMode,
  ProviderStatusView,
  SystemStatusView,
} from './system.js';
