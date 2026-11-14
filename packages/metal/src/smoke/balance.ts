/**
 * GATED Metal testnet balance smoke (issue #6).
 *
 * Reads the funded testnet wallet's native (gas) and USDZ balances through
 * the REAL Tahoe C-Chain RPC — only when the server environment explicitly
 * enables the metal rail. Without credentials this exits non-zero with an
 * exact BLOCKED report instead of fabricating results. A real balance read
 * persists a balance-read receipt (redacted) into the smoke state directory.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpJsonRpcTransport } from '../chain-transport.js';
import { loadMetalConfig } from '../config.js';
import { MetalSigner } from '../signer.js';
import { MetalDispatcher } from '../dispatcher.js';
import { discoverToken, readNativeBalance, readTokenBalance } from '../erc20.js';

function blocked(reason: string): never {
  console.error('BLOCKED: ' + reason);
  process.exit(2);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadMetalConfig();
  } catch (error) {
    blocked(
      `metal smoke is disabled: ${error instanceof Error ? error.message : String(error)} — nothing was called`,
    );
  }
  if (!config.enabled) {
    blocked(
      'metal smoke is disabled: no testnet credentials configured (METAL_ENV=testnet, METAL_SIGNER_PRIVATE_KEY, METAL_USDZ_TOKEN_ADDRESS, METAL_USDZ_DECIMALS, METAL_USDZ_SYMBOL, METAL_MERCHANT_ADDRESS). The real-testnet gate stays BLOCKED; no provider call is made or claimed.',
    );
  }
  const transport = new HttpJsonRpcTransport({
    rpcUrl: config.rpcUrl,
    allowedOrigin: config.allowedOrigin,
    requestTimeoutMs: config.requestTimeoutMs,
    idempotentReadRetries: config.idempotentReadRetries,
  });
  const signer = new MetalSigner(process.env.METAL_SIGNER_PRIVATE_KEY ?? '', config.chainId);

  console.info('metal smoke: connecting to the configured Tahoe C-Chain RPC…');
  const chainIdRaw = await transport.call<string>({
    method: 'eth_chainId',
    params: [],
    idempotentRead: true,
  });
  const chainId = Number(BigInt(chainIdRaw));
  if (chainId !== config.chainId) {
    blocked(
      `connected chain id ${String(chainId)} != configured ${String(config.chainId)}; refusing to continue`,
    );
  }
  const blockNumber = BigInt(
    await transport.call<string>({ method: 'eth_blockNumber', params: [], idempotentRead: true }),
  );
  const token = await discoverToken(transport, {
    address: config.usdzTokenAddress as string,
    symbol: config.usdzSymbol as string,
    decimals: config.usdzDecimals as number,
  });
  const native = await readNativeBalance(transport, signer.address);
  const usdz = await readTokenBalance(transport, token.address, signer.address);

  const stateDir = join(tmpdir(), 'moterva-metal-smoke');
  mkdirSync(stateDir, { recursive: true });
  // Redacted evidence: addresses truncated, no keys anywhere.
  const redact = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;
  const evidence = {
    environment: 'testnet',
    chainId,
    blockNumber: blockNumber.toString(),
    token: { symbol: token.symbol, decimals: token.decimals, address: redact(token.address) },
    wallet: redact(signer.address),
    nativeBalanceWei: native.toString(),
    usdzBalanceMinor: usdz.toString(),
    readAt: new Date().toISOString(),
    note: 'REAL Metal Tahoe testnet balance read via the official RPC; wallet identity truncated',
  };
  writeFileSync(
    join(stateDir, 'last-balance-read.json'),
    JSON.stringify(evidence, null, 2),
    'utf8',
  );
  void MetalDispatcher; // imported for parity with the dispatcher-gated flow

  console.info('metal smoke: REAL testnet balance read verified:');
  console.info(`  chain id        : ${String(chainId)} (Tahoe)`);
  console.info(`  head block      : ${blockNumber.toString()}`);
  console.info(
    `  token           : ${token.symbol} (${String(token.decimals)} decimals) at ${redact(token.address)}`,
  );
  console.info(`  wallet          : ${redact(signer.address)}`);
  console.info(`  native (gas)    : ${native.toString()} wei`);
  console.info(`  USDZ balance    : ${usdz.toString()} minor units`);
  console.info(`  evidence        : ${join(stateDir, 'last-balance-read.json')}`);
}

main().catch((error) => {
  console.error(
    'metal smoke: balance read failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
