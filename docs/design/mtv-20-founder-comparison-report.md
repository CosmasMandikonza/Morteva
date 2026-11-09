# MTV-20 founder comparison report — original vs improved, reference mapping, self-scores

**Status: NOT self-approved.** This report supports the founder visual gate (issue #10 /
demo storyboard §2). Every claim links to a real capture from the running authenticated app
(`docs/assets/production/mtv-20-*.png`) or a named test.

## 1. Original vs improved, per screen

### Mission Treasury — `mtv-20-treasury-dark-1440x900.png` / `-light-` / `-390` / `-320`
- **Original (PR #45):** balance / protected floor / spendable as a three-figure list; commitments
  as a text line; operations panel opened with a text count line.
- **Improved:** one halo focal hero (mission + effective authority); per-currency **four-concept
  decomposition** — Available (balance − protected floor) / Reserved / Pending-unknown / Spendable
  (accent-highlighted) — in Geist Mono with explicit currency codes; **protected-floor-share
  HaloProgress** with warn state + mandatory text equivalent; **exceptions strip** (needs-a-human /
  unknown-outcome HaloBadges with tabular counts) opening the operations panel.
- **References adopted:** Cult UI *minimal/halo card* (single focal card), *halo-progress*
  (bar + text), *halo-badge* (tone+glyph+count); Awwwards *VELTO* honest-totals + *Contiant*
  one-accent restraint (principle only). React Bits *Animated List* is NOT used here — the
  Commons-Clause gate keeps its source out of this public repo; the feed rows use our own
  stagger entrance instead (same felt effect, own code).
- **Why more effective:** the buyer's four questions (what can I commit / what's reserved or
  uncertain / what needs a human / which mission next) are answered in one scan without reading
  prose.

