/**
 * Minimal ERC-20 surface for the USDZ diagnostic purchase (issue #6).
 *
 * Everything goes through the swappable JsonRpcTransport so the offline
 * fixture can script every chain answer; viem is used ONLY for local,
 * deterministic ABI encoding/decoding (no network, no keys). This keeps the
 * fixture lane pattern from the Airwallex package intact.
 *
 * Token metadata is DISCOVERED from the chain (decimals()/symbol()) and
 * cross-checked against configured expectations at connect time — repository
 * law forbids inventing or hardcoding token metadata.
 */
import { encodeFunctionData, decodeFunctionResult, keccak256, toHex } from 'viem';
import type { JsonRpcTransport } from './chain-transport.js';

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

export const TRANSFER_EVENT_TOPIC = keccak256(
  new TextEncoder().encode('Transfer(address,address,uint256)'),
);

export function encodeErc20Call(
  functionName: 'decimals' | 'symbol' | 'balanceOf' | 'transfer',
  args: readonly unknown[] = [],
): string {
  return encodeFunctionData({ abi: ERC20_ABI, functionName, args: args as never });
}

async function ethCall(transport: JsonRpcTransport, to: string, data: string): Promise<string> {
  const result = await transport.call<string>({
    method: 'eth_call',
    params: [{ to, data }, 'latest'],
    idempotentRead: true,
  });
  if (typeof result !== 'string' || result === '0x') {
    throw new Error(`eth_call to ${to} returned empty data — is it a contract?`);
  }
  return result;
}

/** Reads `decimals()` from the token contract on-chain. */
export async function readTokenDecimals(
  transport: JsonRpcTransport,
  tokenAddress: string,
): Promise<number> {
  const raw = await ethCall(transport, tokenAddress, encodeErc20Call('decimals'));
  const value = decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: 'decimals',
    data: raw as `0x${string}`,
  });
  return Number(value);
}

/** Reads `symbol()` from the token contract on-chain. */
export async function readTokenSymbol(
  transport: JsonRpcTransport,
  tokenAddress: string,
): Promise<string> {
  const raw = await ethCall(transport, tokenAddress, encodeErc20Call('symbol'));
  const value = decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: 'symbol',
    data: raw as `0x${string}`,
  });
  return value;
}

/** Reads `balanceOf(wallet)` — token base units as bigint. */
export async function readTokenBalance(
  transport: JsonRpcTransport,
  tokenAddress: string,
  wallet: string,
): Promise<bigint> {
  const raw = await ethCall(transport, tokenAddress, encodeErc20Call('balanceOf', [wallet]));
  const value = decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    data: raw as `0x${string}`,
  });
  return value;
}

/** Builds the ERC-20 `transfer` calldata paying `amountBaseUnits` to `to`. */
export function buildTransferCalldata(to: string, amountBaseUnits: bigint): string {
  return encodeErc20Call('transfer', [to, amountBaseUnits]);
}

export interface DiscoveredToken {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * Connect-time verification: the configured token address must hold contract
 * code and its on-chain metadata must match the configured expectation
 * EXACTLY. A mismatch is a hard configuration error (never silently used).
 */
export async function discoverToken(
  transport: JsonRpcTransport,
  expected: { address: string; symbol: string; decimals: number },
): Promise<DiscoveredToken> {
  const code = await transport.call<string>({
    method: 'eth_getCode',
    params: [expected.address, 'latest'],
    idempotentRead: true,
  });
  if (typeof code !== 'string' || code === '0x' || code === '') {
    throw new Error(
      `METAL_USDZ_TOKEN_ADDRESS ${expected.address} holds no contract code on the connected chain — refusing to continue (never send value to a non-contract address by mistake)`,
    );
  }
  const [decimals, symbol] = await Promise.all([
    readTokenDecimals(transport, expected.address),
    readTokenSymbol(transport, expected.address),
  ]);
  if (decimals !== expected.decimals || symbol !== expected.symbol) {
    throw new Error(
      `on-chain token metadata (symbol ${symbol}, decimals ${String(decimals)}) does not match the configured expectation (symbol ${expected.symbol}, decimals ${String(expected.decimals)}); refusing to continue`,
    );
  }
  return { address: expected.address.toLowerCase(), symbol, decimals };
}

/** Native (gas) balance of `wallet` in wei as bigint. */
export async function readNativeBalance(
  transport: JsonRpcTransport,
  wallet: string,
): Promise<bigint> {
  const raw = await transport.call<string>({
    method: 'eth_getBalance',
    params: [wallet, 'latest'],
    idempotentRead: true,
  });
  return BigInt(raw);
}

/** Current head block number as bigint. */
export async function readBlockNumber(transport: JsonRpcTransport): Promise<bigint> {
  const raw = await transport.call<string>({
    method: 'eth_blockNumber',
    params: [],
    idempotentRead: true,
  });
  return BigInt(raw);
}

export function toQuantityHex(value: bigint): string {
  return toHex(value);
}
