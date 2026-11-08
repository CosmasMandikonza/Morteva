/**
 * Deterministic test helpers for the metal adapter (OFFLINE FIXTURES ONLY).
 *
 * Everything here is a labeled, offline simulation: the simulated chain
 * answers JSON-RPC from in-memory state the test manipulates directly. The
 * private key below is a THROWN-AWAY TEST FIXTURE (never a real key, holds
 * nothing, exists only so signing is deterministic); tests never treat its
 * outputs as live evidence.
 *
 * Receipts are derived from the ACTUAL signed transaction (parseTransaction +
 * recoverTransactionAddress), so the Transfer log a reconcile observes
 * provably belongs to what the signer produced — the economic-identity
 * validation tests are meaningful, not self-fulfilling.
 */
import {
  keccak256,
  encodeFunctionResult,
  toHex,
  parseTransaction,
  recoverTransactionAddress,
} from 'viem';
import type { TransactionSerializedEIP1559 } from 'viem';
import { FixtureJsonRpcTransport, JsonRpcRejectionError } from '../src/chain-transport.js';
import type { FixtureRpcStep } from '../src/chain-transport.js';
import { TRANSFER_EVENT_TOPIC } from '../src/erc20.js';
import type { MetalReceiptStore } from '../src/dispatcher.js';

/** THROWN-AWAY TEST FIXTURE KEY (0xab repeated 32 bytes) — never use for value. */
export const TEST_PRIVATE_KEY = `0x${'ab'.repeat(32)}`;

export const TAHOE_CHAIN_ID_HEX = '0x5d3ec'; // 381932
export const TEST_TOKEN = '0x1111111111111111111111111111111111111111';
export const TEST_MERCHANT = '0x2222222222222222222222222222222222222222';

export interface StoredReceipt {
  orgId: string;
  operationId: string | null;
  requestId: string;
  providerResourceId: string | null;
  kind: string;
  environment: string;
  httpStatus: number | null;
  providerStatus: string | null;
  payloadJson: string;
  recordedAt: string;
}

export class InMemoryReceiptStore implements MetalReceiptStore {
  readonly receipts: StoredReceipt[] = [];

  append(receipt: Parameters<MetalReceiptStore['append']>[0]): void {
    this.receipts.push({ ...receipt, httpStatus: receipt.httpStatus ?? null });
  }

  listByRequestId(requestId: string, orgId: string): StoredReceipt[] {
    return this.receipts.filter((r) => r.requestId === requestId && r.orgId === orgId);
  }

  clear(): void {
    this.receipts.length = 0;
  }
}

interface SimTx {
  readonly raw: string;
  readonly hash: string;
  readonly nonce: number;
  readonly from: string;
  readonly to: string;
  readonly data: string;
  /** null while in mempool */
  receipt: SimReceipt | null;
}

export interface SimReceipt {
  status: '0x1' | '0x0';
  blockNumber: string;
  blockHash: string;
  logs: Array<{ address: string; topics: string[]; data: string; blockNumber: string }>;
  from: string;
  to: string;
}

const TRANSFER_SELECTOR = '0xa9059cbb';

/** Decodes the ERC-20 transfer recipient from transfer calldata. */
function transferRecipient(data: string): string {
  return `0x${data.slice(10 + 24, 10 + 64)}`;
}

/** Decodes the ERC-20 transfer amount from transfer calldata. */
function transferAmount(data: string): bigint {
  return BigInt(`0x${data.slice(10 + 64, 10 + 128)}`);
}

/**
 * An in-memory simulated Tahoe C-Chain. Tests mine blocks, include/revert/
 * drop transactions and force reorg-shaped reads by direct mutation — every
 * adversarial scenario in docs/06 and task D8 without any network.
 */
export class SimulatedChain {
  head = 100n;
  nonce = 0;
  tokenBalance = 50_000_000n; // 50 USDZ at 6 decimals
  nativeBalance = 10n ** 18n; // 1 native unit for gas
  gasPrice = 1_000_000_000n;
  estimate = 65_000n;
  tokenCode = '0x6080604052';
  symbol = 'USDZ';
  decimals = 6;
  chainId = 381932n;
  readonly txs = new Map<string, SimTx>();
  /** Fail the next `count` calls of `method` with transport unavailability. */
  unavailableNext: { method: string; count: number } | null = null;
  /** Behavior override for the next eth_sendRawTransaction calls. */
  sendRawBehavior: 'accept' | 'reject' | 'timeout' = 'accept';

  readonly transport: FixtureJsonRpcTransport;

  constructor() {
    this.transport = new FixtureJsonRpcTransport({
      lanes: {},
      dynamic: (method, params) => this.handle(method, params) as unknown,
    });
  }

  /** Every JSON-RPC call the adapter performed (test observability). */
  get performedCalls(): Array<{ method: string; params: readonly unknown[] }> {
    return this.transport.performedCalls;
  }

  /** Includes all broadcast transactions at the next block(s). */
  mine(count: number | bigint = 12): bigint[] {
    const total = BigInt(count);
    const blocks: bigint[] = [];
    for (let i = 0n; i < total; i += 1n) {
      this.head += 1n;
      blocks.push(this.head);
      for (const tx of this.txs.values()) {
        if (tx.receipt === null) {
          tx.receipt = this.buildReceipt(tx, this.head);
        }
      }
    }
    return blocks;
  }

