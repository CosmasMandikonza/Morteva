# @moterva/metal — Metal Blockchain (Tahoe testnet) adapter

Genuine mandate-controlled USDZ testnet purchases for MOTERVA's paid-diagnostics
journey (issue #6). See [ADR 0007](../../docs/adr/0007-metal-testnet-adapter.md)
for the decision record and
[the ledger contract request](../../docs/contracts/metal-ledger-contract-request.md)
for what Agent A must land before the worker rail opens.

**Status:** adapter complete and adversarially tested offline (60 tests). The
real-testnet gate is BLOCKED on the hackathon Metal guide's USDZ token address +
a funded Tahoe wallet + an explicit owner-authorized purchase. Nothing here
claims a live chain interaction until one produces real receipts.

## Verified environment facts (docs.metalblockchain.org, checked 2026-11-08)

- Tahoe testnet C-Chain (EVM) RPC: `https://tahoe.metalblockchain.org/ext/bc/C/rpc`
- Chain ID `381932` (symbol METAL) · Explorer `https://tahoe.metalscan.io/`
- Faucet `https://faucet.metalblockchain.org` (testnet METAL for gas only)
- USDZ on Tahoe: NOT publicly documented — supplied by the hackathon Metal
  guide as configuration; the adapter re-verifies `decimals()`/`symbol()`
  on-chain before any payment.

## Server-only configuration (never commit, never log)

| Variable                                    | Meaning                                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `METAL_ENV`                                 | must be `testnet` (anything else refuses startup)                                                        |
| `METAL_SIGNER_PRIVATE_KEY`                  | 0x + 32-byte hex wallet key — server env only, never in git/issues/logs                                  |
| `METAL_USDZ_TOKEN_ADDRESS`                  | USDZ contract on Tahoe (from the hackathon guide; verified on-chain at connect)                          |
| `METAL_USDZ_DECIMALS` / `METAL_USDZ_SYMBOL` | expected token metadata, cross-checked against the chain                                                 |
| `METAL_MERCHANT_ADDRESS`                    | the ONLY payee the rail may send to (per-org override: `METAL_MERCHANT_ADDRESS_<orgId>`)                 |
| `METAL_MAX_PURCHASE_MINOR`                  | adapter-boundary per-purchase cap (token minor units)                                                    |
| `METAL_FINALITY_CONFIRMATIONS`              | explicit finality threshold (default 12)                                                                 |
| `METAL_RPC_URL`                             | locked to the official Tahoe endpoint while credentials are configured (any override is a startup error) |

Smoke-only: `METAL_SMOKE_PRICE_MINOR`, `METAL_SMOKE_VALUE_MINOR`,
`METAL_SMOKE_MANDATE_EXPIRES_AT`, `METAL_SMOKE_VENDOR_ID`, `METAL_SMOKE_PRODUCT_NAME`,
`METAL_SMOKE_REPORT_URL`, `METAL_SMOKE_ORG_ID`, `METAL_SMOKE_MISSION_ID`,
`METAL_SMOKE_PURPOSE`, `METAL_SMOKE_STATE_DIR`.

## Secret management and recovery

- The signer key exists ONLY in the server environment of the process that
  signs. It is never persisted, never logged, never returned in any view, and
  never enters a provider receipt (receipts are allowlisted-minimized; the key
  is not an allowed field anywhere).
- Exfiltration boundary: while credentials are configured, signed traffic is
  locked to the exact official Tahoe RPC origin — a hostile `METAL_RPC_URL`
  override fails startup, the transport asserts the origin before every call,
  and cross-origin redirects fail closed.
- **Recovery of an interrupted purchase:** rerun the same command WITHOUT
  `--new-intent`. The durable intent (state dir) + receipt journal reconcile
  the ORIGINAL signed transaction by hash — never a second economic operation.
  The EVM nonce makes double-spend structurally impossible for one intent.
- **State-file loss:** a missing or corrupt `state.json` never authorizes a
  new payment while a prior intent exists; resolve manually. `--new-intent`
  requires the prior intent resolved (definitive on-chain outcome) and
  archives — never deletes — the prior identity.
- **Key rotation:** generate a new Tahoe wallet, fund it from the faucet,
  update `METAL_SIGNER_PRIVATE_KEY` and `METAL_MERCHANT_ADDRESS`-adjacent
  config privately; prior operations keep reconciling by their recorded
  identity (hash + nonce are key-independent).

## Gated smoke procedures

```bash
npm run build:packages

# 1) Real balance read (needs funded wallet; BLOCKED exit otherwise)
npm run smoke:balance -w @moterva/metal

# 2) Mandate-bounded testnet purchase journey (needs --confirm; BLOCKED exit otherwise)
METAL_SMOKE_PRICE_MINOR=2500000 \
METAL_SMOKE_VALUE_MINOR=8000000 \
METAL_MAX_PURCHASE_MINOR=5000000 \
METAL_SMOKE_MANDATE_EXPIRES_AT="2026-11-16T00:00:00Z" \
npm run smoke:purchase -w @moterva/metal -- --confirm
```

Exit codes: `0` confirmed/declined · `1` requires-human/unverified · `2` blocked.
Every run reports which decision gate fired (`INFORMATION_NOT_WORTH_PRICE` is
the no-purchase case, a first-class outcome). Settlement and delivery are
reported as separate facts; the diagnostic vendor in the smoke is SYNTHETIC
and labeled.

## Tests (offline, deterministic)

```bash
npm run test -w @moterva/metal
```

The simulated chain derives receipts from the ACTUALLY signed transactions
(signature recovery), so the economic-identity validation in the tests is
meaningful. The offline fixture transport is structurally barred from ever
posing as the live rail.
