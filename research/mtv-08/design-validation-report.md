# Design validation report — MTV-08 visual candidates (UNAPPROVED)

**What this is:** the evidence package for the founder's visual-direction decision (issue #10, Phase "final design validation"). Two real, interactive, browser-rendered candidates were built on `design/mtv-08-visual-validation`, exercised by Playwright, screenshot-captured at seven viewport configurations, critically reviewed over three fix rounds, and re-verified. **Neither direction is approved by this document.** The founder must choose.

## How to open the candidates (exact instructions)

```bash
npm ci
# Build the web app WITH the design-lab entry (dev-only gate, see §Production isolation):
VITE_DESIGN_LAB=1 npm run build -w @moterva/web        # (Windows cmd: set "VITE_DESIGN_LAB=1" && npm run build -w @moterva/web)
npm run preview -w @moterva/web                          # → http://127.0.0.1:4173
```

- **Founder console (start here):** `http://127.0.0.1:4173/design-lab.html` — switch A / B / side-by-side compare, constrain to 320/390/768/1024/1440/full, flip screens.
- Direct links: `/design-lab.html?c=a` · `/design-lab.html?c=b` (+`&screen=treasury|decision|authority|replay`).
- In each candidate: navigate the four screens, compare the four plans (selecting P2 hands off to Authority), run the full approval flow (Reserve → Approve → Submit → **Verify** → Settle), fire the adversarial simulates (lost response / changed terms / mandate expiry), open **State laboratory** for loading/empty/offline/stale/AI-down/3D-unavailable, and toggle **reduced motion**.

## Production isolation (why this cannot leak into the product)

`apps/web/vite.config.ts` includes the `design-lab.html` rollup input **only** when `VITE_DESIGN_LAB=1`. Verified locally: default `npm run build` output contains **only** `index.html` (+ unchanged `main-*.js/css` hashes) — the shipped app bundle is byte-identical to `main`'s; the lab's 76 kB JS + 75 kB CSS + fonts exist solely in opt-in builds. `apps/web/src/App.tsx` and `styles.css` are untouched. The e2e design spec self-skips on default builds (verified both ways).

## Component → source mapping and license/provenance report

**Nothing was copied.** All lab code is original. Per the CTO gate ("do not copy React Bits source to this public repository…"), the Commons-Clause library is honored by re-implementing interaction patterns, not code. Skiper UI: zero usage (rejected in the ledger). Awwwards: art-direction calibration only.

| Lab element                                                               | Pattern reference (verified live in research ledger)                                                                                                           | Reference license    | Production adoption path (post-approval)         |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------ |
| Status chips (glyph+text+tone, tabular counts, reduced-motion shortening) | Cult UI Halo Badge                                                                                                                                             | MIT                  | copy-in via shadcn CLI, or keep original         |
| Screen tabs (sliding indicator) / segmented framing control               | Cult UI Halo Tabs / Halo Segmented                                                                                                                             | MIT                  | copy-in (Base UI semantics)                      |
| Mandate wizard surfaces (screen contract only)                            | Cult UI Onboarding                                                                                                                                             | MIT                  | copy-in                                          |
| Plans as expandable/selectable cards, money visible collapsed             | Cult UI Expandable Card                                                                                                                                        | MIT                  | copy-in                                          |
| Ops feed / replay rail (spring-in rows, arrow keys)                       | React Bits Animated List **behavior**                                                                                                                          | MIT + Commons Clause | **re-implement** (as here) or adopt with counsel |
| Odometer counter accent                                                   | React Bits Counter behavior                                                                                                                                    | MIT + Commons Clause | re-implement                                     |
| Charts                                                                    | none — custom SVG (incl. threshold + end annotation)                                                                                                           | original             | keep original                                    |
| Operational viewport                                                      | **original SVG staging** — no third-party artwork, no DJI marks; labeled SYNTHETIC STAGING; production WebGL = MTV-09                                          | original             | replaced by #11                                  |
| Fonts                                                                     | IBM Plex Sans/Condensed/Mono; Space Grotesk, Inter, Geist Mono — all SIL OFL 1.1, `@fontsource` self-hosted, tabular figures binary-verified (research-record) | OFL                  | npm deps only; no binaries committed             |

## Measured performance (design-lab build, local Windows, Chromium, warm cache)

| Screen       | goto→load | DOMContentLoaded | DOM nodes |
| ------------ | --------- | ---------------- | --------- |
| A · Treasury | 69 ms     | 64 ms            | 266       |
| A · Decision | 49 ms     | 44 ms            | 312       |
| B · Treasury | 49 ms     | 44 ms            | 173       |
| B · Decision | 48 ms     | 45 ms            | 300       |

