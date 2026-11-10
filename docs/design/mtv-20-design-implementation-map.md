# MTV-20 design implementation map — reference-to-component audit (Checkpoint 1)

**Branch:** `feat/mtv-20-product-design` (integration `61d0ab1` + merged #50 mission-viewer + #51
identity, so this branch IS the combined product tree) · **Design authority:** ADR 0004 (B-led
hybrid, PROVISIONAL) + `design/tokens.json` 1.1.0 + `docs/03_UI_REFERENCES_AND_DESIGN_GATE.md` +
`research/mtv-08/reference-and-component-ledger.md` (the verified ledger — every mapping below
resolves to a ledger row).

## 0. What ships, in order (checkpoint plan)

| Checkpoint | Deliverable |
| --- | --- |
| CP1 (this doc) | Reference→component→screen map with license status |
| CP2 | Decision Room as signature screen: 12-col composition, mission header, Halo Tabs (Finance/Operations/Evidence), expandable candidate cards, evidence Side Panel, viewer card slot |
| CP3 | Treasury decomposition hero + Authority & Execution real surface + Evidence Replay 3-column causal layout + onboarding wizard polish + identity UI |
| CP4 | Full two-person workflow + offline/unknown + replay E2E |
| CP5 | Adversarial polish (a11y, responsive, reduced motion) + founder comparison report |

## 1. Library verdicts (carried from the verified ledger — unchanged)

| Library | License (verified Nov 2–3, 2026) | Verdict |
| --- | --- | --- |
| **Cult UI** (cult-ui.com/docs/components, github.com/nolly-studio/cult-ui) | **MIT** — notice retention | **Structural base.** Component *patterns* are adapted as original implementations on MOTERVA's semantic-token CSS (this repo is React/Vite + custom properties, not Tailwind/shadcn; a blind copy-in would import a foreign framework). Every adaptation re-implements the documented a11y obligations (roving tabindex, focus trap, reduced motion) and is verified by our own tests. |
| **React Bits** (reactbits.dev, MIT + **Commons Clause**) | App-use OK; **redistribution of component source is restricted** — and this repo is public | **Pattern-informed original implementations only.** Zero React Bits source files are copied. Where a pattern is used (Animated List row entrances, Stepper strip), the interaction is re-implemented from the documented behavior with our tokens/motion and our a11y contract. This resolves the ledger's `REVIEW_REQUIRED` gate by not redistributing. |
| **Skiper UI** | Free tier = attribution; much premium; brand-imitation catalog | **Rejected as a system** (ledger §3). Used as motion-craft research only: reveal/dismiss timing and hover/focus feedback studies informed our transition timing (§4 below). **Zero Skiper code, zero attribution burden.** |
| **Awwwards** | Study only | Art-direction principles (§5) applied to composition; no cloned assets/layouts. |
| React Bits Model Viewer | MIT+CC | **Not used.** The mission scene is Agent C's `MissionPhysicalViewer` (merged #50) per contract. |

## 2. Component mapping — exact source URL → MOTERVA artifact → screen function

### Navigation / shell
| Reference (exact URL) | MOTERVA artifact | Function | License note |
| --- | --- | --- | --- |
| https://www.cult-ui.com/docs/components/halo-tabs | `components/ui/HaloTabs.tsx (module: components/ui/index.tsx)` (original: CSS sliding indicator, `role=tablist`, roving tabindex, arrow keys) | Decision Room Finance/Operations/Evidence switch without losing mission state | MIT pattern; original code |
| https://www.cult-ui.com/docs/components/direction-aware-tabs | Indicator direction logic folded into HaloTabs (indicator slides from the previous tab's side) | Same | MIT pattern; original code |
| https://www.cult-ui.com/docs/components/halo-segmented | `components/ui/HaloSegmented.tsx` (single-select, spring thumb analog = CSS transition under motion token) | Treasury lens switch (Positions / Missions / Exceptions), replay topic segmented | MIT pattern; original code |
| https://www.cult-ui.com/docs/components/onboarding | Mandate wizard step indicator upgrade in `OnboardingDialog.tsx` (numbered steps, canGoNext gates — already enforced by exact-review step) | Mission/mandate onboarding | MIT pattern; original code |

### Surfaces / financial hierarchy
| Reference | MOTERVA artifact | Function | License note |
| --- | --- | --- | --- |
| …/minimal-card · …/halo-card | `Panel` (existing) restyled via `.mv-card--halo` modifier (quiet rim highlight on the hero card only — one focal card per screen, never all) | Balance hero, position, authority facts | MIT pattern; original CSS on tokens |
| …/halo-badge | `components/ui/HaloBadge.tsx` (tone+glyph+label from the existing `statusMap`, tabular counts, live dot for in-flight only) | Provider env chips, exception counters, operation states | MIT pattern; original code |
| …/halo-progress | `components/ui/HaloProgress.tsx` (track+fill+text equivalent `x of y committed`, `role=img`+`aria-label`, no color-only) | Budget envelope + protected-reserve bars | MIT pattern; original code |
| …/analytics-chart | **Honest-alternative rule applied:** no trustworthy time-series exists in the current read models (`FinancialOverviewView` is point-in-time). Rather than invent points, the Treasury shows the **commitment decomposition + envelope bars**; the chart component is built but fed only when a real series endpoint exists (documented as an A-dependency). | Spend history when a series ships | MIT pattern; original SVG planned |

