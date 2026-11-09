# Production identity — verification evidence index (MTV-19)

Branch `feat/mtv-19-production-identity`, base `feat/mtv-19-connected-golden-path`
@ `732a8cae286b9f3ced14e263983f1fb384c33bf9`. Every item below is a real test
or gate run on this branch; exact-head CI results are appended to the PR body.

## Suites (all green)

| Suite | Count | Proves |
| --- | --- | --- |
| `apps/api/test/identity/identity-config.test.ts` | 16 | all-or-nothing OIDC config; https-only production transport; loopback-only insecure escape; placeholder refusal; flow-TTL/scope validation; trustProxy default |
| `packages/ledger/test/external-identity.test.ts` | 16 | migration 0004 (fresh + v3→v4 with data preserved); identity links (journal stores subject hashes only); invitation lifecycle incl. duplicate prevention, role ceiling, single-use, expiry, revocation, redemption race (two connections, exactly one winner); OIDC flow store (hashed state, replay/expiry fail-closed) |
| `apps/api/test/identity/production-identity.test.ts` | 11 | REAL local IdP end-to-end: provisioned owner sign-in; hashed single-use invitation accept + wrong-secret refusal; operator proposes → self-approval refused; operator signs out → DIFFERENT approver retrieves persisted exact terms (`decision-plans`), approves, reserves (distinct actor ids asserted in the journal); uninvited identity zero-state-change; callback replay; revoked-actor sign-in refusal; identity-revocation session invalidation; IdP outage (sessions unaffected, exchange fails closed); anonymous financial 401s with zero operations; approver cannot mint owner/admin |
| `apps/api/test/identity/protocol-security.test.ts` | 13 | fake IdP with controlled JWKS against the REAL openid-client stack: tampered signature, alg=none, wrong audience, wrong issuer, expired token, nonce mismatch, wrong state, code replay, invalid_grant/PKCE, IdP timeout (bounded `OIDC_UNAVAILABLE`), JWKS rotation, unknown kid — every case asserts the machine code AND no Set-Cookie |
| `apps/api/test/identity/identity-reliability.test.ts` | 7 | full app+ledger restart (sessions, links, mid-flight flows persist); invalid session records → clean 401; revocation kills the next request; 60s idle expiry exact; repeated reads accumulate nothing; logout is server-side (second tab dead); back-button cookie refused |
| `apps/api/test/identity/identity-edge-cases.test.ts` | 6 | same email / different subjects (distinct members, org-scoped lookups); one subject in two orgs; IdP email change at link recorded-but-not-authoritative; concurrent logins independent until revocation; service actors have no human credential path and machine sessions cannot approve/manage; wrong org/mission refused |
| `apps/api/test/identity/production-startup.test.ts` | 9 | production+identity: OIDC routes live with PKCE-mandated URLs, demo endpoints structurally 404, anonymous financial fail-closed, no client secret in any response, **SECURE/HttpOnly/SameSite=Strict cookies via X-Forwarded-Proto**, session authenticates; production without identity: all identity routes 404; devAuth+production still refused with full identity config |

## Gates

- Clean `npm install` / `npm ci`; `npm run lint` (0 errors); `npm run typecheck` (0 errors); `npm run build` ✓; prettier on all touched files ✓.
- Secret scan 278 files **0 findings** (fixture credentials assembled at runtime per repo convention).
- Documentation integrity 40+ files 0 errors; design-token contract OK.
- Playwright `e2e/identity-oidc.spec.ts` — 4 REAL-browser journeys through the REAL local IdP (sign-in form → code+PKCE+nonce → session → governed workflow; two-person proposal/approval with distinct identities; reviewer invitation-accept landing read-only; uninvited zero-gain).
- Full unit run and exact-head CI: recorded in the PR body (see commit 15 / STATE.md).

## Honest limitations

1. **No real production IdP exists** — the strictly-local `oidc-provider`
   fixture proves the protocol path; real-provider verification is BLOCKED
   until the owner provides issuer/credentials (see
   [DEPLOYMENT_HANDOFF](DEPLOYMENT_HANDOFF.md)). Issue #5-style gate for identity.
2. Invitation secrets are delivered out-of-band (no email delivery service).
3. IdP-initiated SSO/SLO (end_session) is not implemented; logout is local and
   server-side (documented in the frontend contract).
4. Windows `core.autocrlf` makes byte-for-byte artifact comparisons
   host-sensitive (pre-existing, documented in the reliability suite).
