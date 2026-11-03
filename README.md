# MOTERVA · Mission Treasury

**Mission-scoped financial autonomy engine for physical operations (hackathon build).** Repo name is `Morteva` (as created); product name is `MOTERVA`. This is not a production banking service.

> **Truth as of 2026-11-03:** The repository contains engineering documentation, the runnable local skeleton from MTV-01 (issue #3) **and the durable financial ledger foundation from MTV-02 (issue #4)**: org/mission/mandate/plan/approval/operation/commitment records in SQLite with atomic concurrency-safe reservations, a transactional outbox and an append-only evidence journal — all covered by unit, real multi-worker race, and restart/recovery tests. **No financial integration exists yet** — Airwallex and Metal are OFFLINE, no provider credentials are read, and no sandbox/testnet call has been made. Read [STATE](docs/STATE.md) before making claims.

## Quickstart (verified commands)

Prerequisites: **Node.js ≥ 24** (the ledger uses the built-in `node:sqlite`; see [ADR 0002](docs/adr/0002-ledger-persistence.md)) and **npm ≥ 10**. Nothing else — no database server, no docker, no accounts.

```bash
npm ci            # cold install from the committed lockfile
npm run dev       # API on http://127.0.0.1:8787, web on http://127.0.0.1:5173
```

The web app is the honest shell: primary navigation to the planned capabilities (each labelled with its tracking issue — no mock data) and a System status card fed by `GET /api/system/status` that reports providers **OFFLINE** until issues #5/#6 ship verified adapters.

### All commands

| Command                                        | What it does                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm ci`                                       | Cold install exactly from `package-lock.json` (fails if lockfile is tampered)                |
| `npm run dev`                                  | Both servers in watch mode (API + web)                                                       |
| `npm run lint`                                 | ESLint across all workspaces                                                                 |
| `npm run format:check`                         | Prettier check                                                                               |
| `npm run typecheck`                            | `tsc` strict across packages, apps, e2e and tests                                            |
| `npm run test:unit`                            | Vitest per workspace (domain, API, providers, ledger incl. race/restart tests)               |
| `npm run build`                                | Compile packages + API (`tsc`), build web (`vite build`)                                     |
| `npm run test:e2e`                             | Build, then Playwright chromium against the real servers                                     |
| `npm run check:docs`                           | Markdown link integrity + secret patterns in docs                                            |
| `npm run check:secrets`                        | Secret-pattern scan over source files                                                        |
| `npm run seed:demo -w @moterva/ledger`         | Temp-database demo: two missions contend for one pool, honest outcomes                       |
| `npm run seed:authority -w @moterva/ledger`    | Authority journey: actors → mandate/approval → reserve → revocation denials → restart replay |
| `npm run smoke:balance -w @moterva/airwallex`  | One real sandbox balance read; BLOCKED (exit ≠ 0) without server-side credentials            |
| `npm run smoke:transfer -w @moterva/airwallex` | One sandbox transfer + readback; requires credentials + beneficiary + `--confirm`            |

`npm ci` and every script above run on a cold checkout in CI (`.github/workflows/ci.yml`, Linux/Node 24). A red CI check blocks a green claim — see docs/09.

### Optional local configuration

All configuration is optional and safe by default (see [.env.example](.env.example) — **variable names only**). Copy it to `.env` and edit locally; `.env` is gitignored. Invalid values (bad port, malformed origin, unsupported provider mode) make the API **refuse to start** with an actionable message and exit code 1.

## Runbook

- **Start:** `npm run dev` (or `npm run build && npm run start -w @moterva/api` for the compiled server).
- **Liveness:** `curl http://127.0.0.1:8787/healthz` → `{"status":"ok",...}`. This is process liveness only; it never claims provider state.
- **Honest status:** `curl http://127.0.0.1:8787/api/system/status` — providers list with `OFFLINE` labels, a simulation notice, and local ledger facts (schema version, integrity, pending dispatches). The UI renders this verbatim and shows a `DEMO_SIMULATED` notice in simulated mode.
- **Failure states:** backend offline → the web shell shows an explicit "API offline" alert with a Retry button (covered by E2E). Config missing/invalid → API exits 1 before binding a port. Corrupted/failed-migration ledger → API refuses to boot; migrations run transactionally at startup ([schema doc](docs/10_LEDGER_SCHEMA.md)).
- **Financial endpoints (MTV-05):** authenticated session routes (`POST /api/auth/login|logout`, `GET /api/auth/session`) plus role-guarded, CSRF-protected financial routes (`/api/missions`, `/api/mandates` (+`/:id/revoke`), `/api/plans`, `/api/approvals` (+`/:id/revoke`), `/api/operations/reserve`, `/api/operations/:id`). Identity comes only from the session cookie → persisted actor; cross-tenant resources 404; unauthenticated 401; insufficient role / missing CSRF / missing mission grant 403 with machine-readable codes. Login + one-time dev bootstrap exist ONLY under `MOTERVA_DEV_AUTH=1` with non-production `NODE_ENV` (the config refuses to boot otherwise). Unknown routes still fail closed with 404; no provider write paths exist (issues #5/#6).
- **Airwallex rail (MTV-03):** the sandbox adapter exists and is adversarially tested, but is **DISABLED without credentials** — the API registers nothing unless `AIRWALLEX_ENV=sandbox` plus `AIRWALLEX_CLIENT_ID`/`AIRWALLEX_API_KEY` are set server-side (half-configured sandbox refuses to boot), and transfers additionally need a server-side `AIRWALLEX_BENEFICIARY_ID`. `/api/system/status` honestly reports the state (OFFLINE + credential blocker, or SANDBOX with receipt/readback counts — submitted is never settled). See [ADR 0005](docs/adr/0005-airwallex-adapter.md). No real sandbox call has been made from this repository yet.
- **Rollback:** `git revert`; ledger schema changes are forward-only migrations — do not edit applied migration files, append new ones.

## Repository layout

```
apps/web              Vite + React 19 web shell (honest status UI, primary navigation)
apps/api              Fastify 5 API: /healthz, /api/system/status, fail-closed routing, ledger boot (migrate+verify)
packages/domain       Pure typed money, lifecycles, digests and view contracts (integer minor units)
packages/providers    Provider port contracts, receipt contract, OFFLINE descriptors
packages/ledger       Durable financial ledger: SQLite (node:sqlite), atomic reservations, outbox, evidence journal, provider receipts
packages/airwallex    Airwallex sandbox adapter: verified endpoints, conservative finality, offline fixture (tests only), BLOCKED smokes
e2e/                  Playwright specs (smoke, API-offline error state, screenshot capture)
docs/                 Engineering documentation, ADRs and evidence assets
```

Stack rationale: [ADR 0001](docs/adr/0001-stack-and-runtime.md). Ledger persistence & transaction design: [ADR 0002](docs/adr/0002-ledger-persistence.md), schema reference: [docs/10_LEDGER_SCHEMA.md](docs/10_LEDGER_SCHEMA.md).

| App shell (desktop 1440×900)                                 | App shell (mobile 390×844)                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| ![App shell at 1440x900](docs/assets/app-shell-1440x900.png) | ![App shell at 390x844](docs/assets/app-shell-390x844.png) |

## Start here

- [Release epic #2](https://github.com/CosmasMandikonza/Morteva/issues/2): goals and prize-oriented release requirements.
- [Foundation review PR #1](https://github.com/CosmasMandikonza/Morteva/pull/1): audit history, findings and implementation contract.
- [Delivery dependencies / decision register](docs/07_DELIVERY_ORDER_AND_DECISIONS.md)
- [Product charter](docs/00_PRODUCT_AND_COMPETITION.md) and [operator journeys](docs/02_OPERATOR_JOURNEYS.md)
- [Financial architecture](docs/01_ARCHITECTURE_AND_DOMAIN.md) and [security/provider gates](docs/05_FINANCIAL_SECURITY_AND_PROVIDER_GATES.md)
- [Reference-led UI](docs/03_UI_REFERENCES_AND_DESIGN_GATE.md) and [3D quality](docs/04_3D_ASSET_AND_CAMERA_GATE.md)
- [Verification / demo criteria](docs/06_TESTING_AND_DEMO_EVIDENCE.md)
- [CTO risk analysis and first vertical slice](docs/08_CTO_RISK_REVIEW_AND_VERTICAL_SLICE.md)
- [Risk-weighted PR review and safe-merge protocol](docs/09_PR_REVIEW_AND_MERGE_PROTOCOL.md)
- [Truthful status](docs/STATE.md)

## Recommended issue order

**Infrastructure and finance first:** [#3 Stack/CI](https://github.com/CosmasMandikonza/Morteva/issues/3) → [#4 durable financial state](https://github.com/CosmasMandikonza/Morteva/issues/4), [#5 Airwallex sandbox](https://github.com/CosmasMandikonza/Morteva/issues/5), [#6 Metal testnet](https://github.com/CosmasMandikonza/Morteva/issues/6), [#7 exact policy/approval](https://github.com/CosmasMandikonza/Morteva/issues/7), [#8 adaptive planner](https://github.com/CosmasMandikonza/Morteva/issues/8), [#9 mission adapters](https://github.com/CosmasMandikonza/Morteva/issues/9).

**Reference-led visual work in parallel:** [#10 design approval](https://github.com/CosmasMandikonza/Morteva/issues/10) → [#11 3D asset spike](https://github.com/CosmasMandikonza/Morteva/issues/11) → [#12 Mission Treasury](https://github.com/CosmasMandikonza/Morteva/issues/12), [#13 Decision Room](https://github.com/CosmasMandikonza/Morteva/issues/13), [#14 state-linked 3D](https://github.com/CosmasMandikonza/Morteva/issues/14).

**Prove and ship:** [#15 adversarial evaluations](https://github.com/CosmasMandikonza/Morteva/issues/15), [#18 buyer/value case](https://github.com/CosmasMandikonza/Morteva/issues/18) → [#19 final release](https://github.com/CosmasMandikonza/Morteva/issues/19). [#16 Visa](https://github.com/CosmasMandikonza/Morteva/issues/16) and [#17 T:0/AWS](https://github.com/CosmasMandikonza/Morteva/issues/17) are _conditional_ and must not derail the core.

## Contribution contract

One bounded issue per PR with real commands, tests, screenshots and redacted provider evidence where applicable. Review and merge promptly when the appropriate documented risk-tier evidence is complete and the exact head SHA matches; never merge on green labels or summaries alone. No invented financial success, speculative performance claims, placeholder licensed assets or uncontrolled spending. An unknown payment state is not a failed payment and must not be blindly retried. No secrets or personal data in this **public repository**.

## Official sources

- [Airwallex builder guide](https://airwallexdev.com/guide)
- [Hackathon page](https://airwallex.hackerearth.com/)
- Participant-provided organizer Slack extended submission to **Nov 15, 2026 11:59 PM PST**. Reconfirm in submission dashboard; public page still lists an earlier date.
