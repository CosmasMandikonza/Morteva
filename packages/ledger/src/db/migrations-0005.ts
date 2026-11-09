/**
 * Migration 0005 — token-asset ledger for the Metal testnet rail (MTV-19, issue #6 boundary).
 *
 * Enables a token-denominated (USDZ-on-Tahoe) financial authority WITHOUT
 * weakening any fiat invariant:
 *  - currency columns widen from exactly-3 to 3..8 uppercase letters so the
 *    4-letter token code `USDZ` can exist NEXT TO fiat USD, never merged
 *    with it (all spendable/reservation keys are (org, currency) — a fiat
 *    USD snapshot still cannot fund a USDZ order and vice versa).
 *  - accounts gain kind 'token' (distinct from fiat 'treasury').
 *  - balance_snapshots gain explicit chain-read provenance columns
 *    (chain_id, contract_address, chain_read_at) — nullable for fiat rows;
 *    token rows MUST carry them (enforced by TokenAssetService).
 *  - provider_receipts environment CHECK gains 'testnet' (the shared
 *    ProviderReceiptEnvironment union already includes it).
 *  - new `token_assets` registry: the trusted, org-scoped identity of one
 *    on-chain asset (chain id, contract, decimals, symbol, environment) that
 *    mandates/approvals/reservations for `metal_order` must match exactly.
 *
 * All existing tables are rebuilt in place (SQLite cannot ALTER a CHECK);
 * the migrator runs with foreign keys OFF and verifies
 * `PRAGMA foreign_key_check` after — every existing row survives unchanged.
 * Identity migration 0004 is untouched; 0005 is strictly subsequent.
 */
