/**
 * Sponsor-network configuration (issue #6 D1; the execution path that
 * replaces legacy Tahoe — see SPONSOR-AUDIT.md and ADR 0008).
 *
 * Every constant below is verified from the OFFICIAL shipped sponsor
 * tooling — `@metalntwx/metal-pay@0.3.4` dist/networks.js and the
 * `@metalntwx/metal-agent@0.3.3` README — not from participant reports:
 *   testnet chain id 63825 (eip155:63825)
 *   *USDZ ("USD Zero") 18 decimals at 0x000000000000000000000000000000000000B5d5
 *   facilitator https://x402-testnet.metalntwx.com/x402/facilitator
 *   console      https://console-testnet.metalntwx.com  (issues per-user RPC endpoints)
 *   explorer     https://testnet.metalntwx.com
 *   faucet       POST /api/fund (URL from the metal-agent networks.json; override via env)
 *   demo payee   https://x402-demo-testnet.metalntwx.com/quote
 *
 * CREDENTIAL BOUNDARY: the console-issued RPC endpoint URL can carry a key
 * (metal-pay scrubs it from all errors for a reason) — it enters ONLY via
 * METAL_RPC_URL, is never hardcoded, never logged and never persisted.
 * The agent's P-256 key file and the mandate credential file are paths the
 * OPERATOR holds; this code never reads key material, only passes paths to
 * the official CLI. The owner's key NEVER appears here — sponsor mandates
 * exist precisely so the agent cannot move funds outside its limits.
 */
export const SPONSOR_TESTNET_CHAIN_ID = 63825;
export const SPONSOR_USDZ_ADDRESS = '0x000000000000000000000000000000000000b5d5';
export const SPONSOR_USDZ_SYMBOL = '*USDZ';
export const SPONSOR_USDZ_DECIMALS = 18;
export const SPONSOR_USDZ_EIP712_VERSION = '1';
export const SPONSOR_FACILITATOR_URL = 'https://x402-testnet.metalntwx.com/x402/facilitator';
export const SPONSOR_CONSOLE_URL = 'https://console-testnet.metalntwx.com';
export const SPONSOR_EXPLORER_URL = 'https://testnet.metalntwx.com';
export const SPONSOR_DEMO_PAYEE_URL = 'https://x402-demo-testnet.metalntwx.com/quote';
export const SPONSOR_CAIP2 = 'eip155:63825';
/** Official CLI package the adapter shells out to (npx -y @metalntwx/metal-agent …). */
export const SPONSOR_AGENT_PACKAGE = '@metalntwx/metal-agent';

export interface SponsorEnv {
  readonly METAL_SPEND_ENV?: string;
  /** Console-issued per-user RPC endpoint (credential-bearing; env only). */
  readonly METAL_RPC_URL?: string;
  /** Path to the AGENT's P-256 key file (path only; key material is never read here). */
  readonly METAL_AGENT_KEY_FILE?: string;
  /** Path to the bound mandate credential (Verifiable Intent, on-chain enforced). */
  readonly METAL_MANDATE_CREDENTIAL?: string;
  /** Explicit founder authorization token for any SIGNED spend. */
  readonly METAL_SPEND_APPROVED?: string;
  /** Diagnostics seller URL (defaults to the official demo payee). */
  readonly METAL_DIAGNOSTIC_SELLER_URL?: string;
  /** Overrides (official CLI supports both; env form shown). */
  readonly METAL_FACILITATOR_URL?: string;
  readonly METAL_FAUCET_URL?: string;
  readonly METAL_EXPLORER_URL?: string;
  /** Max per payment in *USDZ decimal (the agent CLI's own default is 1 *USDZ). */
  readonly METAL_MAX_PAYMENT_USDZ?: string;
  /** Value-of-information gate: estimated information value in *USDZ cents. */
  readonly METAL_INFO_VALUE_CENTS?: string;
}

