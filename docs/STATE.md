# State of truth — 2026-11-02

## Verified
- GitHub repository `CosmasMandikonza/Morteva` exists, public, and was empty at audit; default branch `main`, no code, no issues or pull requests before bootstrap.
- User is accepted into Airwallex Agentic Banking Hackathon build phase.
- Organizer-provided Slack says custom builds are permitted, Metal testnet with Airwallex sandbox is a qualifying integration pathway when genuinely agentic, and submission due Nov 15 2026 11:59 PM PST.
- User's UI-reference PDF links Cult UI, React Bits, Skiper UI and Awwwards; reference approval and licensing still needed.
- Public event lists four advertised cash awards: Founder 30k, Judges 20k, Visa 15k, Metal 15k; stacking not verified.

## Foundation review findings and control gates
- Nov 2: Full documentation PR #1 manually reviewed, but no application CI or executable code tests exist yet. Found lack of integrated V0 path, oversized P0 backlog, missing risk-weighted merge policy, and external provider access dependency; mitigations documented in docs/08 and docs/09.
- A docs-only merge is not evidence of working software, independent security review, or transaction verification.
- Treat the 'no implementation' statements below as current until a verified code/financial PR changes them.

## MTV-01 bootstrap — merged PR #20, main `f0348019947b0e9abc3721450656b5e63452fb98` (Nov 2, 2026)
- Stack selected and recorded in `docs/adr/0001-stack-and-runtime.md`: npm-workspaces monorepo, Vite+React 19 web shell, Fastify 5 API, shared typed `packages/domain` + `packages/providers`; SQLite-first persistence planned behind a storage port for #4; no microservices.
- Local verification (Windows, Node v24.20.0, npm 11.19.0): `npm ci` clean install; `npm run lint`, `format:check`, `typecheck`, `build` all pass; Original agent run: Vitest 44/44 unit tests pass (domain money invariants 22, API 19, providers 3); CTO review added two provider-finality regression tests (46 total expected; exact reviewed-head CI passed); Playwright chromium E2E 5/5 pass against the real built servers (smoke incl. honest OFFLINE badges + nav, API-offline error state + recovery).
- Negative paths verified with real runs: `MOTERVA_PROVIDER_MODE=sandbox`/`testnet`/unknown, bad `PORT`, malformed `WEB_ORIGIN` each refuse startup (exit 1, actionable message, before binding a port); unknown `/api/*` and admin-style paths fail closed 404; `POST /healthz` 404; disallowed CORS origin receives no `access-control-allow-origin` header; 500 responses never leak stack traces; tampered `package-lock.json` fails `npm ci`; Node 18 rejected by `engines` + `engine-strict`.
- Browser captures at 1440×900 and 390×844 plus the API-offline error state committed under `docs/assets/` and embedded in README; visually inspected — no overlap/clipping, honest labels.
- CI `ci.yml` added: one cold-checkout job (Linux, Node 24) running install → secret scan → docs integrity → lint → format → typecheck → unit → build → Playwright e2e. `docs-integrity` workflow unchanged and passing (its link check was made path-separator-safe for Windows local runs; behavior on Linux unchanged).
- STILL NOT part of this work by design: no Airwallex/Metal adapter, no credentials read, no financial write path, no deployment, no authentication (API is read-only and fail-closed). Provider status honestly reports OFFLINE; `DEMO_SIMULATED` labeling exists for simulated mode.

## CTO review addendum on provider contracts
- Provider call status is intentionally split into submitted/processing/confirmed/failed/status-unknown; a write submission cannot return confirmed by type. The provider adapter must independently verify finality.
- Both Airwallex sandbox and Metal testnet must coexist; MTV-01's provider-mode variable is only a local scenario flag, not the future financial rail selection.
- These are new code-contract protections, not real provider integrations. PR #20 was reviewed and squash-merged with the exact-head guard. GitHub Actions CI and docs-integrity checks passed on reviewed head `aea1b992b29a25befcca5f3d29fb8f891247d580`.

## MTV-08 design research delivered — PR branch `research/mtv-08-design-references` (Nov 3, 2026)
- Verified component/reference ledger for the four user-supplied sources (Cult UI MIT; React Bits MIT+Commons Clause; Skiper UI attribution-required free tier + paid pro, recommended rejected; Awwwards art-direction study only) compiled from live inspection on 2026-11-02/03; component names, URLs, dependencies, licenses and rejected alternatives recorded per docs/03.
- Two competing visual-direction proposals (A "Harbour Watch" light/institutional IBM Plex; B "Night Sortie" dark/cinematic Space Grotesk+Inter+Geist Mono) with license- and tabular-figure-verified font stacks; **both explicitly UNAPPROVED** — founder decision brief with 4 bounded choices in `research/mtv-08/founder-decision-brief.md`. No theme code written in `apps/web`.
- 3D reconnaissance (no scene built; prototype is #11): verified CC-BY shortlists — DJI Matrice 30T/300 RTK (drone), MBARI Doc Ricketts ROV/Hercules (ROV), CC0 Poly Haven harbour HDRI; camera/perf/context-loss strategy sourced from three.js/R3F/drei docs.
- Complete screen/flow specs incl. honest-state matrix and 320–1920 + 200% zoom accessibility budgets; reproducible design rubric + 5-minute demo storyboard.
- No financial-domain files, provider ports, SQLite or shared contracts touched (MTV-02 boundary respected). Pending founder decisions: visual direction, first 3D vertical, Skiper disposition, paid-tier stance, plus unresolved "Webby Design" URL.

## NOT yet verified
No Airwallex/Metal transaction or credential, Visa eligibility, T:0 key, production deployment, approved palette/typeface, 3D asset, customer validation or economic improvements have been verified. No production money movement should be attempted. 'MOTERVA' is a product hypothesis, not an operating company with customers.

## Current environment and access
- GitHub write connection works for this repository.
- Provider credentials/access not available in this chat and **must not be requested in public issues or committed**.
- The repository name is spelled `Morteva`; the brand used in discussion is `MOTERVA`.

## Pending gates
[x] Choose exact stack and create ADR — accepted after review/merge of PR #20 (main `f0348019947b0e9abc3721450656b5e63452fb98`). No production deployment is implied.
[ ] Obtain user-approved reference board, typography/tokens and 3D asset license
[ ] Establish functioning financial engine and durable reservations
[ ] Independently verify Airwallex sandbox operation
[ ] Independently verify Metal signed testnet order + policy denial
[ ] Validate Visa award requirements and decide proceed/no-go
[ ] Integrate actual application and capture quality evidence
[ ] Record independent usability, adversarial, performance results
[ ] Validate Demo Day and submission artifacts

## Rules for this state file
Update only with dated, verifiable evidence (PR, SHA, screenshot, test log or redacted receipt). Move a checkmark only after review; record failures and access blockers. Do not claim an issue created equals implementation complete.
