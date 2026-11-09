/**
 * Production identity configuration (MTV-19).
 *
 * Parses and validates the external OIDC identity-provider environment
 * BEFORE the server starts. Rules:
 *  - All-or-nothing: naming ANY identity variable requires ALL required ones;
 *    a partial configuration is a startup error, never a half-wired flow.
 *  - Production requires https transport for the issuer and redirect URI.
 *  - Plain-HTTP issuers are allowed ONLY with the explicit
 *    MOTERVA_OIDC_ALLOW_INSECURE_TRANSPORT escape hatch AND a loopback
 *    hostname AND a non-production NODE_ENV — this exists exclusively for the
 *    strictly-local test identity provider used by automated verification.
 *  - The client secret is a server-side credential; it is never logged,
 *    never sent to the browser, and never stored in a session.
 */
import { isLoopbackHostname } from './net.js';

export const OIDC_ENV_VARS = {
  issuer: 'MOTERVA_OIDC_ISSUER',
  clientId: 'MOTERVA_OIDC_CLIENT_ID',
  clientSecret: 'MOTERVA_OIDC_CLIENT_SECRET',
  redirectUri: 'MOTERVA_OIDC_REDIRECT_URI',
  scopes: 'MOTERVA_OIDC_SCOPES',
  idTokenAlg: 'MOTERVA_OIDC_ID_TOKEN_ALG',
  flowTtlMs: 'MOTERVA_OIDC_FLOW_TTL_MS',
  httpTimeoutMs: 'MOTERVA_OIDC_HTTP_TIMEOUT_MS',
  allowInsecure: 'MOTERVA_OIDC_ALLOW_INSECURE_TRANSPORT',
} as const;

export interface IdentityConfig {
  /** Canonical issuer URL — must match the IdP metadata `issuer` exactly. */
  readonly issuer: string;
  readonly clientId: string;
  /** Confidential-client secret. Server-side only; never exposed. */
  readonly clientSecret: string;
  /** Pre-registered exact redirect URI (no wildcards, no fragments). */
  readonly redirectUri: string;
  /** Space-separated scopes; always includes `openid`. */
  readonly scopes: string;
  /** Required ID-token signing algorithm; anything else is rejected. */
  readonly idTokenAlg: string;
  /** One authorization-code flow state lifetime (default 10 min). */
  readonly flowTtlMs: number;
  /** True ONLY for the loopback test IdP over plain HTTP (never production). */
  readonly insecureTransport: boolean;
  /** Allowed clock skew for ID-token time checks (seconds). */
  readonly clockToleranceSec: number;
  /** Client HTTP deadline for IdP calls (discovery + token exchange). */
  readonly httpTimeoutMs: number;
}

export const DEFAULT_OIDC_SCOPES = 'openid profile email';
export const DEFAULT_ID_TOKEN_ALG = 'RS256';
export const DEFAULT_FLOW_TTL_MS = 10 * 60_000;
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

function isPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return ['changeme', 'change-me', 'placeholder', 'xxx', 'replace-me'].includes(normalized);
}

/**
 * Parses identity configuration from raw env. Returns null when NO identity
 * variable is set (identity simply not deployed — the server still starts
 * with its other surfaces). Throws StartupConfigError-style issue strings
 * through the returned `issues` contract so loadConfig can aggregate them.
 */
