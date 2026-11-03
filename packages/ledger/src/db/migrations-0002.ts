/**
 * Migration 0002 — financial authority (issue #7).
 *
 * Adds the actor/session/mission-grant trust boundary and rebuilds mandates
 * and approvals (SQLite cannot ALTER CHECK constraints) with cumulative
 * budgets, rail/beneficiary/purpose allowlists, revocation and exact-term
 * approval binding. Legacy v1 rows are preserved with their ORIGINAL
 * authority semantics: total_budget_minor = -1 means "envelope = per-op max"
 * so no old mandate silently gains spending capacity.
 *
 * The mandates/approvals rebuilds require foreign keys OFF during the
 * swap (standard SQLite procedure); the migrator re-enables FK and runs
 * foreign_key_check afterwards — violations fail the migration.
 */
export const MIGRATION_0002_FINANCIAL_AUTHORITY = `
CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  username TEXT NOT NULL CHECK (length(username) >= 3),
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','approver','operator','viewer','service')),
  kind TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human','service')),
  password_hash TEXT,
  password_salt TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, username),
  CHECK (kind = 'human' OR password_hash IS NULL)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (created_at <= expires_at)
);
CREATE INDEX idx_sessions_actor ON sessions(actor_id);

CREATE TABLE mission_grants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  mission_id TEXT NOT NULL REFERENCES missions(id),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  granted_by TEXT NOT NULL REFERENCES actors(id),
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (mission_id, actor_id)
);

CREATE TABLE mandates_v2 (
  id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  mission_id TEXT NOT NULL REFERENCES missions(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','superseded','expired','revoked')),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
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

INSERT INTO mandates_v2 (id, org_id, mission_id, version, status, currency, max_amount_minor,
    total_budget_minor, permitted_kinds_json, rails_json, allowed_beneficiaries_json,
    allowed_purposes_json, require_separate_approver, expires_at, revoked_at, created_at)
  SELECT id, org_id, mission_id, version, status, currency, max_amount_minor,
    -1, permitted_kinds_json, '["airwallex"]', '[]', '[]', 1, expires_at, NULL, created_at
  FROM mandates;

DROP TABLE mandates;
ALTER TABLE mandates_v2 RENAME TO mandates;
CREATE INDEX idx_mandates_mission ON mandates(mission_id);

CREATE TABLE approvals_v2 (
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
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
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

INSERT INTO approvals_v2 (id, org_id, plan_id, plan_version, plan_digest, mandate_id,
    mandate_version, kind, amount_minor, currency, beneficiary, purpose, quote_digest,
    evidence_digest, auth_key, decided_by, decided_at, expires_at, status, revoked_at)
  SELECT id, org_id, plan_id, plan_version, plan_digest, NULL, NULL, 'airwallex_transfer',
    amount_minor, currency, beneficiary, purpose, '', '', 'legacy-' || id,
    decided_by, decided_at, expires_at, status, NULL
  FROM approvals;

DROP TABLE approvals;
ALTER TABLE approvals_v2 RENAME TO approvals;
CREATE INDEX idx_approvals_plan ON approvals(plan_id, plan_version);
CREATE UNIQUE INDEX idx_approvals_plan_version ON approvals(plan_id, plan_version);

ALTER TABLE candidate_plans ADD COLUMN proposed_by TEXT;
`;
