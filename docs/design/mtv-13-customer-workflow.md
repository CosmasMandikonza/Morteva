# MTV-13 — the customer-operated workflow (Agent B)

**Branch:** `feat/mtv-20-product-design` · **PR:** #65 (stacked on Agent C's #64 until #64 merges first) ·
**Scope:** `apps/web/**`, `e2e/**`, `docs/**`. No backend, deploy, Airwallex or Metal file is touched.

A new customer can configure a mission nobody has seen before, receive authenticated operational
evidence from their own system, obtain a financial decision that follows their inputs, pursue
governed approval and inspect durable evidence — all through the real application. Nothing in this
path is a fixture route, a scripted incident button or a hardcoded customer outcome.

## The workflow, as the operator experiences it

| # | Step | Surface | What is real |
| - | ---- | ------- | ------------ |
| 1 | Create the mission | Mission Treasury | `POST /api/missions` |
| 2 | Author the specification: assets, trusted sources, thresholds, economics, suppliers | **Mission Setup** | empty form (no seeded example numbers); exact minor-unit parsing; server-parity validation; derived mandate shape |
| 3 | Exact review, then register | Mission Setup | `POST /api/missions/:id/mission-spec` (operate + CSRF; server re-stamps tenant identity) |
| 4 | Onboard a source: issue a signing credential | Mission Setup | `POST …/sources/:sourceId/secret` — shown **once**, memory-only, masked until Reveal |
| 5 | Grant spending authority (suggestion prefilled from the spec; a human reviews and submits) | Mission Setup | `POST /api/mandates` (owner/admin) |
| 6 | The customer's own system signs and sends FIELD evidence — **no browser, no cookie, no CSRF** | outside the app (guide in Mission Setup) | `POST /api/machine/missions/:id/events` (Agent C) |
| 7 | See the authenticated journal, evaluate from it, compare alternatives | **Decision Room** | `GET /operations/decision`, `POST /operations/evaluate`, `GET /physical-view` |
| 8 | Propose an immutable plan from the recorded evaluation (ID-only) | Decision Room | `POST …/decision-snapshots/:id/propose-plan` |
| 9 | A different person approves exact terms | Decision Room | existing separation-of-duties flow |
| 10 | Inspect durable evidence; reload reconstructs it | Evidence Replay | journal-verified records |

Key rotation: issue a **new** key id, switch the sender, then revoke the old one in Mission Setup
(`POST …/keys/:keyId/revoke`, owner/admin). Revocation is immediate, survives restart and is
irreversible; admitted events stay valid history.

## Decision language (what the operator reads)

* **NO ACTION — HOLD THE CURRENT PLAN**, **DECLINED — NOTHING PERMITTED**, **ESCALATED — HUMAN
  DECISION**, **SPEND PROPOSED — AWAITING HUMAN APPROVAL** are four distinct, first-class outcomes
  (`lib/decisionCopy.ts`). A spend is never described as approved; no-action/decline/escalate
  disable the propose button and explain why.
* Every alternative shows exact currency-aware gross cost and expected net, whether it was
  eligible/selected/refused, and the typed refusal code **in plain words** (every planner rejection
  code has copy — enforced by a drift test against the planner contract).
* Raw `"34545500 minor"` quoted in server reason texts is rewritten to `USD 345,455.00`.
* Assumptions are named: success probabilities are the customer's own; the balance observation is an
  internal ledger observation, not provider-verified.

## Truth boundary (printed on the Decision Room, always)

* **FIELD = a credential-authenticated registered source _claimed_ the observation** — MOTERVA
  verifies who signed it, not that the sensor is right. SYNTHETIC is labelled "not a field
  measurement".
* Decisions are deterministic policy and **propose only**; model absent ⇒ **POLICY-ONLY**
  (a contributing adapter is shown by id when a recorded evaluation says so).
* **Airwallex: OFFLINE · UNVERIFIED**, **Metal: NO RECEIPT** — no provider state is implied.

