/**
 * Metal (Metal Blockchain / Metallicus) testnet adapter configuration
 * (issue #6; mirrors the Airwallex P0-1 exfiltration boundary).
 *
 * Environment basis — verified against CURRENT official documentation:
 *   - Metal docs "Tahoe Workflow" (docs.metalblockchain.org, checked 2026-11-08):
 *       Tahoe testnet C-Chain (EVM) RPC  https://tahoe.metalblockchain.org/ext/bc/C/rpc
 *       Chain ID 381932, symbol METAL, explorer https://tahoe.metalscan.io/
 *       Faucet https://faucet.metalblockchain.org ("METAL ... have no monetary value")
 *   - The hackathon sponsor page describes Metal as "L1 blockchain, docs, nodes,
 *     faucet, wallets + Slack support" (airwallex.hackerearth.com, checked 2026-11-08).
 *
 * The USDZ token contract address on Tahoe comes from the hackathon's Metal
 * guide (organizer-provided, private). Repository law forbids inventing
 * contract addresses, so the adapter REQUIRES it (and the expected decimals)
 * as validated configuration and re-verifies both on-chain at connect time
 * (see erc20.ts discoverToken): the address must be a contract and its
 * on-chain `decimals()`/`symbol()` must match the configured expectation
 * before any payment can be built. Nothing here is guessed.
 *
 * Credential exfiltration boundary: while signer credentials are enabled,
 * credential-bearing (i.e. gas-paying) traffic is locked to the single
 * approved HTTPS Tahoe origin. Any METAL_RPC_URL override other than the
 * exact official endpoint is a startup error, so a hostile override can
 * never receive a signed transaction. Cross-origin redirects fail closed at
 * the transport.
 */
export const TAHOE_CCHAIN_RPC_URL = 'https://tahoe.metalblockchain.org/ext/bc/C/rpc';
export const TAHOE_CHAIN_ID = 381932;
export const TAHOE_EXPLORER_URL = 'https://tahoe.metalscan.io/';
export const TAHOE_FAUCET_URL = 'https://faucet.metalblockchain.org';

export interface MetalEnv {
  readonly METAL_ENV?: string;
  readonly METAL_RPC_URL?: string;
  /** Expected chain id; must be the official Tahoe value when credentials are enabled. */
  readonly METAL_CHAIN_ID?: string;
  /** Server-only hex private key (never committed, logged or persisted). */
  readonly METAL_SIGNER_PRIVATE_KEY?: string;
  /** USDZ token contract address on Tahoe (from the hackathon Metal guide). */
  readonly METAL_USDZ_TOKEN_ADDRESS?: string;
  /** Expected USDZ decimals; re-verified against the chain at connect time. */
  readonly METAL_USDZ_DECIMALS?: string;
  /** Expected USDZ symbol; re-verified against the chain at connect time. */
  readonly METAL_USDZ_SYMBOL?: string;
  /** Allowed payment recipient (the diagnostic vendor's testnet address). */
  readonly METAL_MERCHANT_ADDRESS?: string;
  /** Per-purchase cap in token minor units (adapter-boundary enforcement). */
  readonly METAL_MAX_PURCHASE_MINOR?: string;
  /** Block confirmations required before a receipt counts as verified finality. */
  readonly METAL_FINALITY_CONFIRMATIONS?: string;
}

export interface MetalAdapterConfig {
  readonly enabled: boolean;
  readonly environment: 'testnet' | 'disabled';
  /** The ONLY origin signed transactions may ever be delivered to. */
  readonly rpcUrl: string;
  readonly allowedOrigin: string;
  readonly chainId: number;
  readonly usdzTokenAddress: string | null;
  readonly usdzDecimals: number | null;
  readonly usdzSymbol: string | null;
  readonly merchantAddress: string | null;
  /** Adapter-boundary per-purchase cap in token minor units (0 = unset → disabled cap). */
  readonly maxPurchaseMinor: bigint | null;
  readonly finalityConfirmations: number;
  /** Milliseconds before an RPC call is abandoned (ambiguous → status-unknown). */
  readonly requestTimeoutMs: number;
  /** Bounded retries for idempotent READ rpcs only (never sendRawTransaction). */
  readonly idempotentReadRetries: number;
}

