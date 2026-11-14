/**
 * GATED Metal network probe — READ-ONLY (issue #6; D5 external verification).
 *
 * Reads `eth_chainId`, `eth_blockNumber` and `eth_gasPrice` from the
 * configured (origin-locked) RPC endpoint. NO signer key, NO token
 * configuration, NO state change, NO account data — this verifies the
 * NETWORK endpoint itself (the only external surface that is self-serve
 * public). Account-level verification (balance, token) stays gated behind
 * the full credential configuration in smoke:balance; any state change
 * requires smoke:purchase --confirm.
 *
 * The config gate still applies: METAL_ENV must be testnet-or-unset; a
 * credential-bearing configuration keeps the origin lock. Exit 0 prints the
 * verified facts; failures are honest (exit 1) — never fabricated.
 */
import {
  HttpJsonRpcTransport,
  JsonRpcUnavailableError,
  JsonRpcRejectionError,
} from '../chain-transport.js';
import { loadMetalConfig, TAHOE_CCHAIN_RPC_URL, TAHOE_CHAIN_ID } from '../config.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadMetalConfig();
  } catch (error) {
    console.error(
      `BLOCKED: invalid metal configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
  console.info(`metal network probe: ${config.rpcUrl} (read-only; no credentials used)`);

  const transport = new HttpJsonRpcTransport({
    rpcUrl: config.rpcUrl,
    allowedOrigin: config.allowedOrigin,
    requestTimeoutMs: config.requestTimeoutMs,
    idempotentReadRetries: config.idempotentReadRetries,
  });

  const chainIdRaw = await transport.call<string>({
    method: 'eth_chainId',
    params: [],
    idempotentRead: true,
  });
  const chainId = Number(BigInt(chainIdRaw));
  const blockNumber = BigInt(
    await transport.call<string>({ method: 'eth_blockNumber', params: [], idempotentRead: true }),
  );
  const gasPrice = BigInt(
    await transport.call<string>({ method: 'eth_gasPrice', params: [], idempotentRead: true }),
  );

  const matchesOfficial = chainId === TAHOE_CHAIN_ID && config.rpcUrl === TAHOE_CCHAIN_RPC_URL;
  const evidence = {
    environment: 'testnet (READ-ONLY probe)',
    rpcUrl: config.rpcUrl,
    chainId,
    chainIdMatchesOfficialDocs: chainId === TAHOE_CHAIN_ID,
    headBlock: blockNumber.toString(),
    gasPriceWei: gasPrice.toString(),
    readAt: new Date().toISOString(),
    note: 'Live read-only JSON-RPC verification of the official Tahoe C-Chain endpoint (docs.metalblockchain.org, checked 2026-11-08). No account, token or transaction data touched; no credentials used.',
  };
  console.info('VERIFIED (live read-only):');
  console.info(
    `  chain id    : ${String(chainId)} ${matchesOfficial ? '(matches official Tahoe docs: 381932)' : '(DOES NOT match official Tahoe docs 381932 — investigate)'}`,
  );
  console.info(`  head block  : ${blockNumber.toString()}`);
  console.info(`  gas price   : ${gasPrice.toString()} wei`);
  if (!matchesOfficial) process.exit(1);
  process.exitCode = 0;
  void evidence;
}

main().catch((error) => {
  if (error instanceof JsonRpcUnavailableError) {
    console.error(
      `BLOCKED: Tahoe RPC unreachable (provider downtime or network): ${error.message}`,
    );
  } else if (error instanceof JsonRpcRejectionError) {
    console.error(`BLOCKED: Tahoe RPC refused the read: ${error.message}`);
  } else {
    console.error(
      `metal network probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  process.exit(1);
});
