/**
 * OIDC client wrapper (MTV-19) — thin, audited boundary around
 * `openid-client` (the maintained standards-only implementation).
 *
 * Guarantees enforced HERE (never by callers):
 *  - Authorization Code Flow with PKCE (S256) — response_type=code only.
 *  - ID-token validation: issuer, audience, signature (alg allowlist via the
 *    client metadata), expiry — performed by openid-client per spec; the
 *    nonce is checked through `expectedNonce` against the server-side flow
 *    record. No unverified claim is ever used.
 *  - The token exchange URL is built from the CONFIGURED redirect URI plus
 *    the callback query — never from the request's Host/X-Forwarded-Host, so
 *    host-header injection cannot redirect the code.
 *  - Only whitelisted claims (sub, email, name) are surfaced to the app; the
 *    IdP never supplies roles, org ids or permissions.
 */
import * as oidc from 'openid-client';
import type { IdentityConfig } from './config.js';

export interface OidcIdentity {
  /** The IdP's stable subject — the ONLY identity key. */
  subject: string;
  /** Informational email claim; never an authorization input. */
  email: string | null;
  /** Informational name claim. */
  name: string | null;
  /** Canonical issuer the token came from (already validated by the client). */
  issuer: string;
}

export class OidcProtocolError extends Error {
  constructor(
    readonly code:
      | 'OIDC_ISSUER_UNAVAILABLE'
      | 'OIDC_CALLBACK_INVALID'
      | 'OIDC_STATE_MISMATCH'
      | 'OIDC_NONCE_MISMATCH'
      | 'OIDC_TOKEN_INVALID'
      | 'OIDC_CODE_INVALID'
      | 'OIDC_PROVIDER_ERROR'
      | 'OIDC_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'OidcProtocolError';
  }
}

