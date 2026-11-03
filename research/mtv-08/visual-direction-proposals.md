# Visual direction proposals — MTV-08

**⚠️ BOTH DIRECTIONS ARE UNAPPROVED.** Per issue #10: "Do not silently approve it yourself." Nothing below may be implemented in `apps/web` until the founder records a choice (then a design ADR + `design/tokens.json` follow, per docs/03).

Both directions share the same [verified component ledger](reference-and-component-ledger.md), the same [screen/flow specifications](screen-and-flow-specifications.md), the same responsive/a11y budgets, and the same **financial status semantics** (§3). They differ in tokens (type, color, surface, motion), where the drama lives, and build risk. Every font listed was license- and tabular-figure-verified against foundry sources and font binaries on 2026-11-02/03 (`tnum` = OpenType tabular-figures feature, scanned in the actual TTFs; see [research-record.md](research-record.md)).

---

## Direction A — "Harbour Watch" · light institutional instrument

**One sentence:** a daylight flight-deck ledger — light, dense, single-accent, engineered for the fleet finance manager to trust at first glance.

### References grounding it

- **Cult UI** light mode + Halo family (the ledger's structural set: Halo Tabs/Segmented/Badge/Field, Onboarding, Side Panel, Analytics Chart, Rolling Number) — observed in the docs site's light theme.
- **Awwwards/Contiant** (open-banking HM) — restrained B2B banking: one accent, generous whitespace, credibility-first (art-direction study only).
- **Awwwards/VELTO** (fintech app concept nominee) — clear totals, honest labeling, tabular money.
- **IBM Plex** superfamily — the institutional engineering voice (used by banks, airlines, observatories).

### Typography (all SIL OFL 1.1 · all `@fontsource`-packaged · tabular verified)

| Role                            | Face                                                                | Verification                                                                                           | Notes                                                        |
| ------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| UI text                         | **IBM Plex Sans** (`@fontsource/ibm-plex-sans`)                     | OFL · **tabular by default** (digits uniform-width without toggling — google/fonts#8001 + binary scan) | 100–700 + italics                                            |
| Screen titles / section heads   | **IBM Plex Sans Condensed** (`@fontsource/ibm-plex-sans-condensed`) | same family, OFL                                                                                       | condensed = instrument-panel labels without a second foundry |
| Figures, receipts, IDs, tickers | **IBM Plex Mono** (`@fontsource/ibm-plex-mono`)                     | OFL · mono ⇒ inherently tabular · true italics                                                         | ledger/tape texture                                          |

Hierarchy (tokens candidate): 12/13px dense table text · 14px body · 16px section head (condensed, caps +0.08em tracking) · 20–24px screen title · 28–32px hero liquidity figures (Plex Mono 600). `font-feature-settings: normal` needed nowhere — figures are tabular stock; `tnum` explicitly set on Sans numerics for safety.

### Color (candidate tokens — anchored, not invented: zinc neutrals are the Tailwind scale the ledger components ship with; the accent is derived from the verified Sunbit fintech-blue family `#2779a7`, darkened for 4.5:1 text contrast on paper)

| Token                                                                                                                                                                                                    | Candidate                | Role                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------- |
| `surface/page`                                                                                                                                                                                           | `#F4F4F5` (zinc-100)     | app background                                        |
| `surface/card`                                                                                                                                                                                           | `#FFFFFF`                | panels/cards                                          |
| `surface/sunken`                                                                                                                                                                                         | `#E4E4E7` (zinc-200)     | wells, table headers                                  |
| `ink/primary`                                                                                                                                                                                            | `#18181B` (zinc-900)     | text                                                  |
| `ink/secondary`                                                                                                                                                                                          | `#3F3F46` (zinc-700)     | secondary text (7:1 on white)                         |
| `ink/muted`                                                                                                                                                                                              | `#52525B` (zinc-600)     | captions (7.1:1)                                      |
| `line`                                                                                                                                                                                                   | `#D4D4D8` (zinc-300)     | hairlines/borders                                     |
| `accent`                                                                                                                                                                                                 | `#1D5A8A` (harbour blue) | primary actions, links, focus ring, active indicators |
| `accent/strong`                                                                                                                                                                                          | `#164668`                | hover/pressed                                         |
| Dark mode (follows OS, same tokens): page `#101013`, card `#18181B`, ink `#F4F4F5`, line `#2E2E33`, accent lightens to `#6EA8DC` for contrast. Both themes must pass V5 contrast checks before adoption. |

### Grid, surface, density

- 4px base unit (ledger components are Tailwind-native; spacing 4/8/12/16/24/32/48); card padding 16–24px; gap 12–24px.
- 12-col grid at ≥1024px; content max-width 1600px at 1920.
- Radii: 8px cards / 6px controls / 999px chips (matches Halo family defaults); shadows: single soft `0 1px 2px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.05)` — light mode reads on edges, not glow.
- Density: "instrument" — compact rows (36px), tabular money right-aligned mono, unit labels always visible.

### Motion language

Quiet and mechanical: 150–250ms `cubic-bezier(.2,0,0,1)` for panels/tabs (Halo's sliding indicators); Rolling Number springs reserved for non-money counters; no ambient background animation; 3D camera moves ≤600ms eased. Reduced motion: everything above → instant. The one expressive beat: Dynamic Island (optional S3) for agent/payment ambient status.

### 3D ↔ finance relationship

3D lives in a framed "viewport instrument" card — same border language as charts, light-sky **Simon's Town Harbour HDRI** (CC0). Financial panels never float over the scene; the scene is _evidence_, the panels are _money_ — visually co-equal, side by side (the docs/08 P1 rule made literal).

### Accessibility & performance posture

- Easiest of the two for WCAG AA (light-on-dark text + zinc neutrals pre-pass); focus ring = 2px accent on 2px offset.
- Cheapest paint: no glassmorphism layers, no gradients behind text (Halo rims only on chips/badges, never behind figures).
- Risks: can read "enterprise utilitarian" if hierarchy is lazy — the condensed caps labels + mono figures must be executed with care; demo video pop is lower than Direction B (deliberate trade: buyer credibility > judge spectacle).

---

## Direction B — "Night Sortie" · dark cinematic mission console

**One sentence:** an after-dark offshore operations room — near-black deck, instrument glow, cinematic 3D, motion that narrates state changes.

### References grounding it

- **Cult UI** dark mode + Halo family's gradient rims/frosted tracks (built to shine on dark).
- **React Bits** motion layer: Animated List springs, Lattice Loader, Dot Grid backdrop (subtle, low-opacity), Counter accents — all MIT+Commons-Clause-safe inside the app.
- **Awwwards 2026 SOTD typography study** (Grids/Obys, MECHA): large editorial display type + quiet mono details — applied to screen titles only.
- **Sunbit** (HM) motion-as-narrative lesson: transitions carry the reserve→approve→submit→verify story.

### Typography (all SIL OFL 1.1 · all `@fontsource`-packaged · tabular verified)

| Role                                    | Face                                                      | Verification                                                             | Notes                                                       |
| --------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Display (screen titles, numbers heroes) | **Space Grotesk** (`@fontsource/space-grotesk`, variable) | OFL · **tnum YES** (binary + README) · 300–700, no italics (none needed) | squared techy voice — mission control without costume       |
| UI text                                 | **Inter** (`@fontsource/inter`, variable incl. italics)   | OFL · **tnum YES** (binary + README) · 100–900                           | the neutral engineered body                                 |
| Figures, receipts, IDs                  | **Geist Mono** (`@fontsource-variable/geist-mono`)        | OFL · mono ⇒ tabular · 100–900                                           | crisp console numerals (alt: JetBrains Mono, also verified) |

Hierarchy: 12/13px dense text · 14px body · 17px section heads (Inter 600) · 22–26px screen titles (Space Grotesk 600, −0.01em) · 30–40px hero figures (Space Grotesk tnum). Set `font-feature-settings: "tnum" 1` on ALL numeric text explicitly.

### Color (candidate tokens — zinc-dark surface scale is again the components' native Tailwood dark palette; the amber authority accent is the classic instrument-panel signal color, tuned for contrast on near-black)

| Token                                                                                                                                                                    | Candidate                                                 | Role                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `surface/page`                                                                                                                                                           | `#0A0A0B`                                                 | app background (zinc-950-adjacent)                                                  |
| `surface/card`                                                                                                                                                           | `#141417`                                                 | panels                                                                              |
| `surface/raised`                                                                                                                                                         | `#1E1E22`                                                 | hover/popovers                                                                      |
| `surface/glass`                                                                                                                                                          | `rgba(20,20,23,.72)` + 1px `rgba(255,255,255,.08)` border | panels over the 3D scene only                                                       |
| `ink/primary`                                                                                                                                                            | `#F4F4F5`                                                 | text                                                                                |
| `ink/secondary`                                                                                                                                                          | `#A1A1AA`                                                 | secondary (7.8:1 on card)                                                           |
| `ink/muted`                                                                                                                                                              | `#8E8E96`                                                 | captions (≥4.6:1 on card — verified target, not guesswork)                          |
| `line`                                                                                                                                                                   | `#27272A`                                                 | hairlines                                                                           |
| `accent/authority`                                                                                                                                                       | `#E8B23E` (instrument amber)                              | primary actions, approval CTA, focus ring — money decisions glow, nothing else does |
| `accent/info`                                                                                                                                                            | `#5FA8D3`                                                 | links, informational states                                                         |
| Light mode (follows OS): page `#FAFAFA`, card `#FFFFFF`, ink `#18181B`, amber darkens to `#8A6414` for text contrast; glass surfaces become solid. Same V5 gate applies. |

### Grid, surface, density

- Same 4px base, 12-col grid, max-width 1600, radii 8/6/999 as Direction A (shared skeleton = shared build cost).
- Surfaces: near-flat cards with 1px light-trap borders; glass surfaces ONLY over the 3D viewport (never behind body text); Halo frosted tracks on segmented/tabs.
- Density: same instrument rows; slightly larger hero figures (cinematic hierarchy).

### Motion language

Expressive but narrated: Motion springs on Halo indicators (200–350ms), Animated List row springs on new evidence, Dot Grid breathing at ≤4% opacity (pauses when tab hidden), Dynamic Island for in-flight payments, camera choreography ≤600ms/beats per the 3D storyboard. **Every effect checks the reduced-motion gate first; grayscales to Direction-A-level quiet.**

### 3D ↔ finance relationship

3D is the stage: full-bleed Decision Room viewport with dusk/night environment (Poly Haven CC0, exposure-tuned), evidence pins glowing amber; financial panels are glass instruments floating beside it — always in a reserved grid track (never overlapping the asset), amber = authority signals. Treasury stays panel-first (the money room is calm even at night).

### Accessibility & performance posture

- Contrast is the discipline: every ink token above was chosen against its specific surface with the 4.5:1 math stated; AA is achievable but must be enforced (V5) — amber-on-dark passes for large text/UI, body text never sits on glass or gradients.
- Cost: more GPU (3D + backdrop) → PerformanceMonitor/AdaptiveDpr mandatory (verified drei components); glass = backdrop-filter cost on low-end → auto-downgrade to solid `surface/raised` when DPR-regressed.
- Risks: dark-mode "AI dashboard" cliché if accent discipline slips (amber ONLY on authority/actions); more motion surface to gate for reduced-motion; longer polish time than A. Demo video presence is strongest.

---

## 3. Shared financial status semantics (identical in both directions — this is not a style choice)

| Lifecycle state                                 | Hue family (both themes)              | Icon         | Text label (always)                                            | Notes                                                            |
| ----------------------------------------------- | ------------------------------------- | ------------ | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| PROPOSED                                        | neutral (zinc)                        | ○ draft      | `PROPOSED`                                                     | no color weight                                                  |
| RESERVED                                        | blue/info                             | ◇ hold       | `RESERVED`                                                     | internal commitment, **never implied provider escrow** (docs/01) |
| APPROVED / AUTO_AUTHORIZED                      | accent-tinted                         | ✓ seal       | `APPROVED`                                                     | digest-bound                                                     |
| SUBMITTING / IN_FLIGHT / SUBMITTED              | **amber**                             | ▲ in-transit | `SUBMITTED`                                                    | **never green** (docs/03 non-negotiable)                         |
| SETTLED (provider-verified)                     | **green**                             | ● verified   | `SETTLED` + provider timestamp                                 | green reserved exclusively for provider-verified terminal states |
| RECONCILED                                      | green + check-double                  | ◎            | `RECONCILED`                                                   |                                                                  |
| STATUS_UNKNOWN                                  | amber + pulse + ⚠                     | `UNKNOWN`    | commitment retained; "check by original ID", never blind retry |
| REJECTED / EXPIRED / CANCELLED / REQUIRES_HUMAN | red / neutral / neutral / red-outline | ✕ ⌛ ⃠ ☗     | exact reason shown                                             | denial never a dead end (feasible alternative offered)           |
| Environment labels                              | outlined chips (never hue-encoded)    | —            | `SANDBOX` `TESTNET` `SIMULATED` `OFFLINE`                      | E5 pattern; env truth is a chip, not a mood                      |

Currency is always explicit (`USD 2,150.00`), amounts right-aligned tabular mono, and no status is ever communicated by color alone (icon + text + hue, V4).

## 4. Side-by-side decision table

| Dimension                             | A · Harbour Watch                                                                      | B · Night Sortie                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| First-glance story to a fleet-ops CFO | "serious instrument I can audit"                                                       | "command deck I want to steer"                                |
| Judge/demo-video impact               | solid, quieter                                                                         | strongest                                                     |
| Type system                           | IBM Plex Sans/Condensed/Mono (one foundry, tabular by default)                         | Space Grotesk + Inter + Geist Mono (three verified OFL faces) |
| Accent discipline                     | one harbour blue                                                                       | instrument amber (authority only) + info blue                 |
| Motion budget                         | minimal                                                                                | narrated expressive, strictly gated                           |
| 3D lighting                           | daylight harbour HDRI                                                                  | dusk/night HDRI, glow accents                                 |
| WCAG effort                           | lowest                                                                                 | medium (enforced per-token math above)                        |
| Perf effort                           | lowest                                                                                 | medium (adaptive DPR, glass downgrade path)                   |
| Build-time risk                       | reads plain if hierarchy sloppy                                                        | cliché/contrast risk if discipline slips                      |
| Shared                                | ledger components, status semantics, grid/a11y/responsive budgets, honest-state matrix | (same)                                                        |

## 5. Recommendation (for the founder to accept or overturn — recorded, not decided)

**Lead recommendation: Direction B "Night Sortie" as ONE consistent product-wide token system, using Direction A's information-density discipline** — i.e., B's tokens + motion on the Decision Room/3D flagship, A's calm panel-first density on Mission Treasury and Evidence Replay (both directions already share the skeleton; only tokens differ per screen). Rationale: the hackathon is judged on a memorable, coherent product story where the 3D flagship and financial trust must read as one system; B carries that narrative better, and every risk it adds (contrast, perf, motion) has a verified mitigation already in the rubric. If the founder prefers maximum buyer-credibility per hour of engineering, A alone is the safe pick and ships faster. **This recommendation is itself UNAPPROVED until the founder chooses.**

## 5. Founder visual approval must include visual proof (CTO review)

These color values and typography tables are **candidates derived from research, not approved implementation or a visual comparison**. They cannot substitute for seeing both directions rendered. Before committing a final token set, provide an actual side-by-side reference-grounded style tile (typography, sample balances, 3 financial states, planned 3D viewport composition) at desktop 1440×900 and mobile 390×844. The tiles can be a disposable, isolated prototype or shareable annotated reference links, not permanent `apps/web` theme code. Log precisely which components/typography were used and include the relevant license reviews. A choice based only on the names "Night Sortie" and "Harbour Watch" is **not** a passed visual gate.

**Coherence rule:** If the founder prefers the recommended B-led treatment, keep **one canonical type, color, spacing, state-semantic and component system across every screen**. "Harbour Watch density" may influence table/financial content hierarchy, not create a second contrasting mini-brand per route. The current word "hybrid" is a composition principle, not permission for two simultaneous token systems.
