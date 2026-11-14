/**
 * @moterva/metal — genuine Metal Blockchain (Metallicus) Tahoe testnet
 * adapter for mandate-controlled agentic purchases (issue #6).
 *
 * Server-only. The signer key, RPC origin and USDZ token configuration live
 * exclusively in the server environment; nothing here may be imported by the
 * web app to perform chain calls. Verified environment facts (docs
 * docs.metalblockchain.org "Tahoe Workflow", checked 2026-11-08): Tahoe
 * C-Chain RPC https://tahoe.metalblockchain.org/ext/bc/C/rpc, chain id
 * 381932, explorer https://tahoe.metalscan.io/, faucet
 * https://faucet.metalblockchain.org.
 */
export {
  loadMetalConfig,
  isHexAddress,
  normalizeHexAddress,
  TAHOE_CCHAIN_RPC_URL,
  TAHOE_CHAIN_ID,
  TAHOE_EXPLORER_URL,
  TAHOE_FAUCET_URL,
} from './config.js';
export type { MetalAdapterConfig, MetalEnv } from './config.js';

export {
  HttpJsonRpcTransport,
  FixtureJsonRpcTransport,
  JsonRpcUnavailableError,
  JsonRpcRejectionError,
} from './chain-transport.js';
export type {
  JsonRpcTransport,
  JsonRpcCall,
  FixtureRpcScript,
  FixtureRpcStep,
} from './chain-transport.js';

export {
  ERC20_ABI,
  TRANSFER_EVENT_TOPIC,
  encodeErc20Call,
  buildTransferCalldata,
  readTokenDecimals,
  readTokenSymbol,
  readTokenBalance,
  readNativeBalance,
  readBlockNumber,
  discoverToken,
  toQuantityHex,
} from './erc20.js';

export { MetalSigner, transferCalldata, quantityHex } from './signer.js';
export type { SignedTransfer } from './signer.js';

export { decodeTransferLog, observeOnchain } from './status.js';
export type {
  OnchainStatus,
  ReceiptObservation,
  RpcLog,
  RpcReceipt,
  RpcTransaction,
} from './status.js';

export {
  MetalDispatcher,
  buildTestnetDispatcher,
  buildOfflineFixtureDispatcher,
  asMetalSettlementScope,
} from './dispatcher.js';
export type {
  MetalDispatcherDeps,
  MetalReceiptStore,
  MetalReconcileScope,
  MetalSettlementScope,
} from './dispatcher.js';

export { metalAdapterStatus } from './adapter-status.js';
export type { MetalAdapterStatusInput } from './adapter-status.js';

export {
  TokenMoneyError,
  minorToMajorString,
  majorStringToMinor,
  amountToBaseUnits,
} from './money.js';

export { runMetalPurchaseJourney, offerDigestOf, quarantineFindings } from './journey.js';
export type {
  DiagnosticOffer,
  JourneyDecisionInput,
  JourneyGates,
  DiagnosticVendorClient,
  PurchaseEvidence,
  MetalJourneyInput,
} from './journey.js';

export { FileReceiptStore } from './file-receipt-store.js';

export * from './sponsor/config.js';
export * from './sponsor/usdz.js';
export * from './sponsor/agent-cli.js';
export * from './sponsor/fixture-runner.js';
export * from './sponsor/journey.js';
