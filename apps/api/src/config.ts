/**
 * Startup configuration: parse and validate environment BEFORE the server
 * listens. Fail fast with an actionable message; never start half-configured
 * (issue #3 negative case "bad env"). Variable names only are documented in
 * .env.example — values are never committed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Minimal .env loader for local development only (development convenience;
 * production injects real environment variables). Real process env always
 * wins. Strict KEY=VALUE lines and # comments only — no shell expansion.
 */
export function loadDotEnvForDev(cwd: string = process.cwd()): void {
  if (process.env.NODE_ENV === 'production' || process.env.MOTERVA_SKIP_DOTENV === '1') return;
  for (const candidate of [resolve(cwd, '.env'), resolve(cwd, '../../.env')]) {
    if (!existsSync(candidate)) continue;
    for (const rawLine of readFileSync(candidate, 'utf8').split(/\r?
/)) {
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
  GIT_SHA: z.string().min(1).optional(),
});

/**
 * Parse MTV-01's local scenario-data mode fail-closed: 'offline'/'simulated' work now;
 * 'sandbox'/'testnet' are NOT alternatives in one global rail switch; actual
 * Airwallex sandbox and Metal testnet must be configured independently (#5/#6).
 * These values refuse startup in MTV-01,
 * so no half-wired provider mode can ever boot.
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
  readonly gitSha?: string;
  /** Non-fatal startup warnings (e.g. provider credentials present while offline). */
  readonly warnings: readonly string[];
}

export class StartupConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment configuration:
${issues.map((i) => `  - ${i}`).join('
')}`);
    this.name = 'StartupConfigError';
  }
}

export function loadConfig(env: RawEnv = process.env): AppConfig {
  // Collect every invalid variable so one startup failure lists all problems.
  const issues: string[] = [];
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
    GIT_SHA: env.GIT_SHA,
  });
  if (!parsed.success) {
    issues.push(...parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`));
  }
  if (providerMode === undefined || !parsed.success) {
    throw new StartupConfigError(issues);
  }
  const warnings: string[] = [];
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
    gitSha: parsed.data.GIT_SHA,
    warnings,
  };
}
