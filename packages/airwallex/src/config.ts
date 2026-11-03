/**
 * Airwallex adapter configuration (issue #5).
 *
 * Credentials are read from the SERVER environment only (never committed,
 * never logged, never returned in any view). The adapter is DISABLED unless
 * AIRWALLEX_ENV=sandbox AND both credentials are present — until then the
 * worker seam stays dark and the system honestly reports "disabled".
 *
 * Verified against the official reference (2026-08-21 API version):
 *   sandbox base https://api.sandbox.airwallex.com, prod https://api.airwallex.com
 */
export const SANDBOX_BASE_URL = 'https://api.sandbox.airwallex.com';
export const PRODUCTION_BASE_URL = 'https://api.airwallex.com';

export interface AirwallexEnv {
  readonly AIRWALLEX_ENV?: string;
  readonly AIRWALLEX_BASE_URL?: string;
  readonly AIRWALLEX_CLIENT_ID?: string;
  readonly AIRWALLEX_API_KEY?: string;
  /** Optional: Airwallex beneficiary id used by smoke tooling (not a secret, but env-only). */
  readonly AIRWALLEX_SANDBOX_BENEFICIARY_ID?: string;
}

export interface AirwallexAdapterConfig {
  readonly enabled: boolean;
  readonly environment: 'sandbox' | 'disabled';
  readonly baseUrl: string;
  readonly clientId: string | null;
  readonly apiKey: string | null;
  /** Milliseconds before an HTTP request is abandoned (ambiguous → status-unknown). */
  readonly requestTimeoutMs: number;
  /** Bounded retries for idempotent GETs only (429/5xx backoff). */
  readonly idempotentReadRetries: number;
}

export function loadAirwallexConfig(env: AirwallexEnv = process.env): AirwallexAdapterConfig {
  const environmentTag = (env.AIRWALLEX_ENV ?? '').trim().toLowerCase();
  const clientId = (env.AIRWALLEX_CLIENT_ID ?? '').trim() || null;
  const apiKey = (env.AIRWALLEX_API_KEY ?? '').trim() || null;
  if (environmentTag !== '' && environmentTag !== 'sandbox') {
    // Only the sandbox environment is implemented; anything else fails closed.
    throw new Error(
      `AIRWALLEX_ENV="${environmentTag}" is not supported. This adapter implements the SANDBOX environment only (issue #5); leave AIRWALLEX unset to keep the rail disabled.`,
    );
  }
  const wantsSandbox = environmentTag === 'sandbox';
  const hasCredentials = clientId !== null && apiKey !== null;
  if (wantsSandbox && !hasCredentials) {
    throw new Error(
      'AIRWALLEX_ENV=sandbox requires AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY in the server environment. Without credentials the rail stays disabled (never half-configured).',
    );
  }
  return {
    enabled: wantsSandbox && hasCredentials,
    environment: wantsSandbox && hasCredentials ? 'sandbox' : 'disabled',
    baseUrl: (env.AIRWALLEX_BASE_URL ?? '').trim() || SANDBOX_BASE_URL,
    clientId,
    apiKey,
    requestTimeoutMs: 15_000,
    idempotentReadRetries: 3,
  };
}
