# MTV-08 — Premium product design research and UX architecture (UNAPPROVED PACKAGE)

**Issue:** [#10 (MTV-08)](https://github.com/CosmasMandikonza/Morteva/issues/10) — Reference board, component licensing, and founder-approved design system
**Branch:** `research/mtv-08-design-references` (base `main` @ `06afbca483a5e92f241902e865c10e0e84e29dc8`)
**Compiled:** 2026-11-02/03, from live inspection of every cited source (method below)
**Status:** ⚠️ **Everything in this package is a RESEARCH PROPOSAL. No design direction, font, palette, 3D asset, or token in this package is approved.** The founder must pick; see [founder-decision-brief.md](founder-decision-brief.md). No theme code was written in `apps/web` — that is gated on the founder's choice (per issue #10 CTO handoff).

## Why this exists

docs/03 and issue #10 forbid invented palettes, default fonts, and generic "futuristic SaaS" styling. This package is the evidence base an implementer needs to build the four MOTERVA screens (Mission Treasury, Decision Room, Authority & Execution, Evidence Replay) **without inventing colors, fonts, behaviors, 3D assets, or financial semantics**.

## Package contents

| File                                                                           | What it delivers                                                                                                                                  | Issue #10 deliverable                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [research-record.md](research-record.md)                                       | Exactly what was researched, when, how; source-verification method; licensing uncertainties                                                       | "actual research performed", "licensing uncertainties" |
| [reference-and-component-ledger.md](reference-and-component-ledger.md)         | Verified component ledger for Cult UI, React Bits, Skiper UI + Awwwards art-direction study; licenses, deps, a11y findings, rejected alternatives | component/experience ledger + rejected alternatives    |
| [screen-and-flow-specifications.md](screen-and-flow-specifications.md)         | Complete screen specs, operator journeys, every honest state (loading/empty/denied/pending/unknown/stale/WebGL-lost), responsive + a11y budgets   | operator journey map + viewport budgets                |
| [visual-direction-proposals.md](visual-direction-proposals.md)                 | **Two coherent, competing visual directions** (typography, color semantics, grid, motion, 3D↔finance composition) — both explicitly UNAPPROVED    | two typography/color/motion directions                 |
| [3d-asset-and-camera-research.md](3d-asset-and-camera-research.md)             | Licensed 3D asset shortlist (offshore drone + subsea ROV), camera storyboard strategy, performance/failure techniques                             | 3D reconnaissance (prototype itself is #11)            |
| [quality-rubric-and-demo-storyboard.md](quality-rubric-and-demo-storyboard.md) | Reproducible design-evaluation scorecard, visual acceptance rubric, 5-minute demo storyboard                                                      | design evaluation scorecard                            |
| [founder-decision-brief.md](founder-decision-brief.md)                         | One-page decision brief: recommended direction + 4 bounded founder choices                                                                        | founder decision brief                                 |

## Hard rules this package obeys (from AGENTS.md / docs/03 / issue #10)

1. **No fabricated components.** Every component named in the ledger was observed live on its documentation page on 2026-11-02/03. Names not observed are not listed.
2. **No redistributed screenshots.** Reference-site screenshots (Cult UI, React Bits, Skiper UI, Awwwards, Sketchfab) are the copyright of their publishers. This repo links sources instead of committing their images. The founder review happens against the live pages (each library serves live interactive previews, which are better evidence than static images). Awwwards sites are art-direction study only — no cloned layouts, logos, or assets.
3. **No financial-status lying.** Both visual directions encode the same status semantics ladder (PROPOSED → RESERVED → … → SETTLED) with color + icon + text so SUBMITTED can never read as SETTLED (docs/03 "Non-negotiable").
4. **No touching MTV-02.** This branch adds only files under `research/mtv-08/` plus a dated, clearly-marked section in `docs/STATE.md`. No financial-domain files, provider ports, SQLite, or shared contracts were modified. No `apps/web` theme code.
5. **Unresolved is stated, not papered over.** "Webby Design" remains unresolved pending an exact URL from the founder (docs/03 line 8). Known unknowns are listed in each file.

## How the founder should use this

Read [founder-decision-brief.md](founder-decision-brief.md) first (~5 minutes). It names exactly four decisions. After the choices are made, MTV-09 (#11, 3D spike), #12 (Mission Treasury), #13 (Decision Room) and #14 (state-linked 3D) can consume the ledger and the chosen direction without further design archaeology.
