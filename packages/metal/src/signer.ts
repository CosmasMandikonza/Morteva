/**
 * Server-only transaction signer (issue #6).
 *
 * An AI model NEVER receives signing capability: the private key lives in the
 * server environment only (`METAL_SIGNER_PRIVATE_KEY`), is never logged,
 * persisted or returned, and this module is the ONLY code that touches it.
 *
 * The critical identity property for the ledger: an EIP-155/EIP-1559
 * transaction's hash is keccak256(serialized signed tx) — known the MOMENT
 * signing completes, BEFORE broadcast. The dispatcher persists
 * (txHash, nonce, chainId, to, value, data) durably BEFORE
 * eth_sendRawTransaction, so:
 *   - crash between sign and persist → the signed tx is discarded in memory
 *     and was never broadcast; recovery may re-sign (the account nonce is
 *     still free — verifiable on-chain);
 *   - crash after persist, before/after broadcast → recovery reconciles by
 *     the recorded hash, never signing a second economic operation;
 *   - two transactions with the same (from, nonce) cannot BOTH execute — the
 *     EVM nonce ordering is the chain-native duplicate-prevention equivalent
 *     of Airwallex's request_id dedupe. This difference is explicit: Metal
 *     has NO provider-side request-id, so durable identity = recorded nonce +
 *     tx hash + local ledger uniqueness (documented in ADR 0006).
 *
 * Fees are conservative EIP-1559 fields re-estimated per attempt from the
 * chain (eth_gasPrice + headroom). They are signing parameters, not claims
 * about chain finality. A broadcast refusal (e.g. insufficient native balance
 * for gas, underpriced) surfaces as a definitive JsonRpcRejectionError.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, encodeFunctionData, toHex } from 'viem';
import type { LocalAccount } from 'viem';
import type { JsonRpcTransport } from './chain-transport.js';
import { JsonRpcRejectionError } from './chain-transport.js';

const TRANSFER_ABI = [
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

const GAS_SANITY_CAP = 500_000n; // an ERC-20 transfer is ~50–65k gas on EVM chains

export interface SignedTransfer {
  /** keccak256 of the signed raw transaction — known BEFORE broadcast. */
  readonly txHash: string;
  readonly rawTransaction: string;
  readonly nonce: number;
  readonly chainId: number;
  readonly from: string;
  readonly to: string;
  readonly data: string;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly gas: bigint;
}

export function transferCalldata(to: string, amountBaseUnits: bigint): string {
  return encodeFunctionData({
    abi: TRANSFER_ABI,
    functionName: 'transfer',
    args: [to as `0x${string}`, amountBaseUnits],
  });
}

export function quantityHex(value: bigint): string {
  return toHex(value);
}

async function estimateGasWithHeadroom(
  transport: JsonRpcTransport,
  tx: { from: string; to: string; data: string },
): Promise<bigint> {
  const raw = await transport.call<string>({
    method: 'eth_estimateGas',
    params: [{ from: tx.from, to: tx.to, data: tx.data }],
    idempotentRead: true,
  });
  const estimate = BigInt(raw);
  // 1.5x headroom, hard-capped: wildly larger estimates indicate a reverting
  // transaction (insufficient token balance / non-standard token) — fail
  // before signing, never sign a transaction we already know would revert.
  const withHeadroom = (estimate * 3n) / 2n;
  if (withHeadroom > GAS_SANITY_CAP) {
    throw new JsonRpcRejectionError(
      'eth_estimateGas',
      -32099,
      `estimated gas ${String(estimate)} with headroom exceeds the ${String(GAS_SANITY_CAP)} sanity cap — the transfer would revert (insufficient token balance or a non-standard token)`,
    );
  }
  return withHeadroom;
}

async function feeFields(
  transport: JsonRpcTransport,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const raw = await transport.call<string>({
    method: 'eth_gasPrice',
    params: [],
    idempotentRead: true,
  });
  const gasPrice = BigInt(raw);
  // maxFee = 2x current gas price (covers short-term base-fee movement);
  // priority fee = gas price / 10, floored at 1 gwei. Conservative signing
  // parameters only — never a finality or fee-level claim.
  const maxFeePerGas = gasPrice * 2n;
  const floor = 1_000_000_000n;
  const maxPriorityFeePerGas = gasPrice / 10n > floor ? gasPrice / 10n : floor;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

export class MetalSigner {
  private readonly account: LocalAccount;
  private lastSignedNonce: number | null = null;

  constructor(
    privateKeyHex: string,
    private readonly chainId: number,
  ) {
    // Throws on malformed keys; key material stays in this closure only.
    this.account = privateKeyToAccount(privateKeyHex as `0x${string}`);
  }

  get address(): string {
    return this.account.address.toLowerCase();
  }

  /**
   * True once this signer instance has already signed `nonce`. The dispatcher
   * uses this to refuse signing a second transaction for the same nonce in
   * one process (duplicate signed order). Across processes the durable
   * receipt record + ledger request-id uniqueness carry the same guarantee.
   */
  hasSignedNonce(nonce: number): boolean {
    return this.lastSignedNonce === nonce;
  }

  /**
   * Builds, signs and returns a 1559 ERC-20 transfer WITHOUT broadcasting.
   * `nonce` is supplied by the caller (fetched from the chain and recorded in
   * the durable intent), so a re-sign after a pre-broadcast crash naturally
   * reuses the same nonce — the same economic identity.
   */
  async signTransfer(input: {
    readonly transport: JsonRpcTransport;
    readonly tokenAddress: string;
    readonly to: string;
    readonly amountBaseUnits: bigint;
    readonly nonce: number;
  }): Promise<SignedTransfer> {
    if (this.lastSignedNonce === input.nonce) {
      throw new Error(
        `refusing to sign a second transaction for nonce ${String(input.nonce)} in this process (duplicate signed order)`,
      );
    }
    const data = transferCalldata(input.to, input.amountBaseUnits);
    const gas = await estimateGasWithHeadroom(input.transport, {
      from: this.account.address,
      to: input.tokenAddress,
      data,
    });
    const { maxFeePerGas, maxPriorityFeePerGas } = await feeFields(input.transport);
    const serialized = await this.account.signTransaction({
      chainId: this.chainId,
      nonce: input.nonce,
      to: input.tokenAddress as `0x${string}`,
      value: 0n,
      data: data as `0x${string}`,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      type: 'eip1559',
    });
    this.lastSignedNonce = input.nonce;
    return {
      txHash: keccak256(serialized).toLowerCase(),
      rawTransaction: serialized,
      nonce: input.nonce,
      chainId: this.chainId,
      from: this.account.address.toLowerCase(),
      to: input.tokenAddress.toLowerCase(),
      data,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gas,
    };
  }

  /**
   * Fetches the next usable account nonce from the chain ('pending' count).
   * Callers record it durably with the signed tx.
   */
  async fetchNonce(transport: JsonRpcTransport): Promise<number> {
    const pending = await transport.call<string>({
      method: 'eth_getTransactionCount',
      params: [this.account.address, 'pending'],
      idempotentRead: true,
    });
    return Number(BigInt(pending));
  }
}
