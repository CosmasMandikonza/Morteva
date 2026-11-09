# Deployment handoff — production identity (for Agent E)

Coordination contract only — **no deployment manifests were touched** (Agent E
owns `deploy/`, release suites, compose/systemd topology, TLS). This document
states what the identity feature needs from the deployment and what it
guarantees in return.

## Environment contract (names only; values live in Agent E's secret manager)

| Variable | Required | Meaning |
| --- | --- | --- |
| `MOTERVA_OIDC_ISSUER` | yes (for identity) | Canonical IdP issuer URL; **must be `https://` in production**; matched exactly against IdP metadata |
| `MOTERVA_OIDC_CLIENT_ID` | yes | Confidential client id at the IdP |
| `MOTERVA_OIDC_CLIENT_SECRET` | yes | Confidential client secret — server-side only, never in images/logs/browser |
| `MOTERVA_OIDC_REDIRECT_URI` | yes | EXACT pre-registered callback: `https://<public-host>/api/auth/oidc/callback` (https in production; no fragments) |
| `MOTERVA_OIDC_SCOPES` | no | default `openid profile email` |
| `MOTERVA_OIDC_ID_TOKEN_ALG` | no | default `RS256` — anything else the IdP signs with is rejected |
| `MOTERVA_OIDC_FLOW_TTL_MS` | no | authorization-flow state TTL (default 10 min, max 15) |
| `MOTERVA_OIDC_HTTP_TIMEOUT_MS` | no | IdP HTTP deadline (default 10 s, range 1–30 s) |
| `MOTERVA_TRUST_PROXY` | yes behind Caddy | `1` so `X-Forwarded-Proto` is honored ONLY at the TLS edge |
| `MOTERVA_DEV_AUTH` | **must be absent in production** | demo auth is config-refused in production even when identity is fully configured (tested) |

Partial OIDC configuration = **startup failure** with every missing variable
named — deploy either the full set or none.

## What Agent E's topology must provide

1. **Public route for the callback**: the IdP must be able to reach
   `/api/auth/oidc/callback` on the public host. It is registered inside the
   authenticated scope — in the current "public surface is `/healthz` +
   `/api/system/status` by construction" posture, this is the ONE deliberate
   addition once identity is enabled: `/api/auth/oidc/*`,
   `/api/auth/invitations/accept`, `/api/auth/session`, `/api/auth/logout`
   and the authenticated (session-gated) financial surface become reachable.
   Everything still requires a session/CSRF except the IdP round-trip
   endpoints listed above.
2. **Caddy proxy header**: `X-Forwarded-Proto https` for API requests
   (cookie `Secure` + issuer/redirect https checks rely on it).
3. **IdP registration values for the provider dashboard**: callback URL =
   `MOTERVA_OIDC_REDIRECT_URI`; grant type = authorization code; PKCE
   required (S256); ID token signed RS256; response type `code`; scopes
   `openid profile email`.
4. **Secret delivery**: the four `MOTERVA_OIDC_*` values must arrive via the
   existing private secret channel (env file/secret manager) — never in
   images, compose files, logs, or this repository.

## Guarantees in return (proven by tests)

- No identity traffic or secret ever appears in session payloads, cookies
  (beyond the opaque session/CSRF pair), logs (redacted headers) or API
  responses (asserted in `production-startup.test.ts`).
- `GET /healthz` and `/api/system/status` remain anonymous and unchanged.
- Without identity configured, the deployed surface is exactly what Agent E's
  `verify-production.mjs` asserts today (identity routes 404 — tested).
- A hung IdP fails every attempt bounded (`MOTERVA_OIDC_HTTP_TIMEOUT_MS`),
  never hangs the API; existing sessions are unaffected by IdP outages
  (sessions are server-side).
- Startup fails closed on partial identity configuration — the deployment
  kit can treat a boot with identity as proof the full set was provided.

## Reviewer onboarding runbook (operator steps, no hidden knowledge)

1. Provision the FIRST owner once, server-side (no HTTP route exists):
   a small operator script calling
   `ledger.identity.provisionIdentityActor({ orgTitle, username, displayName,
   role: 'owner', provider, subject, emailAtLink })` with the owner's IdP
   subject. This is the only privileged provisioning step.
2. The owner signs in via the IdP, then invites reviewers:
   `POST /api/invitations { role: 'viewer'|'operator'|'approver', email }`
   → deliver the one-time `secret` out-of-band.
3. The reviewer opens the public URL, submits the invitation id+secret at
   the accept endpoint (or a small Agent B screen), completes the IdP
   sign-in, and lands as a member with the invited role.
4. Reviewer journey: session → missions → Mission Treasury (`/api/financial/overview`)
   → admitted events (`/api/missions/:id/evidence`) → durable evaluations
   (`/api/missions/:id/decision-snapshots`) → exact plan terms
   (`/api/missions/:id/decision-plans`) → evidence journal → logout.
   Read-only by default; any money interaction requires operator/approver
   roles AND the existing mandate/approval gates; provider dispatch stays
   disabled until separately configured and authorized.

## Out of Agent A's scope (flagged for owners)

- IdP account/tenant creation and its credentials (issue #5-equivalent gate
  for identity: **BLOCKED until the owner provides a real production IdP** —
  the strictly-local test IdP is a fixture, never a deployment component).
- In-product invitation email delivery (secrets are delivered out-of-band in
  this increment).
