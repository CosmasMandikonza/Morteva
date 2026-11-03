# B-led production integration handoff — MTV-08 close-out (2026-11-03)

**Status:** founder direction recorded (PROVISIONAL B-led hybrid) in `docs/STATE.md` and issue #10. PR #25 merged to main `9303521bdab809800ef55d4050354ecaf0093742` as an **isolated design-lab and visual-evidence deliverable — not final production design approval**. This document scopes the remaining work: finalize one coherent B-led design system, then integrate it into MOTERVA's production workflows. It is a handoff, not new research — no broad reference cycle, no lab rebuild, no financial-system changes.

## Direction (founder's words, condensed)

- **B-led hybrid:** Night Sortie's cinematic operational identity + Harbour Watch's disciplined financial hierarchy, tables and information density.
- **One coherent design system**, semantic tokens, dark mode as flagship; light mode shares the same components, information architecture, behavior and financial semantics.
- **The product bar:** a distinctive, beautifully designed, functional financial operating system for physical missions — not a research-paper interface, generic SaaS dashboard, or decorative 3D demonstration.
- **The current UI is a starting point, not a finish line** — it remains subject to significant product-quality improvement.

## Preserved: the four connected product surfaces

1. **Mission Treasury** — account decomposition, spendable truth, mission envelopes/burn, exceptions.
2. **Decision Room** — one case at a time: evidence, constraints, plan alternatives with exact terms.
3. **Authority & Execution** — approve exact terms → dispatch → verify → settle, with the honest status ladder (SUBMITTED ≠ SETTLED; UNKNOWN retains commitment and resolves only by original request ID).
4. **Evidence Replay** — time-scrubbed operational truth linked to every financial commitment.

## Experience priorities (in order)

1. **Exceptional navigation** — an operator moves between the four surfaces and back to "now" without thinking; the obvious next action is always visible.
2. **Financial readability** — tabular numerals, explicit currency codes, right-aligned money, per-mission envelopes and burn at a glance (Harbour Watch density discipline on Treasury and Replay).
3. **Meaningful interactions** — every control does something real; approve/deny/defer with exact-term binding; no decorative metrics or dead buttons.
4. **Mission visualization** — the operational viewport stays a truthful view of event state (synthetic SVG staging until production 3D in #11; never the financial system itself).
5. **An obvious next action** — the interface continuously answers "what needs me now?" (exceptions queue, pending decisions, in-flight settlements).

## De-cluttering rules for the operator-facing interface

- Remove explanatory clutter, redundant badges and decorative metrics from operator screens; provenance/licensing/research material lives in `docs/` and `research/`, not the UI.
- A user must be able to **understand the problem, evaluate alternatives, authorize an exact decision and inspect its outcome without studying the architecture.**
- Keep the honest-state language ("synthetic fixtures — never verified provider funds" while synthetic; amber SUBMITTED; UNKNOWN retains commitment) — honesty is product, not clutter, and is test-enforced.

## Phase 1 (next smallest issue): B-led design ADR + semantic token system

Deliverables:

- `docs/adr/0004-b-led-design-system.md` — records the B-led hybrid decision (founder, 2026-11-03, provisional), the one-system/two-density model, dark-flagship/light-shared rules, and the token architecture.
- `design/tokens.json` (docs/03 artifact) — semantic tokens distilled from the merged lab work: surfaces, ink ramp, status ladder tones (transit/hold/verified/danger with icon+text, never color-only), authority amber accent, focus rings, spacing/type ramps, motion durations with reduced-motion gates, chart series semantics. Each token carries dark value + light value + WCAG contrast target (verified math, not aspiration).
- Token derivation table mapping each semantic token to its source in `lab-b.css` / `lab-a.css` so nothing is reinvented.

Acceptance: ADR + tokens reviewed in issue #10; contrast targets computed and recorded; fonts reconfirmed OFL via npm only; no `apps/web` production shell changes yet.

## Phase 2: production shell restyle (theme code lands only after Phase 1 review)

- Apply the semantic tokens to `apps/web` production shell (currently untouched minimal shell) — one token system, dark default, light theme switch.
- Port the four surfaces from the lab into the production app as real product screens, surface by surface (Treasury first), wired to the real API surface that exists; anything not yet backed by real capability renders an honest not-implemented state (existing pattern).
- All 25 design-lab honest-state behaviors carry over as production e2e assertions.

## Phase 3+: workflow integration (separate issues, existing boundaries)

- Decision Room → Authority handoff against real ledger/authority services (MTV-02/MTV-05 contracts; server-side authority, CSRF, roles).
- Provider execution stays with the financial agent's issue #5; **synthetic preview state is never presented as genuine Airwallex transactions**; production financial routes keep MTV-05's security restrictions (loopback-only DEMO_AUTH until a real IdP exists).
- Metal, adaptive planning, operational adapters and production 3D retain their separate issue boundaries (#6, #11, et al.). No financial rewrite, no new 3D in this track.

## Known limitations carried forward

- Native Chrome 200 % browser zoom remains a **manual acceptance check** (CDP reflow evidence is automated; native zoom is not automation-exposed — probed 2026-11-03, Chromium 156).
- Full axe-core accessibility pass lands with the production tokens (Phase 1/2).
- The lab remains available at `VITE_DESIGN_LAB=1` builds as reference material; default production builds are byte-identical to a lab-free build (verified at merge).