  private buildReceipt(tx: SimTx, block: bigint): SimReceipt {
    const status = this.tokenBalance < transferAmount(tx.data) ? '0x0' : '0x1';
    if (status === '0x1' && tx.data.startsWith(TRANSFER_SELECTOR)) {
      this.tokenBalance -= transferAmount(tx.data);
    }
    return {
      status,
      blockNumber: toHex(block),
      blockHash: `0x${(block * 7919n).toString(16).padStart(64, 'a')}`,
      from: tx.from,
      to: tx.to,
      logs: [
        {
          address: tx.to, // an ERC-20 Transfer event is emitted by the token contract
          topics: [
            TRANSFER_EVENT_TOPIC,
            `0x${tx.from.replace(/^0x/, '').padStart(64, '0')}`,
            `0x${transferRecipient(tx.data).replace(/^0x/, '').padStart(64, '0')}`,
          ],
          data: `0x${transferAmount(tx.data).toString(16).padStart(64, '0')}`,
          blockNumber: toHex(block),
        },
      ],
    };
  }

  /** Mutates a MINED tx's receipt block hash (same height) — reorg shape. */
  reorgBlockHash(hash: string): void {
    const tx = this.txs.get(hash);
    if (tx === undefined || tx.receipt === null) throw new Error('reorg test needs a mined tx');
    tx.receipt = { ...tx.receipt, blockHash: `0x${'f'.repeat(64)}` };
  }

  private async handle(method: string, params: readonly unknown[]): Promise<unknown> {
    if (
      this.unavailableNext !== null &&
      this.unavailableNext.method === method &&
      this.unavailableNext.count > 0
    ) {
      this.unavailableNext = { ...this.unavailableNext, count: this.unavailableNext.count - 1 };
      const lanes = this.transport.lanes as Record<string, FixtureRpcStep[]>;
      lanes[method] = [
        ...(lanes[method] ?? []),
        { kind: 'unavailable', message: `simulated ${method} outage` },
      ];
      throw new Error(`simulated ${method} outage`);
    }
    switch (method) {
      case 'eth_chainId':
        return toHex(this.chainId);
      case 'eth_blockNumber':
        return toHex(this.head);
      case 'eth_getTransactionCount':
        return toHex(BigInt(this.nonce));
      case 'eth_getBalance':
        return toHex(this.nativeBalance);
      case 'eth_gasPrice':
        return toHex(this.gasPrice);
      case 'eth_estimateGas':
        return toHex(this.estimate);
      case 'eth_getCode':
        return this.tokenCode;
      case 'eth_call': {
        const call = params[0] as { to: string; data: string };
        const selector = call.data.slice(0, 10);
        if (selector === '0x313ce567') {
          return encodeFunctionResult({
            abi: [
              {
                type: 'function',
                name: 'decimals',
                inputs: [],
                outputs: [{ type: 'uint8' }],
                stateMutability: 'view',
              },
            ] as const,
            functionName: 'decimals',
            result: this.decimals,
          });
        }
        if (selector === '0x95d89b41') {
          return encodeFunctionResult({
            abi: [
              {
                type: 'function',
                name: 'symbol',
                inputs: [],
                outputs: [{ type: 'string' }],
                stateMutability: 'view',
              },
            ] as const,
            functionName: 'symbol',
            result: this.symbol,
          });
        }
        if (selector === '0x70a08231') {
          return encodeFunctionResult({
            abi: [
              {
                type: 'function',
                name: 'balanceOf',
                inputs: [{ name: 'account', type: 'address' }],
                outputs: [{ type: 'uint256' }],
                stateMutability: 'view',
              },
            ] as const,
            functionName: 'balanceOf',
            result: this.tokenBalance,
          });
        }
        throw new Error(`simulated eth_call selector ${selector} not implemented (test bug)`);
      }
      case 'eth_sendRawTransaction': {
        if (this.sendRawBehavior === 'timeout') {
          throw new Error('simulated sendRaw timeout (transport unavailable)');
        }
        if (this.sendRawBehavior === 'reject') {
          // A REAL JsonRpcRejectionError: the node received and refused the tx.
          throw new JsonRpcRejectionError(
            'eth_sendRawTransaction',
            -32000,
            'json-rpc eth_sendRawTransaction error -32000: insufficient funds for gas',
          );
        }
        const raw = params[0] as string;
        const parsed = parseTransaction(raw as TransactionSerializedEIP1559);
        const from = (
          await recoverTransactionAddress({
            serializedTransaction: raw as TransactionSerializedEIP1559,
          })
        ).toLowerCase();
        const hash = keccak256(raw as `0x${string}`).toLowerCase();
        this.txs.set(hash, {
          raw,
          hash,
          nonce: Number(parsed.nonce),
          from,
          to: (parsed.to ?? '').toLowerCase(),
          data: parsed.data ?? '0x',
          receipt: null,
        });
        this.nonce = Number(parsed.nonce) + 1;
        return hash;
      }
      case 'eth_getTransactionByHash': {
        const hash = (params[0] as string).toLowerCase();
        const tx = this.txs.get(hash);
        if (tx === undefined) return null;
        return {
          hash: tx.hash,
          nonce: toHex(BigInt(tx.nonce)),
          from: tx.from,
          to: tx.to,
          value: '0x0',
          data: tx.data,
          chainId: toHex(this.chainId),
          blockNumber: tx.receipt?.blockNumber ?? null,
        };
      }
      case 'eth_getTransactionReceipt': {
        const hash = (params[0] as string).toLowerCase();
        const tx = this.txs.get(hash);
        if (tx === undefined) return null;
        return tx.receipt;
      }
      default:
        throw new Error(`simulated chain has no handler for ${method} (test bug)`);
    }
  }
}

export { keccak256, toHex };
