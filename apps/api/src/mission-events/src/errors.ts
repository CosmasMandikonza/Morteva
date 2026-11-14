/**
 * Rejection taxonomy for mission-event ingestion (issue #9).
 *
 * Every code is machine-readable and deterministic: the same malformed input
 * always produces the same first-failure code. Codes are deliberately namespaced
 * away from the ledger's financial error space — an ingest rejection can never
 * be confused with a reservation, approval or provider outcome, and no code
 * implies anything about money.
 */
export const MISSION_EVENT_ERROR_CODES = [
  // envelope / contract shape
  'UNSUPPORTED_CONTRACT',
  'INVALID_ENVELOPE',
  'INVALID_UNIT',
  'INVALID_VALUE',
  // trust boundary
  'AUTHORITY_TERMS_REJECTED',
  'CROSS_ORG_EVENT',
  'MISSION_NOT_IN_ORG',
  'UNKNOWN_ASSET',
  'UNAUTHENTICATED_SOURCE',
  'SIGNATURE_INVALID',
  'PROVENANCE_MISMATCH',
  'SOURCE_NOT_AUTHORIZED_FOR_ASSET',
  // ordering / duplication
  'DUPLICATE_EVENT',
  'SEQUENCE_REGRESSION',
  'SEQUENCE_GAP',
  // time
  'TIMESTAMP_ORDER',
  'FUTURE_EVENT',
  'STALE_EVENT',
  // physical-state consistency
  'ASSET_OFFLINE',
  'CONFLICTING_OBSERVATIONS',
  'MONOTONIC_VIOLATION',
  // journal integrity (replay path)
  'JOURNAL_TAMPERED',
] as const;

export type MissionEventErrorCode = (typeof MISSION_EVENT_ERROR_CODES)[number];

export class MissionEventError extends Error {
  constructor(
    readonly code: MissionEventErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'MissionEventError';
  }
}

export function isMissionEventError(value: unknown): value is MissionEventError {
  return value instanceof MissionEventError;
}