Bundle (lab entry only): `lab-*.js` 76.5 kB (19.6 kB gzip) + `client` React runtime 223.8 kB (69.5 gzip, shared) + `lab-*.css` 74.4 kB (16.3 gzip, includes all six OFL families' font-face rules). No WebGL, no animation libraries — all motion is CSS/SVG.

## Accessibility & responsive evidence (tested, not asserted)

- **Playwright `e2e/design-lab.spec.ts` (19 tests, both candidates):** SUBMITTED renders `chip--transit` and never `chip--verified`; settle only after an explicit verify step; STATUS_UNKNOWN retains commitment and resolves only by original ID; provider-offline shows last-snapshot language + OFFLINE chip; 3D-unavailable renders the 2D fallback with finances intact; reduced-motion toggle adds `is-reduced` (all animations ≤0.01 ms via CSS gates); viewport pins are keyboard-operable (focus + Enter reframes the scene); **320 px and 390 px: `document.scrollWidth ≤ viewport+1` on both candidates** (money never requires sideways scroll — the missions table collapses to stacked labeled cards on small screens).
- **Focus visibility:** uniform 3px offset outline in both directions (`.lab :focus-visible`), A focus color `#1d5a8a`, B `#e8b23e` (both ≥3:1 on their surfaces).
- **Contrast:** A's text ramp is zinc-900/700/600 on white/zinc-100 (7:1+ for body; the amber transit chip text was darkened to `#7d4f03` on `#fdf1dc` after round-1 critique flagged the original); B's ramp `#f4f4f5`/`#a9a9b2`/`#8e8e96` on `#141417` (body ≥7:1; key metas raised from ink-3 to ink-2 after critique). Green (`chip--verified`) is reserved exclusively for provider-verified terminal states in both — an explicit design rule asserted in tests.
- **Non-color status coding:** every lifecycle state ships glyph + text + tone (verified in captures `a/b-authority-submitted|unknown|settled`).
- **Zoom 200 %:** captured at 720 CSS px @2× DPR (zoom-equivalent) for both candidates — no clipped figures or approval terms (`*-zoom200-720.png`).
- **Honest screenshots:** 37 committed PNGs under `docs/assets/design-lab/` covering both candidates × {Treasury, Decision} × {320, 390, 768, 1024, 1440×900, 1920} + Authority/Replay + submitted/unknown/offline/stale/WebGL-fallback states + founder-compare console.

## Critical comparison (Phase-8 critique, evidence-based)

Three rounds of independent critique (AI-judged renders + my own inspection) drove real fixes: round 1 — sparkline clipping and threshold line, amber contrast, two-line nav noise, decorative orbit in B (→ replaced with the semantic fund-decomposition bar), generic-viewport risk (→ sensor-feed framing: corner brackets, SIM FEED stamp, event line in HUD, labeled evidence pin); round 2 — envelope chart plotting the wrong series (→ mission-scoped 4.25k-vs-12k), clock-strip anchoring, meter visibility (→ labeled bar), label contrast; round 3 — meter label robustness, mobile table stacking, 320 px overflow elimination.

| Criterion                                | A · Harbour Watch                                                                          | B · Night Sortie                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Immediate buyer credibility              | **9/10** — reads like auditable industrial finance                                         | 8/10 — credible but theatrical; needs disciplined execution                        |
| Distinctiveness vs generic AI dashboards | 7.5/10 — instrument character lives in details (condensed caps, mono figures, clock strip) | **9/10** — night-ops identity is unmistakable without neon clichés                 |
| Financial clarity/readability            | **9/10** — dense ledger tables, burn bars, right-aligned tabular money                     | 8.5/10 — hero numbers excellent; card lists less scannable than tables at a glance |
| Operations↔finance relationship          | 8/10 — viewport as framed instrument beside panels                                         | **9/10** — scene as stage, inspector docked in-frame; strongest narrative          |
| Interaction coherence                    | shared state machine — identical honest behavior in both                                   | shared                                                                             |
| Accessibility effort                     | **lower** (light theme margin)                                                             | medium (enforced and currently passing)                                            |
| Mobile quality                           | **9/10** (stacked table cards)                                                             | 8.5/10 (cards collapse well; hero stack tight)                                     |
| Perf/complexity                          | **lowest** (flat surfaces, no glass)                                                       | low-medium (glass dock only; auto-downgrade path defined)                          |
| 5-minute demo impact                     | 7.5/10                                                                                     | **9.5/10**                                                                         |

**Weaknesses on record (both):** A — quieter demo presence; hero hierarchy less memorable; risks "enterprise plain" if the production build drops the clock strip/burn-bar details that carry its character. B — more motion surface to gate; dark-mode contrast must be policed per-token (currently passing); glass dock costs `backdrop-filter` on low-end GPUs (defined fallback: solid raised surface); amber discipline must survive feature pressure. Both — SVG staging is not 3D (by design, MTV-09 next); synthetic scenario is deliberately static (no live data); the onboarding wizard is specified but not rendered (it belongs to the first production issue).

## Recommendation (UNAPPROVED — founder decides)

**B-led hybrid**: Night Sortie tokens and motion on Decision Room + 3D flagship and the approval console; Harbour Watch's information-density discipline (tabular ledger rows, clock strip, burn bars — already implemented in candidate A and portable as patterns) on Mission Treasury and Evidence Replay. One token system, two densities — not two themes. Rationale: B wins the criteria that decide a hackathon demo and a first sales call (distinctiveness, ops↔finance narrative); A wins the criteria that decide trust over a 10-year product (ledger density, cheapest accessibility); the hybrid keeps both without forking the system. If the founder prefers one pure direction, **A is the lower-risk product bet, B the higher-impact demo bet** — the captures in `docs/assets/design-lab/` are the decision material.

## Known limitations

- The 3D viewport is an original 2D SVG staging study (labeled as such in-app); no WebGL claim is made. Licensed-asset integration, camera rails and synchronized production 3D are MTV-09 (#11), building on the verified asset shortlist.
- All data is deterministic synthetic fixture data; no provider is called; the operation flow is a UI state machine, not the real ledger (MTV-02 owns that, untouched).
- Onboarding (first-run mandate wizard) is specified in screen-and-flow-specifications.md but not rendered in the lab — deliberate scope cut; it is a production-implementation item (#12).
- Contrast claims are per-token computed values plus visual verification; a full axe-core pass lands in the production issues where the final tokens exist.
