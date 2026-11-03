/**
 * Financial operation lifecycle (docs/01 "Operation lifecycle").
 *
 * PROPOSED -> RESERVED -> SUBMITTING -> IN_FLIGHT -> SETTLED -> RECONCILED
 * with alternate paths REJECTED, EXPIRED, STATUS_UNKNOWN, CANCELLED, REQUIRES_HUMAN.
 *
 * Rules encoded here are the single source of truth for both the ledger's
 * persisted operations and any later provider adapters (#5/#6). A transition
 * that is not in this table is invalid everywhere; rejecting it prevents
 * out-of-order or duplicated events from regressing state.
 */

export type OperationState =
  | 'PROPOSED'
  | 'RESERVED'
  | 'SUBMITTING'
  | 'IN_FLIGHT'
  | 'SETTLED'
  | 'RECONCILED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'STATUS_UNKNOWN'
  | 'CANCELLED'
  | 'REQUIRES_HUMAN';

const TRANSITIONS: Readonly<Record<OperationState, readonly OperationState[]>> = {
  PROPOSED: ['RESERVED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  RESERVED: [
    'SUBMITTING',
    'STATUS_UNKNOWN',
    'SETTLED',
    'REJECTED',
    'EXPIRED',
    'CANCELLED',
    'REQUIRES_HUMAN',
  ],
  SUBMITTING: ['IN_FLIGHT', 'STATUS_UNKNOWN', 'SETTLED', 'CANCELLED', 'REQUIRES_HUMAN'],
  IN_FLIGHT: ['SETTLED', 'STATUS_UNKNOWN', 'CANCELLED', 'REQUIRES_HUMAN'],
  STATUS_UNKNOWN: ['SUBMITTING', 'IN_FLIGHT', 'SETTLED', 'CANCELLED', 'REJECTED', 'REQUIRES_HUMAN'],
  /**
   * SETTLED may (a) be human-reconciled, or (b) be REVERSED to human review
   * when the provider later reports failure after PAID (Airwallex transfer
   * statuses: a PAID transfer "may subsequently fail... transition to
   * FAILED"). A reversal never rewrites history: the evidence journal keeps
   * the settlement and the reversal as separate audited events, and the
   * mission budget stays consumed until a human adjustment decides otherwise.
   */
  SETTLED: ['RECONCILED', 'REQUIRES_HUMAN'],
  RECONCILED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
  REQUIRES_HUMAN: ['SUBMITTING', 'IN_FLIGHT', 'SETTLED', 'STATUS_UNKNOWN', 'CANCELLED', 'REJECTED'],
};

/** Terminal states have no outgoing transitions. */
export function isTerminalOperationState(state: OperationState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** Can `from` legally move to `to`? Everything else is an invalid transition. */
export function canTransitionOperation(from: OperationState, to: OperationState): boolean {
  const allowed = TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

export function allowedOperationTransitions(from: OperationState): readonly OperationState[] {
  return TRANSITIONS[from] ?? [];
}

export function isOperationState(value: string): value is OperationState {
  return Object.hasOwn(TRANSITIONS, value);
}
