# Step 0 — source audit (Agent C, general mission orchestrator assignment; Nov 10, 2026)

## Exact branch heads at audit time

| Ref                                                            | Head                                                                             | State                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `main`                                                         | `ad59194b`                                                                       | historical money-engine + read APIs; far behind integration |
| `feat/mtv-19-connected-golden-path` (CTO-accepted integration) | `e15d30d7` "Integrate live 3D/2D mission viewer with verified physical evidence" | **assignment target**                                       |
| PR #42 (Integration #19 → main)                                | head `e15d30d7`, base `main`                                                     | OPEN, draft-eligible                                        |
| PR #53 (B design pass)                                         | head `05fd04ee`, base integration                                                | OPEN                                                        |
| PR #54 (ground fixture + two-domain traces)                    | `0b8f6049` lineage                                                               | MERGED into integration                                     |
| PR #55 (viewer integrated acceptance)                          | final head `11ce519f`                                                            | MERGED into integration                                     |
| PR #56 (asOf race fix + adversarial journey)                   | `e3e194cf`                                                                       | MERGED into integration                                     |
| this work                                                      | branch `feat/mtv-general-mission` cut at `e15d30d7`                              | new                                                         |

## What WORKS (proven by committed tests on `e15d30d7`)

1. **mission-events ingestion** (`apps/api/src/mission-events/**`): typed authenticated events, HMAC source registry
   (per org+mission, revocation, `trustedForRecovery`), closed observation vocabulary INCLUDING warehouse kinds
   `aisle_access` / `charger_status` / `stock_discrepancy`, append-only journal with canonicalJson digests,
   planning-validity + freshness, restart safety, multitenant isolation, cross-source race fix, 45-scenario
   reliability matrix, committed `offshore-hull-inspection-v1` + `warehouse-interrupt-v1` scenario traces.
2. **`packages/planner`** (pure, deterministic): `reviewEvidence` → `generateCandidates` → `evaluate`;
   candidate kinds `continue-supplier | reschedule | purchase-diagnostics | hire-alternative | no-action`;
   `ASSET_SAFETY_BLOCKED` gate keyed on `requiresAssetId` (per-asset: a backup robot is gated on ITS asset);
   `INFORMATION_NOT_WORTH_PRICE` diagnostic value gate; `FinancialFacts` from the ledger; intent-keyed
   idempotency downstream. `MissionModelAdapter` interface exists with a POLICY-ONLY `FixtureModelAdapter`
   (keyword stand-in, no live inference).
3. **physical→planner bridge** (`physical-to-planner.ts`): SYNTHETIC planning-valid journal events →
   `asset-safety` evidence; ground assets never consume wind/hold; ground verdict is
   `blocked/comms-offline` or `unknown/insufficient-evidence` — never `clear`.
4. **decision snapshots** (`decision-snapshots.ts`): journaled, digest-verified, intent-keyed idempotent;
   plan proposal revalidates inside BEGIN IMMEDIATE; demo authority refresh issues new mandate versions.
5. **physical-view read API**: strict viewer adapter; server-authoritative S0; catalog UAV aerial.
6. **two-domain-decision traces**: harbor + warehouse traces through the SAME chain, no domain branches.
7. **E2E**: integrated viewer acceptance (serial), adversarial financial journey (serial), governed decision,
   identity OIDC — all green on the integration head.

## What is PROPOSED / synthetic / NOT wired (the actual gaps)

1. **Ground constraint extension is a REQUEST, not accepted**: `ground-safety-proposal.ts`
   (`proposedGroundSafety`, reasons `aisle-obstructed`/`charger-fault`, `domain` discriminator) is isolated;
   `reviewEvidence` would REFUSE the new reasons (fail-closed proof in `ground-safety-proposal.test.ts`).
   The live bridge therefore cannot express a blocked aisle or charger fault to the planner.
2. **Harbor catalog is hardcoded in shared integration logic**: `DECISION_CATALOG` (uav-seeker-1,
   harbor-diagnostics/marine, 22 kt, USD policy constants) lives inside `decision-snapshots.ts`; duplicated
   in `demo-routes.ts` (asserted equal by drift test); `physical-view.ts` knows only the fixed catalog —
   any other asset fail-closes `ASSET_DOMAIN_UNAVAILABLE`. No per-mission asset-domain registry exists.
3. **No real model adapter**: config exposes NO model provider variables; `.env.example` has none; no
   founder-provisioned model access is present in this environment. Only the fixture adapter exists.
4. **Mandate seeding is harbor-specific**: `registerDemoAuthorityRefreshRoute` hardcodes
   `harbor-diagnostics`/`harbor-marine`/`harbor inspection` beneficiaries and purposes.
5. **No mission-specification object**: deadline/economics/policy numbers are inline constants in
   `evaluateMission` and `decisionFor`; supplier offers are module constants.
6. **No industry switch surface**: Agent B's Decision Room has no typed way to discover a mission's domain,
   objective, assets or offers; no `caseId` lineage beyond `evaluationId`.

## Implications for C1–C5 (design deltas, not rewrites)

- C1 introduces `MissionSpecification` v1 + a registry, journaled once per mission (idempotent event key)
  so the spec is DURABLE and replay-linked; harbor values become the FIRST registration of the general
  contract, and `DECISION_CATALOG`/demo constants derive from it (existing tests keep passing).
- C2 completes Agent D's accepted ground-safety proposal in the planner (new reasons + optional `domain`),
  wires the bridge to consume `aisle_access`/`charger_status`, adds warehouse supplier offers with
  per-asset `requiresAssetId`, and adds a warehouse journey through the SAME snapshot/proposal machinery.
- C3 implements the real HTTP `MissionModelAdapter` behind config; with no provider access available it
  degrades visibly (`MODEL_UNAVAILABLE`) — reported honestly; a live call is demonstrated only if access exists.
- C4 runs counterfactuals over the pure planner for BOTH industries with cheap-first / deadline-first /
  static-safe baselines, publishing wins/ties/losses.
- C5 exposes the spec read API + `caseId`/causality labels for B/A/D.