## Credential custody (browser side)

The secret exists **only** in the one issuance response. It is requested with `cache: 'no-store'`,
held in component memory only, masked until the operator presses Reveal, never written to
`localStorage`/`sessionStorage`/URL/console/analytics, and cleared on dismissal, on unmount (sign-out,
session expiry, mission change) and by a 5-minute hard timer. The dialog cannot be dismissed (Escape
or Close) until the operator confirms it was stored. Screenshots mask it (`mask:` option) and are
taken after dismissal; the e2e journey asserts the secret is absent from the page, from browser
storage and from every API read the app makes (spec, decision, snapshots, plans, both evidence
topics, physical view).

## Contract consumed (Agent C, PR #64 at `66e12e1`)

`POST …/mission-spec` · `POST …/sources/:id/secret` · `POST …/sources/:id/keys/:keyId/revoke` ·
`POST /api/machine/missions/:id/events` (credential-only; cookie-bearing requests refused;
the old session route answers `410 EVENTS_ROUTE_MOVED`) · `GET …/operations/decision` ·
`POST …/operations/evaluate` · `POST …/model-interpretation` · existing snapshot/proposal/evidence
reads. **Requests still open on #64** (UI degrades gracefully and labels each): declared `sources[]`
and non-secret credential inventory on `GET …/mission-spec`; candidate/causality detail on
`GET …/decision-snapshots`; `causality.physicalObservations` derived from source provenance (it is
hardcoded `SYNTHETIC_JOURNAL`; the UI derives provenance per event itself); an events list that does
not depend on the viewer's single-aerial-asset contract; baseline derivable after several events
(`BASELINE_WINDOW_CLOSED`); `sourceId`/`provenance` in the evidence projection of
`mission.event.ingested`.

## Responsive and zoom (owned here, no clipping)

The 320px defect was a layout bug, not something to hide. Root causes fixed at the source: `auto`
grid tracks sized to the widest token's min-content (digests, ids), tokens and badges with no wrap
rule, a ≥362px intrinsic floor in the viewer module (long event ids in a `1fr` track), and a HUD that
covered the small scene. Now: shrinkable tracks (`minmax(0, 1fr)`) on every single-column grid, long
tokens wrap (`overflow-wrap`), the HUD stacks **below** the scene at ≤640px (the scene keeps a 4:3 box
and stays visible), the sticky header only sticks where the viewport can spare it
(`min-width: 721px` and `min-height: 620px`; `scroll-padding-top` keeps focus out from under it), and
**every earlier overflow-clipping hack was removed** (`contain: size`, `overflow: hidden !important`,
hiding the canvas, root `overflow-x`). The e2e asserts at 320/390/640 (the viewport of a 200%-zoomed
1280px window)/1024: no horizontal scroll, scene rendered at a real size, HUD below the scene, no
element hiding overflow, the primary action reachable and not obscured.

## Verification

* **Unit (apps/web, 47 tests):** form conversion/validation incl. **every emitted spec passing the
  real server `validateMissionSpec`**; banking-term list and observation vocabulary parity with the
  API source; the printed headless signer **executed against the API verifier**; stage law; planner
  rejection-code copy drift guard; exact minor-unit rewriting.
* **E2E — `e2e/customer-journey.spec.ts`** (real browser, real API, zero fixtures): founder authors an
  _unseen_ quarry-survey mission → registers it → one-time credential (masked, Escape/Close inert,
  absent from storage and responses) → grants authority → a **bare headless client** (no cookie, no
  CSRF) submits signed FIELD events; a cookie-bearing request is refused
  (`MACHINE_SURFACE_BROWSER_FORBIDDEN`), the old route answers 410, forgery → `SIGNATURE_INVALID`,
  foreign mission refused, replay → `DUPLICATE_EVENT` → operator evaluates: baseline = **NO ACTION**;
  breach of the unseen 27 kt limit (29.3 kt) = a **different supplier at a different price**
  (`USD 76,050.00`, incumbent refused `ASSET_SAFETY_BLOCKED`) → immutable proposal → a different
  person approves exact terms → Evidence Replay → reload → no secret in any read → request spy proves
  **zero fixture-route calls**.
