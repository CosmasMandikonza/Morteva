/**
 * Provider ports — the frozen contract shape required by docs/01 "Contract gate".
 *
 * MTV-01 declares these interfaces so later issues (#5 Airwallex, #6 Metal)
 * implement against one owner-owned contract. There is deliberately NO working
 * implementation here: calling any port method is only possible once #5/#6 ship
 * server-side adapters. Nothing in this package may be imported by the web app
 * to perform provider calls; ports execute server-side only.
 */
import type { Money } from '@moterva/domain';

export type ProviderId = 'airwallex' | 'metal';

/** Every capability a provider adapter must declare before use. */
export interface ProviderCapabilities {
  readonly id: ProviderId;
  readonly kind: 'banking' | 'tokenized-payments';
  /** True only after a verified sandbox/testnet read in the owning issue. */
  readonly canReadBalance: boolean;
  readonly canQuoteFx: boolean;
  readonly canTransfer: boolean;
  readonly supportsWebhooks: boolean;
  /** How the provider de-duplicates the same economic operation. */
  readonly idempotency: 'request-id' | 'idempotency-key' | 'none';
  /** Which environment this adapter instance talks to. 'offline' means no calls exist. */
  readonly environment: 'offline' | 'simulated' | 'sandbox' | 'testnet';
}

/**
 * Observable provider operation outcome. Submission is NOT settlement.
 * Only a separately verified provider-specific terminal state is 'confirmed'.
 * A timeout is status-unknown, never proof the operation failed or safe to retry
 * with a new economic identity (docs/01, docs/05).
 */
export type ProviderCallStatus =
  'submitted' | 'processing' | 'confirmed' | 'failed' | 'status-unknown';

/** A provider write response cannot self-attest independent settlement. */
export type ProviderSubmissionStatus = Exclude<ProviderCallStatus, 'confirmed'>;

export function isConfirmedProviderResult(status: ProviderCallStatus): boolean {
  return status === 'confirmed';
}

export interface ProviderCallResult<
  TResult,
  TStatus extends ProviderCallStatus = ProviderCallStatus,
> {
  readonly status: TStatus;
  readonly environment: ProviderCapabilities['environment'];
  /** Original provider status, not an inferred transaction outcome. */
  readonly providerState?: string;
  /** Timestamp of independent readback for an operation marked confirmed. */
  readonly verifiedAt?: string;
  readonly value?: TResult;
  /** Reference to durable raw provider evidence; secrets never inline. */
  readonly receiptRef?: string;
}

export interface BalanceQuery {
  readonly currency: string;
}

export interface BalanceReading {
  readonly currency: string;
  /** Money as of the provider read; staleness handled by callers. */
  readonly amount: Money;
}

/** Read-only provider port (balances, quotes). Writes live in ExecutionPort only. */
export interface ProviderReadPort<TQuery, TResult> {
  readonly capabilities: ProviderCapabilities;
  read(query: TQuery): Promise<ProviderCallResult<TResult>>;
}

/**
 * A financial write command. `requestId` is the durable economic identity that
 * MUST be persisted before dispatch and reused for any retry of the same
 * operation (docs/01 "Core transaction sequence" step 4).
 */
export interface ProviderCommandBase {
  readonly requestId: string;
  readonly amount: Money;
  readonly purpose: string;
}

/** Execution port — NOT implemented in MTV-01; #5/#6 provide server-side adapters. */
export interface ProviderExecutionPort<TCommand extends ProviderCommandBase, TResult> {
  readonly capabilities: ProviderCapabilities;
  /** Dispatch only; write response MUST NOT be equated with settlement. */
  execute(command: TCommand): Promise<ProviderCallResult<TResult, ProviderSubmissionStatus>>;
  /** Independently verify a receipt's state from provider truth, not local cache. */
  verifyReceipt(receiptRef: string): Promise<ProviderCallResult<TResult>>;
  /**
   * Recover a timed-out/ambiguous dispatch using the durable original requestId.
   * If the provider cannot search by requestId, return status-unknown and
   * preserve the commitment; do not silently submit a new economic operation.
   */
  reconcileByRequestId(requestId: string): Promise<ProviderCallResult<TResult>>;
}
