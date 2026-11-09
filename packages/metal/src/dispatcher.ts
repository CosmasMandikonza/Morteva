/**
 * MetalDispatcher — the RailDispatcher implementation wiring the real (or
 * offline-fixture) Tahoe C-Chain into the ledger's atomic dispatch gate
 * (issue #6). Follows the reviewed Airwallex invariants (PRs #23/#26/#30)
 * with Metal's protocol differences PRESERVED EXPLICITLY — Airwallex transfer
 * semantics are never imposed on a blockchain transaction:
 *
 *  - dispatch() NEVER returns 'confirmed' (type-level). Broadcast accepted →
 *    'submitted'; the ledger moves the operation to IN_FLIGHT and
 *    reconciliation owns finality.
 *  - reconcileByRequestId() is the ONLY path returning 'confirmed', and only
 *    when ALL hold: the recorded transaction exists by hash; its receipt
 *    succeeded (status 0x1); the decoded ERC-20 Transfer log names the
 *    configured token, this wallet as sender and the EXACT authorized
 *    merchant as recipient with the EXACT authorized amount; the observation
 *    is at/ beyond the configured finality confirmations; and a COMPLETE
 *    settlement scope (org + operation + amount + currency + merchant) is
 *    present. Missing fields are EVIDENCE_INCOMPLETE; wrong values are
 *    EVIDENCE_MISMATCH; neither can ever confirm.
 *  - Durable identity (Metal difference): there is NO provider-side
 *    request_id on a chain. The signed transaction hash is known BEFORE
 *    broadcast and is persisted (receipt, kind 'dispatch-create') BEFORE
 *    eth_sendRawTransaction. Recovery always reconciles by the recorded
 *    hash — never a new economic operation. The account nonce makes a
 *    double-spend structurally impossible for one recorded intent: two
 *    transactions sharing (from, nonce) cannot both execute. The namespaced
 *    request id (`mtv-{orgHash10}-{ledgerRequestId}`) is carried in receipt
 *    payloads for correlation, not on-chain.
 *  - Definitive non-execution: if NO dispatch receipt exists for the
 *    request id, nothing was ever signed+persisted, and broadcast happens
 *    strictly after persist — so nothing was broadcast. Mirroring the
 *    reviewed Airwallex behavior for NO_TRANSFER_FOR_REQUEST_ID, this maps
 *    to 'failed' NO_BROADCAST_FOR_REQUEST_ID → the ledger escalates to a
 *    human; it never auto-reissues. (A safe same-nonce re-sign path exists
 *    but stays a human-authorized operation, not an automatic retry.)
 *  - Ambiguity: transport unavailability on broadcast → status-unknown (the
 *    tx may still have propagated); unknown hash on readback → status-unknown;
 *    receipt shallower than finality → 'processing' (keep reconciling);
 *    reorg-suspected contradictory reads → status-unknown, never ignored.
 *  - Adapter-boundary mandate checks (D7; the ledger's atomic authority gate
 *    remains the ONLY approval engine — these are provider-mechanical
 *    preconditions, not a second approval decision): kind must be
 *    `metal_order`; the beneficiary must equal the server-configured USDZ
 *    merchant address for the organization; the amount must be a positive
 *    integer within the configured per-purchase cap; the chain must be the
 *    configured Tahoe chain id (verified live at connect, and embedded in
 *    the signature itself).
 *  - Receipts store ONLY allowlisted minimized fields; the private key never
 *    enters a receipt, log or payload.
 */
import { createHash } from 'node:crypto';
import type {
  ProviderCallResult,
  ProviderCallStatus,
  ProviderSubmissionStatus,
} from '@moterva/providers';
import type { ProviderReceiptEnvironment, ProviderReceiptKind } from '@moterva/providers';
import type { DispatchCommand, RailDispatcher } from '@moterva/ledger';
import type { MetalAdapterConfig } from './config.js';
import type { JsonRpcTransport } from './chain-transport.js';
import { JsonRpcRejectionError, JsonRpcUnavailableError } from './chain-transport.js';
import type { MetalSigner } from './signer.js';
import { quantityHex, transferCalldata } from './signer.js';
import { decodeTransferLog, observeOnchain } from './status.js';
import type { ReceiptObservation } from './status.js';
import { discoverToken, readNativeBalance, readTokenBalance } from './erc20.js';

