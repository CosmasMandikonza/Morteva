/**
 * Airwallex transfer status mapping — the conservative normalization layer.
 *
 * Sources (official reference + builder guide, verified 2026-11-03):
 *  - "SENT means in-flight, never final; transfers pending simulation stay in
 *    PROCESSING" — the builder guide.
 *  - Success terminal state: "PAID" (guide, kit 3).
 *  - "A failed transfer ends in CANCELLED, not FAILED... CANCELLED does not
 *    mean a person cancelled it; read failure_type and failure_reason" — so a
 *    terminal CANCELLED readback is a definitive non-execution/refund outcome.
 *  - Webhook lifecycle: payout.transfer.{scheduled,processing,paid,sent,
 *    failed,cancelled,in_approval,...}; failed "can retry or cancel".
 *
 * Repo law preserved here: SUBMITTED/SENT is never settlement; only terminal
 * success maps to 'confirmed' and ONLY via independent readback (the worker
 * enforces the provider-readback attestation). Terminal failure states map to
 * 'failed' — which the ledger escalates (REQUIRES_HUMAN) rather than silently
 * releasing, exactly as reviewed in PRs #23/#26.
 */
export type AirwallexNormalizedStatus =
  'terminal-success' | 'terminal-failed' | 'pending' | 'unknown';

/** Terminal success states: money provably paid out (verified by readback). */
const TERMINAL_SUCCESS = new Set(['PAID', 'COMPLETED']);

/** Terminal non-success states: transfer will not execute (funds returned). */
const TERMINAL_FAILED = new Set(['CANCELLED', 'FAILED', 'REJECTED']);

/** Explicitly non-final in-flight states observed in the reference. */
const PENDING = new Set([
  'PENDING_PROCESSING',
  'PENDING_COMPLIANCE',
  'PENDING_SIGNATURE',
  'AWAITING_FUNDS',
  'REQUIRES_FUNDING_CONFIRMATION',
  'SCHEDULED',
  'PROCESSING',
  'SENT',
  'IN_APPROVAL',
  'CANCELLATION_REQUESTED',
]);

export function normalizeTransferStatus(
  providerStatus: string | undefined | null,
): AirwallexNormalizedStatus {
  if (typeof providerStatus !== 'string' || providerStatus === '') return 'unknown';
  const status = providerStatus.trim().toUpperCase();
  if (TERMINAL_SUCCESS.has(status)) return 'terminal-success';
  if (TERMINAL_FAILED.has(status)) return 'terminal-failed';
  if (PENDING.has(status)) return 'pending';
  // Undocumented state: never guess finality — treat as pending investigation.
  return 'unknown';
}

export function isTerminalStatus(normalized: AirwallexNormalizedStatus): boolean {
  return normalized === 'terminal-success' || normalized === 'terminal-failed';
}
