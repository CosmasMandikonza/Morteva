/**
 * Ledger error contract. Every failure carries a stable machine code so
 * callers (and later provider adapters) can branch on semantics — a stale
 * balance is not an insufficient-funds, and a timeout is never a release.
 */
export type LedgerErrorCode =
  | 'ACCOUNT_NOT_FOUND'
  | 'APPROVAL_CONSUMED'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_INVALIDATED'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_TERMS_MISMATCH'
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
  | 'MANDATE_AMOUNT_EXCEEDS_MAX'
  | 'MANDATE_CURRENCY_MISMATCH'
  | 'MANDATE_EXPIRED'
  | 'MANDATE_KIND_FORBIDDEN'
  | 'MANDATE_NOT_FOUND'
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
  | 'SNAPSHOT_ACCOUNT_MISMATCH'
  | 'STALE_BALANCE';

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
