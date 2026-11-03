# ADR 0004 — Airwallex sandbox adapter: verified endpoints, conservative finality, disabled-until-credentialed

- **Status:** Proposed (delivered with MTV-03, issue #5; real-provider gate BLOCKED on credentials)
- **Date:** 2026-11-03
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

### 3. Finality: submission is never settlement

- `dispatch()` returns `submitted` for any accepted create (provider pending states are accepted-not-final) and is typed so it **cannot** return `confirmed`.
- Only `reconcileByRequestId()` may return `confirmed`, and only when an independent readback (list-by-request-id, then get-by-id for freshest state) shows terminal success, with `verifiedAt`. The ledger then settles with a `provider-readback` attestation; every other readback outcome keeps the commitment.
- Terminal-failed readbacks map to `failed` with the provider state; the ledger escalates to `REQUIRES_HUMAN` and retains exposure (the reviewed rule that potentially-executed money is never auto-released).

### 4. Ambiguity, idempotency and recovery

- Timeouts, connection loss, 429 and 5xx on a **write** are ambiguous: exactly one attempt is made (writes are never retried by the transport), the outcome is `status-unknown`, and recovery ALWAYS reuses the original request id. Airwallex's 7-day `request_id` dedupe plus our ledger's `UNIQUE(org_id, request_id)` make a duplicate economically inert, and a `request_id_duplicate` create response is recoverable via list-by-request-id.
- An empty list-by-request-id result is reported `failed (NO_TRANSFER_FOR_REQUEST_ID)` — definitive non-execution for the human workflow, never a trigger to silently submit a new operation.
- Webhooks (documented at-least-once, HMAC over raw bytes) are ingested as **evidence + reconciliation triggers only**: deduped by event id through a durable sink, never mutating operation state directly — out-of-order events cannot regress anything because reconciliation always reads current provider truth and the ledger state machine rejects regressions.

### 5. Receipts (migration 0003)

`provider_receipts` is an append-only (trigger-enforced), org-scoped table recording every interaction — dispatch, readbacks, definitive rejections, ambiguous failures, webhooks, balance reads — with redacted payloads (credential-shaped values stripped twice: in the adapter and again in persistence). A submission receipt alone can never settle anything; settlement requires a readback receipt plus the ledger attestation. Receipts keep tenant scope across restarts via `orgIdForRequestId` (durable operation lookup); receipts with no owning org are skipped rather than mis-scoped.

### 6. The honest disabled state (current)

With no credentials configured (the actual environment), `loadAirwallexConfig` yields `enabled: false`, the API registers nothing, `/api/system/status` reports the airwallex entry as **OFFLINE with the explicit BLOCKED-on-credentials detail**, and both smoke scripts exit non-zero with a BLOCKED report instead of fabricating results. Enabling requires all of `AIRWALLEX_ENV=sandbox`, `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY` in the server environment (half-configured sandbox is a startup error, never a silent partial rail), plus a server-side beneficiary id per org.

## Alternatives considered

- **Airwallex SDK**: no maintained official Node SDK at decision time; the REST surface is small and the repository law prefers explicit, reviewable HTTP. Revisit if an official SDK appears.
- **Auto-retry writes with backoff**: rejected — an ambiguous write retried with a new request id is exactly the double-spend the ledger forbids, and even same-id retries are pointless while the outcome is unknown (readback is cheaper and honest).
- **Webhook-driven settlement**: rejected as the primary mechanism — signature-verified polling readback is simpler, is the only path the reviewed worker trusts for finality, and webhooks remain purely triggers.

## Consequences / risks

- The real-provider acceptance of issue #5 (one actual sandbox balance read + one safe transfer with independent readback) remains **BLOCKED** on founder-provided sandbox credentials and a beneficiary id; no claim of a live sandbox interaction is made anywhere.
- The adapter is sandbox-only: `AIRWALLEX_ENV=production` fails closed at load. Production enablement is a deliberate future change with its own review.
- Token refresh is per-process in-memory (single-instance assumption); a multi-instance deployment would share tokens or refresh independently (harmless — login is cheap and stateless).
- Status normalization treats undocumented statuses as `unknown`→`processing` (keep reconciling); if Airwallex introduces a new terminal state, the adapter stays conservative until the mapping table is updated from the reference.

## Where the guarantees are proven

`packages/airwallex/test/`: adapter-basics (config gate, status table, money round-trips, transport retry ladder incl. never-retry-writes), client (token refresh, definitive-vs-ambiguous classification, recovery listing), dispatcher (full negative matrix with receipts, webhook dedupe/order-safety, builder guards, payload redaction), ledger-e2e (reserve → gated dispatch → IN_FLIGHT → crash/restart reconcile → settle only on PAID readback; pending-forever retains; definitive rejection escalates).
