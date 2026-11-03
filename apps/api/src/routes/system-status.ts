import type { LedgerStatusView, ProviderMode, SystemStatusView } from '@moterva/domain';
import { offlineProviderStatus } from '@moterva/providers';
import type { AppConfig } from '../config.js';
import { API_VERSION, SERVICE_NAME } from '../version.js';

const DEFAULT_SIMULATION_NOTICE =
  'Physical-world observations are not wired yet; nothing on this screen comes from a live provider.';
const SIMULATED_NOTICE =
  'DEMO_SIMULATED — physical-world observations are synthetic demo data. Provider financial systems remain OFFLINE; no live or sandbox provider call is implied.';

/**
 * Honest, read-only integration status (issue #3: "no fake integration status").
 * Providers stay OFFLINE until issues #5/#6 ship verified adapters; 'simulated'
 * changes only the demo-data notice, never a provider label. The optional
 * ledger section (MTV-02) reports local persistence facts only — it never
 * claims provider settlement.
 */
export function systemStatusView(config: AppConfig, ledger?: LedgerStatusView): SystemStatusView {
  return {
    service: SERVICE_NAME,
    version: API_VERSION,
    time: new Date().toISOString(),
    providerMode: config.providerMode satisfies ProviderMode,
    providers: [offlineProviderStatus('airwallex'), offlineProviderStatus('metal')],
    simulationNotice:
      config.providerMode === 'simulated' ? SIMULATED_NOTICE : DEFAULT_SIMULATION_NOTICE,
    ...(ledger !== undefined ? { ledger } : {}),
  };
}
