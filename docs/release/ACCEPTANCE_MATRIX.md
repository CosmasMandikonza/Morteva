# MOTERVA release acceptance matrix — issue #19

Independent release-readiness audit of the integration branch
`feat/mtv-19-connected-golden-path` at exact head
**`8ce4601e69a79b7307e902cbfc7fecc3737a6055`**, executed 2026-11-08 by Agent E
(release engineering). No PR description, issue checkbox or agent claim was
accepted as evidence; every PASS below was reproduced by running the actual
system on a cold checkout (Windows 11, Node v24.20.0, npm 11.19.0) and/or is
backed by CI on the exact head. CI green on an older commit counts for
nothing here.

States: `PASS` · `FAIL` · `BLOCKED` · `NOT_TESTED` · `NOT_APPLICABLE`.

Environment of record: local cold checkout at 8ce4601 (`npm ci` clean, 0
vulnerabilities), CI runs at that head (Cold checkout verify + Design lab
verify: success, https://github.com/CosmasMandikonza/Morteva/actions/runs/42400198177).

## Summary

| # | Gate | State | Owner |
|---|------|-------|-------|
| 1 | Frontend runtime | PASS | Agent B |
| 2 | API runtime | PASS | Agent A |
| 3 | Authentication | PASS (loopback DEMO_AUTH only) · hosted reviewer auth BLOCKED on Agent A | Agent A |
| 4 | Mission creation | PASS | Agent A |
| 5 | Mandate issuance | PASS | Agent A |
| 6 | Planner decision | PASS | Agent A |
| 7 | Durable evaluation | PASS | Agent A |
| 8 | Plan proposal | PASS | Agent A |
| 9 | Independent approval | PASS | Agent A |
| 10 | Reservation & dispatch | PASS (offline rail; provider dispatch BLOCKED on #5) | Agent A/D |
| 11 | Airwallex sandbox readback | BLOCKED — credentials | Agent D |
| 12 | Metal testnet verification | BLOCKED — #6 RAIL_ASSET_UNSUPPORTED | Agent D |
| 13 | Physical evidence synchronization | PASS (SYNTHETIC sources, labeled) | Agent C/A |
| 14 | 3D viewport & 2D fallback | NOT_TESTED in production shell (dependency #11) | Agent C |
| 15 | Journal integrity | PASS | Agent A |
| 16 | Tenant isolation | PASS | Agent A |
| 17 | Deployment | PASS — packaging + production-boot verified; compose-boot verified in CI (release-verify) | Agent E |
| 18 | Judge access | PARTIAL — local golden path PASS; hosted full journey BLOCKED on reviewer auth | Agent A/E |
| 19 | Final demo materials | IN PROGRESS (this PR + follow-ups) | Agent E |

## Detail per gate

### 1. Frontend runtime — PASS
- SHA: 8ce4601 · Command: `npm ci && npm run build` then `npm run preview -w @moterva/web -- --port 4173` (via Playwright webServer).
- Expected: built shell serves and boots. Actual: build OK (JS 269.23 kB / gzip 81.96 kB, CSS 27.41 kB); all E2E specs drive the real preview server; 17 passed (see gate 18 notes for the 2 local flakes).
- Evidence: local run 2026-11-08; CI e2e step green at head (run 42400198177).

### 2. API runtime — PASS
- Command: `node apps/api/dist/index.js` (compiled dist; the same artifact the container runs).
- Expected: config validation → ledger migrate → integrity verify → listen; honest warnings. Actual: boots in development and production modes; `verify-production.mjs` P1 PASS (`/healthz` `status:"ok"`, gitSha provenance echo).
- Evidence: `scripts/release/verify-production.mjs` → 15/15 PASS (2026-11-08, local; re-run on Linux in `release-verify` CI).

### 3. Authentication — PASS for what exists · hosted reviewer auth BLOCKED
- What exists: scrypt credentials, HttpOnly/SameSite=Strict session cookie, CSRF-bound mutations, login rate limiting, role model — all under the loopback-only DEMO_AUTH gate.
- Release-level proof (real HTTP, real cookies): `scripts/release/verify-demo-auth-security.mjs` → 12/12 PASS: anonymous 401 (S1/S2), bad credentials 401→429 (S3), viewer mutation 403 + state provably unchanged (S4), CSRF missing/wrong 403 + nothing created (S5), cross-org 404 (S6), logout stale-cookie 401 (S7), session isolation (S8), TTL expiry mid-session 401 (S9), bundle secret scan (S10), log redaction at trace level (S12), one-time dev-bootstrap 409 (S11).
- Structural guard verified: production + `MOTERVA_DEV_AUTH=1` refuses startup (P5); non-loopback HOST refused (P6); non-loopback WEB_ORIGIN refused (P7). The hosted deployment therefore CANNOT accidentally expose dev auth.
- BLOCKED: a real (non-dev) reviewer authentication surface for the hosted demo — owned by Agent A. Until then the hosted app is read-only by construction (see gate 17) and reviewer golden-path access is the documented local demo (`docs/release/REVIEWER_ACCESS.md`).

### 4–9. Mission → mandate → planner → evaluation → proposal → approval — PASS
- Commands: `npx playwright test e2e/authenticated.spec.ts e2e/physical-decision.spec.ts e2e/investigation.spec.ts` (real UI against the real seeded API), plus `npm run test -w @moterva/planner -w @moterva/api`.
- Expected/actual: authenticated treasury journey renders real ledger data (missions, effective authority excluding clock-lapsed mandate, envelope math, provenance chip "DEMO_AUTH · seeded internal ledger — not Airwallex funds"); the synthetic incident changes the planner's real selection (ASSET_SAFETY_BLOCKED → Hire vessel-inspection) in the serial run; plan/approval/reservation contracts hold (planner 112/112, api 152/153 unit — see Defects).
- Evidence: local runs 2026-11-08; CI unit+e2e green at head.

### 10. Reservation & dispatch — PASS (offline rail) · provider dispatch BLOCKED
- Ledger reservations reserve/settle/reverse with readback-only settlement, outbox claims, crash-safe reconciliation — 105/105 ledger unit tests at head.
- BLOCKED: dispatch to Airwallex needs sandbox credentials (issue #5 — founder action); Metal is `RAIL_ASSET_UNSUPPORTED` until issue #6. No provider call is claimed.

### 11. Airwallex sandbox readback — BLOCKED
- Dependency: privately provided AIRWALLEX_CLIENT_ID/API_KEY + sandbox beneficiary (issue #5). Adapter merged disabled (PR #30). Status endpoint honestly reports "Adapter implemented … DISABLED" (verified: P1b asserts `label:"OFFLINE"` + DISABLED detail).
- Verification command once unblocked: `npm run smoke:balance -w @moterva/airwallex`, then `npm run smoke:transfer … --confirm` (capped USD 20, durable single intent).

### 12. Metal testnet verification — BLOCKED
- Dependency: issue #6 (chain/token-denominated accounts) — explicitly not unblocked by credentials alone.

### 13. Physical evidence synchronization — PASS (SYNTHETIC, labeled)
- Command: `npm run test -w @moterva/api` (mission-events family incl. 45-scenario reliability matrix, issue #15: physical-evidence 26/26, financial-interaction 12/12, baseline-comparison 7/7 — CI-green at head; see Defect D-1 for the Windows CRLF artifact).
- Signed SYNTHETIC observations enter the real append-only journal through the ingest seam; replay exposes safe identifiers only (#19 projection). No physical claim is presented as field truth.

### 14. 3D viewport & 2D fallback — NOT_TESTED (production shell)
- The production shell has no WebGL viewport yet (design-lab staging is explicitly SYNTHETIC SVG; production 3D is issue #11, Agent C). Nothing to verify at release level; not claimed.

### 15. Journal integrity — PASS
- Command: `node scripts/release/verify-production.mjs` → P8 (corrupt ledger refuses boot, exit 1, "refusing to start — ledger … integrity"), plus ledger unit corruption/tamper/VACUUM suite 105/105 at head.

### 16. Tenant isolation — PASS
- Release-level: S6 (cross-org mission 404 + never listed) over real HTTP. Unit-level: ledger + API cross-org isolation suites at head.

### 17. Deployment — PASS (packaging + production-boot; container boot verified in `release-verify` CI)
- Deliverables: `deploy/` (Dockerfile ×2, compose topology, Caddy edge with automatic TLS + no-store on /api/*, hardened systemd alternative, online verified backup, env template, runbook incl. rollback) + `.github/workflows/release-verify.yml`.
- Local proof: verify-production.mjs 15/15 (production mode: fail-closed 404s, CORS strict both directions, no stack traces, log redaction, all bad-config refusals, corruption refusal, SIGTERM — Linux CI run of P11).
- Container proof: `release-verify` CI job builds both images at the PR SHA, boots compose with staging TLS, asserts healthz gitSha, honest status, `/api/missions` 404, `Cache-Control: no-store`, HSTS/nosniff, static shell, and runs a verified in-container ledger backup.
- Persistent ledger on a named volume, single SQLite writer by construction, no dev-auth possible, no provider credentials shipped. Nothing is announced as publicly "ready" — the hosted surface is honestly read-only until gate 3's real auth lands.

### 18. Judge access — PARTIAL
- PASS: the local reviewer path — cold checkout → `npm run build` → `node e2e/scripts/demo-auth-server.mjs` (+ web preview) → documented credentials → full mission-to-money journey; `docs/release/REVIEWER_ACCESS.md` is the step-by-step.
- BLOCKED: hosted full journey for an external reviewer (needs gate 3 real auth — Agent A). Hosted reviewers today see the shell + honest system status only.
- Note (defects D-2/D-3): two E2E tests are flaky locally; both are test-robustness issues, not product failures (details below). CI passed them at head with `retries: 1` enabled.

### 19. Final demo materials — IN PROGRESS
- This PR delivers the audit, deployment kit, security suites and evidence index. The demo script/video, commercial memo (issue #18) and submission package follow as separate scoped PRs before Nov 15 (freeze discipline: no destabilizing changes after Nov 13).

## Defects found during this audit (reported to owners; not patched by Agent E)

- **D-1 (P2, test robustness, owner Agent A/MTV-13):** `apps/api/test/mission-events/reliability.test.ts` "committed artifacts regenerate byte-for-byte" fails on any Windows `core.autocrlf=true` checkout — committed LF blob vs regenerated LF string compared against CRLF on-disk bytes. Reproducer: `npm run test -w @moterva/api` on Windows. CI (Linux) green at head. Fix hint: normalize line endings when reading the artifact.
- **D-2 (P1, test robustness, owner #19 E2E authors):** `e2e/investigation.spec.ts:88` reads `position.textContent()` once immediately after login with no retry/wait — races the async `/api/financial/overview` render. Failed 3/3 local runs; API verified correct by direct HTTP (EUR spendable 46,900.00 / USD 164,000.00, exact engine math). Passed at head in CI only because Playwright `retries: 1` re-ran it. Fix: use auto-retrying `expect(...).toContainText` like the sibling test, or await a data-loaded testid.
- **D-3 (P1, suite isolation, owner #19 E2E authors):** `e2e/physical-decision.spec.ts` fails under default local parallelism (`fullyParallel` + shared seeded demo server; concurrent synthetic-step mutations across specs reorder the timeline) and passes with `--workers=1`. CI uses `workers: 2` + retries and passed at head. Fix: per-test mission isolation or serial mode for mutating specs.

## Environment & tooling notes

- Audit host: Windows 11 (win32 10.0.26200), Node v24.20.0, npm 11.19.0, Git Bash; Playwright chromium from host cache.
- No Docker on the audit host: container assertions execute in the `release-verify` GitHub Actions job (Linux) — recorded honestly rather than claimed locally.
- Unit totals at head (local, Windows): api 152/153 (D-1), planner 112/112, airwallex 106/106, ledger 105/105, domain 38/38, providers 5/5 → 518/519 local; CI at head green.
