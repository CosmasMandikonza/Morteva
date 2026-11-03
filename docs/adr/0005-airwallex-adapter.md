# ADR 0005 — Airwallex sandbox adapter: verified endpoints, conservative finality, disabled-until-credentialed

- **Status:** Proposed (delivered with MTV-03, issue #5; real-provider gate BLOCKED on credentials; renamed from 0004 per R3 review — 0004 is reserved for issue #29's B-led design ADR)
- **Date:** 2026-11-03 (R3 corrections applied same day: origin lock, namespaced request identities, scoped reconciliation, evidence validation, PAID-reversal semantics, smoke safety, strict list parsing, receipt minimization)
- **Deciders:** Engineering (agent) per docs/07 founder-input gate
- **Review:** due at PR review (R3-sensitive); implements the provider seam ADR 0002/0003 left deliberately empty

## Context

Issue #5 requires the real Airwallex sandbox adapter: server-only auth, balance retrieval with freshness, transfers with durable original request identity, independent readback, and reconciliation semantics — without weakening any reviewed MTV-02/MTV-05 invariant. The CTO handoff explicitly gates real-provider proof on credentials that are **not present in the environment** ("Access is still blocked by credentials/sandbox account and sponsor permissions"). A documentation-only adapter cannot pass the award's proof gate, and fabricated provider success is prohibited. This ADR therefore records the adapter that IS built, the documentation basis for every endpoint it calls, and the exact BLOCKED state of the real-provider gate.

## Verified API basis (official reference, API version 2026-08-21, checked 2026-11-03)

| Call | Endpoint (verified) | Notes that shaped the adapter |
| --- | --- | --- |
| Auth | `POST /api/v1/authentication/login`, headers `x-client-id`/`x-api-key` → 201 `{token, expires_at}` | 30-minute token; refresh once on 401 `credentials_invalid`/`credentials_expired`; 401 codes documented |
| Balances | `GET /api/v1/balances/current` → `{available_amount, currency, pending_amount, reserved_amount, total_amount, account_type}` | amounts are MAJOR units |
| Create transfer | `POST /api/v1/transfers/create` `{request_id, beneficiary_id, transfer_currency, transfer_amount, reason, reference}` | request_id 10–50 chars; duplicates within 7 days rejected `request_id_duplicate` and NOT processed; `request_pending` 409 exists |
| Read transfer | `GET /api/v1/transfers/{id}` | recovery by our id |
| List by request id | `GET /api/v1/transfers?request_id=…` → `{items, page_after}` | the documented recovery path for a lost create response |
| Statuses | `PAID`/`COMPLETED` terminal success; `CANCELLED`/`FAILED`/`REJECTED` terminal failed ("CANCELLED… read failure_type and failure_reason"; "funds have been returned"); `SENT`/`PROCESSING`/`PENDING_*` explicitly not final | sandbox rate limits 20 rps global / 10 per endpoint; 429 → back off |
| Sandbox base | `https://api.sandbox.airwallex.com` | production base exists but the adapter is sandbox-only by construction |

## Decision

### 1. Package shape and the strict offline/real separation

`packages/airwallex` implements: config gate (`loadAirwallexConfig`), conservative status normalization, exact major/minor conversion, `HttpTransport` (timeout, bounded backoff for **idempotent reads only**), `AirwallexClient` (token cache + single 401 refresh), `AirwallexDispatcher` (implements MTV-05's frozen `RailDispatcher`), and a deterministic **`FixtureTransport`** for tests. The separation is structural, not conventional:

- `buildSandboxDispatcher` requires an enabled config **with credentials** and **refuses** any transport carrying the `__offlineFixture` marker; the API only registers the rail when the gate passes. The fixture can never be wired as the live rail.
- Fixture results are recorded with `environment: 'offline-fixture'`; live results with `'sandbox'`. Provider-receipt persistence and status surfaces distinguish them forever.
- The fixture dispatcher reports environment `simulated` through the providers contract — a fixture submission can structurally never settle an operation (only real readback paths return `confirmed`, and the ledger additionally requires the `provider-readback` attestation).

### 2. Money at the boundary

Airwallex amounts are major-unit JSON numbers. Outbound: minor units → exact decimal string via the domain (no float math) → number only at serialization. Inbound: provider number → `String()` → `fromMajorString`, which rejects more decimals than the currency exponent and any binary-float artifact (`0.30000000000000004` fails closed). Round-trip property tests cover USD/JPY/BHD/EUR.

### 3. Finality: submission is never settlement — and PAID is not irreversible

- `dispatch()` returns `submitted` for any accepted create (provider pending states are accepted-not-final) and is typed so it **cannot** return `confirmed`.
- Only `reconcileByRequestId(requestId, scope)` may return `confirmed` — and only when ALL hold (final-review P0-2/P0-3): (a) exactly one match under the **namespaced** provider request id, and that listed record itself carries the exact namespaced id (a listed record **missing** `request_id` is `EVIDENCE_INCOMPLETE`, never a pass-through); (b) the per-id readback (get-by-id) SUCCEEDED — a failed authoritative lookup is `status-unknown (READBACK_INCOMPLETE)`, never a confirmation from the weaker listed record; (c) the get-by-id record names the **same transfer id** as the listing and again the exact namespaced request id; (d) a **complete settlement scope** is present (worker-bound org + operation + authorized amount + currency + beneficiary — webhook/diagnostic/unscoped callers get `SCOPE_INCOMPLETE`, never `confirmed`) and is consistent with the trusted server-side beneficiary mapping (`SCOPE_INCONSISTENT` otherwise); (e) the record's amount (exact minor units), currency and beneficiary id match the authorized operation — **missing** provider identity fields are `EVIDENCE_INCOMPLETE`, wrong values are `EVIDENCE_MISMATCH`, both for a human. The ledger then settles with a `provider-readback` attestation.
- Terminal-failed readbacks map to `failed`; the ledger escalates to `REQUIRES_HUMAN` and retains exposure. For an ALREADY-SETTLED operation whose readback later returns FAILED (documented: a PAID transfer "may subsequently fail if it is rejected by the local clearing system or the recipient bank"), the ledger moves the operation SETTLED→REQUIRES_HUMAN and journals an auditable `settlement.reversed` evidence event — history is never rewritten, the envelope stays consumed, and the money question goes to a human. **SETTLED means "provider-confirmed success at verification time"** — not irreversible delivery; post-settlement monitoring (reconciliation of the still-claimable outbox row) continues until a human RECONCILES, which is the only drain point.
- Status mapping (verified against the official Transfer statuses reference, API version 2025-06-30+ documentation): PAID = terminal success at readback time; FAILED/CANCELLED = terminal failed; SENT/PROCESSING/SCHEDULED/OVERDUE/approval states = never final; **COMPLETED is not a transfer status in this API** and normalizes to `unknown` (keep reconciling, never guessed).

### 4. Ambiguity, idempotency and tenant-safe identity

- Provider request identities are **namespaced per organization** (`mtv-{orgHash10}-{ledgerRequestId}`): identical local request ids in two organizations can never collide at Airwallex or in reconciliation; the ledger worker binds every reconciliation to a durable `ReconcileScope` (org + operation + authorized terms), which is also the evidence-validation baseline. A scopeless reconciliation is `status-unknown (NO_TENANT_SCOPE)`, never a guess.
- Timeouts, connection loss, 429 and 5xx on a **write** are ambiguous: exactly one attempt is made (writes are never retried by the transport), the outcome is `status-unknown`, and recovery ALWAYS reuses the original namespaced request id. Airwallex's 7-day request-id dedupe plus the ledger's `UNIQUE(org_id, request_id)` make a duplicate economically inert.
- A **complete well-formed** list traversal that finds nothing is definitive non-execution (`NO_TRANSFER_FOR_REQUEST_ID` → REQUIRES_HUMAN, never auto-resubmission or release). The listing is **paginated fail-closed** (final-review P1): `page_after` cursors are followed up to a hard 10-page bound; a missing cursor under `has_more`, a **repeated** cursor, a cursor alongside `has_more=false`, a non-boolean `has_more`, a malformed body (missing/non-array `items`) or an over-bound traversal are each `TransportUnavailable` — readback **incomplete**, never treated as empty. Only a complete traversal may conclude "empty".
- Webhooks (documented at-least-once, HMAC over raw bytes) are ingested as **evidence + reconciliation triggers only**: deduped by event id through a durable sink, never mutating operation state directly — out-of-order events cannot regress anything because reconciliation always reads current provider truth and the ledger state machine rejects regressions.

### 5. Receipts (migration 0003) — allowlisted minimization

`provider_receipts` is an append-only (trigger-enforced), org-scoped table recording every interaction — dispatch, readbacks, definitive rejections, ambiguous failures, webhooks, balance reads. **Receipt payloads store an ALLOWLISTED projection only** (`minimize.ts`): transfer id, provider request id, status, currency, amount, beneficiary ID, reference, timestamps, failure CODE (never free-text failure messages, raw beneficiary details, nested objects or unknown fields). A regex redaction pass remains as defense in depth behind the allowlist, not the boundary. A submission receipt alone can never settle anything; settlement requires a readback receipt plus the ledger attestation.

### 6. Credential exfiltration boundary

While sandbox credentials are enabled, credential-bearing traffic is locked to the single approved HTTPS sandbox origin: any `AIRWALLEX_BASE_URL` override other than the exact sandbox origin is a **startup error**; the transport asserts the resolved URL's origin equals `allowedOrigin` before every call (Authorization headers can only ever be delivered to the approved origin) and uses `redirect: 'error'` so cross-origin redirects fail closed. With credentials absent (current state) the adapter is disabled regardless of base URL.

### 7. The honest disabled state (current)

With no credentials configured (the actual environment), `loadAirwallexConfig` yields `enabled: false`, the API registers nothing, `/api/system/status` reports the airwallex entry as **OFFLINE with the explicit BLOCKED-on-credentials detail**, and both smoke scripts exit non-zero with a BLOCKED report instead of fabricating results. Enabling requires all of `AIRWALLEX_ENV=sandbox`, `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY` in the server environment (half-configured sandbox is a startup error, never a silent partial rail), plus a server-side beneficiary id per org.

### 8. Transfer smoke safety — one durable economic intent per state directory

The transfer smoke never seeds a manual balance: a FRESH verified sandbox balance read gates every invocation (the funding model records the provider-read number, source `airwallex-sandbox`, and refuses when funds are less than 10× the amount); the amount is hard-capped (≤ 2000 minor units); `--confirm` and the beneficiary id are mandatory. The one-intent policy is enforced by the **durable ledger across ALL persisted states**: the first invocation persists the complete intent identity (org id, operation id, ledger request id, derived provider request id, beneficiary, amount, currency, one-way sandbox-account fingerprint) **atomically before any provider call**; every rerun **reopens the same ledger operation** — dispatching only if it was never attempted (same id, provider-deduped) and otherwise reconciling by the original identity. A **missing state file never authorizes another payment in any state** (even RECONCILED/CANCELLED prior operations block the silent path); an existing operation that is SETTLED (awaiting reconciliation — PAID can still fail late) or REQUIRES_HUMAN counts as **unresolved** and blocks `--new-intent`. A separate intent requires `--new-intent` (explicit new authorization) AND every prior smoke operation fully resolved (RECONCILED/CANCELLED); only then is the prior state file **archived** (never deleted — the original request/provider identities stay recoverable from the archive, the ledger and the provider receipts). Concurrent invocations serialize on an exclusive lock; state writes are temp+rename atomic.

Reporting is **worker-authoritative and unambiguous**: each run drives the state machine first (`worker.runOnce({claimTtlMs: 0})` reconciles immediately instead of waiting out the claim TTL), then takes a fresh provider readback. `confirmed` requires BOTH an identity-verified PAID readback at a specific `verifiedAt` AND ledger state SETTLED/RECONCILED — a later FAILED readback after settlement is reported as `requires-human` (the authoritative worker performs the auditable reversal, history never rewritten), and a contradictory readback after RECONCILED escalates the report without touching terminal history. Outcome taxonomy: `blocked` (strictly pre-attempt — nothing was submitted), `unverified` (a provider attempt may have occurred; funds remain committed; recovery is reconciling THIS intent, never a new identity), `requires-human`, `confirmed`, `dispatched`/`monitoring` (verifiably pending). Proven by tests that run the actual workflow twice against a deterministic transport with an **empty create lane on rerun**, including crash-after-accept/restart, state-file deletion under SETTLED/REQUIRES_HUMAN/RECONCILED, `--new-intent` under each state, SETTLED→FAILED before claim-TTL elapse, RECONCILED with a contradictory readback, and post-submission pre-readback failure.

## Alternatives considered

- **Airwallex SDK**: no maintained official Node SDK at decision time; the REST surface is small and the repository law prefers explicit, reviewable HTTP. Revisit if an official SDK appears.
- **Auto-retry writes with backoff**: rejected — an ambiguous write retried with a new request id is exactly the double-spend the ledger forbids, and even same-id retries are pointless while the outcome is unknown (readback is cheaper and honest).
- **Webhook-driven settlement**: rejected as the primary mechanism — signature-verified polling readback is simpler, is the only path the reviewed worker trusts for finality, and webhooks remain purely triggers.

## Consequences / risks

- The real-provider acceptance of issue #5 (one actual sandbox balance read + one safe transfer with independent readback) remains **BLOCKED** on founder-provided sandbox credentials and a beneficiary id; no claim of a live sandbox interaction is made anywhere.
- The adapter is sandbox-only: `AIRWALLEX_ENV=production` fails closed at load. Production enablement is a deliberate future change with its own review.
- Token refresh is per-process in-memory (single-instance assumption); a multi-instance deployment would share tokens or refresh independently (harmless — login is cheap and stateless).
- Status normalization treats undocumented statuses as `unknown`→`processing` (keep reconciling); if Airwallex introduces a new terminal state, the adapter stays conservative until the mapping table is updated from the reference.
- Beneficiary validation compares against the server-configured beneficiary ID for the org; orgs without a configured beneficiary produce a definitive pre-call failure rather than dispatching to an unverified payee.

## Where the guarantees are proven

`packages/airwallex/test/`: adapter-basics (config gate incl. origin-lock negatives, status table incl. COMPLETED→unknown, money round-trips, transport retry ladder incl. never-retry-writes), http-transport (origin guard, redirect-block, retry ladder), client (token refresh, definitive-vs-ambiguous classification, strict list parsing, fail-closed pagination), dispatcher (full negative matrix with receipts, webhook dedupe/order-safety, builder guards, minimized payloads), r3-corrections (round-1 matrix: exfiltration, cross-tenant namespacing, evidence validation, PAID→FAILED reversal, malformed readback, nested-secret minimization), r3-final (round-2 matrix: smoke double-run/crash/state-delete/concurrency proving at most one create ever, strict list+get identity validation, scope completeness/inconsistency denials incl. webhook observes-only, pagination fail-closed), ledger-e2e (reserve → gated dispatch → IN_FLIGHT → crash/restart reconcile → settle only on identity-verified PAID readback; pending-forever retains; definitive rejection escalates).