export interface SponsorConfig {
  readonly enabled: boolean;
  readonly environment: 'sponsor-testnet' | 'disabled';
  readonly chainId: number;
  readonly caip2: string;
  readonly usdz: {
    readonly address: string;
    readonly symbol: string;
    readonly decimals: number;
    readonly eip712Version: string;
  };
  readonly facilitatorUrl: string;
  readonly consoleUrl: string;
  readonly explorerUrl: string;
  readonly faucetUrl: string | null;
  readonly demoPayeeUrl: string;
  readonly diagnosticSellerUrl: string;
  /** Present ONLY when the console endpoint is configured (never logged). */
  readonly hasRpcEndpoint: boolean;
  readonly hasAgentKeyFile: boolean;
  readonly hasMandateCredential: boolean;
  /** True when the founder token authorizes SIGNED spend; reads never need it. */
  readonly spendApproved: boolean;
  /** Per-payment cap in *USDZ base units as a decimal string (18 decimals). */
  readonly maxPaymentBaseUnits: string;
  /** Value-of-information gate: estimated info value in *USDZ base units (decimal string). */
  readonly infoValueBaseUnits: string | null;
}

function parseBaseUnitsFromCents(cents: number): string {
  // *USDZ has 18 decimals: 1 cent = 10^16 base units. Integer math only.
  const centsBig = BigInt(Math.trunc(cents));
  if (centsBig < 0n) throw new Error('negative *USDZ amount');
  return (centsBig * 10n ** 16n).toString();
}