export function parseIdentityConfig(
  env: Record<string, string | undefined>,
  nodeEnv: 'development' | 'test' | 'production',
  requestIssues: (issues: readonly string[]) => void,
): IdentityConfig | null {
  const raw = {
    issuer: (env[OIDC_ENV_VARS.issuer] ?? '').trim(),
    clientId: (env[OIDC_ENV_VARS.clientId] ?? '').trim(),
    clientSecret: env[OIDC_ENV_VARS.clientSecret] ?? '',
    redirectUri: (env[OIDC_ENV_VARS.redirectUri] ?? '').trim(),
    scopes: (env[OIDC_ENV_VARS.scopes] ?? '').trim(),
    idTokenAlg: (env[OIDC_ENV_VARS.idTokenAlg] ?? '').trim(),
    flowTtlMs: (env[OIDC_ENV_VARS.flowTtlMs] ?? '').trim(),
    httpTimeoutMs: (env[OIDC_ENV_VARS.httpTimeoutMs] ?? '').trim(),
    allowInsecure: (env[OIDC_ENV_VARS.allowInsecure] ?? '').trim(),
  };
  const anySet = Object.values(raw).some((v) => v !== '');
  if (!anySet) return null;

  const issues: string[] = [];
  const required: Array<keyof typeof OIDC_ENV_VARS> = [
    'issuer',
    'clientId',
    'clientSecret',
    'redirectUri',
  ];
  const missing = required.filter((k) => raw[k] === '');
  if (missing.length > 0) {
    issues.push(
      `identity: OIDC is partially configured — missing ${missing.map((k) => OIDC_ENV_VARS[k]).join(', ')}. Provide ALL of ${required.map((k) => OIDC_ENV_VARS[k]).join(', ')} or remove every MOTERVA_OIDC_* variable to disable identity.`,
    );
  }
  const allowInsecure = raw.allowInsecure === '1';
  if (raw.allowInsecure !== '' && !allowInsecure) {
    issues.push(`${OIDC_ENV_VARS.allowInsecure}: only "1" or unset are accepted.`);
  }
  if (nodeEnv === 'production' && allowInsecure) {
    issues.push(
      `${OIDC_ENV_VARS.allowInsecure}: insecure (plain-HTTP) identity transport can never be enabled in production.`,
    );
  }

  if (raw.issuer !== '') {
    let issuerUrl: URL | null = null;
    try {
      issuerUrl = new URL(raw.issuer);
    } catch {
      issues.push(`${OIDC_ENV_VARS.issuer}: "${raw.issuer}" is not a valid URL.`);
    }
    if (issuerUrl !== null) {
      if (issuerUrl.pathname !== '/' && issuerUrl.pathname !== '') {
        issues.push(
          `${OIDC_ENV_VARS.issuer}: must be an origin (or origin + trailing path without query/fragment).`,
        );
      }
      if (issuerUrl.search !== '' || issuerUrl.hash !== '') {
        issues.push(`${OIDC_ENV_VARS.issuer}: query strings and fragments are not allowed.`);
      }
      const secure = issuerUrl.protocol === 'https:';
      if (!secure) {
        const loopback = isLoopbackHostname(issuerUrl.hostname);
        if (nodeEnv === 'production') {
          issues.push(`${OIDC_ENV_VARS.issuer}: production identity requires an https:// issuer.`);
        } else if (!allowInsecure || !loopback) {
          issues.push(
            `${OIDC_ENV_VARS.issuer}: plain-HTTP issuers are only allowed on loopback with ${OIDC_ENV_VARS.allowInsecure}=1 (local test identity provider).`,
          );
        }
      }
    }
  }

  if (raw.redirectUri !== '') {
    try {
      const redirect = new URL(raw.redirectUri);
      if (redirect.hash !== '') {
        issues.push(`${OIDC_ENV_VARS.redirectUri}: fragments are not allowed in a redirect URI.`);
      }
      if (redirect.protocol === 'http:' && nodeEnv === 'production') {
        issues.push(`${OIDC_ENV_VARS.redirectUri}: production redirect URI must be https://.`);
      }
      if (
        redirect.protocol === 'http:' &&
        !isLoopbackHostname(redirect.hostname) &&
        !allowInsecure &&
        nodeEnv !== 'production'
      ) {
        issues.push(
          `${OIDC_ENV_VARS.redirectUri}: plain-HTTP non-loopback redirect URIs require ${OIDC_ENV_VARS.allowInsecure}=1 (local test identity provider).`,
        );
      }
    } catch {
      issues.push(
        `${OIDC_ENV_VARS.redirectUri}: "${raw.redirectUri}" is not a valid absolute URL.`,
      );
    }
  }

  if (raw.clientSecret !== '' && isPlaceholder(raw.clientSecret)) {
    issues.push(
      `${OIDC_ENV_VARS.clientSecret}: placeholder value refused — configure the real secret or remove it.`,
    );
  }
  if (raw.clientId !== '' && isPlaceholder(raw.clientId)) {
    issues.push(`${OIDC_ENV_VARS.clientId}: placeholder value refused.`);
  }

  const flowTtlMs = raw.flowTtlMs === '' ? DEFAULT_FLOW_TTL_MS : Number(raw.flowTtlMs);
  if (!Number.isSafeInteger(flowTtlMs) || flowTtlMs < 60_000 || flowTtlMs > 15 * 60_000) {
    issues.push(
      `${OIDC_ENV_VARS.flowTtlMs}: must be an integer between 60000 and 900000 (1–15 minutes).`,
    );
  }

  const httpTimeoutMs =
    raw.httpTimeoutMs === '' ? DEFAULT_HTTP_TIMEOUT_MS : Number(raw.httpTimeoutMs);
  if (!Number.isSafeInteger(httpTimeoutMs) || httpTimeoutMs < 1_000 || httpTimeoutMs > 30_000) {
    issues.push(
      `${OIDC_ENV_VARS.httpTimeoutMs}: must be an integer between 1000 and 30000 milliseconds.`,
    );
  }

  const scopes = raw.scopes === '' ? DEFAULT_OIDC_SCOPES : raw.scopes;
  if (!/\bopenid\b/.test(scopes)) {
    issues.push(`${OIDC_ENV_VARS.scopes}: must include the "openid" scope.`);
  }

  if (issues.length > 0) {
    requestIssues(issues);
    return null;
  }
  return {
    issuer: raw.issuer.replace(/\/+$/, ''),
    clientId: raw.clientId,
    clientSecret: raw.clientSecret,
    redirectUri: raw.redirectUri,
    scopes,
    idTokenAlg: raw.idTokenAlg === '' ? DEFAULT_ID_TOKEN_ALG : raw.idTokenAlg,
    flowTtlMs,
    insecureTransport: allowInsecure,
    httpTimeoutMs,
    clockToleranceSec: 60,
  };
}
