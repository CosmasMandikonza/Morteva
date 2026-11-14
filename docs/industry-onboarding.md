# Onboarding a NEW physical industry (without cloning the money engine)

**Status:** contract documentation (general-mission work, Nov 10 2026) — SIMULATED_OPERATION / POLICY-ONLY throughout. Nothing here grants financial authority.

This repository runs TWO industries — harbor offshore inspection (maritime UAV) and warehouse AMR
inventory (ground robots) — through ONE planner, ONE ledger, ONE approval/mandate machinery and ONE
provider interface. This document is the proof-by-construction guide: what a third industry (e.g.
solar-farm drone inspection, subsea cable survey, hospital logistics robots) requires, and what it
must NEVER require.

## The one thing you write: a mission-spec registration

Everything industry-specific lives in a `MissionSpecification` v1 registration
(`apps/api/src/integration/mission-spec.ts`), journaled ONCE per (mission, specId) via
`registerMissionSpec` — immutable history; evolution = a NEW specId. A registration declares:

1. **Identity/objective** — org, mission, human-readable objective.
2. **Assets with physical DOMAIN kinds** (`aerial` | `ground` | `surface`) — the ONLY domain input
   anywhere in the pipeline.
3. **Trusted event sources** — sourceId, sourceType (the closed ingest enum), which assets each may
   report for, `trustedForRecovery`, provenance.
4. **Domain safety policy** — version + clearance-authority label (ALWAYS
   `deterministic-domain-policy`); a modeled wind limit iff an aerial asset exists (structurally
   FORBIDDEN otherwise); the ground-interrupting conditions the domain admits.
5. **Economics** — currency, mission value, failure cost, protected reserve, deadline offset (all
   explicit integer assumptions).
6. **Supplier/service offers** — incumbent, alternatives, optional diagnostics: beneficiary, purpose,
   costs/fees, lead/duration, success-probability assumption, availability, quote validity, and the
   asset whose clearance each offer requires.
7. **Financial mandate SHAPE** — currency + permitted beneficiaries/purposes. The ledger mandate
   itself remains the only authority; this is the configuration the demo authority-refresh issues.

Then write the industry's observation vocabulary entries if new sensor kinds are needed
(`apps/api/src/mission-events/src/vocabulary.ts` — a closed typed enum; data, never code paths) and,
if the domain has NEW interrupting physical conditions, extend the ground/aerial precedence in FOUR
places that must stay verdict-identical (the matched-verdict law): the bridge
(`physical-to-planner.ts`), the physical-view engine (`physical-view.ts::constraintFor`), the viewer
(`apps/web/src/mission-viewer/scene-state.ts::constraintFromPrefix`) and the proposal module
(`ground-safety-proposal.ts`). Each extension lands with matched-verdict tests.

## What you never write

- **No money-engine clone.** Candidate generation, scoring, expected-value math, escalation rules,
  information-value gating, mandate/reservation/approval checks, plan proposal and the journal
  digest machinery are domain-free. The counterfactual suite
  (`apps/api/test/integration/counterfactual-matrix.test.ts`, PROOF 5) proves the SAME contracts
  bind both industries against the real ledger.
- **No new clearance authority.** Clearance is deterministic code over ADMITTED, signed,
  planning-valid journal events. A model can never declare it; a restored network connection can
  never imply it; an operator cannot type it.
- **No per-industry routes in production.** Industry surfaces are DEMO_AUTH-scoped step routes
  (harbor: `demo-routes.ts`; warehouse: `warehouse-demo-routes.ts`) that journal signed synthetic
  events and read decisions through the shared spec-driven view. Production registration is
  unchanged — coordinate with Agent E before touching route composition.

## The pipeline every industry shares

```
registered spec (journaled, digest-verified)
  → MissionEventIngestService (typed signed events, append-only journal)
  → physicalTimelineToPlannerSafety (fresh SYNTHETIC events → typed asset-safety evidence)
  → reviewEvidence → generateCandidates (spec offers) → evaluate (pure EV policy)
  → decision snapshot (journaled, intent-keyed, spec lineage + caseId + causality labels)
  → propose-plan (immutable ledger plan) → approvals → reservation (ledger authority)
```

Optional model assistance (C3) attaches BEFORE the deterministic engine: an untrusted incident
report → strict-validated typed evidence/candidates → journaled with full provenance → validated
like any other input. Model text can never set mandates, approve, declare safety, or reach money.

## Checklist for a new industry PR

1. `mission-catalogs.ts`: the registration factory (values + sources + offers + mandate shape).
2. Vocabulary entries for any new typed observations (with unit + value validation).
3. If new ground-style interrupts: the four matched-verdict sites + tests.
4. A DEMO_AUTH step route mirroring `warehouse-demo-routes.ts` (sign server-side; browser sends
   only step names).
5. Counterfactual scenarios for the new domain in the C4 matrix (wins/ties/losses published).
6. STATE.md section; coordination comments (A: planner changes if any; B: Decision Room surfaces
   read `/api/missions/:id/mission-spec` for the industry switch).