### Decision Room — `mtv-20-decision-dark-baseline/incident/expanded/evidence-lens-…`, `-light-`
- **Original (PR #45):** single-column stack; before/after as static cards; alternatives/reasons
  inside native `<details>`; everything always rendered.
- **Improved:** signature **12-column composition** — physical column (~7: viewer availability
  card, admitted incident with full journal id + digest copy, actions, durable evaluations) beside
  the financial column (~5) with **Halo Tabs** (Finance default / Operations / Evidence, mission
  state preserved); before/after as **ExpandableCards** (action + gross/net + verdict always
  visible collapsed; alternatives, reasons incl. `ASSET_SAFETY_BLOCKED`, uncertainty on expansion;
  no-spend rendered first-class dashed); mission header band with editorial display title +
  factual badges (SIMULATED OPERATION / POLICY-ONLY / 22 kt modeled limit, live dot only when the
  incident is active); lifecycle **Stepper** on the Operations lens.
- **References adopted:** Cult UI *halo-tabs* (+ direction-aware indicator logic), *expandable*,
  *halo-badge*; React Bits *Stepper* pattern (original implementation, text labels mandatory);
  Skiper timing studies → 150/180ms token transitions on selection; Awwwards *Sunbit* "motion as
  narrative" spent on the physical→constraint→decision flow, and *2026 SOTD* editorial display +
  quiet mono details on the header band.
- **Physical integration:** Agent C's genuine `MissionPhysicalViewer` slot ships (availability
  card while Agent A's read endpoint is undeployed — honest, zero-3D-cost). Selection wiring per
  `AGENT-B-HANDOFF.md` is ready (`journey.incident.eventId`). Scene placement stays labeled
  illustrative; the real 24.6 kt vs modeled 22 kt comparison is carried by the admitted journal
  event, never by decorative telemetry.
- **Why more effective:** a judge sees *physical event → safety constraint → financial decision
  changes* spatially, before reading any text (the demo storyboard's beat 3).

### Authority & Execution — `mtv-20-authority-dark/light-1440x900.png`
- **Original:** honest "planned" placeholder (issue #7).
- **Improved:** real authority system from server reads — effective mandates (per-action caps,
  envelope HaloProgress with 80% warn, kinds from persisted JSON), immutable proposals (full
  plan id + digest with copy buttons, proposer identity), factual five-step Stepper
  (Proposed→Approved→Reserved→Submitted→Verified-settled with "provider rail disabled offline"
  stated, never implied), journal-verified approvals as hold-tone badges (green untouched),
  superseded/expired authority behind a disclosure, mission operations with real status chips.
- **References adopted:** Cult UI *side-panel/copy-button/field* family; React Bits *Stepper*
  pattern; Awwwards *Contiant* B2B restraint + *VELTO* explicit environment labeling.
- **Why more effective:** reads like a settlement authority desk, not a checkout — the operator
  sees exactly which control happens next and which are later, separate gates.

### Evidence Replay — `mtv-20-evidence-dark-rail/detail-…`, `evidence-light-detail-…`
- **Original:** read-only list; payload previews capped at 6 keys; no selection.
- **Improved:** selectable rail (aria-pressed rows, keyboard reachable) driving a **Side Panel
  inspector** (focus trap + restore — the a11y the Cult reference lacks, added): seq/type/topic/
  recorded-at, full payload digest + CopyButton, event key, complete allowlisted payload.
  Selection identity survives refetches; selection is view-only by construction.
- **References adopted:** React Bits *Animated List* interaction pattern (original rows, no
  hover-select, no auto-scroll); Cult UI *side-panel* + *halo-badge*; Awwwards editorial
  rail→context→marginalia hierarchy.
- **Why more effective:** investigation reads like a case file, not a JSON dump; the same
  event/plan/approval identities carry through Decision Room and Authority.

### Onboarding & identity — `mtv-20-identity-demo-signin-1440x900.png`
- **Improved:** mandate wizard now shows the Cult UI *Onboarding* step indicator
  (Constraints → Exact review → Server grant with the grant visibly pending until the server
  confirms); production identity per the identity/v1 contract — the shell probes the REAL
  `GET /api/auth/oidc/login` capability (303 → IdP sign-in entry + invitation accept; 404 → the
  existing DEMO_AUTH form untouched). Invitation refusals render in useful language inline.
- **Why more effective:** constraints feel reviewed, not typed; production never implies a local
  credential system; demo stays loopback-honest.

## 2. Self-scores (1–5, rubric §2 axes) — evidence-linked, founder decides

| Axis | Treasury | Decision Room | Authority | Evidence | Evidence anchor |
| --- | --- | --- | --- | --- | --- |
| Distinctive product identity | 4 | 5 | 4 | 4 | header bands, halo hero, incident frame |
| Financial credibility | 5 | 4 | 5 | 4 | four-concept strip; exact-terms block; stepper truth |
| Clear next action | 4 | 5 | 4 | 4 | primary buttons; propose-from-evaluation; approve affordance gating |
| Physical→financial storytelling | n/a | 5 | 3 | 4 | 12-col causality; stepper; journal identity chain |
| Typography & composition | 4 | 5 | 4 | 4 | display/mono discipline; 12-col; editorial rail |
| Interaction craftsmanship | 4 | 4 | 4 | 4 | tabs, expandables, side panel, copy buttons |
| Responsive accessibility | 4 | 4 | 4 | 4 | 390/320 exact scrollWidths; 44px coarse-pointer targets; focus traps |
| Cross-screen coherence | 4 | 5 | 5 | 4 | one token system, one badge/stepper/panel language |

Known weaknesses (not hidden): the physical viewport renders the honest availability card until
Agent A's read endpoint ships (the strongest screen — the mounted 3D scene — is one endpoint
away); Treasury has no time-series chart (no trustworthy series endpoint exists — bars shown
instead, chart built only when data exists); Adobe-grade motion polish remains modest by design
(reduced-motion + Commons-Clause constraints).

## 3. Licensing constraints (binding)

- **Cult UI (MIT):** pattern provenance documented; zero source copied — original token-CSS
  implementations (this repo is not Tailwind/shadcn). A11y obligations re-implemented and
  test-verified (focus trap where the reference lacks it; roving tabindex).
- **React Bits (MIT + Commons Clause):** zero source files in this public repo; Stepper/Animated
  List/entrance patterns re-implemented from documented behavior. No Pro purchase.
- **Skiper UI:** none imported (attribution burden + brand-imitation provenance) — used as
  interaction-timing research only; documented comparison outcome: no candidate beat a Cult
  equivalent.
- **Awwwards:** principles only; no cloned layouts/assets.

## 4. Mobile + reduced-motion evidence

- 390/320: `mtv-20-treasury-390/320.png`, `mtv-20-decision-390/320.png` — scrollWidth exact
  (390→390, 320→320) printed by the capture run; decision column orders first on small screens.
- Reduced motion: production gate added this milestone (`@media (prefers-reduced-motion: reduce)`
  collapses all durations to 0.01ms, entrances render instantly, live dots stop pulsing) —
  verifiable in browser DevTools emulation; the pre-existing e2e reduced-motion check still pins
  the numeric transition-duration equality.

## 5. Before the founder gate can pass

1. Agent A's sanitized physical-view endpoint → mount `MissionPhysicalViewerLazy` (the slot and
   selection wiring are ready; CP2's strongest element completes then).
2. Real OIDC IdP credentials (issue #5-family blocker) → exercise the identity UI against a live
   provider; invitation E2E through the real IdP already exists on PR #51's branch.
3. A trustworthy spend-history series endpoint → replace the honest bars with the Cult
   analytics-chart (table fallback + keyboard navigation per the ledger).
4. Founder live review at 1440 + 390, dark+light, reduced-motion on/off (rubric §2), then the
   aesthetic gate decision in issue #10.
