/**
 * Ledger error contract. Every failure carries a stable machine code so
 * callers (and later provider adapters) can branch on semantics — a stale
 * balance is not an insufficient-funds, and a timeout is never a release.
 */
export type LedgerErrorCode =
  | 'ACCOUNT_NOT_FOUND'
  | 'APPROVAL_ALREADY_EXISTS'
  | 'APPROVAL_CONSUMED'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_INVALIDATED'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_REVOKED'
  | 'APPROVAL_TERMS_MISMATCH'
  | 'AUTH_ACTOR_NOT_FOUND'
  | 'AUTH_MISSION_GRANT_MISSING'
  | 'AUTH_ROLE_FORBIDDEN'
  | 'AUTH_SELF_APPROVAL'
  | 'AUTH_SESSION_EXPIRED'
  | 'AUTH_SESSION_INVALID'
  | 'AUTH_USERNAME_TAKEN'
  | 'BENEFICIARY_NOT_ALLOWED'
  | 'CLAIM_MISMATCH'
  | 'CROSS_ORG_ACCESS'
  | 'DB_CORRUPTED'
  | 'DUPLICATE_EVENT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INSUFFICIENT_SPENDABLE'
  | 'INVALID_AMOUNT'
  | 'INVALID_INPUT'
  | 'INVALID_TRANSITION'
  | 'JOURNAL_APPEND_ONLY'
  | 'MANDATE_ALREADY_REVOKED'
  | 'MANDATE_AMOUNT_EXCEEDS_MAX'
  | 'MANDATE_BUDGET_EXCEEDED'
  | 'MANDATE_CURRENCY_MISMATCH'
  | 'MANDATE_EXPIRED'
  | 'MANDATE_KIND_FORBIDDEN'
  | 'MANDATE_NOT_FOUND'
  | 'MANDATE_REVOKED'
  | 'MANDATE_SUPERSEDED'
  | 'MIGRATION_FAILED'
  | 'MIGRATION_VERSION_CONFLICT'
  | 'MISSION_INACTIVE'
  | 'MISSION_NOT_FOUND'
  | 'NO_BALANCE_SNAPSHOT'
  | 'OPERATION_NOT_FOUND'
  | 'OUTBOX_NOT_FOUND'
  | 'OVERCOMMITTED'
  | 'PLAN_DIGEST_MISMATCH'
  | 'PLAN_NOT_FOUND'
  | 'PURPOSE_NOT_ALLOWED'
  | 'RAIL_ASSET_UNSUPPORTED'
  | 'RAIL_NOT_PERMITTED'
  | 'SNAPSHOT_ACCOUNT_MISMATCH'
  | 'STALE_BALANCE'
  | 'CURRENCY_COLLISION'
  | 'TOKEN_ASSET_DUPLICATE'
  | 'TOKEN_ASSET_NOT_REGISTERED'
  | 'TOKEN_ASSET_REVOKED'
  | 'CHAIN_MISMATCH'
  | 'TOKEN_CONTRACT_MISMATCH';

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export function isLedgerError(error: unknown): error is LedgerError {
  return error instanceof LedgerError;
}
