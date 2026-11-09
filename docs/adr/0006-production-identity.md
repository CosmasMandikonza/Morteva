# ADR 0006 — Production identity, organization membership and reviewer access

- **Status:** accepted (pending CTO integration review)
- **Date:** 2026-11-08
- **Scope:** `apps/api` identity modules + auth boundary, `packages/ledger` additive migration 0004, `packages/domain` identity views
- **Supersedes:** none. **Complements:** [ADR 0003 financial authority](0003-financial-authority.md) (unchanged), the DEMO_AUTH loopback gate (unchanged), Agent E's deployment kit (coordination contract in `docs/identity/DEPLOYMENT_HANDOFF.md`).

## Context

MOTERVA's financial authority has always originated from persisted actors
(owner/admin/approver/operator/viewer/service) with scrypt credentials, hashed
sessions, session-bound CSRF and journaled evidence — but the ONLY human login
was DEMO_AUTH, deliberately loopback-local and structurally absent from
production. A real deployment needs customers, operators, approvers and
reviewers to authenticate independently, belong to correctly authorized
organizations, and reach governed financial workflows without weakening any
existing guarantee ([audit](../identity/AUTH_AUDIT.md)).

## Decision

**1. Standards-based OIDC, Authorization Code Flow with PKCE, server-managed
sessions.** `openid-client` 6.x (maintained, standards-only, Node 24
compatible) drives discovery, the authorization redirect and the code
exchange. `oidc-provider` is a devDependency used ONLY as the strictly-local
test identity provider (127.0.0.1, clearly labeled fixture) — production uses
the same code path with a real configured issuer.

**2. Fail-closed configuration.** `MOTERVA_OIDC_{ISSUER,CLIENT_ID,
CLIENT_SECRET,REDIRECT_URI}` are all-or-nothing: partial configuration is a
startup error. Production requires https transport for issuer and redirect
URI; plain HTTP is allowed ONLY for loopback test identity behind an explicit
`MOTERVA_OIDC_ALLOW_INSECURE_TRANSPORT=1` that production refuses.
`MOTERVA_OIDC_HTTP_TIMEOUT_MS` (1–30s) bounds discovery and token exchange.
`MOTERVA_TRUST_PROXY` enables X-Forwarded-Proto handling only behind the
configured TLS edge.

**3. Identity ≠ authority.** Migration 0004 adds `identity_links`
(canonical issuer + IdP `sub` → actor, per org), `invitations` and
`oidc_flows` — purely additive; every existing table and row survives
(tested v3→v4 with data). Identity links POINT at actors; authority still
lives only in `actors.role` via the unchanged role matrix. No IdP claim
(role, group, email) ever creates or elevates authority. Email is recorded
for humans at link time and is never an authorization input.

**4. Privilege ceiling enforced at the schema.** Invitations carry a role
CHECK restricted to approver/operator/viewer — owner/admin are structurally
uninvitable. Initial privileged access exists ONLY through
`ExternalIdentityService.provisionIdentityActor`, a server-side operation
with no HTTP route. Redeeming an invitation for a pre-provisioned actor of a
different role fails closed; same-role reuse keeps the existing role.

**5. Secrets never persist or travel.** Invitation secrets are returned once
(sha256 at rest), delivered out-of-band, pre-verified constant-time at the
accept endpoint, and never stored again — the OIDC flow row carries only the
invitation id as a pre-verified intent. Flow state: `state` stored hashed
(lookup key), nonce + PKCE verifier stored raw because the protocol needs
them at the callback, rows single-use with a short TTL. ID tokens are
validated for issuer, audience, signature (alg allowlist via client
metadata), expiry and nonce against the consumed flow row; only `sub`,
`email`, `name` are surfaced. Subjects and emails appear in journal payloads
only as sha256 digests.

**6. Sessions unchanged for production.** Sign-in mints the SAME ledger
session model (hashed bearer, HttpOnly SameSite=Strict cookie, CSRF hash +
new `moterva_csrf` double-submit companion so redirect sign-ins can obtain
the CSRF value). Logout, expiry, revocation and `revokeActor`-invalidates-
sessions semantics are shared with the existing path.

**7. Demo isolation preserved.** DEMO_AUTH remains loopback-only and is
refused in production even when identity is fully configured. The
authenticated scope mounts for identity OR devAuth; demo-only routes
(physical demo, refresh-authority, password login/bootstrap) stay inside the
devAuth gate.

## Consequences

- A different approver authenticates independently and retrieves/authorizes
  persisted exact plan terms — no shared passwords, no development backdoor.
- Reviewers get read-only membership by invitation; any interaction with
  money movement still requires operator/approver roles AND the existing
  mandate/approval/reservation gates; provider dispatch remains disabled
  until independently configured and authorized.
- A hung or hostile IdP fails bounded (timeout → `OIDC_UNAVAILABLE`), and a
  partially configured deployment refuses to boot.
- Known limitation: reviewer sign-in requires the operator to deliver
  invitation secrets out-of-band (email/Slack); no in-product invitation
  email delivery in this increment.

## Verification anchors

`apps/api/test/identity/` — configuration fail-closed (16), ledger identity
lifecycle + v3→v4 migration + redemption race (16), real-IdP end-to-end incl.
two-person proposal→approval with distinct journaled identities (11),
protocol-security adversarials against the real openid-client stack (13),
restart/reliability (7), production startup posture (8). Total 71.
