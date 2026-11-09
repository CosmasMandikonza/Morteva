/**
 * Lightweight entry point for server processes that only need the Metal
 * rail's CONFIGURATION GATE and HONEST STATUS — without importing the
 * signing/chain stack. `@moterva/metal` (the main entry) deliberately pulls
 * viem and the whole EIP-1559/JSON-RPC surface; an API that merely reports
 * whether the rail is enabled must not carry that weight in its startup
 * import graph (measured effect: governed-decision E2E journeys on CI are
 * timing-marginal, and a heavier API boot shifts every test's budget).
 *
 * Import graph of this entry: node:crypto (config hash inputs only) and
 * @moterva/domain — NO viem, NO signer, NO transport.
 */
export {
  loadMetalConfig,
  TAHOE_CCHAIN_RPC_URL,
  TAHOE_CHAIN_ID,
  TAHOE_EXPLORER_URL,
  TAHOE_FAUCET_URL,
} from './config.js';
export type { MetalAdapterConfig, MetalEnv } from './config.js';
export { metalAdapterStatus } from './adapter-status.js';
export type { MetalAdapterStatusInput } from './adapter-status.js';
