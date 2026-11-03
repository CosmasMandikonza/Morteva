/**
 * Shared read-model contract for honest system status.
 * Single owner (docs/07): apps/api produces it, apps/web renders it verbatim.
 * Labels are deliberately explicit — an integration that has not made a
 * verified provider call MUST report OFFLINE/DEMO_SIMULATED, never "connected".
 */

export type ProviderEnvironment = 'offline' | 'simulated' | 'sandbox' | 'testnet';

/** Modes actually implemented in the API. 'sandbox'/'testnet' are reserved for #5/#6. */
export type ProviderMode = 'offline' | 'simulated';

export type ProviderStatusLabel = 'OFFLINE' | 'DEMO_SIMULATED' | 'SANDBOX' | 'TESTNET';

export interface ProviderStatusView {
  readonly id: string;
  readonly kind: string;
  readonly environment: ProviderEnvironment;
  readonly label: ProviderStatusLabel;
  readonly detail: string;
}

/** Local financial-ledger health (MTV-02): persistence facts, never provider claims. */
export interface LedgerStatusView {
  readonly ok: boolean;
  readonly schemaVersion: number;
  readonly integrity: 'ok' | 'violations' | 'unchecked';
  readonly pendingDispatches: number;
}

export interface SystemStatusView {
  readonly service: string;
  readonly version: string;
  readonly time: string;
  readonly providerMode: ProviderMode;
  readonly providers: readonly ProviderStatusView[];
  readonly simulationNotice: string;
  /** Present once the API boots with the financial ledger wired (MTV-02). */
  readonly ledger?: LedgerStatusView;
}
