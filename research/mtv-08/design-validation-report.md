# Design validation report — MTV-08 visual candidates (UNAPPROVED)

**What this is:** the evidence package for the founder's visual-direction decision (issue #10, Phase "final design validation"). Two real, interactive, browser-rendered candidates were built on `design/mtv-08-visual-validation`, exercised by Playwright, screenshot-captured at seven viewport configurations, critically reviewed over three fix rounds, and re-verified. After the CTO's code corrections on this branch, every capture was regenerated from the corrected source and independently re-inspected, and two further defects were found and fixed (§Recapture verification). **Neither direction is approved by this document.** The founder must choose.

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

- **Playwright `e2e/design-lab.spec.ts` (25 tests, both candidates):** SUBMITTED renders `chip--transit` and never `chip--verified`; settle only after an explicit verify step; STATUS_UNKNOWN retains commitment and resolves only by original ID; provider-offline shows last-snapshot language + OFFLINE chip; 3D-unavailable renders the 2D fallback with finances intact; reduced-motion toggle adds `is-reduced` (all animations ≤0.01 ms via CSS gates); viewport pins are keyboard-operable (focus + Enter reframes the scene); **320 px and 390 px: `document.scrollWidth ≤ viewport+1` on both candidates** (money never requires sideways scroll — the missions table collapses to stacked labeled cards on small screens); every displayed monetary amount must be finite (no NaN/Infinity/undefined — regression guard for the stale-capture defect the CTO caught); no dead recovery/onboarding controls (the offline state offers a working "Restore synthetic snapshot", the empty state honestly defers creation to MTV-10); exceptions header count must equal the rendered rows and zero out together under the empty override.
- **Focus visibility:** uniform 3px offset outline in both directions (`.lab :focus-visible`), A focus color `#1d5a8a`, B `#e8b23e` (both ≥3:1 on their surfaces).
- **Contrast:** A's text ramp is zinc-900/700/600 on white/zinc-100 (7:1+ for body; the amber transit chip text was darkened to `#7d4f03` on `#fdf1dc` after round-1 critique flagged the original); B's ramp `#f4f4f5`/`#a9a9b2`/`#8e8e96` on `#141417` (body ≥7:1; key metas raised from ink-3 to ink-2 after critique). Green (`chip--verified`) is reserved exclusively for provider-verified terminal states in both — an explicit design rule asserted in tests.
- **Non-color status coding:** every lifecycle state ships glyph + text + tone (verified in captures `a/b-authority-submitted|unknown|settled`).
- **Zoom 200 % — two distinct proofs:** (1) _DPR-equivalent_: 720 CSS px @2× deviceScaleFactor context (`*-zoom200-720.png`); (2) _genuine browser zoom_: the live 1440×900 page is zoomed after load via CDP device-metrics — the CSS layout viewport halves to 720 px while `devicePixelRatio` doubles to 2, i.e. real Ctrl+Zoom reflow semantics — asserting `clientWidth=720`, `devicePixelRatio=2`, `scrollWidth ≤ 721` and visible money for both candidates × {Treasury, Decision} (`*-zoom200-real-720.png`). A DOM probe at the zoomed state found **zero elements painting past the 720 px viewport** in either candidate (A's widest element, the missions table, ends at 692 px).
- **Honest screenshots:** 39 committed PNGs under `docs/assets/design-lab/` covering both candidates × {Treasury, Decision} × {320, 390, 768, 1024, 1440×900, 1920} + Authority/Replay + submitted/unknown/offline/stale/WebGL-fallback states + DPR-zoom + genuine-zoom pair + founder-compare console.

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

## Recapture verification (post-CTO corrections — 2026-11-03)

The CTO corrected the branch code (financial-display gating so loading/empty/offline never produce non-finite figures, functional synthetic-snapshot recovery replacing dead refresh controls, truthful provider wording, formatting), then every committed capture was regenerated from the corrected source with `CAPTURE=1` and independently inspected (AI-vision read-back of the PNGs plus DOM measurement). Two defects survived into that pass and were fixed on top:

1. **Hardcoded exceptions counters.** Both candidates displayed "2 require attention" / "2 open" above three rendered rows (and above "No open exceptions." under the empty override). Counters now derive from the same fixture as the list, read "none open" in the empty state, and a Playwright gate (`exceptions header count matches the rendered rows in both candidates`) pins counter == rows and joint zeroing. Fresh captures show `3 require attention` / `3 open` over exactly three rows.
2. **Zoom evidence was DPR-equivalent only.** A genuine browser-zoom gate was added (CDP device-metrics reflow of the live 1440 page, as detailed under §Accessibility evidence), with committed evidence `a/b-treasury-zoom200-real-720.png` distinct from the retained DPR-equivalent pair.

Read-back of the fresh captures confirmed, with exact strings: Night Sortie account decomposition `99,250.00 + 28,600.00 + 6,400.00 + 50,000.00` under total `USD 184,250.00` with hero `USD 99,250.00`; no `NaN` / `Infinity` / `undefined` in any capture; provider-offline hero reads `USD —` with "synthetic fixture, never verified provider funds" (no verification claims anywhere); SUBMITTED renders amber "in flight — NOT settled"; STATUS_UNKNOWN keeps "Funds remain committed … resolved by original request ID"; replay viewports carry the "SYNTHETIC STAGING VIEWPORT" label; the founder-compare console renders both candidates side by side; 320/390 px captures show stacked mission cards with no edge-crossing text. Local gates at the evidence head: lint ✓, typecheck ✓ (all workspaces), unit 130/130 (api 22, domain 37, ledger 66, providers 5), design-lab Playwright 25/25, capture spec 5/5 (regenerated all 39 PNGs), docs/secrets scans clean. Evidence head: `fd206946bb022d0e31f4256118315622d46a79f4` (captures + gates; parent of the docs-only head); final branch head and CI status: see the PR #25 description.

## Known limitations

- The 3D viewport is an original 2D SVG staging study (labeled as such in-app); no WebGL claim is made. Licensed-asset integration, camera rails and synchronized production 3D are MTV-09 (#11), building on the verified asset shortlist.
- All data is deterministic synthetic fixture data; no provider is called; the operation flow is a UI state machine, not the real ledger (MTV-02 owns that, untouched).
- Onboarding (first-run mandate wizard) is specified in screen-and-flow-specifications.md but not rendered in the lab — deliberate scope cut; it is a production-implementation item (#12).
- Contrast claims are per-token computed values plus visual verification; a full axe-core pass lands in the production issues where the final tokens exist.