* **E2E — `e2e/customer-states.spec.ts`:** empty/invalid inputs (no server write), spec-id collision
  (`SPEC_ID_COLLISION` explained), signed-out, viewer read-only, session lost mid-flow, empty journal,
  no-mandate **decline**, closed baseline window explained, 5xx/409 read failures (no fabricated
  alternatives), key rotation + revocation through the UI (revoked key `403 CREDENTIAL_REVOKED`,
  replacement accepted, revoked id never re-issuable, operators cannot revoke), 5-minute secret TTL
  (fake clock), responsive ladder.

Reproduce: `npm ci && npm run build && npx playwright test e2e/customer-journey.spec.ts
e2e/customer-states.spec.ts --workers=1` (CI runs them as a serial step). Evidence images:
`CAPTURE=1 npx playwright test e2e/capture-customer-workflow.spec.ts --workers=1` →
`docs/assets/production/mtv-13-customer-*.png` (dark + light, 1440 → 320, 640×450 = 200% zoom, the
credential dialog **masked**).

## Acceptance matrix

| Criterion | Result |
| --------- | ------ |
| Customer-created mission configuration through the production API (arbitrary assets, sources, thresholds, economics, suppliers, constraints) | **PASS** — unseen mission registered; every emitted spec passes the server validator |
| Authenticated FIELD observations read from the real journal; no demo buttons in the customer path | **PASS** — zero fixture-route calls asserted; demo entry points exist only for demo missions, labelled |
| Source onboarding with one-time credential custody; never in storage/screenshots/evidence | **PASS** — asserted in DOM, storage and every read; capture masks it |
| Alternatives, costs, feasibility, refusal reasons, uncertainty, no-action/escalation | **PASS** (no-action, decline, spend asserted in a real browser); **escalate** is covered by the outcome classifier and server counterfactual tests but not driven in a browser (no deterministic contradiction input is exposed by the API) |
| Immutable proposal → separate approval → provider status → Evidence Replay, correct identities | **PASS** — provider state stays OFFLINE/unverified; no settlement implied |
| Existing industry-aware design, 3D viewer, mission-context fix, prior tests retained | **PASS** — full suite 66/66 locally (3 consecutive runs) |
| `.mpv` clipping owned and fixed (usable at 320 and 200% zoom, not merely scrollWidth) | **PASS** — root-caused, hacks removed, usability asserted |
| Real-browser tests with unfamiliar values, auth failures, empty, invalid, refresh, persistence, mobile | **PASS** |

## Honest limitations and external blockers

* **Escalation in the browser:** not exercised (see above).
* **Credential inventory after reload:** the read API does not list declared sources/keys yet, so the
  source field becomes a text input and key ids issued in a previous session are not listed
  (requested on #64).
* **Baseline window:** several observations before a baseline evaluation close the window
  (server rule); the UI explains it instead of offering a refused action (change requested on #64).
* **Evidence projection** does not yet carry `sourceId`/`provenance` for ingested events, so Evidence
  Replay shows identity and digest but no FIELD badge per event (requested on #64).
* **200% zoom** is validated as the equivalent CSS viewport (640×450); Playwright cannot drive native
  browser zoom.
* **Live model, Airwallex, Metal:** unchanged external blockers — founder-provisioned provider
  access; no external transaction is made or implied.
* **Historical images:** `mtv-20-*`, `mtv-13-final-*` and `mtv-08-5-*` captures predate this workflow
  (several show the retired "viewer unavailable" card or the old sheet layout). They are history, not
  evidence of the current UI — use `mtv-13-customer-*`.
