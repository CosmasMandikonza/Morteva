/**
 * Migration 0001 — financial foundation schema.
 *
 * Money discipline: every monetary column is INTEGER minor units with a
 * CHECK(> 0) or CHECK(>= 0); there is no FLOAT column anywhere.
 * Isolation: every economic table is org-scoped and FK-bound to organizations.
 * Identity: UNIQUE(org_id, request_id) on operations is the durable economic
 * identity; UNIQUE(operation_id) on commitments/outbox keeps 1:1 links.
 * Journal: evidence_events is append-only, enforced by triggers.
 */
export const MIGRATION_0001_FINANCIAL_FOUNDATION = `
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','archived')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_missions_org ON missions(org_id);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  kind TEXT NOT NULL DEFAULT 'treasury' CHECK (kind IN ('treasury')),
  label TEXT NOT NULL,
  protected_floor_minor INTEGER NOT NULL DEFAULT 0 CHECK (protected_floor_minor >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (org_id, currency, kind)
);

CREATE TABLE balance_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  minor_units INTEGER NOT NULL CHECK (minor_units >= 0),
  source TEXT NOT NULL CHECK (source IN ('airwallex-sandbox','metal-testnet','manual-seed')),
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  CHECK (observed_at <= expires_at)
);
CREATE INDEX idx_balance_account_observed ON balance_snapshots(account_id, observed_at DESC);

CREATE TABLE mandates (
  id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  mission_id TEXT NOT NULL REFERENCES missions(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','expired')),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  max_amount_minor INTEGER NOT NULL CHECK (max_amount_minor > 0),
  permitted_kinds_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE INDEX idx_mandates_mission ON mandates(mission_id);

CREATE TABLE candidate_plans (
  id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  mission_id TEXT NOT NULL REFERENCES missions(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  terms_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE INDEX idx_plans_mission ON candidate_plans(mission_id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  plan_digest TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  beneficiary TEXT NOT NULL,
  purpose TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','consumed','invalidated')),
  FOREIGN KEY (plan_id, plan_version) REFERENCES candidate_plans(id, version)
);
CREATE INDEX idx_approvals_plan ON approvals(plan_id, plan_version);

CREATE TABLE operations (
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
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  beneficiary TEXT NOT NULL,
  purpose TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, request_id),
  FOREIGN KEY (plan_id, plan_version) REFERENCES candidate_plans(id, version),
  FOREIGN KEY (mandate_id, mandate_version) REFERENCES mandates(id, version)
);
CREATE INDEX idx_operations_org_currency_state ON operations(org_id, currency, state);

CREATE TABLE commitments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  mission_id TEXT NOT NULL REFERENCES missions(id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  state TEXT NOT NULL CHECK (state IN ('reserved','unknown','settled','released')),
  finalized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_commitments_org_currency_state ON commitments(org_id, currency, state);

CREATE TABLE outbox_dispatches (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  rail TEXT CHECK (rail IN ('airwallex','metal')),
  request_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','dispatched','abandoned')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_outbox_status ON outbox_dispatches(status);

CREATE TABLE evidence_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  mission_id TEXT REFERENCES missions(id),
  topic TEXT NOT NULL CHECK (topic IN ('financial','operational')),
  type TEXT NOT NULL,
  event_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (org_id, event_key)
);
CREATE INDEX idx_evidence_org_topic ON evidence_events(org_id, topic);

CREATE TRIGGER evidence_events_no_update BEFORE UPDATE ON evidence_events
BEGIN
  SELECT RAISE(ABORT, 'evidence_events is append-only');
END;

CREATE TRIGGER evidence_events_no_delete BEFORE DELETE ON evidence_events
BEGIN
  SELECT RAISE(ABORT, 'evidence_events is append-only');
END;
`;
