/**
 * Mandate budget accounting (issue #7 / CTO gate on PR #23).
 *
 * A mandate's cumulative envelope is consumed by every operation that has
 * left the proposal stage and has NOT been proven never-executed. Unlike
 * treasury *spendable* capacity (where a newer provider balance snapshot
 * frees settled amounts — the bank already knows), a SETTLED or RECONCILED
 * payment consumes its mandate budget FOR THE LIFETIME of the mandate: the
 * envelope bounds total authorized spending, not current float. Unknown and
 * escalated operations consume until independently resolved.
 */
import type { OperationState } from './operations.js';

/** States proving the operation never executed (frees mandate budget). */
const NEVER_EXECUTED: readonly OperationState[] = ['CANCELLED', 'REJECTED', 'EXPIRED'];

export function operationConsumesMandateBudget(state: OperationState): boolean {
  return !NEVER_EXECUTED.includes(state);
}

export const MANDATE_BUDGET_CONSUMING_STATES: readonly OperationState[] = [
  'RESERVED',
  'SUBMITTING',
  'IN_FLIGHT',
  'STATUS_UNKNOWN',
  'SETTLED',
  'RECONCILED',
  'REQUIRES_HUMAN',
];
