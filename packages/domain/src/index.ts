/**
 * MOTERVA financial domain — pure, typed, no I/O.
 * Single owner of money representation and shared read-model contracts (docs/07).
 */
export type { CurrencyCode, Money, MoneyErrorCode } from './money.js';
export {
  MoneyError,
  addMoney,
  createMoney,
  currencyExponent,
  fromMajorString,
  subMoney,
  supportedCurrencies,
  toMajorString,
  zeroMoney,
} from './money.js';

export type {
  LedgerStatusView,
  ProviderEnvironment,
  ProviderMode,
  ProviderStatusView,
  SystemStatusView,
} from './system.js';

export type { OperationState } from './operations.js';
export {
  allowedOperationTransitions,
  canTransitionOperation,
  isOperationState,
  isTerminalOperationState,
} from './operations.js';

export type { CommitmentState } from './commitments.js';
export { commitmentConsumesCapacity, commitmentStateFor } from './commitments.js';

export { canonicalJson, termsDigest } from './digest.js';

export type {
  AccountId,
  AccountView,
  ApprovalId,
  ApprovalView,
  BalanceSnapshotView,
  BalanceSource,
  CandidatePlanView,
  CommitmentView,
  EvidenceEventView,
  FinancialOperationView,
  MandateId,
  MandateView,
  MissionId,
  MissionStatus,
  MissionView,
  OperationId,
  OperationKind,
  OrganizationView,
  OrgId,
  OutboxDispatchView,
  OutboxStatus,
  PlanId,
  SpendableView,
} from './entities.js';
