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
| `mandates` | immutable versioned spending authority per mission | `PK(id, version)`; `max_amount_minor > 0`; status active/superseded/expired |
| `candidate_plans` | immutable versioned plan terms + canonical digest | `PK(id, version)`; digest = sha256(canonicalJson(terms)) |
| `approvals` | exact-term approval binding one plan version | FK to `candidate_plans(id, version)`; `amount_minor > 0`; status valid/consumed/invalidated |
| `operations` | the durable economic intent | `UNIQUE(org_id, request_id)` = idempotency identity; lifecycle state CHECK; FKs to plan version + mandate version |
| `commitments` | the money view of an operation (1:1) | `UNIQUE(operation_id)`; `state ∈ reserved/unknown/settled/released`; `finalized_at` set on settlement |
| `outbox_dispatches` | transactional dispatch record (1:1 per rail op) | `UNIQUE(operation_id)`; `rail ∈ airwallex/metal`; status pending/claimed/dispatched/abandoned |
| `evidence_events` | append-only audit journal | `UNIQUE(org_id, event_key)` (replay suppression); UPDATE/DELETE blocked by triggers |
| `schema_migrations` | applied versions | PK `version` |

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
