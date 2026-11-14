# Mission-event ingestion (issue #9 — Agent C lane)

**TRUTH LABEL: everything in this module is `SIMULATED_OPERATION` at the physical layer.**
Scenarios, sources and assets are SYNTHETIC. An HMAC-authenticated synthetic source is **not** a
verified physical measurement. No event — accepted or rejected — can approve, reserve, settle or
dispatch money; nothing here is a provider result.

This module builds the missing link between a real-world operating circumstance and the financial
planner: a **versioned, typed, authenticated mission-event ingestion** capability that persists and
replays valid events through the EXISTING permitted evidence boundary (the ledger's append-only
`evidence_events` journal, topic `operational`, org-scoped, duplicate-suppressed, digest-stamped).
It does not touch the financial engine, the frontend, routes or the app factory.

## Layout

| Path                | Role                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/vocabulary.ts` | Closed observation kind→unit→value table (both domains in ONE table: data, not code branches) + financial-authority term rejection |
| `src/schema.ts`     | Strict zod envelope (`contractVersion` 1); unknown fields and free text are structurally impossible                                |
| `src/digest.ts`     | sha256 event digest over canonical JSON; HMAC-SHA256 source signatures (constant-time compare)                                     |
| `src/registry.ts`   | Trusted-source registry: per (org, mission) keys, asset scope, `trustedForRecovery`                                                |
| `src/ingest.ts`     | The single validation→authentication→ordering→time→state pipeline; journals via `ledger.evidence.append`                           |
| `src/view.ts`       | Pure timeline projection: replay, freshness (`fresh`/`stale`/`expired`), per-asset latest readings with evidence references        |
| `src/rng.ts`        | Seeded determinism (fnv1a→mulberry32); fixture-only key derivation                                                                 |
| `src/scenarios/`    | Flagship offshore + warehouse fixtures as scripted, expectation-checked submissions                                                |
| `demo/run.ts`       | Runnable demonstration (both scenarios, real temp SQLite ledger, live proofs)                                                      |
| `contract/`         | JSON Schema, machine-readable kind registry, normalized examples — **the Agent A/B consumer contract**                             |
| `fixtures/`         | Committed SYNTHETIC reference traces + the regeneration tool                                                                       |

## The contract in one paragraph

An event is `(contractVersion, eventId, sequence, orgId, missionId, assetId, observedAt,
ingestedAt, source{sourceId, sourceType, keyId, provenance, signature}, observations[])`.
Sequences are strictly contiguous per `(missionId, assetId, sourceId)` stream and **a stream must
begin at sequence 1** — a first-ever sequence >1, a regression and a gap all fail closed (the gap
case is a lost update and stays closed until the missing event is delivered). Admission is enforced
TWICE: against in-memory state (lazy-hydrated from the journal per `(org, mission)` scope on first
use — a fresh instance never trusts empty state for an existing stream) and journal-authoritatively
inside a `BEGIN IMMEDIATE` write transaction, so two concurrent service instances cannot both admit
the same stream sequence. All in-memory validation state is keyed by composite `org+mission+asset`
(+ `source` for streams) JSON-tuple identities, so organizations or missions reusing the same id
strings cannot contaminate one another's offline/monotonic/duplicate checks. The signature is
HMAC-SHA256 over the canonical JSON of the envelope without the signature; digests use
`@moterva/domain` `canonicalJson` (floats forbidden — decimals travel as exact strings).
Observations older than 15 min are refused at arrival (`STALE_EVENT`).

**Planning eligibility (for planner consumers, issue #8): `planningValid` is true ONLY while
`freshness === 'fresh'`.** Stale (≥15 min) and expired (≥30 min) events remain visible as
digest-verifiable journal history — never deleted, never rewritten — but must not influence
consequential planning unless a fresh refresh event arrives or an explicit, separately-reviewed
override policy says otherwise. See `contract/mission-event.v1.schema.json`,
`contract/observation-kinds.v1.json` and `contract/examples/`.

## Rejection taxonomy (deterministic first-failure)

`UNSUPPORTED_CONTRACT` · `INVALID_ENVELOPE` · `INVALID_UNIT` · `INVALID_VALUE` ·
`AUTHORITY_TERMS_REJECTED` · `CROSS_ORG_EVENT` · `MISSION_NOT_IN_ORG` · `UNKNOWN_ASSET` ·
`UNAUTHENTICATED_SOURCE` · `SIGNATURE_INVALID` · `PROVENANCE_MISMATCH` ·
`SOURCE_NOT_AUTHORIZED_FOR_ASSET` · `DUPLICATE_EVENT` · `SEQUENCE_REGRESSION` · `SEQUENCE_GAP` ·
`TIMESTAMP_ORDER` · `FUTURE_EVENT` · `STALE_EVENT` · `ASSET_OFFLINE` · `CONFLICTING_OBSERVATIONS` ·
`MONOTONIC_VIOLATION` · `JOURNAL_TAMPERED` (replay path).

Notable rules:

- **Streams start at sequence 1** and stay contiguous. Admission never trusts a fresh instance's
  empty state: the target scope is rebuilt from the journal on first use, and inside the write
  transaction BOTH orderings are re-derived from the journal itself — stream sequencing AND the
  asset-wide physical state (latest offline/monotonic readings across ALL sources) — so a
  concurrently committed event on an independent source stream (e.g. a gateway declaring the asset
  offline while telemetry was being validated) cannot be outrun. An inconsistent journal (including
  a duplicated sequence injected by a raw DB writer bypassing ingest) fails closed at replay.
- **Offline assets cannot speak.** Once a trusted observation declares `asset_comms: offline`, the
  asset's own telemetry is rejected (`ASSET_OFFLINE`) — scoped to that one (org, mission, asset), so
  the same asset id in another mission is unaffected. Recovery requires a _different_,
  `trustedForRecovery` source (e.g. the support vessel's gateway) carrying an explicit
  `asset_comms: online` observation. There is no magic recovery.
- **Banking vocabulary cannot enter.** Any occurrence of approve/reserve/settle/dispatch/payment/…
  in ANY string field rejects the event. There is no free-text field anywhere in the contract.
- **Mission success ≠ payment success.** Accepted events journal under topic `operational` with type
  `mission.event.ingested` and event key `mevt:{eventId}`. The demo proves zero `financial`-topic
  evidence, zero operations and zero commitments after both full scenarios.

## Running

```bash
npm ci
npm run build -w @moterva/api            # tsc -b (builds domain/ledger refs first)
node apps/api/dist/mission-events/demo/run.js          # human-readable two-scenario trace
node apps/api/dist/mission-events/demo/run.js --json   # machine-readable report
npx vitest run test/mission-events -w @moterva/api     # the isolated test suite (84 tests)
npx tsx apps/api/src/mission-events/fixtures/generate.ts  # regenerate reference fixtures
```

The demo creates a real temp SQLite ledger, registers the scenario sources, executes both scripted
scenarios (accepted AND adversarially-rejected beats with expectation checks), replays each mission
from the journal, and prints verdicts for: expectations matched, same-seed determinism, and
financial isolation. It exits non-zero on any failure. Two consecutive runs reproduce the same
meaningful event sequence (world ids differ per run by design — org/mission ids are generated by the
ledger; the seed drives the event content, ordering, timestamps and signatures).

## Fixtures (all SYNTHETIC)

- **Flagship `offshore-hull-inspection-v1`** — UAV + support-vessel hull inspection. Economic arc:
  calm window (aerial = cheap alternative) → wind 24.6 kt exceeds the 22 kt limit (aerial blocked,
  costlier vessel path becomes the only option) → UAV link lost offshore (aerial-dependent spend
  unjustifiable) → authorized physical recovery via the vessel gateway (physical only, nothing
  financial) → vessel inspection finds a MAJOR defect (follow-up diagnostic spend becomes a planner
  question). Scripted adversarial beats: ghost telemetry from the offline asset, an exact replay, an
  unregistered "magic recovery" source, a lost-update sequence gap, a contradictory progress report.
- **Second fixture `warehouse-cycle-count-v1 (ingestion breadth) and warehouse-robot-interrupt-v1 (decision-pathway interrupt + governed recovery)`** — counting robot: aisle obstruction (throughput
  cost), charger fault (manual-fallback economics), offline/recovery through the WMS, a 14-item
  stock discrepancy that survives to the end. Same ingest code path; only vocabulary differs.
  Adversarial beats: ghost telemetry, prompt-injection-shaped id (`approve…payment`), stale
  delivery, monotonic violation.

Committed reference traces: `fixtures/*.reference-trace.json` (regenerate with
`fixtures/generate.ts`; a diff after editing a scenario definition is a deliberate change to review).

## Boundary and known limitations (honest)

- **Ownership:** only `apps/api/src/mission-events/**` and `apps/api/test/mission-events/**`. No
  edits to `apps/web`, ledger/provider/authority code, `routes.ts`, `app.ts`, Agent A's planner, the
  lockfile or root config. No HTTP route is registered: an architecture test enforces that this
  module never imports financial engine machinery.
- **Disclosure:** mission events are journaled digest-verified, but the public
  `GET /api/missions/:id/evidence` route projects UNKNOWN event types (including
  `mission.event.ingested`) to `payload: null` by CTO-approved design — extending that disclosure
  allowlist is a deliberate, separately-reviewed change outside this lane. The replay view from this
  module is the consumer contract meanwhile.
- **Keys:** source keys in fixtures are derived from the scenario seed and are fixture-only. A
  production deployment provisions real keys from a secret manager into the same registry shape.
- **Registry is in-memory** per service instance; durable truth is the journal. A service
  lazily rebuilds a scope's validation state from the journal on first admission (and
  `rehydrate(orgId, missionId)` does it explicitly); the rebuild is additive per scope, so
  rehydrating one mission never disturbs another. Key rotation/revocation tooling is future work.
- **Concurrent multiwriter admission** is safe between instances of THIS module: the
  journal-authoritative check inside `BEGIN IMMEDIATE` re-derives stream sequencing AND the
  asset-wide offline/monotonic state from the journal (independent source streams cannot outrun
  each other's state changes; proven by tests). A raw writer that bypasses ingest and inserts a
  duplicate sequence directly into the journal is NOT prevented by the journal's per-eventId
  uniqueness — that residual is detected fail-closed at replay (stream-continuity check) rather
  than prevented.
- **Freshness policy** (15 min stale / 30 min expired, 2 min future tolerance) is one global default;
  per-kind policies can be added without contract changes if a domain needs them.
- The planner (issue #8, Agent A) decides what the evidence MEANS economically; this module supplies
  only typed, authenticated, freshness-stamped facts with evidence references. Scenario
  `economicEffect` annotations are human-facing SYNTHETIC script narration, never journaled.
