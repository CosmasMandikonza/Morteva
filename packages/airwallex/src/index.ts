/**
 * @moterva/airwallex — the Airwallex sandbox adapter (issue #5).
 *
 * DISABLED unless AIRWALLEX_ENV=sandbox plus server-side credentials are
 * configured; the offline fixture is strictly test-only. No provider success
 * is ever inferred from the fixture, and submission is never settlement.
 */
export { loadAirwallexConfig, PRODUCTION_BASE_URL, SANDBOX_BASE_URL } from './config.js';
export type { AirwallexAdapterConfig, AirwallexEnv } from './config.js';

export { normalizeTransferStatus, isTerminalStatus } from './status.js';
export type { AirwallexNormalizedStatus } from './status.js';

export {
  majorUnitsToMinor,
  majorUnitsToMoney,
  minorToMajorUnits,
  transferAmountMinorToMajor,
} from './money.js';

export { HttpTransport } from './http-transport.js';
export type { HttpTransportOptions } from './http-transport.js';

export { FixtureTransport, created, httpError, ok, unavailable } from './fixture-transport.js';
export type { FixtureScript, FixtureStep, FixtureTransfer } from './fixture-transport.js';

export {
  AirwallexClient,
  AirwallexDefinitiveRejectionError,
  parseTransferRecord,
} from './client.js';
export type { AirwallexBalance, AirwallexTransferRecord } from './client.js';

export {
  AirwallexDispatcher,
  AirwallexWebhookSignatureError,
  asSettlementScope,
  buildOfflineFixtureDispatcher,
  buildSandboxDispatcher,
  redactProviderPayload,
} from './dispatcher.js';
export type { AirwallexDispatcherDeps, ReconcileScope, SettlementScope } from './dispatcher.js';

export type { AirwallexTransport, TransportRequest, TransportResponse } from './transport.js';
export { TransportUnavailableError } from './transport.js';

export { verifyWebhookSignature } from './webhook-signature.js';
export type { WebhookSignatureVerdict } from './webhook-signature.js';

export { airwallexAdapterStatus } from './adapter-status.js';
export type { AirwallexAdapterStatusInput } from './adapter-status.js';
