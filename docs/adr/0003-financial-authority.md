# ADR 0003 — Financial authority: actors, exact approvals, cumulative budgets, revocation

- **Status:** Proposed (delivered with MTV-05, issue #7)
- **Date:** 2026-11-03
- **Deciders:** Engineering (agent) per docs/07 founder-input gate; role taxonomy reviewed against docs/05
- **Review:** due at PR review (R3-sensitive); supersedes the "auth plan of record" paragraph of ADR 0002 §Authentication

## Context

Issue #7's CTO gate: MTV-02 shipped `mandates.max_amount_minor` enforced **per operation**, approvals granted by an unverified `decidedBy` string, and an outbox worker that will later call real providers. Without genuine actor identity, cumulative mission budgets, exact-term approval scope and a dispatch-time authority re-check, a model or caller could split spend across many under-limit operations, reuse authority after revocation, or approve its own proposal. This ADR records the authority architecture implemented in migration 0002 + `packages/ledger/src/services/authority.ts` (+ mandates/approvals/reservations/worker extensions) and the authenticated API surface in `apps/api`.

## Decision

### 1. Identity: persisted actors, scrypt credentials, hashed-token sessions

- `actors` rows (org-scoped, unique username, role ∈ owner/admin/approver/operator/viewer, kind human|service) are the ONLY source of identity. A client-supplied `actorId`, `X-Role` header or body role is never trusted; the session cookie resolves to a persisted actor via sha256-token lookup.
- Human credentials: Node's built-in **scrypt** (reputable primitive, no custom crypto) with per-actor 16-byte salts; verification is constant-time (`timingSafeEqual`) and burns comparable work for unknown usernames (no user oracle). Service actors have no password and can never log in.
- Sessions: 32-byte tokens stored **only as sha256 digests**, expiring (default 8h, `MOTERVA_SESSION_TTL_MS`), individually revocable; revoking an actor kills all their sessions.
- HTTP surface: `HttpOnly; SameSite=Strict; Path=/` cookie (`Secure` in production), per-session CSRF token (sha256-bound, `X-CSRF-Token` required on every mutation), per-username+IP login rate limiting (5 failures → 60s cooldown). Roles are checked by a single pure policy function mirrored between route guards and the ledger service.
- **DEMO_AUTH gate:** `MOTERVA_DEV_AUTH=1` enables username/password login and a one-time dev bootstrap (prints generated dev passwords) **only with NODE_ENV ≠ production, loopback HOST and loopback WEB_ORIGIN**. Production financial routes are NOT registered until a proper IdP-backed authentication boundary exists; the local demo bootstrap generates passwords with crypto-secure randomness. No public `demo-approve` endpoint exists.

### 2. Cumulative mandate budgets (the "10 under-cap payments" gate)

Migration 0002 rebuilds `mandates` (SQLite cannot ALTER CHECK constraints; foreign keys are disabled only for the transactional table swap and verified **inside the migration transaction before COMMIT**) adding:

- `total_budget_minor` — cumulative lifetime envelope. **`-1` preserves the v1 per-operation maximum as historical data only.** Because v1 approvals were unverified identity strings, migration supersedes all v1 active mandates and invalidates unconsumed v1 approvals. Previously attempted provider operations must still reconcile; they cannot be blindly resubmitted. New spending requires a trusted re-issue and a fresh approval.
- `rails_json` (only `airwallex` issuable; authorizing `metal` is refused with `RAIL_ASSET_UNSUPPORTED` until #6's token-asset ledger exists), `allowed_beneficiaries_json` / `allowed_purposes_json` allowlists (empty = unrestricted, the v1 semantics), `require_separate_approver`, `revoked_at` and status `revoked`.

Budget accounting: **`consumed = SUM(operations WHERE org_id = O AND mission_id = M AND currency = C AND state IN (RESERVED, SUBMITTING, IN_FLIGHT, STATUS_UNKNOWN, SETTLED, RECONCILED, REQUIRES_HUMAN))`**. An authorized mandate reissued under a different ID cannot reset historical mission spending. Issuing a new mandate supersedes every other active mandate for that mission/currency, while old operations still consume the global mission envelope. **Settled payments consume for the lifetime of the mandate** — unlike treasury *spendable* (where a fresher provider snapshot frees settled float, because the bank already knows), an envelope bounds total authorized spending and is never freed by a balance refresh. Only provably-never-executed states (CANCELLED/REJECTED/EXPIRED) release budget. The check runs in the SAME `BEGIN IMMEDIATE` transaction as the reservation insert, so N concurrent under-cap workers cannot exceed the envelope (proved by real worker-thread races: exactly one of two 60k claims wins a 100k envelope with 60k consumed).

### 3. Exact-term approvals

`approvals` rebuild binds: org+mission (via persisted plan), plan id/version + **server-recomputed digest** (a caller-supplied plan object is re-verified against the persisted row; tampering → `PLAN_DIGEST_MISMATCH`), operation kind, **server-resolved current mandate id+version (never nullable for new approvals)**, amount, currency, beneficiary, purpose, **quote digest** (canonical digest of the plan's quote block — changed quote ⇒ stale approval) and an optional **evidence digest** (the bundle the approver reviewed; the reserve must present the same digest). One approval per immutable plan version (`UNIQUE(plan_id, plan_version)`): double-clicks are idempotent for the same decider, refused for a different one; the approval is consumed atomically by the single reservation it authorizes; explicit revocation (`status='revoked'`) also blocks **consumed but still queued** approvals at the dispatch gate; it cannot reverse an already potentially submitted provider operation.

**Separation of duties:** plans record `proposed_by`; an actor can never approve a plan they proposed when the mandate requires separation (default on), and service actors can never approve at all.

### 4. Revocation × dispatch: one atomic gate, no TOCTOU

The worker's authoritative dispatch decision is a SINGLE transaction (`claimWithAuthorityGate`): claim the outbox row (conditional UPDATE, rotating token) → reload the operation → if still `RESERVED`, re-verify both the mandate and the consumed approval (not revoked/expired, issued by an active approver, bound to the current mandate version; mission-wide cumulative consumption still within the envelope) → either transition `RESERVED→SUBMITTING` (decision made; dispatch proceeds) or **block**: `CANCELLED` (provably never submitted ⇒ safe release), outbox `abandoned`, `dispatch.blocked` evidence with a stable reason. Consequences:

- Revocation **before** the gate: provider never called, money released.
- Revocation **after** the gate: the operation is already in the dispatch attempt — it is reconciled by its ORIGINAL requestId and **retains its commitment** until provider truth resolves it; revocation never retroactively proves an in-flight payment did not execute.
- Re-issuing (superseding) a mandate or shrinking its envelope blocks queued operations authorized by the previous version, exactly like revocation.
- `SUBMITTING/IN_FLIGHT/STATUS_UNKNOWN` claims always RECONCILE (PR #23 semantics preserved); only verified provider readback settles.

### 5. Untrusted inputs

Model output, telemetry, vendor text and invoices are data, never authority: they cannot create actors/mandates, enlarge budgets, approve, change a bound beneficiary/quote, or reach the dispatch worker. Every material denial is journaled (`reservation.denied` with the machine code) in its own transaction so the audit trail survives the rolled-back reservation, and typed outcomes (`AUTHORIZED | DENIED | NEEDS_HUMAN | REVOKED | STALE_APPROVAL` + reason codes) are exported from the domain package.

## Alternatives considered

- **JWT instead of server-side sessions:** stateless tokens cannot be revoked per-session before expiry — unacceptable while "revoke authority now" is a core requirement. Hashed-token rows give instant invalidation.
- **Argon2 via native dependency:** better KDF hammering, but adds a native build to a zero-native-dep repo (an MTV-01 acceptance pillar). scrypt with standard parameters is the reputable built-in; revisit if GPU attacks become the threat model.
- **Per-mission approval counters in application memory:** rejected — budget accounting must be transactional with the reservation (handoff #3); the SQL sum inside the write transaction is the enforcement point.
- **Revocation via mandate deletion/status on rows only:** insufficient alone — the dispatch gate must re-check atomically at claim time or a revoked-but-queued row still dispatches.

## Consequences / risks

- One approval per plan version means re-approval after expiry/consumption requires a NEW plan version (terms unchanged ⇒ same economics re-posed); documented in the API contract.
- Legacy `totalBudgetMinor=-1` is preserved for historical audit, **NOT an executable spending allowance**. v1 authority is disabled on migration, with prior ambiguous financial operations retained for reconciliation.
- The rate limiter is per-process (single-node deployment assumption, documented); a multi-instance deployment needs a shared store.
- Demo auth is a dev affordance, not an identity product: no password reset, no lockout persistence, generated one-time passwords printed once.

## Where the guarantees are proven

`packages/ledger/test/`: authority (credentials/sessions/CSRF/roles/SoD/idempotent approvals/revocation/grants/denial audit), cumulative budgets (4th-of-3 denied; settled-still-consumes after fresh snapshot; cancelled releases, unknown/escalated retain; duplicate requestIds count once, distinct count twice; per-org isolation; allowlists; superseded-version staleness; mixed-currency separation), **real two-worker budget races**, revocation×dispatch (the 5-step race; post-gate retention; expiry/supersede/shrink blocking; healthy gate; forged-attestation refusal), and the v1→v2 migration on a populated v1 database. `apps/api/test/auth-routes.test.ts`: 401/403/404/409/429 matrix, cookie flags, CSRF, SoD over HTTP, cross-tenant 404, service grants.

## CTO correction note — R3 acceptance blockers resolved in branch, pending exact-head CI

- Financial budgets now count all consuming operations for one **organization+mission+currency**, even across mandate IDs and versions. Issuing a new mandate ID supersedes the previous active authority; a fresh ID alone cannot create an extra budget.
- Every new approval resolves a live persisted mandate at issuance, binds its exact ID/version and rejects mismatched caller assertions. A revoked or expired queued approval cannot pass the worker's final trusted gate.
- Legacy actor-less mandates and unconsumed approvals no longer remain dispatch authority after schema migration. An FK violation aborts its migration transaction before commit.
- Production financial API commands and password login deliberately fail closed without a real production IdP; explicit local demo access also requires loopback bind/origin, and bootstrap credentials use cryptographic randomness. No real provider credentials or payment receipts have been verified.
- Evidence of the amended exact-head full CI must be attached to PR #26 before merging. Passing initial agent CI on the older SHA does not establish these corrections.
