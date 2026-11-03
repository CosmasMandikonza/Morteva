/**
 * Typed policy outcomes (issue #7 acceptance: "State machine records
 * denied/needs-human and reason codes"). Every material denial resolves to
 * one of these stable, machine-readable reason codes, and is journaled.
 */
export type PolicyOutcome = 'AUTHORIZED' | 'DENIED' | 'NEEDS_HUMAN' | 'REVOKED' | 'STALE_APPROVAL';

export type PolicyReasonCode =
  | 'OK'
  | 'UNAUTHENTICATED'
  | 'ROLE_FORBIDDEN'
  | 'MISSION_GRANT_MISSING'
  | 'SELF_APPROVAL_FORBIDDEN'
  | 'ACTOR_NOT_FOUND'
  | 'ACTOR_REVOKED'
  | 'SESSION_EXPIRED'
  | 'SESSION_INVALID'
  | 'CSRF_INVALID'
  | 'MANDATE_NOT_FOUND'
  | 'MANDATE_REVOKED'
  | 'MANDATE_SUPERSEDED'
  | 'MANDATE_EXPIRED'
  | 'MANDATE_BUDGET_EXCEEDED'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_REVOKED'
  | 'APPROVAL_CONSUMED'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_TERMS_MISMATCH'
  | 'BENEFICIARY_NOT_ALLOWED'
  | 'PURPOSE_NOT_ALLOWED'
  | 'RAIL_NOT_PERMITTED'
  | 'RAIL_ASSET_UNSUPPORTED';

export interface PolicyDecision {
  readonly outcome: PolicyOutcome;
  readonly reason: PolicyReasonCode;
  readonly detail?: string;
}

export function authorized(): PolicyDecision {
  return { outcome: 'AUTHORIZED', reason: 'OK' };
}

export function denied(reason: PolicyReasonCode, detail?: string): PolicyDecision {
  return { outcome: 'DENIED', reason, detail };
}

export function revoked(detail?: string): PolicyDecision {
  return { outcome: 'REVOKED', reason: 'MANDATE_REVOKED', detail };
}

export function staleApproval(detail?: string): PolicyDecision {
  return { outcome: 'STALE_APPROVAL', reason: 'APPROVAL_TERMS_MISMATCH', detail };
}

export function needsHuman(reason: PolicyReasonCode, detail?: string): PolicyDecision {
  return { outcome: 'NEEDS_HUMAN', reason, detail };
}
