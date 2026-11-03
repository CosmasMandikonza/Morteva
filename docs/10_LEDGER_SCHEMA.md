# Ledger schema and migrations (MTV-02)

Single source of truth for the persisted financial model. The executable schema lives in `packages/ledger/src/db/migrations-0001.ts` (embedded SQL, applied by `packages/ledger/src/db/migrator.ts`); this document explains the design. Money columns are always **INTEGER minor units** with CHECK guards — there is no FLOAT anywhere.

## Startup, migration, backup

- **Startup order (apps/api):** open database → run pending migrations → verify integrity → serve. Any step failing refuses boot (exit 1) — the API never runs against a database it cannot trust.
- **Migrations:** forward-only, one version per transaction; a failing migration rolls back completely; a database from a newer schema version refuses to run (downgrade protection). New migrations are appended to `MIGRATIONS` in `packages/ledger/src/db/migrator.ts`.
- **Backup:** `ledger.backupTo(path)` performs an online `VACUUM INTO` copy that is safe under WAL.
- **Local default file:** `apps/api/data/moterva.sqlite` (gitignored); override with `MOTERVA_LEDGER_PATH`.

## Tables (migration 0001 — financial foundation)

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `organizations` | tenancy root | PK `id` |
| `missions` | org-scoped operating unit | FK org; `status ∈ active/completed/archived` |
| `accounts` | one treasury account per org+currency | `UNIQUE(org_id, currency, kind)`; `protected_floor_minor >= 0` |
| `balance_snapshots` | append-only provider/manual balance observations | `minor_units >= 0`; `source ∈ airwallex-sandbox/metal-testnet/manual-seed`; `observed_at <= expires_at` (freshness) |
| `mandates` (v2) | immutable versioned spending authority per mission | `PK(id, version)`; `max_amount_minor > 0`; **`total_budget_minor` cumulative **mission/currency** envelope; -1 denotes historical, disabled v1 authority**; rails/beneficiary/purpose allowlists; `require_separate_approver`; status active/superseded/expired/**revoked** + `revoked_at` |
| `candidate_plans` (v2) | immutable versioned plan terms + canonical digest | `PK(id, version)`; digest = sha256(canonicalJson(terms)); **`proposed_by` actor** (separation of duties) |
| `approvals` (v2) | exact-term approval binding one plan version | FK to `candidate_plans(id, version)`; **`UNIQUE(plan_id, plan_version)`** (one approval per immutable version); binds kind + mandate id/version + **quote digest + evidence digest**; `auth_key` single-use identity; status valid/consumed/invalidated/**revoked** |
| `operations` | the durable economic intent | `UNIQUE(org_id, request_id)` = idempotency identity; lifecycle state CHECK; FKs to plan version + mandate version |
| `commitments` | the money view of an operation (1:1) | `UNIQUE(operation_id)`; `state ∈ reserved/unknown/settled/released`; `finalized_at` set on settlement |
| `outbox_dispatches` | transactional dispatch record (1:1 per rail op) | `UNIQUE(operation_id)`; `rail ∈ airwallex/metal`; status pending/claimed/dispatched/abandoned |
| `evidence_events` | append-only audit journal | `UNIQUE(org_id, event_key)` (replay suppression); UPDATE/DELETE blocked by triggers |
| `actors` (v2) | persisted identity: role + scrypt credential | `UNIQUE(org_id, username)`; role ∈ owner/admin/approver/operator/viewer/service; service actors have no password |
| `sessions` (v2) | hashed-token expiring sessions | `token_hash`/`csrf_hash` UNIQUE (sha256); `expires_at`; `revoked_at` |
| `mission_grants` (v2) | explicit per-mission machine authority | `UNIQUE(mission_id, actor_id)`; `revoked_at` |
| `schema_migrations` | applied versions | PK `version` |

## The mandate budget invariant (v2)

```
mission_consumed = SUM(operations WHERE org_id = O AND mission_id = M AND currency = C
                       AND state IN (RESERVED, SUBMITTING, IN_FLIGHT,
                                     STATUS_UNKNOWN, SETTLED, RECONCILED, REQUIRES_HUMAN))
reserve allowed ⇔ mission_consumed + requested ≤ current_mandate.total_budget_minor
                   (one BEGIN IMMEDIATE transaction; across all mandate IDs)
```

**Settled payments consume the envelope for the lifetime of the mandate** — a fresher provider balance snapshot frees treasury *spendable* (the bank already knows), never *authority*. Only provably-never-executed states (CANCELLED/REJECTED/EXPIRED) release budget. The budget check shares the reservation's `BEGIN IMMEDIATE` transaction, so concurrent workers cannot exceed the envelope (proved by real worker-thread races).

## The authority gate (v2)

The dispatch worker's authoritative decision is ONE transaction: claim outbox row → reload operation → if still RESERVED, re-verify (mandate not revoked/superseded/expired, active version unchanged, **approval valid for this queued operation and actor, global mission consumption within envelope**) → `RESERVED→SUBMITTING` or **block** (`CANCELLED` + outbox `abandoned` + `dispatch.blocked` evidence; provider never called). Revocation after the gate retains the commitment and reconciles by the original request id. See [ADR 0003](adr/0003-financial-authority.md).

## The spendable invariant

```
spendable = latest fresh snapshot − protected floor − consuming commitments
consuming = commitments.state IN ('reserved','unknown')
         OR (state = 'settled' AND finalized_at > snapshot.observed_at)
```

Computed inside the same `BEGIN IMMEDIATE` transaction as the reservation inserts — that write lock is what prevents two workers from spending the same money. If commitments exceed balance−floor, spendable clamps to 0 with an `overcommitted` flag and autonomous spending halts.

## Lifecycle

```
PROPOSED → RESERVED → SUBMITTING → IN_FLIGHT → SETTLED → RECONCILED
alternates: REJECTED / EXPIRED / STATUS_UNKNOWN / CANCELLED / REQUIRES_HUMAN
```

The transition table lives in `packages/domain/src/operations.ts` (single owner). Commitment state is derived — never stored independently — via `commitmentStateFor()`:
RESERVED/SUBMITTING/IN_FLIGHT → `reserved`; STATUS_UNKNOWN/REQUIRES_HUMAN → `unknown` (retains funds); SETTLED/RECONCILED → `settled`; REJECTED/EXPIRED/CANCELLED → `released`.

Resolving an operation out of `STATUS_UNKNOWN` requires an attestation (`provider-readback` / `operator-action` / `test-harness`) recorded in the journal; a timeout alone never releases money.

## Idempotency, outbox and recovery

- `(org_id, request_id)` is the durable economic identity: identical retries return the same operation; the same key with different terms throws `IDEMPOTENCY_CONFLICT`.
- The outbox row is committed atomically with the reservation. Workers claim via conditional UPDATE, complete by claim token; a crashed claim is re-claimed after a TTL and ambiguous dispatches replay through `reconcileByRequestId` with the original id.
- MTV-02 registers **no dispatchers** — the seam is visibly disabled; #5 (Airwallex) and #6 (Metal) plug in side by side.

## Evidence journal

Financial and operational events share one append-only table keyed `(org_id, event_key)`; duplicates (webhook/worker replay) are rejected with `DUPLICATE_EVENT`; UPDATE/DELETE are aborted by triggers. Payloads carry a sha256 digest for tamper-evident replay tooling later.

## Where the guarantees are proven

`packages/ledger/test/`: migrations & corruption, balance freshness, mandate/plan/approval binding, reservation math, idempotency, lifecycle retention, evidence, cross-org isolation, **real two-/four-worker thread races**, restart & torn-transaction recovery, outbox claim/replay, drift detection. See the MTV-02 PR for exact outputs.


## CTO review — safe integration boundaries (review of PR #23)

### Dispatch persistence and finality
A provider's `submitted` or `processing` response **must not finish the settlement-monitoring job**. The worker retains its outbox claim and records `IN_FLIGHT`, then claims it again after its lease and invokes `reconcileByRequestId`. After a crash in `SUBMITTING` or `IN_FLIGHT`, it reconciles using the original request ID **before** considering another submission. Unknown response remains `STATUS_UNKNOWN` and continues to consume its commitment. Only provider-confirmed finality completes the outbox. The worker is still disabled by default: no real provider dispatchers exist in MTV-02.

A terminal settlement or release **after dispatch may have started** requires an independently verified provider-readback attestation; test-harness or human claims alone cannot release committed exposure. Provider adapters in #5/#6 must additionally verify actual provider ID, receipt/source, signature where appropriate and environment before returning an attested terminal state.

### Separate fiat and token accounts — hard-block Metal until #6
The v1 SQLite schema tracks **ISO 4217 fiat** currencies and one treasury account per organization/currency. It does **not** model Metal testnet chain, token contract, token precision, wallet identity, token balances or custody. A USDC/token amount is not automatically equivalent to fiat USD cents or Airwallex account liquidity. **`metal_order` reservations deliberately throw `RAIL_ASSET_UNSUPPORTED`** in this version. Issue #6 must introduce asset/rail-specific balances and exact token precision + units, a migration and cross-asset tests before enabling Metal dispatch. This is an explicit unimplemented capability, not a provider credential-only blocker. Do not fabricate an Airwallex-to-Metal funding bridge.

### Conservative money and evidence semantics
- Settlement `finalized_at >= snapshot.observed_at` keeps consuming funds even when timestamps tie; only a strictly later verified snapshot can free capacity.
- Balance snapshots reject invalid timestamps and observations more than 30 seconds into the future; maximum source freshness, anti-spoofing and provider identity verification are additional adapter requirements.
- Approval issuance verifies the persisted org-scoped plan and digest, and requires a valid future expiry. Mandates and plan versions cannot silently bind another organization's mission.
- Evidence events can only target a mission in their organization; event receipts are looked up by exact `org_id + event_key`, not by the last global/org journal sequence, avoiding cross-writer misattribution.
- The current `mandates.max_amount_minor` is a **per-operation** ceiling, not an aggregate lifetime or mission budget. This does not yet enforce rolling cumulative limits, merchant allowlists, approval actor authorization, or mandate revocation. Those must be implemented and tested as part of MTV-05/#7 before any autonomous bank/signer action.
- `manual-seed` is only a synthetic development balance; do not display it as provider-verified. No real Airwallex/Metal receipt or funds have been verified by this issue.

### Outstanding engineering risks (must become #5/#6/#7 acceptance)
- Signed/attributed provider receipts, verified `providerState` transitions, source authentication and bounded retry/reconciliation cadence.
- Per-org mission cumulative budgets, real approval identity, release/reversal authorization, segregated rail asset units and provider-backed balances.
- Multi-instance deployment and durable job scheduling; the single-host SQLite adapter is a deliberate local MVP limit.


### MTV-05 CTO review boundary

- All monetary consumption is assessed per org/mission/currency, **across mandate identities**. One active mandate per mission/currency is permitted. Reissued/superseded credentials cannot silently reset previous settled/unknown payments.
- V1 mandates and unverified approvals are preserved as **historical data, not authorization to spend**: migration supersedes active legacy mandates and invalidates unconsumed legacy approvals. Existing attempted operations still reconcile against provider truth.
- The worker rechecks queued approval revocation, expiry, actor revocation and bound mandate version before calling any provider; post-attempt revocation retains exposure. Provider connectors remain disabled.
- Foreign key verification happens inside migration transactions, so a failed integrity check rolls back both the schema and migration version.
- Real financial HTTP routes require a future production IdP. For now they are enabled only in loopback DEMO_AUTH; do not expose the demo listener or classify demo credentials as customer access.
