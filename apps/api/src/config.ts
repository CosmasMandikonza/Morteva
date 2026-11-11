/**
 * Startup configuration: parse and validate environment BEFORE the server
 * listens. Fail fast with an actionable message; never start half-configured
 * (issue #3 negative case "bad env"). Variable names only are documented in
 * .env.example — values are never committed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { parseIdentityConfig, type IdentityConfig } from './identity/config.js';

/**
 * Minimal .env loader for local development only (development convenience;
 * production injects real environment variables). Real process env always
 * wins. Strict KEY=VALUE lines and # comments only — no shell expansion.
 */
export function loadDotEnvForDev(cwd: string = process.cwd()): void {
  if (process.env.NODE_ENV === 'production' || process.env.MOTERVA_SKIP_DOTENV === '1') return;
  for (const candidate of [resolve(cwd, '.env'), resolve(cwd, '../../.env')]) {
    if (!existsSync(candidate)) continue;
    for (const rawLine of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (process.env[key] === undefined && value !== '') process.env[key] = value;
    }
    return;
  }
}

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().min(1).default('127.0.0.1'),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
  MOTERVA_LEDGER_PATH: z.string().min(1).default('data/moterva.sqlite'),
  MOTERVA_SESSION_TTL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(7 * 24 * 3_600_000)
    .default(8 * 3_600_000),
  GIT_SHA: z.string().min(1).optional(),
  MOTERVA_TRUST_PROXY: z.enum(['0', '1']).default('0'),
  /**
   * P0-2 secret custody (CTO review PR #64): the envelope-encryption KEK for
   * machine-source signing credentials. OPTIONAL — when absent, a
   * deterministic local derivation keeps local/test flows working, but
   * PRODUCTION deployments MUST provision this from their secret manager
   * (32 bytes; base64url or hex). The KEK itself is never journalled.
   */
  MOTERVA_SOURCE_KEY_KEK: z.string().min(16).max(512).optional(),
});

/**
 * Parse MTV-01's local scenario-data mode fail-closed: 'offline'/'simulated' work now.
 * 'sandbox'/'testnet' are NOT alternatives in one global rail switch; actual
 * Airwallex sandbox and Metal testnet must be configured independently (#5/#6).
 * These values refuse startup in MTV-01; no half-wired provider may boot.
 */
export function parseProviderMode(raw: string | undefined): 'offline' | 'simulated' {
  const value = raw === undefined || raw === '' ? 'offline' : raw;
  if (value === 'sandbox' || value === 'testnet') {
    const issue = value === 'sandbox' ? '#5 (Airwallex sandbox)' : '#6 (Metal testnet)';
    throw new StartupConfigError([
      `MOTERVA_PROVIDER_MODE: "${value}" is reserved for issue ${issue} and is NOT implemented yet. Start with "offline" or "simulated"; no provider credentials are read in MTV-01.`,
    ]);
  }
  if (value !== 'offline' && value !== 'simulated') {
    throw new StartupConfigError([
      `MOTERVA_PROVIDER_MODE: unknown value "${value}". Allowed now: offline, simulated. Reserved for later issues: sandbox (#5), testnet (#6).`,
    ]);
  }
  return value;
}

export type RawEnv = Record<string, string | undefined>;

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly host: string;
  readonly webOrigin: string;
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
  readonly providerMode: 'offline' | 'simulated';
  /** SQLite file for the financial ledger (MTV-02). Relative paths resolve against the API cwd. */
  readonly ledgerPath: string;
  readonly sessionTtlMs: number;
  /**
   * DEMO_AUTH gate (issue #7): enables the dev bootstrap + username/password
   * login endpoints. Requires NODE_ENV ≠ production AND MOTERVA_DEV_AUTH=1;
   * setting it together with production is a startup error, so demo auth can
   * never be active accidentally in a deployed configuration.
   */
  readonly devAuth: boolean;
  /**
   * REVIEWER_DEMO (issues #17/#19): hosted, explicitly-enabled reviewer
   * capability admitting the FIXED signed synthetic scenario under a real
   * OIDC session. Requires identity; refuses startup when requested without
   * it, and the routes are never mounted when disabled (fail-closed 404).
   */
  readonly reviewerDemo: boolean;
  /**
   * Production identity (MTV-19): OIDC configuration, or null when no
   * MOTERVA_OIDC_* variable is set (identity simply not deployed — the rest
   * of the server still boots). Partial configuration fails startup.
   */
  readonly identity: IdentityConfig | null;
  /**
   * Trust X-Forwarded-* from the TLS termination proxy (Agent E's Caddy edge).
   * Only enable when the API is NOT directly internet-exposed.
   */
  readonly trustProxy: boolean;
  readonly gitSha?: string;
  /**
   * Envelope-encryption KEK for machine-source signing credentials
   * (P0-2 secret custody). Optional; see the schema comment.
   */
  readonly sourceKeyKek?: string;
  /** Non-fatal startup warnings (e.g. provider credentials present while offline). */
  readonly warnings: readonly string[];
}

export class StartupConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'StartupConfigError';
  }
}

