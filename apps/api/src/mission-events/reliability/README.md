# Reliability matrix (issue #15 evidence layer — Agent C lane)

**TRUTH LABEL: SIMULATED_OPERATION / SYNTHETIC.** Every scenario runs against a REAL temp SQLite
ledger through three public seams: mission-event ingestion (this module, including the accepted
cross-source atomic admission correction), the integration bridge (Agent A's, imported read-only),
and the `@moterva/planner` public API over real ledger facts. No provider, bank or physical vehicle
is contacted; the planner is POLICY-ONLY.

## Run it

```bash
npm ci
npm run build -w @moterva/api
node apps/api/dist/mission-events/reliability/run.js            # human summary, exit ≠ 0 on any failure
node apps/api/dist/mission-events/reliability/run.js --json     # machine-readable matrix
npx tsx apps/api/src/mission-events/reliability/run.ts --write  # regenerate committed artifacts
```

Each run executes the whole matrix TWICE on independent fresh worlds and requires identical
world-independent results (determinism proof).

## Layout

| Path                     | Role                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `types.ts`               | Scenario/case/result contracts                                                                        |
| `harness.ts`             | Real world builder (ledger+clock+sources), public planner chain, side-effect counting, fair baselines |
| `scenarios-physical.ts`  | PE-01..PE-25 — admission/journal/replay faults and multi-domain probes                                |
| `scenarios-financial.ts` | FI-01..FI-12 — planner/ledger interaction cases through public interfaces                             |
| `scenarios-baselines.ts` | BM-01..BM-07 — honest economic comparisons incl. ties and baseline wins                               |
| `run.ts`                 | Matrix runner, determinism proof, artifact writer                                                     |
| `results/matrix.json`    | Committed machine-readable results (regenerable byte-for-byte)                                        |
| `results/summary.md`     | Committed human summary                                                                               |

## Invariants enforced every run

1. Evidence-only cases create ZERO financial side effects (operations/commitments/approvals).
2. Event ingestion NEVER writes `financial`-topic evidence (financial-topic rows only appear in
   financial-interaction cases from explicit public financial calls: mandate/approval/reservation).
3. No provider receipt ever appears (no provider access exists — none is fabricated).
4. The accepted cross-source race fix stays green (PE-08/PE-09).
5. Two independent full runs are identical (world-independent fingerprint).

## Fair baselines (issue #15)

Cheapest-first / earliest-deadline-first / static-safe are computed over the SAME candidate set the
planner saw, scored by the SAME scoring math. The committed results deliberately include ties and a
baseline win (governance-by-escalation defers value a naive automaton would capture — recorded, not
hidden). See `results/summary.md` for the exact spread.

## Scenario authorship rules

- A scenario must inject a CONCRETE fault or operational change (or be an explicitly-labeled
  no-fault anchor) and assert named expected-vs-actual checks.
- No scenario may assert planner internals; only public `evaluate` outcomes, rejection codes,
  bridge outputs and ledger counts.
- Any new admission behavior must arrive with a scenario before it ships.
