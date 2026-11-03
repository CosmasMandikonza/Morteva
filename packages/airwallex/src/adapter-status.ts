/**
 * Honest Airwallex adapter-status descriptors (issue #5).
 *
 * MTV-03 adds the real adapter, but without sandbox credentials in the server
 * environment the rail stays DISABLED — status says exactly that, including
 * the BLOCKED real-provider gate. With credentials configured, status reports
 * the adapter as SANDBOX-CONFIGURED but still never claims a verified
 * transaction until one actually happened (receipts exist).
 */
import type { ProviderStatusView } from '@moterva/domain';

export interface AirwallexAdapterStatusInput {
  /** True when the sandbox dispatcher is actually registered on the worker. */
  readonly registered: boolean;
  /** Count of persisted Airwallex receipts (any kind) — proof of real calls. */
  readonly receiptCount: number;
  /** Count of readback receipts specifically (verified provider truth). */
  readonly readbackCount: number;
}

export function airwallexAdapterStatus(input: AirwallexAdapterStatusInput): ProviderStatusView {
  if (!input.registered) {
    return {
      id: 'airwallex',
      kind: 'Banking (Airwallex)',
      environment: 'offline',
      label: 'OFFLINE',
      detail:
        'Adapter implemented (issue #5) but DISABLED: no sandbox credentials in the server environment (AIRWALLEX_ENV/AIRWALLEX_CLIENT_ID/AIRWALLEX_API_KEY). The real-provider gate is BLOCKED on credentials; no provider call is made or claimed.',
    };
  }
  if (input.receiptCount === 0) {
    return {
      id: 'airwallex',
      kind: 'Banking (Airwallex)',
      environment: 'sandbox',
      label: 'SANDBOX',
      detail:
        'Sandbox adapter registered and enabled; no provider interaction has occurred yet (0 receipts). Nothing is claimed as verified.',
    };
  }
  const readbackNote =
    input.readbackCount > 0
      ? `${input.readbackCount} independent readback receipt(s) recorded.`
      : 'No independent readback yet — no settlement is claimed.';
  return {
    id: 'airwallex',
    kind: 'Banking (Airwallex)',
    environment: 'sandbox',
    label: 'SANDBOX',
    detail: `Sandbox adapter enabled; ${input.receiptCount} provider interaction receipt(s) persisted. ${readbackNote} Submitted is not settled.`,
  };
}