/**
 * Receipt store for the metal rail. Shape-compatible with
 * @moterva/providers ProviderReceiptStore (the environment may be
 * 'testnet' per the providers contract); persistence into the ledger's
 * `provider_receipts` additionally requires Agent A's migration 0005
 * (provider-aware rows + 'testnet' in the environment CHECK) — see
 * docs/contracts/metal-ledger-contract-request.md.
 */
export interface MetalReceiptStore {
  append(receipt: {
    orgId: string;
    operationId: string | null;
    requestId: string;
    providerResourceId: string | null;
    kind: ProviderReceiptKind;
    environment: ProviderReceiptEnvironment;
    httpStatus: number | null;
    providerStatus: string | null;
    payloadJson: string;
    recordedAt: string;
  }): void;
  listByRequestId(
    requestId: string,
    orgId: string,
  ): ReadonlyArray<{
    kind: string;
    providerResourceId: string | null;
    payloadJson: string;
    recordedAt: string;
  }>;
}

/** Scope the ledger worker binds to every reconciliation (tenant-safe). */
export interface MetalReconcileScope {
  readonly orgId: string;
  readonly operationId: string | null;
  /** Authorized amount in token minor units. */
  readonly amountMinor?: number;
  readonly currency?: string;
  /** Authorized merchant address (the operation's beneficiary field). */
  readonly merchant?: string;
}

export interface MetalSettlementScope {
  readonly orgId: string;
  readonly operationId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly merchant: string;
}

export function asMetalSettlementScope(
  scope: MetalReconcileScope | undefined,
): MetalSettlementScope | null {
  if (scope === undefined) return null;
  if (
    scope.orgId === '' ||
    scope.operationId === null ||
    scope.operationId === '' ||
    typeof scope.amountMinor !== 'number' ||
    !Number.isInteger(scope.amountMinor) ||
    scope.amountMinor <= 0 ||
    typeof scope.currency !== 'string' ||
    scope.currency === '' ||
    typeof scope.merchant !== 'string' ||
    scope.merchant === ''
  ) {
    return null;
  }
  return {
    orgId: scope.orgId,
    operationId: scope.operationId,
    amountMinor: scope.amountMinor,
    currency: scope.currency,
    merchant: scope.merchant.toLowerCase(),
  };
}

export interface MetalDispatcherDeps {
  readonly config: MetalAdapterConfig;
  readonly transport: JsonRpcTransport;
  readonly store: MetalReceiptStore;
  readonly clock: { now(): Date; iso(): string };
  /** Server-side merchant mapping per org (sandbox/testnet configuration). */
  readonly merchantForOrg: (orgId: string) => string | undefined;
  readonly environment: 'testnet' | 'offline-fixture';
  readonly signer: MetalSigner;
}

interface RecordedDispatch {
  readonly txHash: string;
  readonly nonce: number;
  readonly tokenAddress: string;
  readonly merchant: string;
  readonly amountBaseUnits: string;
  /** 'refused' = the node refused the broadcast; the tx never entered the chain. */
  readonly broadcast: 'not-broadcast' | 'accepted' | 'refused' | undefined;
}

