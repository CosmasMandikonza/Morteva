import type {
  LedgerStatusView,
  ProviderMode,
  ProviderStatusView,
  SystemStatusView,
} from '@moterva/domain';
import { offlineProviderStatus } from '@moterva/providers';
import { airwallexAdapterStatus } from '@moterva/airwallex';
import type { AppConfig } from '../config.js';
import { API_VERSION, SERVICE_NAME } from '../version.js';

const DEFAULT_SIMULATION_NOTICE =
  'Physical-world observations are not wired yet; nothing on this screen comes from a live provider.';
const SIMULATED_NOTICE =
  'DEMO_SIMULATED — physical-world observations are synthetic demo data. Provider financial systems remain OFFLINE; no live or sandbox provider call is implied.';

export interface AirwallexRailFacts {
  readonly registered: boolean;
  readonly receiptCount: number;
  readonly readbackCount: number;
}

/**
 * Honest, read-only integration status (issue #3: "no fake integration status").
 * The Airwallex entry reflects the real adapter state (issue #5): DISABLED
 * with the BLOCKED credential gate until sandbox credentials configure it, and
 * even then nothing is claimed as verified until receipts exist. Metal stays
 * OFFLINE (issue #6). 'simulated' changes only the demo-data notice.
 */
export function systemStatusView(
  config: AppConfig,
  ledger?: LedgerStatusView,
  airwallexFacts?: AirwallexRailFacts,
): SystemStatusView {
  const airwallex: ProviderStatusView =
    airwallexFacts !== undefined
      ? airwallexAdapterStatus(airwallexFacts)
      : offlineProviderStatus('airwallex');
  return {
    service: SERVICE_NAME,
    version: API_VERSION,
    time: new Date().toISOString(),
    providerMode: config.providerMode satisfies ProviderMode,
    providers: [airwallex, offlineProviderStatus('metal')],
    simulationNotice:
      config.providerMode === 'simulated' ? SIMULATED_NOTICE : DEFAULT_SIMULATION_NOTICE,
    ...(ledger !== undefined ? { ledger } : {}),
  };
}
