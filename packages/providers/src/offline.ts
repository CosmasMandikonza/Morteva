import type { ProviderCapabilities, ProviderId } from './ports.js';
import type { ProviderStatusView } from '@moterva/domain';

/**
 * Honest OFFLINE descriptors used by the API status route.
 * These exist so the product can never render a provider "connected" badge
 * before a verified sandbox/testnet call exists (AGENTS.md "Provider truth").
 */
const OFFLINE_CAPABILITIES: Readonly<Record<ProviderId, ProviderCapabilities>> = {
  airwallex: {
    id: 'airwallex',
    kind: 'banking',
    canReadBalance: false,
    canQuoteFx: false,
    canTransfer: false,
    supportsWebhooks: false,
    idempotency: 'request-id',
    environment: 'offline',
  },
  metal: {
    id: 'metal',
    kind: 'tokenized-payments',
    canReadBalance: false,
    canQuoteFx: false,
    canTransfer: false,
    supportsWebhooks: false,
    idempotency: 'idempotency-key',
    environment: 'offline',
  },
};

export function offlineCapabilities(id: ProviderId): ProviderCapabilities {
  return OFFLINE_CAPABILITIES[id];
}

export function offlineProviderStatus(id: ProviderId): ProviderStatusView {
  const capabilities = OFFLINE_CAPABILITIES[id];
  const trackingIssue = id === 'airwallex' ? '#5' : '#6';
  const kindLabel =
    capabilities.kind === 'banking' ? 'Banking (Airwallex)' : 'Tokenized payments (Metal)';
  return {
    id,
    kind: kindLabel,
    environment: 'offline',
    label: 'OFFLINE',
    detail: `No ${id} integration is implemented yet (tracking issue ${trackingIssue}). No credentials loaded; no provider calls attempted or claimed as working.`,
  };
}
