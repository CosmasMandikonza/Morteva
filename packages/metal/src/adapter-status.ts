/**
 * Honest Metal adapter-status descriptors (issue #6) — the Metal counterpart
 * of airwallexAdapterStatus. Without testnet credentials in the server
 * environment the rail stays DISABLED with the exact blocker; with
 * credentials the label is TESTNET and never claims a verified on-chain
 * transaction until receipts exist.
 */
import type { ProviderStatusView } from '@moterva/domain';

export interface MetalAdapterStatusInput {
  /** True when the testnet dispatcher is actually registered on the worker. */
  readonly registered: boolean;
  /** Count of persisted Metal receipts (any kind) — proof of real calls. */
  readonly receiptCount: number;
  /** Count of readback receipts specifically (verified chain truth). */
  readonly readbackCount: number;
  /** Optional exact-blocker detail overriding the generic disabled wording. */
  readonly detail?: string;
}

export function metalAdapterStatus(input: MetalAdapterStatusInput): ProviderStatusView {
  if (!input.registered) {
    return {
      id: 'metal',
      kind: 'Tokenized payments (Metal)',
      environment: 'offline',
      label: 'OFFLINE',
      detail:
        input.detail ??
        'Adapter implemented (issue #6) but DISABLED: no testnet signer/token configuration in the server environment (METAL_ENV/METAL_SIGNER_PRIVATE_KEY/METAL_USDZ_TOKEN_ADDRESS/METAL_MERCHANT_ADDRESS). Ledger enablement additionally requires the metal token-asset accounting contract (ledger migration for testnet receipt environments + metal_order mandate support); the real-testnet gate is BLOCKED. No provider call is made or claimed.',
    };
  }
  if (input.receiptCount === 0) {
    return {
      id: 'metal',
      kind: 'Tokenized payments (Metal)',
      environment: 'testnet',
      label: 'TESTNET',
      detail:
        'Metal testnet adapter registered and enabled; no chain interaction has occurred yet (0 receipts). Nothing is claimed as verified.',
    };
  }
  const readbackNote =
    input.readbackCount > 0
      ? `${input.readbackCount} independent on-chain readback receipt(s) recorded.`
      : 'No independent on-chain readback yet — no settlement is claimed.';
  return {
    id: 'metal',
    kind: 'Tokenized payments (Metal)',
    environment: 'testnet',
    label: 'TESTNET',
    detail: `Metal testnet adapter enabled; ${input.receiptCount} chain interaction receipt(s) persisted. ${readbackNote} Broadcast is not settlement.`,
  };
}
