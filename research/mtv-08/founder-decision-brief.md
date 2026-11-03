# Founder decision brief — MTV-08

**You have exactly four decisions.** Everything else (component choices, screen specs, states, responsive/a11y budgets, camera strategy) is evidence-backed engineering default and needs no sign-off. Research details: [package README](README.md). ~5-minute read.

---

## What was delivered (evidence, not taste)

- **Verified component ledger** from live inspection of the exact four sources you named: Cult UI (MIT — structural base: Halo tabs/segmented/badges/fields, Onboarding, Side Panel, Analytics Chart…), React Bits (MIT+Commons Clause — motion layer: Animated List, Counter, Stepper, Model Viewer…), Skiper UI (rejected as a system: attribution-required free tier, $129 pro, widespread Nike/Apple/Vercel/Uniswap-style recreations — provenance risk), Awwwards (art-direction study only; VELTO/Contiant/Sunbit references recorded). Nothing invented; every row carries its URL.
- **Two complete visual directions** (both UNAPPROVED): **A "Harbour Watch"** (light institutional instrument; IBM Plex family, single harbour-blue accent) and **B "Night Sortie"** (dark cinematic console; Space Grotesk + Inter + Geist Mono, instrument-amber authority accent). All fonts license-verified (OFL) with binary-scanned tabular figures; all token contrast targets stated with math.
- **Complete screen + flow specs** for Mission Treasury, Decision Room, Authority & Execution, Evidence Replay — including every honest state (loading/empty/denied/pending/unknown/stale/offline/WebGL-lost), 320→1920 + 200% zoom budgets, keyboard/reduced-motion/contrast rules, and the status-semantics ladder where SUBMITTED can never look settled.
- **3D reconnaissance** (no scene built — that's #11): verified CC-BY shortlists — drone: real **DJI Matrice 30T** (200k tris) / Matrice 300 RTK (904k, needs compression); ROV: **MBARI's official Doc Ricketts** (42k tris, animated) / ROV Hercules. CC0 Poly Haven harbour HDRI for lighting. Camera storyboard, clamping, context-loss and low-end strategies all sourced from three.js/R3F/drei docs.
- **Reproducible quality rubric + 5-minute demo storyboard** for #12–#14 and your review session.

## Decision 1 — Visual direction

| Option                                       | The bet                                                                               | Cost/risk                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **A · Harbour Watch**                        | Buyer-credibility per hour; light institutional; safest WCAG                          | Quieter demo; "enterprise" risk if hierarchy is lazy             |
| **B · Night Sortie**                         | Memorable command-deck story; strongest demo video                                    | Contrast/perf/motion discipline required (mitigations verified)  |
| **B-led hybrid (engineers' recommendation)** | B tokens/motion on Decision Room + 3D flagship; A's calm density on Treasury & Replay | Two token sets to maintain (shared skeleton, tokens only differ) |

Pick one: `A` / `B` / `B-led hybrid`. After your choice we record the design ADR + `design/tokens.json` (docs/03 artifacts), and only then does any theme code land in `apps/web`.

## Decision 2 — 3D primary vertical (first asset built in #11)

| Option                                            | Assets ready                                                     | Story fit                                       |
| ------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| **Offshore inspection drone** (recommended first) | DJI Matrice 30T (primary), 300 RTK (cinematic), Tello (fallback) | Journey A end-to-end; cheaper scene (sky/ocean) |
| **Subsea ROV**                                    | MBARI Doc Ricketts (primary), Hercules, Weaver                   | Maps 1:1 to Metal "paid diagnostics" beat       |

The other asset direction stays licensed and ready as the second typed adapter (docs/08 V2-14). Pick: `drone` / `rov`.

## Decision 3 — Skiper UI disposition

Recommended: **reject entirely** (attribution mechanics undocumented + brand-imitation provenance + no financial-console primitives). Alternative: allow at most ONE audited free component with visible attribution (none currently beats a Cult UI equivalent). Pick: `reject` / `allow-one-audited`.

## Decision 4 — Paid-tier stance (default: no purchases)

React Bits Pro / Cult UI "AI SDK Agents" blocks / Skiper Pro / CGTrader assets are all paid. Default: **no purchases** — the MIT/CC-BY shortlist already covers every need. Override only if you want a specific paid block. Pick: `no-purchases` / name the purchase.

## Open item needing your input (not a decision, an input)

**"Webby Design"** was never resolved — the original PDF gave no URL (docs/03 line 8). If you want it audited, post the exact URL in issue #10; otherwise it stays out of scope.

---

### Why you can trust this package

Every external claim was observed live on its source page (or via the platform's official API for Sketchfab, and actual font binaries for tabular figures) on 2026-11-02/03; the method and all uncertainties are recorded in [research-record.md](research-record.md). No screenshots of copyrighted sites were committed (source links instead). No financial-domain files, provider ports, or shared contracts were touched, and nothing in `apps/web` was themed — per your CTO handoff boundaries. Nothing here is "approved" until you say so.
