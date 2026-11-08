# MOTERVA release evidence index (issue #19)

Single reviewer-oriented index of what MOTERVA can demonstrably do, where the
proof lives, and what remains honestly unverified. Everything below is backed
by code and executed evidence at a stated SHA — no claims beyond it.

## Product

- **README.md** — product overview, stack, how to run, honest state.
- **docs/release/REVIEWER_ACCESS.md** — the reviewer path (local golden path today).
- **docs/release/ACCEPTANCE_MATRIX.md** — gate-by-gate release readiness with commands and evidence.

## Source of truth for this release audit

- Integration head: `8ce4601e69a79b7307e902cbfc7fecc3737a6055`
  (`feat/mtv-19-connected-golden-path`).
- CI at that head: success — Cold checkout verify + Design lab verify
  (https://github.com/CosmasMandikonza/Morteva/actions/runs/42400198177).

## Verification suites (all rerunnable from a cold checkout)

| Suite | What it proves | Result @ audit |
|---|---|---|
| `npm ci && npm run lint && npm run typecheck && npm run build` | engineering gates | PASS at head |
| `npm run test:unit` | domain money invariants, ledger races/crash/recovery, authority, planner adversarial, airwallex adapter negative matrix | PASS on CI; local Windows 518/519 (D-1 CRLF artifact) |
| `npx playwright test` | real-UI journeys: smoke, authenticated treasury, physical→decision, judge investigation | CI green at head (2 local flakes: D-2/D-3, test-robustness) |
| `node scripts/release/verify-production.mjs` | 15 production fail-closed scenarios (boot, provenance, route 404s, CORS, refusals, corruption, redaction, shutdown) | **15/15 PASS** (local + Linux CI) |
| `node scripts/release/verify-demo-auth-security.mjs` | 12 auth/security scenarios over real HTTP with cookies (401/403/CSRF/tenant/logout/expiry/bundle/logs) | **12/12 PASS** |
| `.github/workflows/release-verify.yml` | builds both release images, boots compose with TLS edge, asserts public surface + verified in-container ledger backup | runs on every PR to this branch |
| `apps/api/src/mission-events/reliability/results/summary.md` | 45-scenario reliability matrix (issue #15) | 45/45 PASS (CI) |

## Deployment

- **deploy/README.md** — architecture diagram, deploy/verify/backup/restore/rollback runbook.
- **deploy/docker-compose.yml** + **deploy/Dockerfile** + **deploy/web/** — reproducible single-host packaging; ledger on a persistent volume; read-only public surface.
- **deploy/moterva-api.service** — hardened systemd alternative.
- Hosted URL: **not yet provisioned** (recorded honestly; the compose-boot CI
  job is the reproducible proof the packaging works). When provisioned, its
  exact release SHA will be recorded here and in `/healthz`.

## Honest state boundaries (unchanged by any release tooling)

- Physical environment: SYNTHETIC (labeled everywhere).
- Airwallex: sandbox adapter implemented, **DISABLED — no credentials** (issue #5 open).
- Metal: `RAIL_ASSET_UNSUPPORTED` until issue #6.
- No production authentication for hosted use yet; dev auth is loopback-only by construction.
- No real money movement anywhere, at any point.

## Demo materials (tracked, delivered before Nov 15)

- [ ] Under-five-minute product video from the real build (script in progress).
- [ ] Backup recorded-replay demo, clearly labeled (works offline/no-3D).
- [ ] Commercial memo + competitive matrix (issue #18, separate PR).
- [ ] Submission bundle checklist.

## Known limitations & defects

See `ACCEPTANCE_MATRIX.md` §Defects (D-1/D-2/D-3 — all test-robustness class;
none block the release claims above).
