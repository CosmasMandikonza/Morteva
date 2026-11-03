/**
 * Airwallex transfer status mapping — the conservative normalization layer.
 *
 * Sources (official "Transfer statuses" reference, API version 2025-06-30+
 * documentation checked 2026-11-03, plus the builder guide):
 *  - The transfer status set is: IN_APPROVAL, APPROVAL_RECALLED,
 *    APPROVAL_REJECTED, APPROVAL_BLOCKED, SCHEDULED, OVERDUE, PROCESSING,
 *    SENT, PAID, FAILED, CANCELLED. **COMPLETED is NOT a transfer status**
 *    in this API — it is deliberately not mapped and normalizes to 'unknown'
 *    (keep reconciling, never guess).
 *  - **PAID is not always final**: a PAID transfer "may subsequently fail if
 *    it is rejected by the local clearing system or the recipient bank, at
 *    which point its status will transition to FAILED". 'terminal-success'
 *    therefore means "provider-confirmed success AT VERIFICATION TIME" —
 *    post-PAID monitoring continues (the ledger settles but keeps
 *    reconciling, and a later FAILED escalates with an auditable
 *    settlement.late_failure event; it never rewrites history).
 *  - FAILED and CANCELLED are terminal non-success states (CANCELLED means
 *    "paid amount (minus fees) returned to the Wallet" — read failure fields).
 *  - "SENT means in-flight, never final" — builder guide.
 *
 * Repo law preserved here: SUBMITTED/SENT is never settlement; only terminal
 * success maps to 'confirmed' and ONLY via independent readback (the worker
 * enforces the provider-readback attestation). Terminal failure states map to
 * 'failed' — which the ledger escalates (REQUIRES_HUMAN) rather than silently
 * releasing, exactly as reviewed in PRs #23/#26.
 */
export type AirwallexNormalizedStatus =
  'terminal-success' | 'terminal-failed' | 'pending' | 'unknown';

/**
 * Terminal success AT VERIFICATION TIME: provider-confirmed processed
 * successfully by the banking partner. NOT proof of irreversible delivery —
 * post-PAID FAILED transitions exist and stay monitored.
 */
const TERMINAL_SUCCESS = new Set(['PAID']);

/** Terminal non-success states: transfer will not execute (funds returned). */
const TERMINAL_FAILED = new Set(['CANCELLED', 'FAILED']);

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
  'OVERDUE',
  'APPROVAL_RECALLED',
  'APPROVAL_REJECTED',
  'APPROVAL_BLOCKED',
]);

export function normalizeTransferStatus(
  providerStatus: string | undefined | null,
): AirwallexNormalizedStatus {
  if (typeof providerStatus !== 'string' || providerStatus === '') return 'unknown';
  const status = providerStatus.trim().toUpperCase();
  if (TERMINAL_SUCCESS.has(status)) return 'terminal-success';
  if (TERMINAL_FAILED.has(status)) return 'terminal-failed';
  if (PENDING.has(status)) return 'pending';
  // Undocumented state (including the non-transfer status "COMPLETED"):
  // never guess finality — treat as pending investigation.
  return 'unknown';
}

export function isTerminalStatus(normalized: AirwallexNormalizedStatus): boolean {
  return normalized === 'terminal-success' || normalized === 'terminal-failed';
}
