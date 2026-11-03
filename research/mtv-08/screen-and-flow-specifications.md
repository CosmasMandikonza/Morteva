# Screen and user-flow specifications — MTV-08

Grounded in `docs/02_OPERATOR_JOURNEYS.md` (personas, Journeys A/B/C, screen contract), `docs/01` (domain objects, operation lifecycle), `docs/00` (primary customer flows), and the CTO handoff (issue #10). Component references resolve to the [verified ledger](reference-and-component-ledger.md); nothing here inventors a component that doesn't exist.

## 0. Global shell & navigation

- **Top bar (all screens):** MOTERVA mark · org/mission context switcher · four-screen primary nav (Mission Treasury / Decision Room / Authority & Execution / Evidence Replay) · environment badge (SANDBOX / TESTNET / SIMULATED / OFFLINE per provider — ledger E5 Halo Badge) · user menu with role.
- **Role-aware rendering** (docs/02 personas): finance approver sees Approve actions; technician sees evidence capture but never expanded authority; auditor gets read-only Replay + receipts. Role is displayed, not hidden — trust needs visibility.
- **Navigation semantics:** hash-routed sections (existing `nav.ts` pattern), `aria-current="page"`, full keyboard operability. Onboarding (S1) gates the very first run only.
- **Global honesty banner:** dismissible-but-logged "Hackathon build — provider environments labeled per surface" strip, plus per-card provider chips (never a single global "everything is fine").
- **Mobile (<768px):** nav collapses to a bottom tab bar (thumb reach, 4 items max — exactly our screen count); environment badge stays pinned visible.

## 1. Onboarding — first-run mandate wizard (Journey A steps 1–3)

**Component:** Cult UI Onboarding (S1 — controlled steps, `canGoNext` gate, ChoiceGroup, TipsList).
**Flow:** welcome & role → mission purpose + time window → budget envelope → protected reserve floor → per-action limit → approved counterparties (ChoiceGroup) → authorization expiry → required-evidence rules → **compiled mandate review** (plain-language summary of every constraint with exact numbers; requires explicit "I have read the restrictions" confirmation, `canGoNext=false` until checked) → `onComplete`.
**States:** step validation errors inline (exact reason: "reserve floor exceeds envelope"); resume-after-abandon (draft persisted); back-navigation never silently mutates earlier constraints; final digest shown with its hash so the operator knows what they approved.
**Empty/first-run:** if no org/mission exists, Treasury shows the honest empty state with a single "Configure first mission" CTA (no fake data, per MTV-01 shell precedent).

## 2. Mission Treasury — financial overview

**Purpose (docs/02):** priority actions, funding/commitment state, active missions, exceptions.

**Layout (desktop):**

- Row 1: **Liquidity cards** (per currency): provider balance with source timestamp + provider chip; separately _Available_, _Reserved_, _Pending_, **Spendable** (ledger T5 cards; T1 status chips; numbers in tabular figures, currency always explicit, e.g. `USD 12,450.00`).
- Row 2: **Budget envelope panel** — consumed vs envelope vs protected reserve (T7 Halo Progress with text equivalents); reserve-floor breach warning.
- Row 3: **Active missions** grid (mission, status, committed, next action) + right rail **operations feed** (T6 Animated List, hover-select OFF).
- Row 4: **Exceptions** — denials, STATUS_UNKNOWN, stale evidence, expiring mandates (E5 badges; never color-only).
  **Interactions:** drill into any operation → Authority & Execution deep-link; mission card → Decision Room; chart time-range via T4 segmented.
  **States:**
- _Loading:_ skeleton cards + provider status "reading…" (text, not spinners-only).
- _Empty:_ no missions → honest empty state + onboarding CTA; no balances → `OFFLINE` card with "why" and retry (existing API-offline E2E pattern).
- _Stale:_ balance older than policy threshold → amber "as of HH:MM, retry" + autonomous commitments refused until fresh (docs/02 Journey C).
- _Denied/reservation conflict:_ exact denial with reason + feasible alternative + updated spendable (Journey B) — a toast (A4) plus persistent exception entry (toast never the only record).
- _Concurrent reservation race:_ optimistic UI is FORBIDDEN here — the reservation result comes from the server; UI shows "reserving…" then the authoritative outcome.

## 3. Decision Room — evidence, 3D context, alternative plans

**Purpose:** selected mission evidence, alternative plans, estimated effects, synchronized 3D/2D state.

**Layout (desktop, 12-col grid):** left evidence/3D column (≈7 cols) + right financial column (≈5 cols), CSS grid so panels never overlap the viewport (3D doc rule).

- **Top:** mission header + D1 Halo Tabs (Finance / Operations / Evidence) + D5 lifecycle stepper strip (PROPOSED→…→SETTLED with side-states).
- **Left column:** 3D viewport (drone/ROV scene, camera storyboard per [3D research](3d-asset-and-camera-research.md) §3) with evidence pins; below it the **event narrative** (what happened, provenance, freshness age, source: SIMULATED vs VALIDATED); D4 Model Viewer as the "inspect asset" card.
- **Right column:** **CandidatePlan cards** (D3 Expandable Card): each plan shows total committed cost, time, key assumption, uncertainty band, policy verdict (WITHIN AUTHORITY / NEEDS APPROVAL / REJECTED+reason) — collapsed state must show the money; expanded shows reasoning + evidence digest. "No-payment" is always a first-class plan (docs/08 V0 item 3).
  **Interactions:** select plan → financial impact preview (envelope/reserve math, tabular); confirm → reservation happens server-side (honest pending) → if within authority and auto-exec allowed → Authority & Execution handoff; if outside → approval request created (A-panel). Never require clicking "next" per agent step (docs/02 A6) — agent progress streams into the narrative panel with per-step provenance.
  **States:** _AI unavailable_ → case + financial state remain readable, plans show "planner offline — manual decision permitted within mandate" (no fake fallback authority, docs/02 C); _stale evidence_ → age badge + "autonomous commitment refused" until fresh; _WebGL lost/unavailable_ → 2D scene card (SVG asset schematic + event track) — financial columns untouched; _3D loading_ → progress + skeleton; _fault event_ → camera event-focus framing + exception chip.

## 4. Authority & Execution — permissions, approval, payment status, receipts

**Purpose:** exact terms, policy evaluations, action receipt, honest provider status.

**Layout:** terms ledger (A1 inputs locked to the digest: beneficiary, amount, currency, purpose, quote, expiry — read-only echo with A3 counter as accent only), policy evaluation table (each constraint → pass/fail with the mandate clause cited), digest + expiry countdown, execution history per provider (SUBMITTING / IN_FLIGHT / SUBMITTED / SETTLED / STATUS_UNKNOWN / REJECTED / EXPIRED), receipt drawer (A5 copy IDs, A6 raw JSON, redaction notice).
**The approval act:** one primary CTA ("Approve exact terms — USD 2,150.00 to NorthSea Divers AS") — quiet styling (both visual directions); keyboard path: focus → Enter; no double-press ambiguity (loading lock + disabled state with reason); changed-terms detection invalidates the prior approval inline ("digest mismatch — re-approval required", docs/02 C).
**Provider honesty rules (docs/01/03):** SUBMITTED never green; STATUS_UNKNOWN keeps its reservation and shows "commitment retained until resolved — do not retry" with a "check status by original ID" action; settled displays provider-verified timestamp + environment; FX/transfer/Metal shown as separate economic intents each with own request IDs.
**States:** _pending provider_ → stepper at SUBMITTING/IN_FLIGHT with elapsed time + last-checked; _denied_ → exact provider/policy reason + next feasible step; _expired mandate_ → block before spend with re-config path; _AI unavailability_ → approval path unaffected (human authority is the point).

## 5. Evidence Replay — events, decisions, transaction evidence, outcomes

**Purpose:** immutable timeline, original/revised plans, linked approvals, provider vs operating results.

**Layout:** left = timeline rail (E1 Animated List, one row per journaled event: operational events, plan revisions, approvals, provider operations, outcome evidence — each with type icon + age); right = detail panel (E3 Side Panel): event context → linked plan (original AND revised, diff-highlighted) → approval digest → operation + provider receipt (raw, labeled) → **operating outcome** (kept separate from financial status — provider SETTLED ≠ mission success, docs/02 C).
**Playback:** deterministic replay driven by the journal (same mission-time source as 3D): scrub or step through events; 3D (if WebGL on) reflects the selected moment. Replay mode is visibly labeled "REPLAY" (docs/06: tested backup replay clearly labeled).
**States:** _loading_ → E4 lattice loader + "rebuilding from journal"; _empty_ → "no events yet this mission"; _partial_ → "journal truncated after restart — showing persisted prefix" (honesty over fake continuity); _exception rows_ → STATUS_UNKNOWN / delivery-missing (paid but not delivered, docs/02 C4) pinned with "unresolved" chips.

## 6. Cross-cutting state matrix (every screen × every honest state)

| State                    | Rule (applies everywhere)                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| Loading                  | Text-labeled skeletons; never blank; never spinner-only.                                 |
| Empty                    | Names the emptiness + one honest next action; zero fabricated data.                      |
| Pending                  | Which subsystem, since when, what happens next, how to verify independently.             |
| Unknown (STATUS_UNKNOWN) | Retains commitment; no retry button for money; "check by original ID" affordance.        |
| Denied                   | Exact reason (policy clause or provider message) + feasible alternative.                 |
| Stale                    | Age + freshness policy + consequence (autonomy suspended) + refresh action.              |
| Error/offline            | Existing API-offline alert + Retry pattern (MTV-01 E2E-proven); correlation ID surfaced. |
| WebGL lost               | "3D paused — finances unaffected"; 2D card parity; restore attempt automatic.            |
| Reduced motion           | All spring/roll/choreography off; instant state transitions; no parallax.                |
| Zoom 200%                | No clipped panels, no horizontal scroll of financial tables (see §7).                    |

## 7. Responsive, keyboard, and accessibility budget (binding for #12–#14)

**Breakpoints (docs/06 Gate 3):** 320, 390, 768, 1024, 1440×900, 1920 — plus browser zoom 200% at 1440 (equivalent ~720px effective width must not clip).

- **320px (smallest):** single column; liquidity cards collapse to label+value rows (tabular figures preserved); 3D becomes poster card with "open full view"; bottom tab nav; tables become stacked definition lists — **no horizontal scrolling of money figures ever**.
- **390px:** as 320 + slightly larger hit targets; environment badge remains visible.
- **768px:** two-column where useful; 3D viewport 16:9 block; right rail moves below.
- **1024–1440:** the designed primary layout; 3D left + finance right grid.
- **1920:** content max-width cap (~1600px) + deeper whitespace, not stretched widgets.
  **Keyboard:** every action reachable; roving tabindex on tabs/segmented (Base UI); listbox arrow-key selection on feeds/timeline (React Bits Animated List documented behavior); visible `:focus-visible` ring on every interactive element; focus moves into Side Panel on open and restores on close (audit item D2); Escape closes panels; no keyboard traps.
  **Screen readers:** landmarks (banner/nav/main/complementary); `aria-live="polite"` for status changes (badges/toasts); `aria-live="assertive"` only for denials/unknown; financial figures in `<data>` or explicit text with currency; charts carry table fallbacks (T3 custom-SVG → we own this); 3D canvas has `role="img"` + label + the 2D rail as the accessible equivalent.
  **Contrast:** all text ≥ 4.5:1 (both directions in the proposals file); status colors ≥ 3:1 against their surface for non-text; **status never encoded by color alone** — icon + text + color (docs/03).
  **Tabular numbers:** every monetary/numeric table and count uses a face with tabular figures (font candidates in proposals; Halo Badge already ships this for counts).
  **Motion:** one global gate (`prefers-reduced-motion`): springs → fades → none; 3D auto-rotate off; camera choreography off; counters render final value instantly.
  **Touch:** ≥44px targets; hover-select disabled on touch; no hover-only information anywhere (docs/03).

## 8. Journey test scripts (what QA/demo actually clicks)

- **J1 Golden path:** onboard → Treasury (balances+chips) → event lands in Decision Room → compare 3 plans (incl. no-payment) → within-authority execute → Authority shows SUBMITTED (not settled) → provider verify → SETTLED with receipt → Replay shows the whole chain linked.
- **J2 Budget race (docs/02 B):** two missions reserve concurrently → second gets exact denial + alternative + updated spendable — proven live, not narrated.
- **J3 Bad states (docs/02 C):** unknown status retains commitment; changed beneficiary invalidates approval; expired mandate blocks before spend; paid-but-not-delivered shows both statuses separately; stale observation suspends autonomy; kill AI → manual path works; kill WebGL → 2D parity.
- **J4 Access:**
  keyboard-only golden path; reduced-motion screenshot diff; 320px + 200% zoom no-clip; screen-reader labels on the approval act.