export function isHexAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function normalizeHexAddress(value: string): string {
  return value.toLowerCase();
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function positiveInt(raw: string | undefined, label: string): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer (got "${raw}")`);
  }
  return value;
}

export function loadMetalConfig(env: MetalEnv = process.env): MetalAdapterConfig {
  const environmentTag = (env.METAL_ENV ?? '').trim().toLowerCase();
  if (environmentTag !== '' && environmentTag !== 'testnet') {
    // Only the Tahoe testnet is implemented; anything else fails closed.
    throw new Error(
      `METAL_ENV="${environmentTag}" is not supported. This adapter implements the TAHOE TESTNET only (issue #6); leave METAL_ENV unset to keep the rail disabled.`,
    );
  }
  const wantsTestnet = environmentTag === 'testnet';

  const signerKey = (env.METAL_SIGNER_PRIVATE_KEY ?? '').trim() || null;
  if (signerKey !== null && !/^0x[0-9a-fA-F]{64}$/.test(signerKey)) {
    throw new Error(
      'METAL_SIGNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key when provided (server-only; never commit or log it).',
    );
  }
  const tokenAddress = (env.METAL_USDZ_TOKEN_ADDRESS ?? '').trim() || null;
  if (tokenAddress !== null && !isHexAddress(tokenAddress)) {
    throw new Error('METAL_USDZ_TOKEN_ADDRESS must be a 0x-prefixed 20-byte contract address.');
  }
  const merchantAddress = (env.METAL_MERCHANT_ADDRESS ?? '').trim() || null;
  if (merchantAddress !== null && !isHexAddress(merchantAddress)) {
    throw new Error('METAL_MERCHANT_ADDRESS must be a 0x-prefixed 20-byte address.');
  }
  const decimals = positiveInt(env.METAL_USDZ_DECIMALS, 'METAL_USDZ_DECIMALS');
  if (decimals !== null && decimals > 18) {
    throw new Error('METAL_USDZ_DECIMALS must be between 1 and 18.');
  }
  const symbol = (env.METAL_USDZ_SYMBOL ?? '').trim() || null;

  // Enabled = every credential/contract input present. Half-configured is a
  // startup error, never a silent partial rail (same law as Airwallex).
  const complete =
    signerKey !== null &&
    tokenAddress !== null &&
    merchantAddress !== null &&
    decimals !== null &&
    symbol !== null;
  if (wantsTestnet && !complete) {
    const missing = [
      signerKey === null ? 'METAL_SIGNER_PRIVATE_KEY' : null,
      tokenAddress === null ? 'METAL_USDZ_TOKEN_ADDRESS' : null,
      merchantAddress === null ? 'METAL_MERCHANT_ADDRESS' : null,
      decimals === null ? 'METAL_USDZ_DECIMALS' : null,
      symbol === null ? 'METAL_USDZ_SYMBOL' : null,
    ].filter((v): v is string => v !== null);
    throw new Error(
      `METAL_ENV=testnet requires ${missing.join(', ')} in the server environment. Without them the rail stays disabled (never half-configured). The USDZ token address comes from the hackathon Metal guide and is never invented by this repository.`,
    );
  }

  const chainIdOverride = positiveInt(env.METAL_CHAIN_ID, 'METAL_CHAIN_ID');
  const chainId = chainIdOverride ?? TAHOE_CHAIN_ID;
  const rpcOverride = (env.METAL_RPC_URL ?? '').trim();
  let rpcUrl = TAHOE_CCHAIN_RPC_URL;
  if (rpcOverride !== '') {
    if (!wantsTestnet || !complete) {
      // No credentials in play: a non-default base is only meaningful for
      // future test tooling — still require HTTPS to avoid normalizing bad input.
      if (!isHttpsUrl(rpcOverride)) {
        throw new Error(`METAL_RPC_URL must be an HTTPS URL (got "${rpcOverride}").`);
      }
      rpcUrl = rpcOverride;
    } else {
      // Credentials ARE enabled: lock signed traffic to the official Tahoe
      // endpoint. Any other destination is an exfiltration risk and refuses
      // startup (Airwallex P0-1 boundary, applied to gas-paying calls).
      if (rpcOverride !== TAHOE_CCHAIN_RPC_URL) {
        throw new Error(
          `METAL_RPC_URL="${rpcOverride}" is not allowed while testnet signer credentials are configured. Signed transactions are restricted to the official Tahoe C-Chain endpoint ${TAHOE_CCHAIN_RPC_URL}; remove the override to proceed.`,
        );
      }
      rpcUrl = rpcOverride;
    }
  }
  if (complete && chainId !== TAHOE_CHAIN_ID) {
    throw new Error(
      `METAL_CHAIN_ID=${String(chainId)} is not allowed: the adapter implements the Tahoe C-Chain (chain id ${String(TAHOE_CHAIN_ID)} per docs.metalblockchain.org). No other chain id is configured or claimed.`,
    );
  }

  const maxPurchaseMinor = (env.METAL_MAX_PURCHASE_MINOR ?? '').trim() || null;
  let cap: bigint | null = null;
  if (maxPurchaseMinor !== null) {
    if (!/^[0-9]+$/.test(maxPurchaseMinor)) {
      throw new Error(
        'METAL_MAX_PURCHASE_MINOR must be a non-negative integer (token minor units).',
      );
    }
    cap = BigInt(maxPurchaseMinor);
  }
  const finalityConfirmations = positiveInt(
    env.METAL_FINALITY_CONFIRMATIONS,
    'METAL_FINALITY_CONFIRMATIONS',
  );

  return {
    enabled: wantsTestnet && complete,
    environment: wantsTestnet && complete ? 'testnet' : 'disabled',
    rpcUrl,
    allowedOrigin: new URL(rpcUrl).origin,
    chainId,
    usdzTokenAddress: tokenAddress,
    usdzDecimals: decimals,
    usdzSymbol: symbol,
    merchantAddress: merchantAddress === null ? null : normalizeHexAddress(merchantAddress),
    maxPurchaseMinor: cap,
    finalityConfirmations: finalityConfirmations ?? 12,
    requestTimeoutMs: 15_000,
    idempotentReadRetries: 3,
  };
}
