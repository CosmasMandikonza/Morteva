# ADR 0002 — Ledger persistence: SQLite via node:sqlite, atomic reservations, outbox

- **Status:** Accepted for the internal MTV-02 ledger foundation (reviewed/merged PR #23; not authorization for live provider payments)
- **Date:** 2026-11-03
- **Deciders:** Engineering (agent) per docs/07 founder-input gate
- **Review:** exact-head CI and security/correctness review passed on `80aa93aeaf47cbf893e42b11440c78211256876f`; merged main `8bb231145deec082caf3c765bd34b3678d6f7fdb`. Supersedes the persistence *plan* in ADR 0001 §Decision 3. See docs/10 for the post-review Metal account and provider-readback limitations.

## Context

Issue #4 requires durable financial state: org/mission/account/mandate/plan/approval/operation/commitment/evidence records, atomic multi-worker reservations, crash-safe recovery and a transactional outbox — before any provider integration (#5/#6). ADR 0001 committed to "SQLite first, behind a storage port, Postgres later". This ADR records the concrete persistence decisions.

## Decision

### 1. SQLite through Node's built-in `node:sqlite` (zero dependency)

`node:sqlite` (stable in the Node 24 LTS line this repo pins, `engines.node >= 24`) is used instead of a native binding (better-sqlite3) or an ORM. Verified on this repository's exact runtime before adoption: WAL mode, `busy_timeout`, CHECK constraints and foreign keys all behave as required, and integer round-trips up to 2^53−1 are exact.

- No native build step → cold-checkout installs stay reliable on Windows/Linux/CI (an MTV-01 acceptance criterion).
- No ORM: the SQL is explicit and reviewable — for money code, that is the point. Migrations are embedded, versioned SQL.
- Cost: `engines.node` tightens from ≥22 to ≥24 (recorded in README). Accepted: CI and development both run Node 24.

### 2. Serialization: WAL + `BEGIN IMMEDIATE` + busy timeout + bounded retry

Every reservation runs inside one `BEGIN IMMEDIATE` transaction (write lock taken up front): idempotency check → mission/mandate/plan/approval validation → spendable computation → inserts (operation, commitment, outbox, evidence). Two workers, threads or processes cannot both pass the spendable check for the same org+currency — the second one's transaction starts only after the first commits. Contention is handled by `PRAGMA busy_timeout = 5000` plus bounded backoff on `SQLITE_BUSY`. `PRAGMA synchronous = FULL` keeps commits durable.

This gives single-database linearizability for money, which is exactly the invariant; a later multi-node deployment is what would force the Postgres move.

### 3. The spendable formula (docs/05 #2)

```
spendable(org, currency) =
    latest fresh balance snapshot        (expired → STALE_BALANCE, none → NO_BALANCE_SNAPSHOT)
  − protected floor                      (org treasury account column)
  − Σ commitments that consume capacity:
        state IN ('reserved','unknown')   (pending and ambiguous retain funds)
     OR state = 'settled' AND finalized_at > snapshot.observed_at
                                          (money left the bank after the snapshot was taken;
                                           a settlement against a stale snapshot still consumes
                                           until a fresher observation arrives)
```

If commitments exceed balance−floor (external spend from the same wallet), spendable clamps to 0 and reports `overcommitted` — autonomous spending halts instead of lending phantom capacity (docs/01 "Reserved budget vs provider funds"). An internal reservation is never a bank hold or escrow; the UI must never imply provider custody.

### 4. Commitment state mirrors operation state through one pure function

`commitmentStateFor(operationState)` (packages/domain) is the single mapping. The ledger updates the commitment row only inside the same transaction as the operation transition, so the two state columns cannot drift. Ambiguous outcomes (`STATUS_UNKNOWN`, `REQUIRES_HUMAN`) map to `unknown`, which retains capacity; only REJECTED/EXPIRED/CANCELLED release. Resolving out of `STATUS_UNKNOWN` requires an explicit attestation naming the verified source — a timeout alone can never move money state.

### 5. Durable economic identity and the outbox

`(org_id, request_id)` is UNIQUE on `operations`: the idempotency key created at reserve time, reused for every retry of the same intent; same key + different terms is a hard `IDEMPOTENCY_CONFLICT`. The outbox row is written in the same transaction as the reservation, carrying the original request id. Workers claim rows with a conditional UPDATE (atomic), complete by claim token, and stale claims (crashed worker) are re-claimed after a TTL — replaying `reconcileByRequestId(original)` for ambiguous dispatches, never submitting a new economic instruction.

MTV-02 ships the worker with **no dispatchers registered** (the disabled seam): `runOnce()` claims nothing until #5/#6 register Airwallex/Metal adapters side by side (both rails concurrent by design; no global rail switch). Submission ≠ settlement is enforced structurally: dispatch results are typed `ProviderSubmissionStatus` (no `confirmed`), only readback can confirm.

### 6. Restart & recovery

Startup order (apps/api): open → migrate (forward-only, transactional; downgrade refused) → integrity verification (commitment/operation 1:1, state mapping, no duplicate identities, no missing outbox rows) → serve. Violations fail the boot: recovery surfaces damage for a human decision; it never auto-repairs money state. Backups: `VACUUM INTO` online copy (tested).

## Alternatives considered

- **better-sqlite3**: mature, slightly faster; native build risk on cold checkouts and another install-script approval. Rejected for reliability of `npm ci`.
- **Postgres now**: real row-level locking and concurrent writers, but adds a managed service to every dev machine and CI run during a two-week build. Deferred per ADR 0001; the storage port (`LedgerDatabase`) keeps the swap contained.
- **Drizzle/Prisma**: schema-in-TypeScript is attractive, but the transactional SQL here is short, explicit and load-bearing; hiding it behind query builders makes the money path harder to review, not easier.

## Consequences / risks

- Single-writer at a time: fine at one-org demo scale; contention is bounded by short transactions (worker race tests run in ~0.4s).
- `node:sqlite` requires Node ≥ 24 (engines updated; README documents it).
- No free multi-process job queue — irrelevant until a second API process exists; the outbox already models the claim protocol.
- SQLite dynamic typing is contained by CHECK constraints on every money column (negative/invalid amounts rejected at the storage layer too, tested by direct-SQL corruption attempts).

## Migration path (the "later" trigger)

When concurrent writers beyond one host or a hosted multi-process deployment arrive: implement `LedgerDatabase` over Postgres, port the ~15 SQL statements (they are ANSI-ish), keep services and tests; run the same race/restart suites against the new adapter. That port is deliberately not built now (docs/08: no infrastructure before the vertical slice needs it).

## References

- Issue #4 and its CTO handoff comment
- [ADR 0001 — stack and runtime](0001-stack-and-runtime.md)
- [Ledger schema and migrations](../10_LEDGER_SCHEMA.md)
- [Financial correctness gates](../05_FINANCIAL_SECURITY_AND_PROVIDER_GATES.md)
