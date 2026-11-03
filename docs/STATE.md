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
- Two competing visual-direction proposals (A "Harbour Watch" light/institutional IBM Plex; B "Night Sortie" dark/cinematic Space Grotesk+Inter+Geist Mono) with agent-reported font license/tabular-feature checks (full binary evidence not independently reproduced); **both explicitly UNAPPROVED** — founder decision brief with 4 bounded choices in `research/mtv-08/founder-decision-brief.md`. No theme code written in `apps/web`.
- 3D reconnaissance (no scene built; prototype is #11): agent-researched CC-BY candidates — third-party DJI Matrice 30T/300 RTK (drone) and MBARI Doc Ricketts ROV/Hercules, CC0 Poly Haven harbour HDRI. **DJI trademark/creator provenance and actual model importability remain unverified; not production-approved.** MBARI official listing and Poly Haven HDRI independently cross-checked. Camera/perf/context-loss strategy from three.js/R3F/drei docs.
- Complete screen/flow specs incl. honest-state matrix and 320–1920 + 200% zoom accessibility budgets; reproducible design rubric + 5-minute demo storyboard. Research can merge, but Issue #10 remains open until the founder sees side-by-side visual proof and approves one coherent system. React Bits component-source redistribution in this public repo requires further license diligence.
- No financial-domain files, provider ports, SQLite or shared contracts touched (MTV-02 boundary respected). Pending founder decisions: visual direction, first 3D vertical, Skiper disposition, paid-tier stance, plus unresolved "Webby Design" URL.

## MTV-02 financial foundation — merged PR #23, main `8bb231145deec082caf3c765bd34b3678d6f7fdb` (Nov 3, 2026)
- Durable financial ledger implemented in `packages/ledger` and wired into API startup (open → migrate → verify integrity → serve; corruption fails the boot). Persistence recorded in [ADR 0002](adr/0002-ledger-persistence.md) with the [schema reference](10_LEDGER_SCHEMA.md): SQLite via zero-dependency `node:sqlite` (engines.node raised to ≥24), WAL + `BEGIN IMMEDIATE` serialization, transactional forward-only migrations, append-only evidence journal (trigger-enforced), transactional outbox with claim tokens and TTL replay.
- Invariants implemented and tested: `spendable = fresh verified balance − protected floor − outstanding commitments` where outstanding includes reserved, unknown (ambiguous/escalated) and settlements finalized after the snapshot; overcommitment clamps spendable to 0 and halts autonomous spending. Approvals bind exact plan digests+terms (changed terms structurally cannot reuse an approval). Mandates are versioned; commitments derive from operation state through one pure mapping.
- Local verification (Windows, Node v24.20.0): `npm ci` clean; lint/format/typecheck/build pass; **original Vitest 122/122** (api 22, domain 37, ledger 58, providers 5); CTO-reviewed amended commit: **130/130** (api 22, domain 37, ledger 66, providers 5) and Playwright 5/5 in CI. Ledger suite includes: clean+migration rollback/downgrade/corruption/CHECK-tamper/VACUUM-backup tests; stale-snapshot rejection; mandate currency/kind/max enforcement; approval-term mismatch, consumed/expired; idempotent duplicates vs conflicts; lifecycle retention (timeout-unknown retains funds; settling before a fresh snapshot still consumes; resolving STATUS_UNKNOWN requires an attestation); append-only journal + duplicate event keys; cross-org isolation; **real worker-thread races**: 2 workers over final funds (exactly one 600k wins of 900k pool), 4-worker slice stress (never overcommits), concurrent duplicate requestIds (exactly one operation); abrupt-restart reconstruction, torn-transaction persistence-nothing, outbox claim/crash/TTL-reclaim with original request id, disabled-worker seam, submission≠settlement, synchronous provider failure → REQUIRES_HUMAN retaining exposure; recovery drift detection.
- `npm run seed:demo -w @moterva/ledger` output captured in the PR: two missions reserve 450k each from a 900k pool, consumed-approval retry rejected, over-pool attempt rejected INSUFFICIENT_SPENDABLE with the full math, integrity ok, providers contacted: NONE.
- NOT in this issue by design: no Airwallex/Metal adapter (dispatch worker ships with zero registered dispatchers — the disabled seam), no authentication (financial mutations stay at the internal service boundary; no public financial routes), no LLM planner, no 3D. `MOTERVA_PROVIDER_MODE` remains a local scenario flag, not a rail selector.


## CTO review of MTV-02 — accepted after verified financial-correctness patches
- Review of PR #23 found a high-risk gap: a crashed `SUBMITTING` dispatch could resubmit and a merely `submitted` payment could lose its reconciliation job. Worker/outbox semantics corrected: post-submission stays `IN_FLIGHT`, claim remains eligible for later provider readback; already-attempted `SUBMITTING/IN_FLIGHT/STATUS_UNKNOWN` always reconcile original request ID first. Tested with crash and pending readback cases.
- Metal's token balances cannot share ISO fiat USD minor units: `metal_order` is now explicitly `RAIL_ASSET_UNSUPPORTED` until issue #6 implements chain/token/asset-denominated accounts, exact precision, mandate and separate funding source. #6 is **not** unblocked solely by receiving credentials.
- Post-dispatch fund release and settlement now require provider-readback attestation; invalid/future balance timestamps, cross-org evidence/plan/mandate/approval association and equal-time snapshot/settlement double counting hardened with regression tests.
- These safeguards are still **internal code contracts**, not actual payment-provider verification. Real Airwallex and Metal transactions, tokens, auth, and customer-world evidence remain unverified. Exact reviewed head `80aa93aeaf47cbf893e42b11440c78211256876f` passed full CI (https://github.com/CosmasMandikonza/Morteva/actions/runs/41567982155) and docs checks; PR #23 was squash-merged, main `8bb231145deec082caf3c765bd34b3678d6f7fdb`. Main-branch CI also passed. MTV-02's internal ledger is accepted, **not** an authorization for real banking or token payments.

## MTV-08 visual validation delivered — branch `design/mtv-08-visual-validation` (Nov 3, 2026)
- Two fully rendered, interactive design candidates (A "Harbour Watch" light/IBM Plex; B "Night Sortie" dark/Space Grotesk-Inter-Geist Mono) built as an **opt-in design-lab entry** (`VITE_DESIGN_LAB=1` gate; default production builds verified byte-identical to main — lab excluded). Founder console with A/B/side-by-side compare, width + screen controls; same deterministic synthetic scenario in both.
- All interactions originally implemented — **no React Bits/Skiper source copied** (CTO gate respected); Cult UI patterns credited in the mapping table of `research/mtv-08/design-validation-report.md` with MIT production-adoption path. Fonts self-hosted via `@fontsource` (OFL). Operational viewport is an original, clearly-labeled SYNTHETIC SVG staging (no DJI marks, no WebGL claims — production 3D stays #11).
- Honest-state machine exercised by 19 Playwright tests (both candidates): SUBMITTED amber ≠ SETTLED green; STATUS UNKNOWN retains commitment, resolves only by original ID; provider-offline/stale/AI-down/3D-fallback/evidence-unavailable states; reduced-motion gates; keyboard-operable evidence pins; 320/390 px no-horizontal-scroll assertions (missions table collapses to stacked cards).
- 37 committed captures under `docs/assets/design-lab/` (both candidates × Treasury/Decision × 320–1920, Authority/Replay, submitted/unknown/offline/stale/WebGL-fallback, 200%-zoom equivalent, founder-compare console) after three critique/fix rounds (contrast, sparkline clipping, semantic chart series, decorative→semantic hero instrument, mobile stacking).
- Local verification (Windows, Node 22.14.0, on main before the MTV-02 merge): lint ✓, typecheck ✓, unit 46/46 ✓, default build ✓ (lab excluded), default e2e 5 passed + lab tests self-skip ✓, lab build + full Playwright 24 passed ✓, prettier ✓ on new files, docs/secrets scans ✓. After rebasing onto post-MTV-02 main (engines.node ≥ 24), the authoritative full-matrix verification is the PR's GitHub Actions CI (Linux, Node 24) on the exact head. CI gains a `design-lab` job (lab build + design spec). Measured lab perf: ≤69 ms load, ≤312 DOM nodes per screen; lab bundle 76.5 kB JS (19.6 gzip).
- **Both candidates remain UNAPPROVED** — decision 1 in the founder brief now points at the live lab. No `apps/web` production shell/theme changes; no financial-domain/provider/persistence files touched (MTV-02's merged code — `apps/api`, `packages/ledger`, root configs — is untouched by this branch; only `package-lock.json` was auto-merged by the rebase).

## NOT yet verified
No Airwallex/Metal transaction or credential, Visa eligibility, T:0 key, production deployment, approved palette/typeface, 3D asset, customer validation or economic improvements have been verified. No production money movement should be attempted. 'MOTERVA' is a product hypothesis, not an operating company with customers.

## Current environment and access
- GitHub write connection works for this repository.
- Provider credentials/access not available in this chat and **must not be requested in public issues or committed**.
- The repository name is spelled `Morteva`; the brand used in discussion is `MOTERVA`.

## Pending gates
[x] Choose exact stack and create ADR — accepted after review/merge of PR #20 (main `f0348019947b0e9abc3721450656b5e63452fb98`). No production deployment is implied.
[ ] Obtain user-approved reference board, typography/tokens and 3D asset license
[x] Establish durable internal financial engine and atomic commitment reservations — accepted via PR #23. Live provider execution, token-asset accounting, and authenticated approval are NOT included.
[ ] Independently verify Airwallex sandbox operation
[ ] Independently verify Metal signed testnet order + policy denial
[ ] Validate Visa award requirements and decide proceed/no-go
[ ] Integrate actual application and capture quality evidence
[ ] Record independent usability, adversarial, performance results
[ ] Validate Demo Day and submission artifacts

## Rules for this state file
Update only with dated, verifiable evidence (PR, SHA, screenshot, test log or redacted receipt). Move a checkmark only after review; record failures and access blockers. Do not claim an issue created equals implementation complete.
