# Current-state authentication audit (MTV-19 production identity, commit 1)

Scope: what authentication and authorization actually exist at integration head
`732a8cae286b9f3ced14e263983f1fb384c33bf9`, verified by reading the code and the
existing test suites — the baseline the production identity feature must preserve
and extend. This is an audit of shipped behavior, not of intent.

## What exists and works (verified)

**Persisted authority (`packages/ledger/src/services/authority.ts`)**

- Actors are org-scoped rows (`actors`: owner/admin/approver/operator/viewer human
  roles, plus `service` machine actors) created ONLY server-side
  (`createHumanActor` / `createServiceActor`); every creation writes an
  `actor.created` evidence event.
- Human credential verification is scrypt (64-byte derived key, random 16-byte
  salt, constant-time compare); missing users burn comparable time (no username
  oracle); revoked actors and service actors can never pass `verifyCredential`.
- Sessions: random 32-byte bearer tokens stored ONLY as sha256 digests, with
  expiry (`expires_at`), revocation (`revoked_at`), `last_used_at` touch, and a
  `session.created` evidence event per session.
- CSRF: every mutation must echo `X-CSRF-Token`, verified constant-time against
  the session's stored csrf hash; sessions carry `SameSite=Strict HttpOnly`
  cookies (no session content is client-readable).
- Role policy is a single matrix (`packages/domain/src/roles.ts`): service actors
  can NEVER approve or manage authority; humans rank viewer<operator<approver<
  admin<owner; `AuthorityService.requireRole` is the one funnel.
- Mission grants: explicit per-mission grants for SERVICE actors only
  (`grantMissionAccess`), journaled; `hasMissionGrant` gates mission-scoped
  operations (used by decision-snapshot routes since PR #44).
- Revocation: `revokeActor` revokes the actor AND all their live sessions, and
  journals it.

**HTTP boundary (`apps/api/src/app.ts`, `apps/api/src/auth.ts`, `routes.ts`)**

- `request.session` resolves from the `moterva_session` cookie through
  `AuthorityService.resolveSession` — nothing else (no header, body field, or
  role string) can influence identity.
- `guard(request, reply, action)` chains authentication → role policy; `csrfOk`
  guards mutations. Cross-org resources are 404-indistinguishable.
- All financial + demo routes are registered inside ONE encapsulated scope that
  exists ONLY when `config.devAuth` is true; login and the one-time
  `dev-bootstrap` endpoint exist only inside that scope.
- Logout (`POST /api/auth/logout`) and session inspection (`GET
  /api/auth/session`) are also currently DEMO_AUTH-scoped.
- Login rate limiting (5 failures / 60s cooldown, in-process, per ip+username).

**Configuration fail-closed posture (`apps/api/src/config.ts`)**

- `MOTERVA_DEV_AUTH=1` is refused at startup with production `NODE_ENV`, with a
  non-loopback `HOST`, or with a non-loopback `WEB_ORIGIN` — demo auth is
  structurally loopback-local (Agent E's release suite proves this again).
- Provider-mode parsing refuses `sandbox`/`testnet` (issues #5/#6 reserved);
  unknown values refuse startup; provider credentials set while offline produce
  warnings, never calls.
- Config validation collects ALL issues before failing with one actionable
  `StartupConfigError`.

**Evidence:** every sensitive server action (actor create/revoke, session
create, mandate/approval/reservation, grant create/revoke) appends to the
append-only, digest-chained evidence journal.

## Verified gaps (what production identity must add)

1. **No production authentication surface.** The ONLY human login is
   username/password under DEMO_AUTH (loopback, non-production). In production
   the authenticated surface does not exist at all — including `/api/auth/logout`
   and `/api/auth/session`.
2. **No identity-provider integration.** Nothing implements OIDC; no config
   surface exists for an external IdP.
3. **No identity-to-actor linkage.** Actors authenticate by password only; there
   is no persisted mapping from an external identity (issuer, subject) to an
   actor.
4. **No organization membership lifecycle.** Actors are created by developers
   (dev bootstrap) or direct service calls; there is no invitation, redemption,
   or admin-driven join flow, and no way for a startup to onboard a reviewer.
5. **Financial read/mutation routes are unreachable outside DEMO_AUTH**, so a
   production-authenticated reviewer could not even read Mission Treasury.
6. **No flow-state persistence for authorization-code flows** (state, nonce,
   PKCE verifier) — must be added, restart-survivable, single-use, hashed.

## Constraints the new work must preserve (verified invariants)

- DEMO_AUTH stays loopback-only and never runs in production (config-refused;
  Agent E's `verify-production.mjs` 15/15 suite depends on this).
- No second permission matrix: production identity must resolve to the SAME
  `AuthorityService` actors/roles; an IdP claim (role, email, group) must never
  create authority by itself.
- Session + CSRF semantics (hashed tokens, SameSite=Strict HttpOnly cookie,
  X-CSRF-Token header) are reused unchanged.
- Cross-org isolation (404) and 404-on-unknown-route fail-closed behavior stay.
- Append-only evidence journal remains the audit trail — identity events (link,
  invitation lifecycle, redemption) must be journaled the same way.
- No provider credentials (Airwallex/Metal/OIDC client secrets) may ever appear
  in session payloads, logs, or test artifacts.

## Design consequences (short)

- OIDC Authorization Code Flow with PKCE + server-side session (openid-client,
  maintained, standards-only) mounted in a NEW production-identity scope that
  coexists with — never replaces — DEMO_AUTH.
- A local, clearly-labeled test IdP (`oidc-provider`) proves the flow end to end
  including a real two-person browser journey; production uses the same code
  path with a real configured issuer.
- Identity→actor linkage happens ONLY through (a) a separately authorized
  server-side provisioning step for the initial owner/admin, or (b) an
  expiring single-use invitation with a hashed secret whose role allowlist
  excludes owner/admin. Email alone grants nothing; IdP role claims are ignored.
