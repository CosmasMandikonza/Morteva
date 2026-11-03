/**
 * Commitment state — the money view of an operation (docs/05 #2, #6).
 *
 * A commitment is an INTERNAL earmark of org funds. It is never a bank hold,
 * escrow, or claim on provider custody. It exists so the same money cannot be
 * committed twice while an economic operation is pending or unresolved.
 *
 *   reserved — the amount consumes spendable capacity.
 *   unknown  — dispatch outcome ambiguous; the amount STILL consumes capacity
 *              until resolved by verified provider truth (never by a timeout).
 *   settled  — provider confirmed finality; keeps consuming capacity until a
 *              balance snapshot newer than the settlement is observed.
 *   released — funds are free again; consumes nothing.
 */
import type { OperationState } from './operations.js';

export type CommitmentState = 'reserved' | 'unknown' | 'settled' | 'released';

/**
 * Single owner of the operation→commitment mapping. The ledger updates a
 * commitment row only through this function, in the same transaction as the
 * operation transition, so the two state columns cannot drift apart.
 */
export function commitmentStateFor(operationState: OperationState): CommitmentState {
  switch (operationState) {
    case 'PROPOSED':
      // A PROPOSED operation has not reserved anything yet.
      return 'released';
    case 'RESERVED':
    case 'SUBMITTING':
    case 'IN_FLIGHT':
      return 'reserved';
    case 'STATUS_UNKNOWN':
    case 'REQUIRES_HUMAN':
      // Ambiguous or escalated: exposure is retained, never silently freed.
      return 'unknown';
    case 'SETTLED':
    case 'RECONCILED':
      return 'settled';
    case 'REJECTED':
    case 'EXPIRED':
    case 'CANCELLED':
      return 'released';
  }
}

/** Does this commitment consume spendable capacity right now? */
export function commitmentConsumesCapacity(state: CommitmentState): boolean {
  return state === 'reserved' || state === 'unknown' || state === 'settled';
}
