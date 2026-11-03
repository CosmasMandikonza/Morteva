# ADR 0004 — B-led hybrid design system (semantic tokens, dark flagship)

- **Status:** PROVISIONAL — accepted as the engineering contract for production design work; **final production approval remains open in issue #10** until the founder reviews this ADR, the final reference selection, `design/tokens.json` and the production-quality requirements.
- **Date:** 2026-11-03
- **Deciders:** founder (creative direction, provisional), design/engineering agent (token architecture and evidence)
- **Issue:** #29 (delivery), #10 (review gate) · **Implements:** `research/mtv-08/b-led-production-integration-handoff.md` Phase 1
- **ADR numbering:** 0004 is reserved for the B-led design system per founder instruction. The Airwallex adapter ADR (PR #30) renumbers to **0005** — coordination note posted on that PR.

## Context

PR #25 merged two fully rendered design candidates as an isolated design-lab deliverable: **A "Harbour Watch"** (light institutional, IBM Plex, disciplined ledger density) and **B "Night Sortie"** (dark cinematic, Space Grotesk/Inter/Geist Mono, instrument-amber authority accent). On 2026-11-03 the founder selected a **B-led hybrid** as the preferred creative direction — Night Sortie's operational/cinematic identity with Harbour Watch's financial hierarchy and information density — explicitly as a direction, **not** a declaration that the current UI is finished or meets the final product-quality bar.

## Decision

1. **One design system, two densities — not two themes.** A single semantic-token contract (`design/tokens.json`) drives both modes. Dark is the flagship presentation. Light mode shares the same components, information architecture, behavior and financial semantics; only mode-scoped token values differ.
2. **Traceability over invention.** Every token value is carried over verbatim from the merged lab (`apps/web/src/design-lab/{a,b}`) wherever one exists. The handful of new values (light-mode amber text, light glass overlay) are marked `origin:new` and flagged for visual validation in Phase 2. `scripts/check-design-tokens.mjs` enforces this traceability mechanically — a token without a lab source or an explicit `origin:new` marker fails CI.
3. **Identity = B; discipline = A.** Surface/ink ramps, the amber authority accent and the type stack come from candidate B. Candidate A contributes the light-mode ramp, its AA-tuned status text values (darkened in the lab's round-1 critique), the harbour-blue interactive/focus tone for light mode, and the layout patterns (ledger tables, burn bars, clock strip) that ship as component contracts, not color.

## The contract (summary — normative detail lives in `design/tokens.json`)

### Status semantics (financial honesty is a design rule)

The ten-state ladder (`PROPOSED → RESERVED → APPROVED → SUBMITTING → SUBMITTED → STATUS_UNKNOWN → SETTLED → RECONCILED` + `REJECTED/EXPIRED`) maps to five tones: neutral (ink), info (blue), transit (amber), hold, verified (green), danger. **Never color-only** — every state renders glyph + text + tone. **Green is reserved exclusively for provider-verified terminal states** (`SETTLED`, `RECONCILED`); `SUBMITTED` is amber transit and can never read as settled. The checker asserts the verified tone is used by exactly those two states.

### Typography and financial numerals

Space Grotesk (display) · Inter (UI/body) · Geist Mono — all SIL OFL 1.1, self-hosted via `@fontsource-variable/*` npm packages only (verified against `apps/web/package.json` by the checker). **Every financial numeral, currency amount, ID and timestamp renders in Geist Mono** (monospaced digits = guaranteed tabular alignment); any numeric run in Inter carries `font-variant-numeric: tabular-nums`. Currency codes are always explicit (`USD 2,150.00`) — never bare symbols. IBM Plex families remain lab-only reference dependencies.

### Focus, keyboard, motion

Focus ring: 3px solid, 2px offset, 4px corner — identical geometry in both modes; color is the mode's `interactive.text` (amber `#e8b23e` dark / harbour blue `#1d5a8a` light), ≥3:1 against every surface (computed 9.52–10.24 dark, 6.63–7.29 light). Motion: 150/180/420ms with `cubic-bezier(0.22, 0.61, 0.36, 1)`; under `prefers-reduced-motion: reduce` every duration collapses to 0.01ms and staggers to zero (the lab's proven gate).

### Light-mode rules

Surfaces invert to A's ramp (page `#f4f4f5`, card white); status text adopts A's AA-tuned darkened values; `accent.text` and the chart primary series move to `#8a6118` (decorative amber fills `#e8b23e` stay — identity — but never carry text or required affordances in light mode, where they are 1.94:1). Interactive text/focus follow the proven blue.

## Computed accessibility evidence

`node scripts/check-design-tokens.mjs` (zero-dependency, wired into CI) computes WCAG 2.x relative-luminance contrast for **48 declared pairs × both modes** (text ≥4.5:1; focus/chart UI ≥3:1; rgba chip backgrounds composited over the card surface). Current result — **48/48 PASS: 22 pairs at AAA (≥7:1), 26 at AA/UI minimums**; darkest margins are the light verified chip (4.73) and dark danger chip (5.65), both AA. Full table is emitted by the script and reproduced in the PR.

## Consequences

- Phase 2 (production shell restyle, four surfaces ported from the lab) builds **only** on these tokens — no ad-hoc hex values in production code; the checker is the regression gate when tokens evolve.
- This ADR does **not** approve final production design: the founder reviews it in #10 together with the final reference selection and production-quality requirements before theme code lands in `apps/web`.
- No design-lab rebuild, no production restyle, no financial-backend changes, no new 3D in this ADR (boundaries per the integration handoff).
- Values marked `origin:new` (light glass overlay, light amber text) must be visually validated in Phase 2 before being considered final.
