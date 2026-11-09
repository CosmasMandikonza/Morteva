# Contract request to Agent A — enabling the metal rail on the reviewed ledger

**From:** Agent D (provider integrations — `packages/airwallex`, `packages/metal`)
**To:** Agent A (ledger/planner/authority)
**Status:** OPEN — the metal adapter (ADR 0007) is complete and adversarially tested, but the frozen ledger interface cannot yet express a metal operation truthfully. Per the operating rules this is a request, not a bypass: nothing in `packages/ledger` was changed.

## Why the rail stays dark today (exact mechanisms)

1. **No authorized metal operation can exist.** `ReservationService.reserveLocked` refuses
   `kind === 'metal_order'` with `RAIL_ASSET_UNSUPPORTED` (packages/ledger/src/services/reservations.ts:309),
   and `MandateService` refuses `rails` containing `'metal'` (packages/ledger/src/services/mandates.ts:87).
   Consequence: no outbox row can ever carry `rail: 'metal'` through the public seam, so a registered
   metal dispatcher would never be invoked. This gate is CORRECT while token-asset accounting does
   not exist — a fiat-USD snapshot must never fund a tokenized payment.

2. **A metal receipt cannot be persisted truthfully.** `provider_receipts` (migration 0003) has
   `provider TEXT NOT NULL CHECK (provider IN ('airwallex','metal'))` and
   `environment TEXT NOT NULL CHECK (environment IN ('sandbox','offline-fixture'))` — no `'testnet'`.
   `ProviderReceiptService.append` additionally hardcodes `'airwallex'` as the provider column
   (packages/ledger/src/services/provider-receipts.ts:43), and the shared
   `@moterva/providers` `ProviderReceipt` type carries no `provider` field at all. A real testnet
   receipt therefore either violates the CHECK or would be stored with the WRONG provider label.

## Requested changes (smallest set that preserves every reviewed invariant)

### R1 — Migration 0005: extend the receipt CHECKs (ledger-owned; AFTER identity 0004)
**Migration sequencing (CTO convergence directive, Nov 9):** PR #51 (`feat/mtv-19-production-identity`)
owns ledger migration `0004` and ADR `0006` (production identity). The Metal ledger expansion MUST be a
SUBSEQUENT migration — `0005` — and must never replace, recreate or renumber identity's `0004`.
- `environment` CHECK: add `'testnet'` (the `@moterva/providers` `ProviderReceiptEnvironment`
  union already includes `'testnet'`; the DB is the only place it is forbidden).
- The `provider` column already accepts `'metal'` — keep the CHECK as-is.

### R2 — Provider-aware receipts (ledger-owned, typed contract change in `@moterva/providers`)
- Add `readonly provider: ProviderId` to `ProviderReceipt` (default resolved at call sites; the
  adapter packages pass `'airwallex'` / `'metal'` respectively).
- `ProviderReceiptService.append`: persist `receipt.provider` instead of the hardcoded `'airwallex'`.
- This is additive: existing Airwallex call sites pass `'airwallex'` and behavior is unchanged.
  The metal dispatcher (`MetalReceiptStore`) is structurally compatible with the updated interface.

### R3 — Token-asset accounting for `metal_order` (ledger-owned; the substantive design decision)
The metal rail needs mandate/approval/reservation semantics for a TOKEN-ASSET currency. Requested
shape (Agent A decides the internal design):
- A registered token asset per org: `{ symbol: 'USDZ', decimals, contractAddress, chainId: 381932,
  environment: 'testnet' }` — the adapter's `discoverToken` already verifies `decimals()`/`symbol()`
  on-chain at connect, so the ledger can treat the verified metadata as trusted configuration.
- Balance snapshots with `source: 'metal-testnet'` and an explicit chain-read provenance
  (never a manual seed, never a fiat snapshot) feeding the usual spendable math.
- Lift `RAIL_ASSET_UNSUPPORTED` for `kind === 'metal_order'` ONLY when: the currency is a registered
  token asset, the org has a token-asset account, and the mandate's `rails` include `'metal'` with
  `permittedOperationKinds` containing `'metal_order'`. The beneficiary field carries the merchant
  address; `BENEFICIARY_NOT_ALLOWED` semantics unchanged.
- Mixed-currency isolation preserved: a fiat-USD envelope can never authorize a USDZ purchase and
  vice versa (this is the invariant that made the original gate correct).

### R4 — Worker registration wiring (Agent D's `apps/api` wiring, unblocked by R1–R3)
Once R1–R3 land, `apps/api/src/index.ts` registers the testnet dispatcher on the ledger worker
(`ledger.worker.register(buildTestnetDispatcher(...))`) with the real `ledger.providerReceipts`
store, and the `/api/system/status` metal entry flips to the registered (TESTNET, receipts-counted)
path that already exists in `metalAdapterStatus`. The gated smoke (`smoke:purchase`) then becomes
the ledger-reserved flow mirroring `smoke:transfer` for Airwallex.

## What the metal side guarantees in return

- `MetalDispatcher.dispatch` can never return `confirmed` (type-level); only the independent
  by-hash readback with exact economic-identity validation may, at/ beyond the configured
  finality confirmations, with a complete worker-bound scope.
- Durable identity before broadcast (tx hash + nonce persisted first); nonce-duplication is
  structurally impossible; ambiguous outcomes always reconcile the ORIGINAL identity.
- Receipts are allowlisted-minimized (no keys, no oversized payloads); the signer key never
  leaves the server environment and never enters a receipt, log or view.
- Adapter-boundary preconditions (kind, merchant allowlist, per-purchase cap, live chain-id
  assertion) fail closed BEFORE any signature — defense in depth behind the ledger's authority
  gate, never a replacement for it.

## Verification split

- Offline (already delivered, 60 tests): the full adversarial matrix in `packages/metal/test/`
  against the labeled simulated chain (receipts derived from actually-signed transactions).
- Live (gated): `npm run smoke:balance -w @moterva/metal` (real balance read; needs funded
  wallet) and `npm run smoke:purchase -w @moterva/metal -- --confirm` (one authorized
  mandate-bounded testnet purchase + independent readback; needs the hackathon Metal guide's
  USDZ token address/decimals + explicit owner authorization). Never a mocked response claimed
  as a real transaction.