### Decisions / inspectors
| Reference | MOTERVA artifact | Function | License note |
| --- | --- | --- | --- |
| …/side-panel | `components/ui/SidePanel.tsx` — right-side inspector sheet: focus trap + restore + Escape (the ledger flagged that Cult's panel documents **no focus trap**; ours adds it, reusing the proven `Sheet` mechanics) | Evidence inspector on Decision Room; receipt inspector on Authority/Replay | MIT pattern; original code with required a11y added |
| …/expandable | `components/ui/ExpandableCard.tsx` — collapsed state always shows action + gross + verdict + next step; expansion reveals reasoning/uncertainty/evidence IDs | Candidate decision cards (baseline / revised / alternatives / no-spend first-class) | MIT pattern; original code |
| …/halo-field · …/halo-input · …/halo-select | Field styling pass on existing `.mv-field`/`.mv-input` (labels stay persistent — hover-only is banned) | Approval + mandate + invitation forms | MIT pattern; original CSS |
| …/popover-form | Deferred — policy peeks render inline (never hover-only); revisit post-gate | — | — |
| …/copy-button | `components/ui/CopyButton.tsx` (clipboard + `aria-live` announcement) | Digests, request IDs, receipt IDs | MIT pattern; original code |
| …/halo-toast | `components/ui/Toast.tsx` — `role=status`, **never auto-dismisses financial states**; persistent records remain in panels (toast is an echo, not the record) | Proposal/approval/denial echoes | MIT pattern; original code |

### Motion (React Bits patterns — original implementations, zero copied source)
| Reference | MOTERVA behavior | Reduced-motion contract |
| --- | --- | --- |
| https://www.reactbits.dev/components/animated-list | Evidence rail + operations feed rows enter with a single 180ms translate/fade stagger (max 8 rows); **no auto-scroll** (review stability) | Stagger → 0.01ms, rows render instantly |
| https://www.reactbits.dev/components/stepper | `components/ui/Stepper.tsx` — PROPOSED→RESERVED→SUBMITTING→IN_FLIGHT→SETTLED/RECONCILED factual strip with side-states (REQUIRES_HUMAN, STATUS_UNKNOWN as distinct amber/unknown glyphs, never green) | Instant state flips |
| Selection transitions | Event/marker selection: 150ms highlight + panel content swap; the **money numbers never animate** | Same |
| Loading | Skeleton rows + text "reading…" (existing pattern); no theatrical loaders | Same |

**React Bits license resolution:** the Commons Clause restricts redistribution of the component
source itself. All motion above is original CSS/TSX implementing the *interaction pattern*
(documented), so no React Bits source enters this public repository — the ledger's
`REVIEW_REQUIRED` gate is satisfied by construction. No React Bits Pro was purchased or used.

### Skiper (research only — documented per the directive)
Pages studied: https://skiper-ui.com/components catalog + https://skiper-ui.com/docs/quick-start.
Observations folded into our craft: (1) reveal timing ~180–240ms with soft ease-out on panels;
(2) hover feedback = border+background shift, never scale on financial containers; (3) dismissal =
content-first, chrome-second. **No Skiper component imported** — the free tier's attribution
requirement plus brand-imitation provenance conflicts with the ledger's verdict; the one candidate
audited (smooth-caret input) was rejected again (zero functional gain over Halo Input styling).
This satisfies "at most one licensed component after documented comparison" with the outcome
documented as *none adopted*.

## 3. Awwwards art-direction transfer (≥2 references per key screen)

From the ledger's §4 study (VELTO 2026 nominee, Contiant 2023 HM, Sunbit 2020 HM, 2026 SOTD
typography) plus the live fintech category (awwwards.com/websites/fintech/):

| Screen | Awwwards-derived principle (source examples) | Concrete MOTERVA application |
| --- | --- | --- |
| Treasury | VELTO: honest totals + labeling win on clarity. Contiant: restrained palette, one accent, generous whitespace. | One halo hero card (spendable) as the focal point; all other cards quiet minimal; single amber accent; decomposed money concepts instead of six KPI tiles. |
| Decision Room | Sunbit: motion as narrative in service of a story. 2026 SOTD: large editorial display + quiet mono details. | The defining composition: physical event (viewer/scene context, 7 cols) → constraint → decision cards (5 cols); display face only on the mission title; all figures Geist Mono. |
| Authority | Contiant: B2B banking credibility through restraint. VELTO: explicit environment labels. | Authority reads like a settlement ledger: exact terms block, factual stepper, quiet controls; SANDBOX/OFFLINE chips adjacent to every external fact. |
| Evidence Replay | 2026 SOTD: editorial information hierarchy (left rail → story → marginalia). | Three-column investigation: rail → context → details; one selected event drives all three. |

## 4. Binding constraints honored

Space Grotesk / Inter / Geist Mono only (already in `apps/web/package.json` via fontsource) ·
semantic tokens only (checker-enforced) · dark flagship / light parity · amber-dark / blue-light
interactive contract · ≥14px essential text (16px preferred) · explicit currency codes ·
focus ring + reduced-motion gates untouched · green reserved for SETTLED/RECONCILED · no new
fonts, no glassmorphism layers beyond the existing token, no neon, no decorative charts, no
payment-button theatrics.

## 5. Explicitly out of scope (documented rejections)

Skiper import (attribution/provenance) · React Bits source copies (Commons Clause + public repo) ·
Awwwards cloning · Tailwind/shadcn migration (framework rewrite without product gain) · chart with
invented series (no time-series endpoint exists — honest bars shown instead) · hover-only
financial detail · animated money.
