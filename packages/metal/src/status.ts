/**
 * On-chain status normalization and independent receipt verification
 * (issue #6; the Metal counterpart of the Airwallex conservative status
 * table and R3 P0-3 economic-identity validation).
 *
 * VERIFIED FACTS vs EXPLICIT ASSUMPTIONS — kept separate by construction:
 *  - VERIFIED from the chain: the transaction receipt fields (status, block
 *    number, block hash, logs), the head block number, the Transfer log.
 *  - EXPLICIT ASSUMPTION (configurable): finality confirmations
 *    (METAL_FINALITY_CONFIRMATIONS, default 12). Metal Tahoe's formal
 *    finality rule is not published in the public docs this repository relies
 *    on, so the adapter treats N-blocks-deep as the configured evidence
 *    threshold — conservative, explicit, and never claimed to be the chain's
 *    own finality rule. Reorg handling is honest: a receipt that disappears
 *    or changes block hash on re-query is REORG_SUSPECTED (status-unknown),
 *    never ignored.
 */
import { TRANSFER_EVENT_TOPIC } from './erc20.js';
import type { JsonRpcTransport } from './chain-transport.js';

export interface RpcLog {
  readonly address?: string;
  readonly topics?: readonly string[];
  readonly data?: string;
  readonly blockNumber?: string;
  readonly transactionHash?: string;
  readonly logIndex?: string;
}

export interface RpcTransaction {
  readonly hash?: string;
  readonly nonce?: string;
  readonly from?: string;
  readonly to?: string | null;
  readonly value?: string;
  readonly data?: string;
  readonly chainId?: string;
  readonly blockNumber?: string | null;
}

export interface RpcReceipt {
  readonly transactionHash?: string;
  readonly status?: string; // '0x1' success, '0x0' reverted
  readonly blockNumber?: string;
  readonly blockHash?: string;
  readonly logs?: readonly RpcLog[];
  readonly from?: string;
  readonly to?: string | null;
  readonly effectiveGasPrice?: string;
  readonly gasUsed?: string;
}

/** Normalized on-chain outcome for one recorded transaction identity. */
export type OnchainStatus =
  | 'not-found' // no transaction with the recorded hash (may still be propagating, or dropped)
  | 'mempool' // transaction exists, no receipt yet
  | 'reverted' // receipt status 0x0 — terminal failure (executed, rolled back)
  | 'pending-finality' // receipt status 0x1 but shallower than the configured finality depth
  | 'finalized' // receipt status 0x1 at/ beyond the configured finality depth
  | 'reorg-suspected'; // contradictory chain reads (receipt vanished / block hash changed)

export interface ReceiptObservation {
  readonly status: OnchainStatus;
  /** Block confirmations at observation time (head − receipt block + 1). */
  readonly confirmations: number | null;
  readonly blockNumber: bigint | null;
  readonly blockHash: string | null;
  readonly receipt: RpcReceipt | null;
}

/**
 * Decodes the ERC-20 Transfer log of the payment. Returns null when no log
 * matches (wrong token, wrong event, empty logs) — the caller then fails
 * closed (EVIDENCE_MISMATCH), never confirms.
 */
export function decodeTransferLog(
  receipt: RpcReceipt,
  expected: { tokenAddress: string; from: string; to: string },
): { from: string; to: string; value: bigint } | null {
  const logs = receipt.logs ?? [];
  for (const log of logs) {
    const topics = log.topics ?? [];
    if (topics.length !== 3) continue;
    if ((topics[0] ?? '').toLowerCase() !== TRANSFER_EVENT_TOPIC.toLowerCase()) continue;
    if ((log.address ?? '').toLowerCase() !== expected.tokenAddress.toLowerCase()) continue;
    // ERC-20 Transfer(address indexed from, address indexed to, uint256 value)
    const from = `0x${(topics[1] ?? '').slice(26)}`.toLowerCase();
    const to = `0x${(topics[2] ?? '').slice(26)}`.toLowerCase();
    if (from !== expected.from.toLowerCase() || to !== expected.to.toLowerCase()) continue;
    const valueHex = (log.data ?? '0x').replace(/^0x/, '');
    if (!/^[0-9a-fA-F]*$/.test(valueHex) || valueHex.length > 64) continue;
    return { from, to, value: BigInt(`0x${valueHex.length === 0 ? '0' : valueHex}`) };
  }
  return null;
}

/**
 * One authoritative on-chain observation of a recorded transaction identity:
 * by-hash transaction, then its receipt. `prior` is the previously persisted
 * observation (from an earlier readback receipt) — used ONLY for reorg
 * detection, never to shortcut verification.
 */
export async function observeOnchain(
  transport: JsonRpcTransport,
  txHash: string,
  finalityConfirmations: number,
  prior?: { blockNumber: bigint; blockHash: string } | null,
): Promise<ReceiptObservation> {
  const tx = await transport.call<RpcTransaction | null>({
    method: 'eth_getTransactionByHash',
    params: [txHash],
    idempotentRead: true,
  });
  if (tx === null || tx === undefined) {
    return {
      status: 'not-found',
      confirmations: null,
      blockNumber: null,
      blockHash: null,
      receipt: null,
    };
  }
  const receipt = await transport.call<RpcReceipt | null>({
    method: 'eth_getTransactionReceipt',
    params: [txHash],
    idempotentRead: true,
  });
  if (receipt === null || receipt === undefined) {
    return {
      status: 'mempool',
      confirmations: null,
      blockNumber: null,
      blockHash: null,
      receipt: null,
    };
  }
  if (
    receipt.status === undefined ||
    receipt.blockNumber === undefined ||
    receipt.blockHash === undefined
  ) {
    // Malformed receipt: ambiguous, never final.
    return {
      status: 'mempool',
      confirmations: null,
      blockNumber: null,
      blockHash: null,
      receipt: null,
    };
  }
  const blockNumber = BigInt(receipt.blockNumber);
  const blockHash = (receipt.blockHash ?? '').toLowerCase();

  // Reorg detection: a previously recorded receipt that now reports a
  // different block hash at the same height is a contradictory read —
  // status-unknown, never ignored.
  if (
    prior !== null &&
    prior !== undefined &&
    prior.blockNumber === blockNumber &&
    prior.blockHash !== blockHash
  ) {
    return { status: 'reorg-suspected', confirmations: null, blockNumber, blockHash, receipt };
  }

  const head = await readHead(transport);
  const confirmations = head >= blockNumber ? Number(head - blockNumber + 1n) : 0;
  if (receipt.status === '0x0' || receipt.status === '0x00') {
    return { status: 'reverted', confirmations, blockNumber, blockHash, receipt };
  }
  if (receipt.status === '0x1' || receipt.status === '0x01') {
    return {
      status: confirmations >= finalityConfirmations ? 'finalized' : 'pending-finality',
      confirmations,
      blockNumber,
      blockHash,
      receipt,
    };
  }
  // Unknown status encoding: never guess.
  return { status: 'mempool', confirmations, blockNumber, blockHash, receipt };
}

async function readHead(transport: JsonRpcTransport): Promise<bigint> {
  const raw = await transport.call<string>({
    method: 'eth_blockNumber',
    params: [],
    idempotentRead: true,
  });
  return BigInt(raw);
}
