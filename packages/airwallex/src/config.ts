/**
 * Airwallex adapter configuration (issue #5; R3 CTO review P0-1).
 *
 * Credentials are read from the SERVER environment only (never committed,
 * never logged, never returned in any view). The adapter is DISABLED unless
 * AIRWALLEX_ENV=sandbox AND both credentials are present — until then the
 * worker seam stays dark and the system honestly reports "disabled".
 *
 * Credential exfiltration boundary: while sandbox credentials are enabled,
 * credential-bearing traffic is locked to the single approved HTTPS sandbox
 * origin. Any AIRWALLEX_BASE_URL override other than the exact sandbox
 * origin is a startup error, so a misconfigured or hostile override can
 * never receive the Authorization header. Cross-origin redirects are
 * additionally blocked at the transport (redirect: 'error' + origin check).
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
  /** The ONLY origin credential-bearing requests may be delivered to. */
  readonly baseUrl: string;
  readonly allowedOrigin: string;
  readonly clientId: string | null;
  readonly apiKey: string | null;
  /** Milliseconds before an HTTP request is abandoned (ambiguous → status-unknown). */
  readonly requestTimeoutMs: number;
  /** Bounded retries for idempotent GETs only (429/5xx backoff). */
  readonly idempotentReadRetries: number;
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
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

  const override = (env.AIRWALLEX_BASE_URL ?? '').trim();
  let baseUrl = SANDBOX_BASE_URL;
  if (override !== '') {
    if (!wantsSandbox || !hasCredentials) {
      // No credentials are in play; a non-default base is only meaningful for
      // future test tooling — still require HTTPS to avoid normalizing bad input.
      if (!isHttpsUrl(override)) {
        throw new Error(`AIRWALLEX_BASE_URL must be an HTTPS URL (got "${override}").`);
      }
      baseUrl = override;
    } else {
      // Credentials ARE enabled: lock traffic to the approved sandbox origin.
      // Any other destination — including lookalikes and plain-HTTP URLs — is
      // an exfiltration risk and refuses startup.
      if (override !== SANDBOX_BASE_URL) {
        throw new Error(
          `AIRWALLEX_BASE_URL="${override}" is not allowed while sandbox credentials are configured. Credential-bearing traffic is restricted to the approved sandbox origin ${SANDBOX_BASE_URL}; remove the override to proceed.`,
        );
      }
      baseUrl = override;
    }
  }

  return {
    enabled: wantsSandbox && hasCredentials,
    environment: wantsSandbox && hasCredentials ? 'sandbox' : 'disabled',
    baseUrl,
    allowedOrigin: new URL(baseUrl).origin,
    clientId,
    apiKey,
    requestTimeoutMs: 15_000,
    idempotentReadRetries: 3,
  };
}
