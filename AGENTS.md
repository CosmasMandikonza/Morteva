# MOTERVA — instructions for AI coding agents

These instructions govern work throughout this repository. Read `README.md`, `docs/STATE.md`, `docs/01_ARCHITECTURE_AND_DOMAIN.md`, `docs/05_FINANCIAL_SECURITY_AND_PROVIDER_GATES.md`, `docs/06_TESTING_AND_DEMO_EVIDENCE.md`, then the specific assigned GitHub issue **before making changes**.

## One-issue operating procedure
1. Identify exact issue, dependencies, branch, main/base SHA, existing code and tests. Restate scope and unknowns briefly.
2. Audit rather than overwrite. Reuse existing files/components where correct; do not implement unrelated issues or rebrand the product.
3. Build one minimal **real** vertical capability with tested failure states. Prefer durable contracts over rushed UI mockery.
4. Run actual typecheck/lint/unit/integration/E2E commands as applicable. Record exact outputs and failures; never fabricate.
5. For UI/3D work, reference exact approved library component, screenshot, license and token source. Capture real browser screenshots at specified breakpoints; fix overlaps, clipping and broken camera paths before declaring done.
6. For Airwallex/Metal, preserve provider identifiers and verify state independently. Mocks must be labeled; no provider call may be claimed without proof.
7. Open a small PR linking one issue; list changed files, head SHA, evidence, negative tests, screenshots and known limitations. **Never merge automatically.**
8. Update `docs/STATE.md` with evidence-backed progress and remaining blockers, not intent.

## Safety and correctness laws
- **No secrets:** bank keys, signing seeds, access tokens, private user data or unredacted sandbox IDs in git, issues, logs, screenshots or demos. Credentials live in server-only environment/secret manager. Do not request them in public comments.
- **Server-side authority:** the model interprets evidence/proposes candidates; typed trusted code validates exact terms and money movement. No broad bank SDK/tool access to LLM.
- **Money units:** internal integer minor units by currency; Airwallex public guide describes provider API amounts in major units. Unit conversion requires explicit tests.
- **Idempotency:** persist original operation/request identity before external call. Timeout/unknown status never allows blind new transfer. Submitted is not settled.
- **Reservations:** concurrency-safe commitments by org/currency/mission; protected reserve cannot be double spent.
- **Approval:** digest binds original plan and evidence plus beneficiary, amount, currency, purpose, quote and expiry. Changed data invalidates prior authorization.
- **Provider truth:** genuine sandbox/testnet transactions only; explicitly separate Airwallex sandbox, Metal testnet and synthetic physical-world observations. No asserted real fiat-to-token bridge.
- **Asset provenance:** only licensed model, font, UI source and art references; no copying proprietary paid code or logos without rights.
- **User experience:** functionality via keyboard/touch and 2D fallback, reduced-motion support; no untested decorative controls.
- **Scope control:** do not invent framework/theme before related ADR or founder-approved references. Do not turn one issue into a full product rewrite.

## Required completion report (PR body)
- Issue and base/head SHA; precise file list; approved references; commands run and test results; browser captures at requested widths; provider receipts with sensitive details redacted; adversarial cases; accessibility; performance/asset-license proof; known failures; deployment/rollback; changes to `STATE.md`.
- If a dependency is unavailable, state **BLOCKED** and the smallest legitimate unblock action. Never use fake data to imply production or sandbox verification.

## Freeze and deadline
Organizer participant Slack extended submission to Nov 15 2026 11:59 PM PST. Avoid destabilizing changes after Nov 13; emphasize documented real results, a coherent sub-five-minute video and reviewer access.

## Product mission
One general-purpose *mission-scoped financial autonomy* engine for physical operations. 3D is a truthful view of the event state, not the financial system itself. Optimize for trusted Airwallex/Metal execution, agentic decisions, reproducibility, real product usability and a credible first buyer—not sponsor-count theater.