export function loadConfig(env: RawEnv = process.env): AppConfig {
  // Collect every invalid variable so one startup failure lists all problems.
  const issues: string[] = [];
  let identity: IdentityConfig | null = null;
  try {
    identity = parseIdentityConfig(
      env,
      (env.NODE_ENV as 'development' | 'test' | 'production') ?? 'development',
      (newIssues: readonly string[]) => {
        issues.push(...newIssues);
      },
    );
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  let providerMode: 'offline' | 'simulated' | undefined;
  try {
    providerMode = parseProviderMode(env.MOTERVA_PROVIDER_MODE);
  } catch (error) {
    if (error instanceof StartupConfigError) issues.push(...error.issues);
    else throw error;
  }
  const parsed = configSchema.safeParse({
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    HOST: env.HOST,
    WEB_ORIGIN: env.WEB_ORIGIN,
    LOG_LEVEL: env.LOG_LEVEL,
    MOTERVA_LEDGER_PATH: env.MOTERVA_LEDGER_PATH,
    MOTERVA_SESSION_TTL_MS: env.MOTERVA_SESSION_TTL_MS,
    GIT_SHA: env.GIT_SHA,
    MOTERVA_TRUST_PROXY: env.MOTERVA_TRUST_PROXY,
  });
  if (!parsed.success) {
    issues.push(...parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`));
  }
  // DEMO_AUTH is deliberately local-only, not merely "non-production".
  // NODE_ENV is often left at development in preview/cloud deployments.
  const devAuthRequested = (env.MOTERVA_DEV_AUTH ?? '') === '1';
  // REVIEWER_DEMO (issues #17/#19): explicitly-enabled hosted reviewer
  // capability admitting the FIXED signed synthetic scenario. Off by
  // default; when enabled it requires a configured production identity
  // (OIDC) — the routes never exist anonymously or under dev auth alone.
  const reviewerDemoRaw = (env.MOTERVA_REVIEWER_DEMO ?? '').trim();
  const reviewerDemoRequested = reviewerDemoRaw === '1';
  if (reviewerDemoRaw !== '' && !reviewerDemoRequested) {
    issues.push('MOTERVA_REVIEWER_DEMO: only "1" or unset are accepted.');
  }
  if (devAuthRequested && parsed.success) {
    if (parsed.data.NODE_ENV === 'production') {
      issues.push(
        'MOTERVA_DEV_AUTH: demo authentication cannot be enabled in production; refusing to start (remove MOTERVA_DEV_AUTH or set NODE_ENV=development/test)',
      );
    }
    const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
    if (!loopbackHosts.has(parsed.data.HOST)) {
      issues.push(
        'MOTERVA_DEV_AUTH: demo bootstrap requires loopback HOST only; refusing network-exposed demo actor creation',
      );
    }
    const origin = new URL(parsed.data.WEB_ORIGIN);
    if (!loopbackHosts.has(origin.hostname)) {
      issues.push(
        'MOTERVA_DEV_AUTH: demo bootstrap requires a loopback WEB_ORIGIN, not a public website',
      );
    }
  }
  if (providerMode === undefined || !parsed.success || issues.length > 0) {
    throw new StartupConfigError(issues);
  }
  const reviewerDemo = reviewerDemoRequested && identity !== null;
  if (reviewerDemoRequested && identity === null) {
    throw new StartupConfigError([
      'MOTERVA_REVIEWER_DEMO: the hosted reviewer demo requires a configured production identity (set the MOTERVA_OIDC_* variables) — the capability must never exist without authenticated OIDC sessions. Remove MOTERVA_REVIEWER_DEMO or configure identity.',
    ]);
  }
  const devAuth = devAuthRequested && parsed.data.NODE_ENV !== 'production';
  const warnings: string[] = [];
  if (reviewerDemo) {
    warnings.push(
      'REVIEWER_DEMO is ACTIVE (MOTERVA_REVIEWER_DEMO=1 with a configured identity): the fixed signed synthetic reviewer scenario is enabled for authenticated org members. It admits SYNTHETIC evidence only and moves no money.',
    );
  }
  if (devAuth) {
    warnings.push(
      'DEMO_AUTH is ACTIVE (MOTERVA_DEV_AUTH=1 in non-production): username/password login and one-time dev bootstrap are enabled for local development only. Never use this mode in a deployed configuration.',
    );
  }
  const providerCredentialVars = [
    'AIRWALLEX_API_KEY',
    'AIRWALLEX_CLIENT_ID',
    'METAL_SIGNER_KEY',
  ].filter((name) => (env[name] ?? '').trim() !== '');
  if (providerCredentialVars.length > 0) {
    warnings.push(
      `Provider credential variable(s) ${providerCredentialVars.join(', ')} are set but MOTERVA_PROVIDER_MODE is "${providerMode}". They are IGNORED in MTV-01 — no provider call is attempted. Remove them until issue #5/#6 implements the adapters.`,
    );
  }
  return {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    host: parsed.data.HOST,
    webOrigin: parsed.data.WEB_ORIGIN,
    logLevel: parsed.data.LOG_LEVEL,
    providerMode,
    ledgerPath: parsed.data.MOTERVA_LEDGER_PATH,
    sessionTtlMs: parsed.data.MOTERVA_SESSION_TTL_MS,
    devAuth,
    reviewerDemo,
    identity,
    trustProxy: parsed.data.MOTERVA_TRUST_PROXY === '1',
    gitSha: parsed.data.GIT_SHA,
    sourceKeyKek: parsed.data.MOTERVA_SOURCE_KEY_KEK,
    warnings,
  };
}
