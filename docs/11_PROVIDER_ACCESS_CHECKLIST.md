# Provider Access Checklist — real-money gates (issues #5, #6)

Status: **BLOCKED — no authorized provider access exists.** This checklist is
the audit the decision-to-authority milestone (issue #19, A4) owes: what the
merged Airwallex adapter (PR #30) already enforces, and the exact non-secret
prerequisites still missing before any genuine provider verification can
happen. Nothing here solicits or publishes credentials; all secrets stay in
private server configuration.

## What is already built and safe (PR #30, merged `51107e7`)

- `packages/airwallex` implements the full provider contract: config gate,
  fixture/sandbox transports, dispatcher, request-id minting, payload
  minimization, money mapping, and status reporting. 106 unit tests.
- The adapter is **disabled by construction**: it activates only when
  `AIRWALLEX_ENV=sandbox` AND server-side `AIRWALLEX_CLIENT_ID` /
  `AIRWALLEX_API_KEY` are present. Without them every status probe reports
  `disabled: no sandbox credentials configured` and **no provider call is
  made or claimed**.
- `AIRWALLEX_BASE_URL` may only override to the exact sandbox origin; any
  other value is rejected (no production endpoint is reachable).
- The dispatcher is registered only through explicit server wiring; the
  demo/decision paths in this milestone register none, so reservations stay
  internal-ledger-only (verified by test: outbox entries sit `pending`
  forever, `provider_receipts` stays empty).
- Secrets are read from the server environment only (`apps/api/src/config.ts`
  allowlist); none are committed, logged, or returned by any API.

## Missing prerequisites (all non-secret) — issue #5 stays OPEN

| # | Prerequisite | Status |
| --- | --- | --- |
| 1 | Airwallex sandbox account created by the account owner | MISSING |
| 2 | `AIRWALLEX_CLIENT_ID` / `AIRWALLEX_API_KEY` issued for that sandbox and placed in private server config | MISSING (credentials never enter this repo) |
| 3 | `AIRWALLEX_ENV=sandbox` set in the deployment environment | MISSING |
| 4 | Sandbox beneficiary id configured privately (`AIRWALLEX_BENEFICIARY_ID[_<orgId>]`) matching a mandate allowlist | MISSING |
| 5 | Sandbox funding (play-money balance) confirmed in the Airwallex dashboard | MISSING |
| 6 | A separate, explicit engineering authorization to enable even one sandbox transfer or testnet purchase | NOT GIVEN |

Until all six exist, issue #5 remains the single open gate for genuine
Airwallex sandbox verification, exactly as recorded in
[STATE.md](STATE.md). No transfer, payout, or testnet purchase may be
attempted without that separate authorization.

## Metal / testnet (issue #6) — additionally blocked

The ledger already refuses metal rails with `RAIL_ASSET_UNSUPPORTED`
(`packages/ledger/src/services/mandates.ts`): tokenized assets cannot be
funded from fiat treasuries and need their own asset accounting, precision,
and custody review first. Beyond the Airwallex prerequisites above, Metal
needs: token-asset ledger accounts (issue #6 scope), a funded testnet wallet
held privately, and its own authorization. Nothing in this milestone touches
that rail.

## How verification will be evidenced once unblocked

When the prerequisites exist, evidence goes through the existing provider
receipt journal (append-only `provider_receipts` + evidence events) with the
sandbox response ids and the operation's ledger ids — never screenshots or
prose claims. Until then every surface that could imply provider contact
reports the honest `disabled` status above.
