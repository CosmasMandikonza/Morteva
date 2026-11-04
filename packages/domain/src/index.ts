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

export type { ActorRole, ActorKind } from './roles.js';
export {
  ACTOR_ROLES,
  canApproveFinancialActions,
  canManageAuthority,
  canOperate,
  canProposePlans,
  canReadFinancialState,
  isActorRole,
} from './roles.js';

export type { PolicyOutcome, PolicyReasonCode, PolicyDecision } from './policy.js';
export { authorized, denied, needsHuman, revoked, staleApproval } from './policy.js';

export { MANDATE_BUDGET_CONSUMING_STATES, operationConsumesMandateBudget } from './budget.js';

export type {
  AccountId,
  AccountView,
  ActorView,
  ApprovalId,
  ApprovalView,
  AttentionLevel,
  BalanceProvenanceView,
  BalanceSnapshotView,
  BalanceSource,
  CandidatePlanView,
  CommitmentBreakdownView,
  CommitmentView,
  EvidenceEventView,
  FinancialCurrencyStatus,
  FinancialCurrencyView,
  FinancialOperationView,
  FinancialOverviewView,
  MandateId,
  MandateView,
  MissionEvidenceEventView,
  MissionEvidenceListView,
  MissionGrantView,
  MissionId,
  MissionStatus,
  MissionView,
  MoneyView,
  OperationId,
  OperationKind,
  OperationListView,
  OperationReadView,
  OrganizationView,
  OrgId,
  OutboxDispatchView,
  OutboxStatus,
  PlanId,
  SessionContextView,
  SpendableView,
} from './entities.js';
