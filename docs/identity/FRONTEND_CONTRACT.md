# Frontend contract — authentication & membership (decision-authority/v1 + identity/v1)

For Agent B. Backend-owned, versioned interface for sign-in, session, org/role
membership, logout and invitation acceptance. **No screen rewrites are
required by the backend; this contract is additive.** Route naming and shapes
are final at identity/v1; changes only as a new version with notice.

## 0. Modes

`GET /api/auth/session` returns `authMode`:

- `"oidc"` — production identity configured. Use the OIDC journey below.
- `"demo"` — DEMO_AUTH (loopback development only). Existing
  `POST /api/auth/login` + one-time `POST /api/auth/dev-bootstrap` unchanged.
- Unauthenticated callers receive `401 UNAUTHENTICATED` — show the sign-in
  entry for the configured mode.

## 1. Sign-in initiation (OIDC)

`GET /api/auth/oidc/login?orgId={optional}` — **full-page browser navigation**
(not fetch; it redirects to the IdP).

- `303` → `Location: <IdP authorization URL>` (browser goes there; PKCE +
  state + nonce are server-side — the frontend stores nothing).
- Optional `orgId` scopes the post-login organization (validated; unknown →
  `404 NOT_FOUND`).
- `429 RATE_LIMITED` after repeated attempts from one IP — render the wait.

## 2. Authentication callback

`GET /api/auth/oidc/callback` — the IdP redirects here; the backend completes
the exchange and lands the user on the configured `WEB_ORIGIN` (`303`).

Error landings the SPA may surface (query unchanged — errors are NOT in the
URL; the SPA learns them from the session probe or a redirected error page):

| Backend status | Machine code | Meaning for the UI |
| --- | --- | --- |
| 400 | `OIDC_STATE_REPLAYED` / `OIDC_STATE_INVALID` | Stale/back-button sign-in — offer "Sign in again" |
| 400 | `OIDC_TOKEN_INVALID` / `OIDC_CODE_INVALID` | IdP rejected the exchange — retry |
| 403 | `IDENTITY_NOT_LINKED` | Not a member — show invitation-accept entry |
| 403 | `AUTH_ACTOR_REVOKED` | Account revoked — no retry hint |
| 409 | `ORG_SELECTION_REQUIRED` | body carries `orgIds[]` — show an org picker that re-calls login with `?orgId=` |
| 429 | `RATE_LIMITED` | Too many attempts |

## 3. Session inspection + membership

`GET /api/auth/session` →

```json
{
  "actor": { "id": "act_…", "username": "reviewer@idp.test", "displayName": "…", "role": "viewer", "kind": "human", "orgId": "org_…" },
  "expiresAt": "2026-11-08T20:00:00.000Z",
  "authMode": "oidc"
}
```

- `401 UNAUTHENTICATED` → treat as signed out (expired or revoked); show the
  sign-in entry. Do NOT loop-probe; re-probe on route change or after 401s.
- `role` is the MOTERVA financial role (viewer|operator|approver|admin|owner)
  — gate UI affordances by it, never by IdP data.

## 4. CSRF after a redirect sign-in

A `moterva_csrf` cookie (SameSite=Strict, NOT HttpOnly) is set alongside the
session — read it with `document.cookie` and send it as the `X-CSRF-Token`
header on every mutation (same requirement as demo mode). It is not a
secret; the server verifies it against the session's stored hash.

## 5. Logout

`POST /api/auth/logout` with the session cookie + `X-CSRF-Token` → `{ ok: true }`
and cleared cookies. Then drop all in-memory state and navigate to the signed-out
view. Both auth modes share this endpoint. A stale-cookie call returns 401 —
treat as already-signed-out.

## 6. Invitation acceptance (pre-authentication)

`POST /api/auth/invitations/accept` with `{ invitationId, secret }` (form or
JSON; **no session, no CSRF** — the secret IS the credential):

- `303` → `Location: <IdP>` — navigate; after the IdP round-trip the user
  lands signed-in with the invited role.
- `403 INVITATION_SECRET_INVALID` · `409 INVITATION_REDEEMED` /
  `INVITATION_REVOKED` · `400 INVITATION_EXPIRED` (machine codes map to
  friendly copy) — the invitation link/id/secret tuple comes from the admin;
  `POST /api/invitations` returns `{ invitation, secret }` exactly once for
  the admin to deliver.

## 7. Invitation management (owner/admin UI)

- `POST /api/invitations` `{ role: 'approver'|'operator'|'viewer', email, ttlMs? }`
  (session + CSRF) → `200 { invitation, secret }` — display the secret ONCE
  with copy-to-clipboard; it is never retrievable again.
  `403` non-owner/admin (incl. any attempt to invite owner/admin) · `409`
  duplicate active invitation.
- `GET /api/invitations` → `{ invitations: [{ id, role, email, createdAt,
  expiresAt, redeemedAt, revokedAt }] }` — no secrets, ever.
- `POST /api/invitations/:id/revoke` (CSRF) → `{ ok: true }` / `404`.

## 8. Secure-cookie behavior behind the proxy

Production sets `Secure` on both cookies and the API trusts
`X-Forwarded-Proto` only when `MOTERVA_TRUST_PROXY=1` (Agent E's Caddy edge).
Local development over `http://localhost` works because the environment is
non-production. Never render session cookies; never log them (the API
redacts `cookie`/`authorization` headers in logs).

## 9. Explicitly out of scope for the frontend

- Any IdP configuration, client secrets, or token handling — the browser
  never sees signing secrets or tokens; sessions are opaque server-side.
- Role assignment from email domains or IdP UI claims — membership is shown,
  never derived.
- Registration/sign-up flows — membership exists only via invitation or
  (server-side) provisioning; there is no public sign-up endpoint.