export const MIGRATION_0005_TOKEN_ASSETS = `
CREATE TABLE token_assets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  currency TEXT NOT NULL CHECK (length(currency) BETWEEN 3 AND 8 AND currency = upper(currency)),
  symbol TEXT NOT NULL CHECK (length(symbol) BETWEEN 2 AND 12),
  decimals INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  contract_address TEXT NOT NULL CHECK (length(contract_address) = 42 AND contract_address LIKE '0x%'),
  chain_id INTEGER NOT NULL CHECK (chain_id > 0),
  environment TEXT NOT NULL CHECK (environment IN ('testnet')),
  created_by TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (org_id, chain_id, contract_address),
  UNIQUE (org_id, currency)
);
CREATE INDEX idx_token_assets_org ON token_assets(org_id, currency);

CREATE TABLE accounts_v5 (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  currency TEXT NOT NULL CHECK (length(currency) BETWEEN 3 AND 8 AND currency = upper(currency)),
  kind TEXT NOT NULL DEFAULT 'treasury' CHECK (kind IN ('treasury','token')),
  label TEXT NOT NULL,
  protected_floor_minor INTEGER NOT NULL DEFAULT 0 CHECK (protected_floor_minor >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (org_id, currency, kind)
);
INSERT INTO accounts_v5 (id, org_id, currency, kind, label, protected_floor_minor, created_at)
  SELECT id, org_id, currency, kind, label, protected_floor_minor, created_at FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_v5 RENAME TO accounts;

CREATE TABLE balance_snapshots_v5 (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  currency TEXT NOT NULL CHECK (length(currency) BETWEEN 3 AND 8 AND currency = upper(currency)),
  minor_units INTEGER NOT NULL CHECK (minor_units >= 0),
  source TEXT NOT NULL CHECK (source IN ('airwallex-sandbox','metal-testnet','manual-seed')),
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  chain_id INTEGER,
  contract_address TEXT,
  chain_read_at TEXT,
  CHECK (observed_at <= expires_at),
  CHECK ((source = 'metal-testnet') OR (chain_id IS NULL AND contract_address IS NULL AND chain_read_at IS NULL)),
  CHECK ((chain_id IS NULL AND contract_address IS NULL AND chain_read_at IS NULL) OR (chain_id IS NOT NULL AND contract_address IS NOT NULL AND chain_read_at IS NOT NULL))
);
INSERT INTO balance_snapshots_v5 (id, account_id, org_id, currency, minor_units, source, observed_at, expires_at, recorded_at)
  SELECT id, account_id, org_id, currency, minor_units, source, observed_at, expires_at, recorded_at FROM balance_snapshots;
DROP TABLE balance_snapshots;
ALTER TABLE balance_snapshots_v5 RENAME TO balance_snapshots;
CREATE INDEX idx_balance_account_observed ON balance_snapshots(account_id, observed_at DESC);

CREATE TABLE mandates_v5 (
  id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  mission_id TEXT NOT NULL REFERENCES missions(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','superseded','expired','revoked')),
  currency TEXT NOT NULL CHECK (length(currency) BETWEEN 3 AND 8 AND currency = upper(currency)),
  max_amount_minor INTEGER NOT NULL CHECK (max_amount_minor > 0),
  total_budget_minor INTEGER NOT NULL DEFAULT -1
    CHECK (total_budget_minor = -1 OR total_budget_minor > 0),
  permitted_kinds_json TEXT NOT NULL,
  rails_json TEXT NOT NULL DEFAULT '["airwallex"]',
  allowed_beneficiaries_json TEXT NOT NULL DEFAULT '[]',
  allowed_purposes_json TEXT NOT NULL DEFAULT '[]',
  require_separate_approver INTEGER NOT NULL DEFAULT 1 CHECK (require_separate_approver IN (0,1)),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
INSERT INTO mandates_v5 (id, org_id, mission_id, version, status, currency, max_amount_minor,
    total_budget_minor, permitted_kinds_json, rails_json, allowed_beneficiaries_json,
    allowed_purposes_json, require_separate_approver, expires_at, revoked_at, created_at)
  SELECT id, org_id, mission_id, version, status, currency, max_amount_minor,
    total_budget_minor, permitted_kinds_json, rails_json, allowed_beneficiaries_json,
    allowed_purposes_json, require_separate_approver, expires_at, revoked_at, created_at
  FROM mandates;
DROP TABLE mandates;
ALTER TABLE mandates_v5 RENAME TO mandates;
CREATE INDEX idx_mandates_mission ON mandates(mission_id);

CREATE TABLE approvals_v5 (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  plan_digest TEXT NOT NULL,
  mandate_id TEXT,
  mandate_version INTEGER,
  kind TEXT NOT NULL DEFAULT 'airwallex_transfer'
    CHECK (kind IN ('airwallex_transfer','metal_order','internal_hold')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) BETWEEN 3 AND 8 AND currency = upper(currency)),
  beneficiary TEXT NOT NULL,
  purpose TEXT NOT NULL,
  quote_digest TEXT NOT NULL DEFAULT '',
  evidence_digest TEXT NOT NULL DEFAULT '',
  auth_key TEXT NOT NULL UNIQUE,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'valid'
    CHECK (status IN ('valid','consumed','invalidated','revoked')),
  revoked_at TEXT,
  FOREIGN KEY (plan_id, plan_version) REFERENCES candidate_plans(id, version)
);
INSERT INTO approvals_v5 (id, org_id, plan_id, plan_version, plan_digest, mandate_id, mandate_version,
    kind, amount_minor, currency, beneficiary, purpose, quote_digest, evidence_digest, auth_key,
    decided_by, decided_at, expires_at, status, revoked_at)
  SELECT id, org_id, plan_id, plan_version, plan_digest, mandate_id, mandate_version,
    kind, amount_minor, currency, beneficiary, purpose, quote_digest, evidence_digest, auth_key,
    decided_by, decided_at, expires_at, status, revoked_at
  FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_v5 RENAME TO approvals;
CREATE INDEX idx_approvals_plan ON approvals(plan_id, plan_version);
CREATE UNIQUE INDEX idx_approvals_plan_version ON approvals(plan_id, plan_version);

CREATE TABLE operations_v5 (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  mission_id TEXT NOT NULL REFERENCES missions(id),
  kind TEXT NOT NULL CHECK (kind IN ('airwallex_transfer','metal_order','internal_hold')),
  request_id TEXT NOT NULL CHECK (length(request_id) > 0),
  state TEXT NOT NULL CHECK (state IN
    ('PROPOSED','RESERVED','SUBMITTING','IN_FLIGHT','SETTLED','RECONCILED',
     'REJECTED','EXPIRED','STATUS_UNKNOWN','CANCELLED','REQUIRES_HUMAN')),
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  plan_digest TEXT NOT NULL,
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  mandate_id TEXT NOT NULL,
  mandate_version INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) BETWEEN 3 AND 8 AND currency = upper(currency)),
  beneficiary TEXT NOT NULL,
  purpose TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, request_id),
  FOREIGN KEY (plan_id, plan_version) REFERENCES candidate_plans(id, version),
  FOREIGN KEY (mandate_id, mandate_version) REFERENCES mandates(id, version)
);
INSERT INTO operations_v5 (id, org_id, mission_id, kind, request_id, state, plan_id, plan_version,
    plan_digest, approval_id, mandate_id, mandate_version, amount_minor, currency, beneficiary,
    purpose, created_at, updated_at)
  SELECT id, org_id, mission_id, kind, request_id, state, plan_id, plan_version,
    plan_digest, approval_id, mandate_id, mandate_version, amount_minor, currency, beneficiary,
    purpose, created_at, updated_at
  FROM operations;
DROP TABLE operations;
ALTER TABLE operations_v5 RENAME TO operations;
CREATE INDEX idx_operations_org_currency_state ON operations(org_id, currency, state);

CREATE TABLE commitments_v5 (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  mission_id TEXT NOT NULL REFERENCES missions(id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
  currency TEXT NOT NULL CHECK (length(currency) BETWEEN 3 AND 8 AND currency = upper(currency)),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  state TEXT NOT NULL CHECK (state IN ('reserved','unknown','settled','released')),
  finalized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO commitments_v5 (id, org_id, mission_id, operation_id, currency, amount_minor, state, finalized_at, created_at, updated_at)
  SELECT id, org_id, mission_id, operation_id, currency, amount_minor, state, finalized_at, created_at, updated_at
  FROM commitments;
DROP TABLE commitments;
ALTER TABLE commitments_v5 RENAME TO commitments;
CREATE INDEX idx_commitments_org_currency_state ON commitments(org_id, currency, state);

CREATE TABLE provider_receipts_v5 (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  operation_id TEXT,
  request_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('airwallex','metal')),
  transfer_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN
    ('dispatch-create','readback-by-id','readback-by-request-id','balance-read','definitive-rejection','ambiguous-failure','webhook')),
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','offline-fixture','testnet')),
  http_status INTEGER,
  provider_status TEXT,
  payload_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
INSERT INTO provider_receipts_v5 (id, org_id, operation_id, request_id, provider, transfer_id, kind, environment, http_status, provider_status, payload_json, recorded_at)
  SELECT id, org_id, operation_id, request_id, provider, transfer_id, kind, environment, http_status, provider_status, payload_json, recorded_at
  FROM provider_receipts;
DROP TABLE provider_receipts;
ALTER TABLE provider_receipts_v5 RENAME TO provider_receipts;
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