export function loadSponsorConfig(env: SponsorEnv = process.env): SponsorConfig {
  const envTag = (env.METAL_SPEND_ENV ?? '').trim().toLowerCase();
  if (envTag !== '' && envTag !== 'sponsor-testnet') {
    throw new Error(
      `METAL_SPEND_ENV="${envTag}" is not supported. The sponsor path is 'sponsor-testnet' ` +
        `(Metal testnet eip155:63825 via console-testnet.metalntwx.com). The legacy Metallicus ` +
        `Tahoe configuration is NOT the sponsor network and is isolated (see SPONSOR-AUDIT.md).`,
    );
  }
  const wantsSponsor = envTag === 'sponsor-testnet';

  const rpcUrl = (env.METAL_RPC_URL ?? '').trim();
  const agentKeyFile = (env.METAL_AGENT_KEY_FILE ?? '').trim();
  const mandateCredential = (env.METAL_MANDATE_CREDENTIAL ?? '').trim();
  const spendApproved = (env.METAL_SPEND_APPROVED ?? '').trim() !== '';
  const maxPaymentUsdz = (env.METAL_MAX_PAYMENT_USDZ ?? '').trim();
  const infoValueCents = (env.METAL_INFO_VALUE_CENTS ?? '').trim();

  if (wantsSponsor) {
    const missing: string[] = [];
    if (rpcUrl === '')
      missing.push(
        'METAL_RPC_URL (create an endpoint at ' +
          SPONSOR_CONSOLE_URL +
          ' — the URL is credential-bearing; set it only in the server environment)',
      );
    if (agentKeyFile === '')
      missing.push(
        'METAL_AGENT_KEY_FILE (the AGENT key file path — the owner key must never be given to the agent)',
      );
    if (mandateCredential === '')
      missing.push('METAL_MANDATE_CREDENTIAL (the bound mandate credential path)');
    if (missing.length > 0) {
      throw new Error(
        `METAL_SPEND_ENV=sponsor-testnet requires ${missing.join('; ')}. ` +
          'Without them the sponsor rail stays disabled (never half-configured); the legacy Tahoe config is not a substitute.',
      ) as Error;
    }
  }

  // The CLI itself caps offers at 1 *USDZ unless told otherwise; we bind our
  // own cap from env (decimal *USDZ, e.g. "0.50"), converted with exact
  // 18-decimal integer math. Refuses anything but plain decimals.
  let maxPaymentBaseUnits = (1n * 10n ** 18n).toString(); // sponsor default 1 *USDZ
  if (maxPaymentUsdz !== '') {
    if (!/^\d+(\.\d+)?$/.test(maxPaymentUsdz)) {
      throw new Error(
        `METAL_MAX_PAYMENT_USDZ must be a decimal *USDZ amount (got "${maxPaymentUsdz}")`,
      );
    }
    const parts = maxPaymentUsdz.split('.');
    const whole = parts[0] ?? '0';
    const fraction = parts[1] ?? '';
    if (fraction.length > 18) {
      throw new Error(
        `METAL_MAX_PAYMENT_USDZ has more than 18 fractional digits (${maxPaymentUsdz}) — money is never rounded`,
      );
    }
    maxPaymentBaseUnits = (
      BigInt(whole) * 10n ** 18n +
      BigInt(fraction.padEnd(18, '0') || '0')
    ).toString();
  }

  let infoValueBaseUnits: string | null = null;
  if (infoValueCents !== '') {
    const cents = Number(infoValueCents);
    // Integer cents only: a fractional cent is not a money amount we price.
    if (!Number.isInteger(cents) || cents <= 0) {
      throw new Error(
        `METAL_INFO_VALUE_CENTS must be a positive integer number of cents (got "${infoValueCents}")`,
      );
    }
    infoValueBaseUnits = parseBaseUnitsFromCents(cents);
  }

  const faucetUrl = (env.METAL_FAUCET_URL ?? '').trim() || null;
  const explorerUrl = (env.METAL_EXPLORER_URL ?? '').trim() || SPONSOR_EXPLORER_URL;
  const facilitatorUrl = (env.METAL_FACILITATOR_URL ?? '').trim() || SPONSOR_FACILITATOR_URL;

  return {
    enabled: wantsSponsor,
    environment: wantsSponsor ? 'sponsor-testnet' : 'disabled',
    chainId: SPONSOR_TESTNET_CHAIN_ID,
    caip2: SPONSOR_CAIP2,
    usdz: {
      address: SPONSOR_USDZ_ADDRESS,
      symbol: SPONSOR_USDZ_SYMBOL,
      decimals: SPONSOR_USDZ_DECIMALS,
      eip712Version: SPONSOR_USDZ_EIP712_VERSION,
    },
    facilitatorUrl,
    consoleUrl: SPONSOR_CONSOLE_URL,
    explorerUrl,
    faucetUrl,
    demoPayeeUrl: SPONSOR_DEMO_PAYEE_URL,
    diagnosticSellerUrl: (env.METAL_DIAGNOSTIC_SELLER_URL ?? '').trim() || SPONSOR_DEMO_PAYEE_URL,
    hasRpcEndpoint: rpcUrl !== '',
    hasAgentKeyFile: agentKeyFile !== '',
    hasMandateCredential: mandateCredential !== '',
    spendApproved,
    maxPaymentBaseUnits,
    infoValueBaseUnits,
  };
}

/** Paths the adapter passes to the official CLI — never logged, never persisted. */
export interface SponsorSecretPaths {
  readonly rpcUrl: string;
  readonly agentKeyFile: string;
  readonly mandateCredential: string;
}

export function sponsorSecretPaths(
  config: SponsorConfig,
  env: SponsorEnv = process.env,
): SponsorSecretPaths | null {
  if (!config.enabled) return null;
  const rpcUrl = (env.METAL_RPC_URL ?? '').trim();
  const agentKeyFile = (env.METAL_AGENT_KEY_FILE ?? '').trim();
  const mandateCredential = (env.METAL_MANDATE_CREDENTIAL ?? '').trim();
  if (rpcUrl === '' || agentKeyFile === '' || mandateCredential === '') return null;
  return { rpcUrl, agentKeyFile, mandateCredential };
}
