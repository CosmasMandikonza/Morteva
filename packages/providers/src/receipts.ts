/**
 * Provider receipt contract — the shared, provider-neutral evidence record
 * for every provider interaction (owner: providers package; implemented by
 * the ledger's ProviderReceiptService, consumed by the Airwallex adapter
 * and later Metal).
 *
 * A submission receipt alone can NEVER settle an operation: settlement
 * requires a readback receipt plus the ledger's provider-readback
 * attestation (docs/05; PR #23 review law). Payloads are stored pre-redacted
 * by the adapter; the persistence layer refuses credential-shaped payloads.
 */

export type ProviderReceiptKind =
  | 'dispatch-create'
  | 'readback-by-id'
  | 'readback-by-request-id'
  | 'balance-read'
  | 'definitive-rejection'
  | 'ambiguous-failure'
  | 'webhook';

export type ProviderReceiptEnvironment = 'sandbox' | 'offline-fixture' | 'testnet';

export interface ProviderReceipt {
  readonly orgId: string;
  readonly operationId: string | null;
  readonly requestId: string;
  /** Provider-side resource id (e.g. Airwallex transfer id), once known. */
  readonly providerResourceId: string | null;
  readonly kind: ProviderReceiptKind;
  readonly environment: ProviderReceiptEnvironment;
  readonly httpStatus: number | null;
  /** Original provider status string, not an inferred outcome. */
  readonly providerStatus: string | null;
  /** Redacted request/response snapshot (credentials never inline). */
  readonly payloadJson: string;
  readonly recordedAt: string;
}

export interface ProviderReceiptStore {
  append(receipt: ProviderReceipt): void;
  /** All receipts for an economic identity, oldest first (audit/replay). */
  listByRequestId(requestId: string, orgId: string): readonly ProviderReceipt[];
  /**
   * Owning org for an economic identity (from the durable operation row).
   * Readback receipts stay tenant-scoped even after a process restart, when
   * no dispatch has happened in this process to remember the org.
   */
  orgIdForRequestId(requestId: string): string | null;
}