export interface OidcClient {
  readonly issuer: string;
  /** Fresh state/nonce/PKCE triple for one authorization-code flow. */
  beginFlow(redirectUri: string): Promise<{
    authorizationUrl: string;
    state: string;
    nonce: string;
    codeVerifier: string;
  }>;
  /**
   * Exchanges the callback response for verified claims. `expectedState` /
   * `expectedNonce` / verifier come from the consumed server-side flow row.
   * Throws OidcProtocolError with a machine code on ANY protocol failure.
   */
  completeFlow(input: {
    callbackQuery: Record<string, string | string[] | undefined>;
    expectedState: string;
    expectedNonce: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OidcIdentity>;
}

/** Discovery timeout so a dead IdP fails the login attempt fast and clean. */
const DISCOVERY_TIMEOUT_MS = 5_000;
const TOKEN_TIMEOUT_MS = 10_000;

export async function createOidcClient(identity: IdentityConfig): Promise<OidcClient> {
  const server = new URL(identity.issuer);
  let config: oidc.Configuration;
  try {
    config = await withDeadline(
      oidc.discovery(
        server,
        identity.clientId,
        {
          client_secret: identity.clientSecret,
          token_endpoint_auth_method: 'client_secret_basic',
          // Alg allowlist: the ID token MUST be signed with the configured
          // algorithm; anything else (incl. HS256/none) is rejected.
          id_token_signed_response_alg: identity.idTokenAlg,
          [oidc.clockTolerance]: identity.clockToleranceSec,
        },
        undefined,
        {
          // Plain HTTP only for the strictly-local test IdP (config-validated).
          ...(identity.insecureTransport ? { execute: [oidc.allowInsecureRequests] } : {}),
        },
      ),
      DISCOVERY_TIMEOUT_MS,
      'OIDC_ISSUER_UNAVAILABLE',
    );
  } catch (error) {
    if (error instanceof OidcProtocolError) throw error;
    throw new OidcProtocolError(
      'OIDC_ISSUER_UNAVAILABLE',
      `identity provider discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    issuer: identity.issuer,

    async beginFlow(redirectUri: string) {
      const state = oidc.randomPKCECodeVerifier();
      const nonce = oidc.randomPKCECodeVerifier();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const challenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const authorizationUrl = oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        client_id: identity.clientId,
        response_type: 'code',
        scope: identity.scopes,
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      return { authorizationUrl: authorizationUrl.href, state, nonce, codeVerifier };
    },

    async completeFlow(input) {
      const query = input.callbackQuery;
      const error = query['error'];
      if (typeof error === 'string' && error !== '') {
        throw new OidcProtocolError('OIDC_PROVIDER_ERROR', `identity provider returned ${error}`);
      }
      const code = query['code'];
      if (typeof code !== 'string' || code === '') {
        throw new OidcProtocolError(
          'OIDC_CALLBACK_INVALID',
          'authorization response carries no code',
        );
      }
      // Rebuild the exchange URL from the CONFIGURED redirect URI so the
      // request's Host header is irrelevant.
      const callbackUrl = new URL(input.redirectUri);
      for (const [key, value] of Object.entries(query)) {
        if (typeof value === 'string') callbackUrl.searchParams.set(key, value);
      }
      let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
      try {
        tokens = await withDeadline(
          oidc.authorizationCodeGrant(config, callbackUrl, {
            expectedState: input.expectedState,
            expectedNonce: input.expectedNonce,
            pkceCodeVerifier: input.codeVerifier,
            idTokenExpected: true,
          }),
          TOKEN_TIMEOUT_MS,
          'OIDC_UNAVAILABLE',
        );
      } catch (error) {
        if (error instanceof OidcProtocolError) throw error;
        throw mapGrantError(error);
      }
      const claims = tokens.claims();
      if (claims === undefined) {
        throw new OidcProtocolError('OIDC_TOKEN_INVALID', 'no verified ID-token claims returned');
      }
      const subject = typeof claims.sub === 'string' ? claims.sub : '';
      if (subject === '') {
        throw new OidcProtocolError('OIDC_TOKEN_INVALID', 'ID token carries no subject');
      }
      return {
        subject,
        email: typeof claims.email === 'string' && claims.email !== '' ? claims.email : null,
        name: typeof claims.name === 'string' && claims.name !== '' ? claims.name : null,
        issuer: claims.iss ?? identity.issuer,
      };
    },
  };
}

/** Deadline wrapper so a hung IdP fails the attempt cleanly, not forever. */
async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  code: OidcProtocolError['code'],
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new OidcProtocolError(code, 'identity provider did not respond in time')),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function mapGrantError(error: unknown): OidcProtocolError {
  // openid-client throws typed OAuth2/RP errors; map to machine codes without
  // leaking provider internals beyond the error code string.
  const asRecord = error as { error?: unknown; message?: unknown } | null;
  const oauthCode = typeof asRecord?.error === 'string' ? asRecord.error : '';
  const message = typeof asRecord?.message === 'string' ? asRecord.message : String(error);
  switch (oauthCode) {
    case 'invalid_grant':
      // Covers an expired code, an already-used code and PKCE mismatch.
      return new OidcProtocolError(
        'OIDC_CODE_INVALID',
        'authorization code rejected by the identity provider',
      );
    case 'invalid_client':
    case 'invalid_request':
      return new OidcProtocolError('OIDC_TOKEN_INVALID', 'token exchange rejected');
    case 'access_denied':
      return new OidcProtocolError(
        'OIDC_PROVIDER_ERROR',
        'sign-in was denied by the identity provider',
      );
    default:
      break;
  }
  const text = message.toLowerCase();
  if (text.includes('state'))
    return new OidcProtocolError('OIDC_STATE_MISMATCH', 'authorization state mismatch');
  if (text.includes('nonce'))
    return new OidcProtocolError('OIDC_NONCE_MISMATCH', 'ID-token nonce mismatch');
  if (
    text.includes('timed out') ||
    text.includes('fetch failed') ||
    text.includes('econnrefused')
  ) {
    return new OidcProtocolError('OIDC_UNAVAILABLE', 'identity provider is unreachable');
  }
  return new OidcProtocolError('OIDC_TOKEN_INVALID', 'ID-token validation failed');
}
