/**
 * Migration 0003 — provider receipts (issue #5).
 *
 * Append-only, org-scoped storage for every Airwallex interaction (dispatch,
 * readback, definitive rejection, ambiguous failure, balance read). Payloads
 * are stored pre-redacted by the adapter; UPDATE/DELETE are blocked by
 * triggers like the evidence journal. A submission receipt alone can never
 * settle an operation — settlement requires a readback receipt plus the
 * ledger's provider-readback attestation.
 */
export const MIGRATION_0003_PROVIDER_RECEIPTS = `
CREATE TABLE provider_receipts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  operation_id TEXT,
  request_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('airwallex','metal')),
  transfer_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN
    ('dispatch-create','readback-by-id','readback-by-request-id','balance-read','definitive-rejection','ambiguous-failure','webhook')),
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','offline-fixture')),
  http_status INTEGER,
  provider_status TEXT,
  payload_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX idx_provider_receipts_request ON provider_receipts(org_id, request_id);
CREATE INDEX idx_provider_receipts_operation ON provider_receipts(operation_id);

CREATE TRIGGER provider_receipts_no_update BEFORE UPDATE ON provider_receipts
BEGIN
  SELECT RAISE(ABORT, 'provider_receipts is append-only');
END;

CREATE TRIGGER provider_receipts_no_delete BEFORE DELETE ON provider_receipts
BEGIN
  SELECT RAISE(ABORT, 'provider_receipts is append-only');
END;
`;
