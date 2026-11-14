# MTV-07 second-domain audit — what exists, what is genuinely missing (2026-11-09)

**Scope of this audit:** issue #9 acceptance criteria measured against the tree at integration
`4a585fa9429bd34a4d54c7ba25664ddbfe187038`. Written BEFORE implementation so review can check
each gap against the commit that closes it.

## Already delivered by prior lanes (do NOT rebuild)

| Capability                                                                                                                                                                                                                                      | Where                                      | Evidence                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| Authenticated source registry (HMAC keys, per-(org,mission,source) scoping, global keyId uniqueness, `trustedForRecovery`)                                                                                                                      | `src/registry.ts`                          | auth.test 12 cases incl. cross-org key, rogue key, provenance mismatch             |
| Envelope schema v1 + observation vocabulary (12 kinds incl. warehouse `aisle_access`/`charger_status`/`stock_discrepancy`), canonical digests, AUTHORITY_TERMS refusal                                                                          | `src/schema.ts`, `src/vocabulary.ts`       | contract.test 10 cases                                                             |
| Ingest pipeline: sequence monotonicity per source, gaps fail-closed, offline ghost-telemetry refusal, authorized recovery only, staleness/future skew at arrival, journal integrity, tenant isolation, deterministic replay                     | `src/ingest.ts`                            | ingest/replay/restart-safety/multitenant/cross-source-race suites (50+ cases)      |
| Warehouse ingestion fixture `warehouse-cycle-count-v1` (17 beats: obstructed aisle, charger fault, offline+authorized recovery, discrepancy, ghost/authority-terms/stale/monotonic adversarial beats) with committed byte-exact reference trace | `src/scenarios/warehouse.ts` + `fixtures/` | demo.test regeneration test                                                        |
| Reliability-matrix warehouse coverage: PE-22 (schema), PE-24 (no forced UAV rules, comms-only robot → conservative unknown), PE-25 (both domains coexist), FI-12 (warehouse economics, zero operations)                                         | `reliability/scenarios-*.ts`               | reliability.test (45-case stable catalogue — intentionally untouched by this work) |
| Bridge `physicalTimelineToPlannerSafety`: fresh-SYNTHETIC-only evidence, stale withheld not erased, per-source `physicalSequence` preserved, no forecast invention, UAV wind threshold as explicit policy parameter                             | `src/integration/physical-to-planner.ts`   | integration/physical-to-planner.test 4 cases                                       |

## The genuine gaps (this workstream)

**G1 — the bridge applies aerial policy to every asset.** `PhysicalSafetyPolicy` carries one
`uavWindLimitKt` with no asset-domain concept. A ground robot whose telemetry includes a wind
reading is evaluated against the UAV threshold: at 30 kt it is `blocked/wind-limit` (an aerial
verdict for a ground asset), and at 10 kt + hold clear + comms online it becomes `clear/nominal` —
**inheriting aerial clearance the operator never granted the ground domain**. Edge case: ground
asset incorrectly receiving aerial wind policy.

**G2 — no ground-domain decision evidence.** Warehouse facts are journaled but no committed,
reproducible trace derives a _decision_ through `physicalTimelineToPlannerSafety → reviewEvidence
→ generateCandidates → evaluate` for a ground asset. FI-12 exercises the catalogue but documents
"conservative clearance pending the domain adapter" without a committed trace. Issue #9 requires
"same planner and provider contract handles both physical domains without domain-specific finance
branches" to be DEMONSTRATED, not only asserted.

**G3 — credential revocation untested.** The registry has `register` but no revocation path; a
rotated/revoked `keyId` must fail authentication exactly like an unknown key.

**G4 — missing adversarial proofs** for the #9 matrix: duplicate event ⇒ duplicate financial
proposal (must be impossible by construction), physical recovery with no payment verification,
operational failure after financial approval (commitment retained, no fabricated release), and a
single no-hardcoding proof that outcomes track observations rather than mission/asset id strings.

**G5 — the ground planner constraint remains an unimplemented request.** `planner-adapter-request.v1.md`
extension 1 (domain discriminator + `aisle-obstructed`/`charger-fault` reasons) touches
`packages/planner` — Agent A's package. This workstream implements it as an ISOLATED, fully tested
typed proposal module + doc update, never as a competing permission engine, and keeps the bridge's
ground verdicts `unknown` (never `clear`) until A accepts the type change.

## Fix plan mapped to gaps

- G1 → bridge `assetKinds?: Readonly<Record<assetId, 'aerial' | 'ground'>>` (the exact field the
  contract doc requests): aerial/undeclared keep today's semantics byte-for-byte (harbor call sites
  and the 45-case matrix unchanged); declared-ground assets never consume `wind_speed`/`weather_hold`
  for their verdict (comms stays domain-neutral; verdict is `blocked/comms-offline` when offline,
  otherwise `unknown/insufficient-evidence` — a ground asset can NEVER be `clear` until Agent A's
  clearance contract lands).
- G2 → new deterministic scenario `warehouse-robot-interrupt-v1` (isolated module + committed
  reference trace) plus two-domain decision tests reproducing Trace A (harbor wind 24.6 vs 22) and
  Trace B (warehouse interruption) from their journals through the SAME bridge+planner chain.
- G3 → `SourceRegistry.revoke(keyId)` + tests (revoked ⇒ unknown key ⇒ rejected; re-registration is
  the only path back).
- G4 → dedicated adversarial test module (duplicates never duplicate proposals; recovery without
  payment; failure after approval retains the commitment; id-swap proves data-driven outcomes).
- G5 → `src/integration/ground-safety-proposal.ts`: pure, tested, typed proposal implementing the
  exact mapping the contract doc requests, proven against every ground fact combination; NOT wired
  into the planner path; contract doc updated to record the implemented proposal.
