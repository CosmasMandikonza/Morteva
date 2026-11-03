# Design evaluation scorecard, acceptance rubric, and demo storyboard — MTV-08

Reproducible checks only — anything not measurable at review time is not on this rubric (docs/06 Gate 0: never claim unmeasured quality). This file is the pass/fail contract for issues #12–#14 and the founder review.

## 1. Design-evaluation scorecard (run per candidate screen build)

Each check names the method. Score P (pass) / F (fail) / N-A, with the artifact (screenshot, log, reading) linked in the PR.

| #   | Check                                                                                                           | Method                                                     | Source                         |
| --- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------ |
| V1  | Reference fidelity: every visible component resolves to a ledger row (name + URL + license in PR)               | Diff screen inventory vs ledger                            | docs/03 §4                     |
| V2  | No invented design: font/palette/spacing values all traceable to the approved direction's token table           | Token audit vs chosen proposal                             | docs/03 non-negotiable         |
| V3  | Financial status honesty: SUBMITTED never styled as SETTLED; currency always explicit; unknown keeps commitment | Scripted state matrix render at every lifecycle state      | docs/03, AGENTS.md             |
| V4  | Status never color-only: icon + text + color for every status                                                   | Screenshot review + grayscale filter pass                  | issue #10 adversarial          |
| V5  | Contrast: text ≥4.5:1, non-text ≥3:1, both themes                                                               | axe contrast scan + manual sampling incl. status chips     | docs/06 Gate 3                 |
| V6  | Tabular figures: numeric columns show no digit-width jitter while values change                                 | Screen-record a counter/table update; measure column edges | docs/03                        |
| V7  | Reduced motion: zero spring/roll/choreography; final states instant                                             | Emulate `prefers-reduced-motion` + before/after captures   | AGENTS.md UX law               |
| V8  | Keyboard: full golden path keyboard-only incl. approval act; focus visible & restored                           | Scripted tab/arrow/enter pass                              | docs/06 Gate 3                 |
| V9  | Viewports: 320/390/768/1024/1440/1920 + 200% zoom: no clipping, no horizontal money-scroll, no panel overlap    | Playwright screenshot suite (extend MTV-01 capture job)    | docs/03 §5, docs/06            |
| V10 | WebGL off: 2D parity preserves every financial action                                                           | Block WebGL context; run J1                                | docs/08 P1                     |
| V11 | WebGL context loss: recovery or honest "paused" card; finances unaffected                                       | `WEBGL_lose_context` extension forced                      | issue #10 adversarial          |
| V12 | 3D framing: zoom extrema never clip asset or hide it behind panels; camera storyboard beats all reachable       | Manual + scripted orbit min/max captures                   | docs/04                        |
| V13 | Performance: measured FPS + draw calls + tris + load time on a mid-tier integrated GPU at 1440 and 390          | Recorded numbers with device/browser stated                | docs/04 (no unmeasured claims) |
| V14 | Asset licensing: manifest per docs/04 (author/URL/hash/license/scale/rig/textures) + in-app credits             | Manifest diff + credits screen screenshot                  | AGENTS.md provenance           |
| V15 | Dead controls: every interactive element does something real or is honestly disabled with reason                | Click inventory per screen                                 | docs/08 MVP acceptance         |

## 2. Aesthetic review gate (founder checkpoint — not self-awarded)

Presented as a live browser session (not static mocks): both directions' representative **Decision Room** build + Treasury screen at 1440 and 390, light+dark, reduced-motion on/off. Founder grades 1–5: instant credibility for a fleet-ops finance buyer; readability of the next action; does the 3D feel like a truthful view of money state (not decoration); distinctiveness vs generic AI dashboard. A direction proceeds only at ≥4 on credibility and next-action; ties break toward the direction with fewer licensing/motion risks.

## 3. Five-minute demo storyboard (docs/06: sub-five-minute requirement)

| Beat | Time      | Screen                | What the reviewer sees (all real states, no fakery)                                                                                                                           |
| ---- | --------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 0:00–0:25 | Onboarding            | Mandate wizard: envelope, reserve floor, per-action limit, counterparties, expiry — explicit constraints, compiled review, digest                                             |
| 2    | 0:25–1:00 | Mission Treasury      | Balances with provider chips + timestamps; available/reserved/pending/spendable separated; environment labels                                                                 |
| 3    | 1:00–2:15 | Decision Room         | Inspection event lands (3D camera event-focus); three alternative plans incl. no-payment; uncertainty + policy verdicts; reserve happens on selection                         |
| 4    | 2:15–3:00 | Authority & Execution | Approve exact immutable terms; SUBMITTED shown honestly amber; kill-and-retry path denied (digest mismatch); provider verification flips to SETTLED with receipt + request ID |
| 5    | 3:00–3:40 | Evidence Replay       | Scrub the journal: event → plan → approval → provider receipt → operating outcome; financial vs operating status separated                                                    |
| 6    | 3:40–4:20 | Adversarial pass      | Budget race denial with exact reason; STATUS_UNKNOWN retains commitment; WebGL blocked → full 2D parity                                                                       |
| 7    | 4:20–5:00 | Wrap                  | Environment labeling everywhere; credits/attribution screen; one-screen buyer value statement                                                                                 |

Recording rules: real clock, visible environment chips, no cuts that hide loading/error states (docs/08: click path, error, accessible fallback on tape).

## 4. Loading & performance budgets (targets to verify in #12–#14; stated as targets, not achievements)

- Web shell first contentful paint without 3D bundle: 3D route is code-split; Mission Treasury usable before three.js loads.
- Hero GLB: ≤150k tris post-compression (A1 base or decimated A2), Draco/Meshopt, progress UI; ≤8MB over the wire target.
- Interactions: state transitions ≤100ms perceived (springs may settle longer but meaning is instant — text/status flips immediately, motion is decoration after the fact).
- Charts: SVG (no chart lib); feed virtualization beyond 100 rows must be implemented and verified separately; Animated List motion/selection is **not** proof of windowed virtualization. Do not use it alone for unbounded financial-event streams.
