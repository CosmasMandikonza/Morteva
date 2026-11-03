# Reference-led UI system: no invented brand decisions

## User-provided sources
1. https://www.cult-ui.com/docs/components — candidate application components, forms, panels, navigation, badges.
2. https://www.reactbits.dev/get-started/index — selected motion and interactions, with accessibility fallback.
3. https://www.skiper-ui.com/components — secondary animation/component candidates after source/license audit.
4. https://www.awwwards.com/ — editorial art direction and interaction references, **not freely reusable assets**.
User also mentioned 'Webby Design'; exact URL was not provided in the supplied PDF. Do not assume a similarly named library is authorized.

## Procedure
1. Capture 2 real reference screenshots per primary screen, and one counterexample of what NOT to copy. Preserve source URL, source date, copyright/licensing, exact relevant interaction, screenshot path and owner review.
2. Select ONE coherent design language; do not remix unrelated typography and colors from many templates.
3. Produce token candidates only after reference comparison: typefaces/licensing, text sizes, tabular-number face, surface and semantic colors, spacing, radii, shadows, motion easing and breakpoints. Keep all candidates marked *unapproved* until chosen.
4. For each imported component, log exact component name, canonical source URL, dependencies, license/attribution, approved UX use, file path, keyboard/screen-reader behavior, performance and alternatives rejected.
5. Build one representative Decision Room screen first and photograph at 320, 390, 768, 1024, 1440x900 and 1920 widths, at 100% and 200% zoom. Compare actual layout against reference before replicating elsewhere.

## Candidate mapping (not a design decision)
- Cult UI Onboarding: mission mandate wizard.
- Cult UI Halo Tabs/Segmented: finance/operations/evidence view switch.
- Cult UI Side Panel: contextual approvals and evidence.
- Cult UI fields: exact beneficiary/amount approval inputs.
- React Bits Animated List/Counter: event changes and noncritical numeric transitions if accessibility passes.
- React Bits Model Viewer: isolated asset reference, **not** the mission scene engine.
- Skiper: optional single component only after its precise license and DOM behavior are inspected.
- Awwwards: art-direction study only; no cloned branding/layout/assets.

## Non-negotiable
No arbitrary invented typeface, color palette or hero layout; no overanimated payment buttons; never color SUBMITTED green as though SETTLED; currency always explicitly displayed; keyboard and reduced-motion parity; no inaccessible hover-only details. Reference screenshots, licenses and design decisions are PR evidence, not suggestions.

## Artifacts after approval
`design/reference-ledger.md`, `design/component-ledger.md`, `design/tokens.json`, `design/typography.md`, responsive screenshots. Create when real references and approved decisions exist—not empty files pretending a system is approved.

## Research status (MTV-08, Nov 3 2026 — awaiting founder decisions)
The verified reference/component ledger, screen/flow specifications, two UNAPPROVED visual-direction proposals, 3D asset reconnaissance, quality rubric and founder decision brief live in [`research/mtv-08/`](../research/mtv-08/README.md). No token in that package is approved and no theme code exists in `apps/web` until the founder records the choices in `research/mtv-08/founder-decision-brief.md`.