function parseDispatchPayload(payloadJson: string): RecordedDispatch | null {
  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    const payment = parsed.payment as Record<string, unknown> | undefined;
    if (
      payment === undefined ||
      typeof payment.txHash !== 'string' ||
      typeof payment.nonce !== 'number' ||
      typeof payment.tokenAddress !== 'string' ||
      typeof payment.merchant !== 'string' ||
      typeof payment.amountBaseUnits !== 'string'
    ) {
      return null;
    }
    const broadcast = parsed.broadcast;
    return {
      txHash: payment.txHash,
      nonce: payment.nonce,
      tokenAddress: payment.tokenAddress,
      merchant: payment.merchant,
      amountBaseUnits: payment.amountBaseUnits,
      broadcast:
        broadcast === 'accepted' || broadcast === 'refused' || broadcast === 'not-broadcast'
          ? broadcast
          : undefined,
    };
  } catch {
    return null;
  }
}

/** Allowlisted receipt payload projection (no keys, no raw oversized data). */
function minimizedDispatchPayload(input: {
  requestId: string;
  providerRequestId: string;
  payment: {
    txHash: string;
    nonce: number;
    chainId: number;
    tokenAddress: string;
    merchant: string;
    amountBaseUnits: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    gas: string;
  };
  broadcast?: 'accepted' | 'refused' | 'not-broadcast';
  error?: string;
}): Record<string, unknown> {
  return {
    request_id: input.providerRequestId,
    payment: input.payment,
    ...(input.broadcast !== undefined ? { broadcast: input.broadcast } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

export class MetalDispatcher implements RailDispatcher {
  readonly rail = 'metal' as const;

  constructor(private readonly deps: MetalDispatcherDeps) {}

  private env(): 'testnet' | 'simulated' {
    return this.deps.environment === 'testnet' ? 'testnet' : 'simulated';
  }

  async dispatch(
    command: DispatchCommand,
  ): Promise<ProviderCallResult<unknown, ProviderSubmissionStatus>> {
    const merchant = this.deps.merchantForOrg(command.orgId);
    if (merchant === undefined || merchant.trim() === '') {
      return this.definitiveDispatchRejection(command, 'NO_MERCHANT_CONFIGURED', {
        note: 'no merchant configured for organization',
      });
    }
    if (command.beneficiary.trim().toLowerCase() !== merchant.toLowerCase()) {
      // The operation's authorized beneficiary is not the configured payee —
      // refuse BEFORE any signing. The ledger's BENEFICIARY_NOT_ALLOWED gate
      // remains authoritative; this is the provider-mechanical double-check.
      return this.definitiveDispatchRejection(command, 'MERCHANT_NOT_ALLOWED', {
        note: 'operation beneficiary differs from the configured merchant address',
      });
    }
    if (command.kind !== 'metal_order') {
      return this.definitiveDispatchRejection(command, 'UNSUPPORTED_KIND', {
        note: `metal rail supports kind metal_order only (got ${command.kind})`,
      });
    }
    if (!Number.isInteger(command.amountMinor) || command.amountMinor <= 0) {
      return this.definitiveDispatchRejection(command, 'INVALID_AMOUNT', {
        note: 'amount must be a positive integer number of token minor units',
      });
    }
    if (this.deps.config.maxPurchaseMinor !== null) {
      const cap = this.deps.config.maxPurchaseMinor;
      if (BigInt(command.amountMinor) > cap) {
        return this.definitiveDispatchRejection(command, 'PER_PURCHASE_CAP_EXCEEDED', {
          note: `amount ${String(command.amountMinor)} minor exceeds the configured per-purchase cap ${String(cap)}`,
        });
      }
    }
    if (this.deps.config.usdzTokenAddress === null || this.deps.config.usdzDecimals === null) {
      return this.definitiveDispatchRejection(command, 'TOKEN_NOT_CONFIGURED', {
        note: 'USDZ token configuration missing',
      });
    }

    const tokenAddress = this.deps.config.usdzTokenAddress.toLowerCase();
    const amountBaseUnits = BigInt(command.amountMinor); // internal minor exponent = token decimals
    const providerRequestId = this.namespacedRequestId(command.orgId, command.requestId);

    // Sign BEFORE persist: hash known at signature time; persisted BEFORE
    // broadcast so a crash anywhere leaves a recoverable durable identity.
    let signed;
    try {
      const nonce = await this.deps.signer.fetchNonce(this.deps.transport);
      signed = await this.deps.signer.signTransfer({
        transport: this.deps.transport,
        tokenAddress,
        to: merchant,
        amountBaseUnits,
        nonce,
      });
    } catch (error) {
      if (error instanceof JsonRpcRejectionError) {
        return this.definitiveDispatchRejection(command, 'SIGNING_REJECTED', {
          note: error.message,
          providerRequestId,
        });
      }
      this.appendAmbiguous(command, providerRequestId, error);
      return { status: 'status-unknown', environment: this.env() };
    }

    const payment = {
      txHash: signed.txHash,
      nonce: signed.nonce,
      chainId: signed.chainId,
      tokenAddress,
      merchant: merchant.toLowerCase(),
      amountBaseUnits: amountBaseUnits.toString(),
      maxFeePerGas: signed.maxFeePerGas.toString(),
      maxPriorityFeePerGas: signed.maxPriorityFeePerGas.toString(),
      gas: signed.gas.toString(),
    };

    // DURABLE BEFORE BROADCAST: receipt records the signed identity first.
    this.appendReceipt({
      orgId: command.orgId,
      operationId: command.operationId,
      requestId: command.requestId,
      providerResourceId: signed.txHash,
      kind: 'dispatch-create',
      providerStatus: 'SIGNED',
      payload: minimizedDispatchPayload({
        requestId: command.requestId,
        providerRequestId,
        payment,
        broadcast: 'not-broadcast',
      }),
    });

    try {
      await this.deps.transport.call<string>({
        method: 'eth_sendRawTransaction',
        params: [signed.rawTransaction],
        // WRITE: exactly one attempt, never retried.
      });
    } catch (error) {
      if (error instanceof JsonRpcRejectionError) {
        // The node refused the raw transaction — nothing was broadcast.
        this.appendReceipt({
          orgId: command.orgId,
          operationId: command.operationId,
          requestId: command.requestId,
          providerResourceId: signed.txHash,
          kind: 'definitive-rejection',
          providerStatus: 'BROADCAST_REJECTED',
          payload: minimizedDispatchPayload({
            requestId: command.requestId,
            providerRequestId,
            payment,
            broadcast: 'refused',
            error: error.message,
          }),
        });
        return {
          status: 'failed',
          environment: this.env(),
          providerState: 'BROADCAST_REJECTED',
        };
      }
      // Timeout/connection loss after the request was sent: the transaction
      // MAY have propagated — status-unknown, recover by the recorded hash.
      this.appendAmbiguous(command, providerRequestId, error, {
        txHash: signed.txHash,
        nonce: signed.nonce,
      });
      return { status: 'status-unknown', environment: this.env() };
    }

    this.appendReceipt({
      orgId: command.orgId,
      operationId: command.operationId,
      requestId: command.requestId,
      providerResourceId: signed.txHash,
      kind: 'dispatch-create',
      providerStatus: 'BROADCAST_ACCEPTED',
      payload: minimizedDispatchPayload({
        requestId: command.requestId,
        providerRequestId,
        payment,
        broadcast: 'accepted',
      }),
    });

    // Broadcast accepted — NEVER 'confirmed'. Finality comes only from the
    // independent readback below. receiptRef is uniformly `metal:<txHash>`
    // (the chain id lives in the receipt payload, not the ref).
    return {
      status: 'submitted',
      environment: this.env(),
      providerState: 'BROADCAST_ACCEPTED',
      receiptRef: `metal:${signed.txHash}`,
    };
  }

  async reconcileByRequestId(
    requestId: string,
    scope?: MetalReconcileScope,
  ): Promise<ProviderCallResult<unknown, ProviderCallStatus>> {
    const orgId = scope?.orgId ?? null;
    if (orgId === null || orgId === '') {
      // Without the tenant scope we cannot look up the durable dispatch
      // record — reconciliation is impossible, not "empty".
      return {
        status: 'status-unknown',
        environment: this.env(),
        providerState: 'NO_TENANT_SCOPE',
      };
    }
    const record = this.findDispatchRecord(requestId, orgId);
    if (record.kind === 'duplicate') {
      this.appendReceipt({
        orgId,
        operationId: scope?.operationId ?? null,
        requestId,
        providerResourceId: null,
        kind: 'ambiguous-failure',
        providerStatus: 'DUPLICATE_DISPATCH_RECORDS',
        payload: { note: 'multiple dispatch-create receipts for one request id; refusing to pick' },
      });
      return {
        status: 'status-unknown',
        environment: this.env(),
        providerState: 'DUPLICATE_DISPATCH_RECORDS',
      };
    }
    if (record.kind === 'rejected') {
      // The node refused the broadcast of the recorded signed transaction —
      // nothing ever entered the chain under this identity.
      return {
        status: 'failed',
        environment: this.env(),
        providerState: record.code,
      };
    }
    if (record.kind === 'none') {
      // Persist-before-broadcast ordering proves nothing was broadcast for
      // this request id. Definitive non-execution → ledger escalates; the
      // original economic intent is preserved for human resolution.
      this.appendReceipt({
        orgId,
        operationId: scope?.operationId ?? null,
        requestId,
        providerResourceId: null,
        kind: 'readback-by-request-id',
        providerStatus: null,
        payload: { note: 'no signed transaction was ever persisted for this request id' },
      });
      return {
        status: 'failed',
        environment: this.env(),
        providerState: 'NO_BROADCAST_FOR_REQUEST_ID',
      };
    }

    // Independent on-chain observation by the recorded hash.
    const recorded = record.dispatch;
    let observation: ReceiptObservation;
    try {
      observation = await observeOnchain(
        this.deps.transport,
        recorded.txHash,
        this.deps.config.finalityConfirmations,
        this.priorObservation(requestId, orgId),
      );
    } catch (error) {
      this.appendReceipt({
        orgId,
        operationId: scope?.operationId ?? null,
        requestId,
        providerResourceId: recorded.txHash,
        kind: 'ambiguous-failure',
        providerStatus: 'READBACK_INCOMPLETE',
        payload: { error: describe(error) },
      });
      return {
        status: 'status-unknown',
        environment: this.env(),
        providerState: 'READBACK_INCOMPLETE',
      };
    }

    this.appendReceipt({
      orgId,
      operationId: scope?.operationId ?? null,
      requestId,
      providerResourceId: recorded.txHash,
      kind: 'readback-by-id',
      providerStatus: observation.status.toUpperCase(),
      payload: {
        tx_hash: recorded.txHash,
        onchain_status: observation.status,
        block_number: observation.blockNumber === null ? null : observation.blockNumber.toString(),
        block_hash: observation.blockHash,
        confirmations: observation.confirmations,
        finality_confirmations_required: this.deps.config.finalityConfirmations,
      },
    });

    if (observation.status === 'reverted') {
      return {
        status: 'failed',
        environment: this.env(),
        providerState: 'REVERTED',
        receiptRef: `metal:${recorded.txHash}`,
      };
    }
    if (observation.status === 'not-found') {
      // The recorded hash is unknown to the node. It may still be propagating
      // (or the node lags) — ambiguous, keep reconciling; never re-sign here.
      return {
        status: 'status-unknown',
        environment: this.env(),
        providerState: 'TRANSACTION_NOT_FOUND',
      };
    }
    if (observation.status === 'reorg-suspected') {
      return {
        status: 'status-unknown',
        environment: this.env(),
        providerState: 'REORG_SUSPECTED',
      };
    }
    if (observation.status === 'mempool' || observation.status === 'pending-finality') {
      return {
        status: 'processing',
        environment: this.env(),
        providerState: observation.status.toUpperCase(),
        receiptRef: `metal:${recorded.txHash}`,
      };
    }

    // status === 'finalized': validate the economic identity from the chain
    // itself (final-round P0-3 analogue) BEFORE any confirmation.
    const receipt = observation.receipt;
    if (receipt === null) {
      return {
        status: 'status-unknown',
        environment: this.env(),
        providerState: 'EVIDENCE_INCOMPLETE',
      };
    }
    const tokenAddress = this.deps.config.usdzTokenAddress?.toLowerCase() ?? '';
    const merchantAddress = this.deps.config.merchantAddress?.toLowerCase() ?? '';
    const transfer = decodeTransferLog(receipt, {
      tokenAddress,
      from: this.deps.signer.address,
      to: merchantAddress,
    });
    if (transfer === null) {
      this.appendReceipt({
        orgId,
        operationId: scope?.operationId ?? null,
        requestId,
        providerResourceId: recorded.txHash,
        kind: 'ambiguous-failure',
        providerStatus: 'EVIDENCE_MISMATCH',
        payload: {
          note: 'finalized receipt does not carry a Transfer log from this wallet to the configured merchant over the configured token',
          tx_hash: recorded.txHash,
        },
      });
      return {
        status: 'status-unknown',
        environment: this.env(),
        providerState: 'EVIDENCE_MISMATCH',
      };
    }

    const settlement = asMetalSettlementScope(scope);
    if (settlement === null) {
      this.appendReceipt({
        orgId,
        operationId: scope?.operationId ?? null,
        requestId,
        providerResourceId: recorded.txHash,
        kind: 'ambiguous-failure',
        providerStatus: 'SCOPE_INCOMPLETE',
        payload: { note: 'finalized readback without a complete settlement scope; observing only' },
      });
      return {
        status: 'status-unknown',
        environment: this.env(),
        providerState: 'SCOPE_INCOMPLETE',
      };
    }
    const mismatches: string[] = [];
    if (settlement.merchant.toLowerCase() !== merchantAddress) {
      mismatches.push('merchant: settlement scope differs from the configured merchant address');
    }
    if (transfer.value !== BigInt(recorded.amountBaseUnits)) {
      mismatches.push(
        `amount: recorded ${recorded.amountBaseUnits} base units, on-chain log shows ${transfer.value.toString()}`,
      );
    }
    if (settlement.currency.toUpperCase() !== (this.deps.config.usdzSymbol ?? '').toUpperCase()) {
      mismatches.push(
        `currency: authorized ${settlement.currency}, configured token is ${this.deps.config.usdzSymbol ?? 'unknown'}`,
      );
    }
    if (mismatches.length > 0) {
      this.appendReceipt({
        orgId,
        operationId: settlement.operationId,
        requestId,
        providerResourceId: recorded.txHash,
        kind: 'ambiguous-failure',
        providerStatus: 'EVIDENCE_MISMATCH',
        payload: { mismatches, tx_hash: recorded.txHash },
      });
      return {
        status: 'status-unknown',
        environment: this.env(),
        providerState: 'EVIDENCE_MISMATCH',
      };
    }

    // THE ONLY 'confirmed' in this adapter: finalized receipt whose decoded
    // Transfer log matches every authorized term exactly, timestamped.
    return {
      status: 'confirmed',
      environment: this.env(),
      providerState: 'FINALIZED',
      verifiedAt: this.deps.clock.iso(),
      receiptRef: `metal:${recorded.txHash}`,
    };
  }

  /** Balance read for the smoke harness (native gas + USDZ token). */
  async readBalances(): Promise<
    | {
        ok: true;
        nativeWei: bigint;
        tokenBaseUnits: bigint;
        tokenAddress: string;
        readAt: string;
      }
    | { ok: false; providerCode: string | null }
  > {
    try {
      const tokenAddress = this.deps.config.usdzTokenAddress;
      if (tokenAddress === null) return { ok: false, providerCode: 'TOKEN_NOT_CONFIGURED' };
      const [nativeWei, tokenBaseUnits] = await Promise.all([
        readNativeBalance(this.deps.transport, this.deps.signer.address),
        readTokenBalance(this.deps.transport, tokenAddress, this.deps.signer.address),
      ]);
      return { ok: true, nativeWei, tokenBaseUnits, tokenAddress, readAt: this.deps.clock.iso() };
    } catch (error) {
      return {
        ok: false,
        providerCode: error instanceof JsonRpcRejectionError ? String(error.rpcCode) : null,
      };
    }
  }

  /** Connect-time chain verification (smoke + registration gating). */
  async verifyConnection(): Promise<{
    chainId: number;
    blockNumber: bigint;
    token: { address: string; symbol: string; decimals: number } | null;
  }> {
    const rawChainId = await this.deps.transport.call<string>({
      method: 'eth_chainId',
      params: [],
      idempotentRead: true,
    });
    const chainId = Number(BigInt(rawChainId));
    if (chainId !== this.deps.config.chainId) {
      throw new Error(
        `connected chain id ${String(chainId)} does not match the configured chain id ${String(this.deps.config.chainId)} — refusing to operate on the wrong chain`,
      );
    }
    const blockNumber = await this.deps.transport.call<string>({
      method: 'eth_blockNumber',
      params: [],
      idempotentRead: true,
    });
    let token: { address: string; symbol: string; decimals: number } | null = null;
    if (
      this.deps.config.usdzTokenAddress !== null &&
      this.deps.config.usdzSymbol !== null &&
      this.deps.config.usdzDecimals !== null
    ) {
      token = await discoverToken(this.deps.transport, {
        address: this.deps.config.usdzTokenAddress,
        symbol: this.deps.config.usdzSymbol,
        decimals: this.deps.config.usdzDecimals,
      });
    }
    return { chainId, blockNumber: BigInt(blockNumber), token };
  }

  private namespacedRequestId(orgId: string, ledgerRequestId: string): string {
    // Same namespacing law as Airwallex (org-scoped correlation identity);
    // on-chain there is no request_id — this lives in receipts only.
    return `mtv-${createHash('sha256').update(orgId, 'utf8').digest('hex').slice(0, 10)}-${ledgerRequestId}`;
  }

  /**
   * Resolves the durable dispatch record for a request id. Receipts SIGNED
   * and BROADCAST_ACCEPTED share ONE hash (two records, one economic
   * operation), so duplicates are counted by DISTINCT tx hash; a
   * BROADCAST_REJECTED definitive rejection resolves as definitively failed.
   */
  private findDispatchRecord(
    requestId: string,
    orgId: string,
  ):
    | { kind: 'none' }
    | { kind: 'duplicate' }
    | { kind: 'rejected'; code: string }
    | { kind: 'recorded'; dispatch: RecordedDispatch } {
    const receipts = this.deps.store.listByRequestId(requestId, orgId);
    const parsed = receipts
      .filter((r) => r.kind === 'dispatch-create' || r.kind === 'definitive-rejection')
      .map((r) => parseDispatchPayload(r.payloadJson))
      .filter((p): p is RecordedDispatch => p !== null);
    const distinctHashes = new Set<string>();
    let first: RecordedDispatch | null = null;
    for (const p of parsed) {
      distinctHashes.add(p.txHash);
      if (first === null) first = p;
    }
    if (distinctHashes.size > 1) return { kind: 'duplicate' };
    if (distinctHashes.size === 1 && first !== null) {
      const refusedForSoleHash = parsed.some(
        (p) => p.broadcast === 'refused' && p.txHash === first.txHash,
      );
      if (refusedForSoleHash) return { kind: 'rejected', code: 'BROADCAST_REJECTED' };
      return { kind: 'recorded', dispatch: first };
    }
    return { kind: 'none' };
  }

  private priorObservation(
    requestId: string,
    orgId: string,
  ): { blockNumber: bigint; blockHash: string } | null {
    const receipts = this.deps.store.listByRequestId(requestId, orgId);
    for (let i = receipts.length - 1; i >= 0; i -= 1) {
      const receipt = receipts[i];
      if (receipt === undefined || receipt.kind !== 'readback-by-id') continue;
      try {
        const parsed = JSON.parse(receipt.payloadJson) as {
          block_number?: string | null;
          block_hash?: string | null;
        };
        if (parsed.block_number && parsed.block_hash) {
          return { blockNumber: BigInt(parsed.block_number), blockHash: parsed.block_hash };
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private definitiveDispatchRejection(
    command: DispatchCommand,
    code: string,
    detail: { note: string; providerRequestId?: string },
  ): ProviderCallResult<unknown, ProviderSubmissionStatus> {
    this.appendReceipt({
      orgId: command.orgId,
      operationId: command.operationId,
      requestId: command.requestId,
      providerResourceId: null,
      kind: 'definitive-rejection',
      providerStatus: code,
      payload: {
        ...(detail.providerRequestId !== undefined ? { request_id: detail.providerRequestId } : {}),
        note: detail.note,
      },
    });
    return { status: 'failed', environment: this.env(), providerState: code };
  }

  private appendAmbiguous(
    command: DispatchCommand,
    providerRequestId: string,
    error: unknown,
    signed?: { txHash: string; nonce: number },
  ): void {
    this.appendReceipt({
      orgId: command.orgId,
      operationId: command.operationId,
      requestId: command.requestId,
      providerResourceId: signed?.txHash ?? null,
      kind: 'ambiguous-failure',
      providerStatus: null,
      payload: {
        request_id: providerRequestId,
        ...(signed !== undefined
          ? { signed_tx_hash: signed.txHash, signed_nonce: signed.nonce }
          : {}),
        error: describe(error),
      },
    });
  }

  private appendReceipt(input: {
    orgId: string;
    operationId: string | null;
    requestId: string;
    providerResourceId: string | null;
    kind: ProviderReceiptKind;
    providerStatus: string | null;
    payload: unknown;
  }): void {
    this.deps.store.append({
      orgId: input.orgId,
      operationId: input.operationId,
      requestId: input.requestId,
      providerResourceId: input.providerResourceId,
      kind: input.kind,
      environment: this.deps.environment === 'testnet' ? 'testnet' : 'offline-fixture',
      httpStatus: null,
      providerStatus: input.providerStatus,
      payloadJson: JSON.stringify(input.payload ?? null),
      recordedAt: this.deps.clock.iso(),
    });
  }
}

function describe(error: unknown): string {
  if (error instanceof JsonRpcUnavailableError || error instanceof JsonRpcRejectionError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Builds the LIVE (testnet) dispatcher; refuses fixture transports. */
export function buildTestnetDispatcher(
  config: MetalAdapterConfig,
  transport: JsonRpcTransport,
  store: MetalReceiptStore,
  clock: { now(): Date; iso(): string },
  merchantForOrg: (orgId: string) => string | undefined,
  signer: MetalSigner,
): MetalDispatcher {
  if (!config.enabled) {
    throw new Error(
      'buildTestnetDispatcher requires an enabled testnet configuration with credentials',
    );
  }
  if ((transport as { __offlineFixture?: boolean }).__offlineFixture === true) {
    throw new Error('buildTestnetDispatcher must not be wired to the offline fixture transport');
  }
  return new MetalDispatcher({
    config,
    transport,
    store,
    clock,
    merchantForOrg,
    environment: 'testnet',
    signer,
  });
}

/** Builds the OFFLINE FIXTURE dispatcher (tests only; reports 'simulated'). */
export function buildOfflineFixtureDispatcher(
  config: MetalAdapterConfig,
  transport: JsonRpcTransport,
  store: MetalReceiptStore,
  clock: { now(): Date; iso(): string },
  merchantForOrg: (orgId: string) => string | undefined,
  signer: MetalSigner,
): MetalDispatcher {
  return new MetalDispatcher({
    config,
    transport,
    store,
    clock,
    merchantForOrg,
    environment: 'offline-fixture',
    signer,
  });
}

export { quantityHex, transferCalldata };
