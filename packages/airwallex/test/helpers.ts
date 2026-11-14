/**
 * Shared test helper: an ENABLED sandbox-shaped config for the offline
 * fixture. The client's login law (2026-11-11 live proof) requires real
 * credential headers on /authentication/login — a header-less POST is
 * rejected at the provider edge — so fixture tests must construct clients
 * with a credential-carrying (fixture) config, never the disabled
 * `loadAirwallexConfig({})` shape. Fixture values are not secrets.
 */
import { SANDBOX_BASE_URL } from '../src/config.js';
import type { AirwallexAdapterConfig } from '../src/config.js';

export const FIXTURE_CLIENT_ID = 'fixture-client-id';
export const FIXTURE_API_KEY = 'fixture-api-key';

export function fixtureClientConfig(): AirwallexAdapterConfig {
  return {
    enabled: true,
    environment: 'sandbox',
    baseUrl: SANDBOX_BASE_URL,
    allowedOrigin: new URL(SANDBOX_BASE_URL).origin,
    clientId: FIXTURE_CLIENT_ID,
    apiKey: FIXTURE_API_KEY,
    requestTimeoutMs: 5_000,
    idempotentReadRetries: 0,
  };
}
