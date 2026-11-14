/**
 * Migration 0004 — production identity (MTV-19).
 *
 * Adds the external-identity trust layer WITHOUT touching any existing
 * table: actors, sessions, mandates, approvals, evidence and all financial
 * state from v1–v3 are preserved byte-for-byte (pure additive migration).
 *
 *   identity_links  persisted (provider, subject) → actor binding per org.
 *                   Authority still lives ONLY in actors/roles; the link is
 *                   a pointer. Email is recorded for humans to read, never
 *                   for authorization. One actor per identity per org.
 *   invitations     expiring single-use join tokens for NON-privileged roles
 *                   (approver/operator/viewer — the CHECK constraint makes
 *                   owner/admin uninvitable at the schema level, so no public
 *                   flow can mint privileged authority). Secrets are stored
 *                   only as sha256 digests. A partial unique index enforces
 *                   one ACTIVE invitation per (org, email, role).
 *   oidc_flows      server-side authorization-code flow state (hashed state,
 *                   nonce, PKCE verifier), single-use with expiry, restart-
 *                   survivable. Optionally carries a PRE-VERIFIED invitation
 *                   intent (id only — the secret is never stored again).
 */
export const MIGRATION_0004_PRODUCTION_IDENTITY = `
CREATE TABLE identity_links (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email_at_link TEXT,
  linked_by TEXT NOT NULL REFERENCES actors(id),
  linked_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (provider, subject, org_id),
  CHECK ((email_at_link IS NULL) OR (email_at_link = '' OR instr(email_at_link, '@') > 1))
);
CREATE INDEX idx_identity_actor ON identity_links(actor_id);
CREATE INDEX idx_identity_org ON identity_links(org_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  role TEXT NOT NULL CHECK (role IN ('approver','operator','viewer')),
  email TEXT NOT NULL CHECK (length(email) >= 3),
  secret_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  redeemed_by TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  CHECK (created_at <= expires_at),
  CHECK (redeemed_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX idx_invitations_org ON invitations(org_id);
CREATE UNIQUE INDEX idx_invitations_active
  ON invitations(org_id, email, role)
  WHERE redeemed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE oidc_flows (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  org_id TEXT REFERENCES organizations(id),
  invitation_id TEXT REFERENCES invitations(id),
  invitation_preverified INTEGER NOT NULL DEFAULT 0 CHECK (invitation_preverified IN (0,1)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK (created_at <= expires_at)
);
CREATE INDEX idx_oidc_flows_expiry ON oidc_flows(expires_at);
`;
