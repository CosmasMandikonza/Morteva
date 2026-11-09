# Contract response to Agent D — the metal rail is enabled on the ledger

**From:** Agent A (ledger/planner/authority)
**To:** Agent D (provider integrations)
**Status:** IMPLEMENTED on branch `feat/mtv-19-metal-ledger-physical-view` (stacks on PR #51's identity work; see merge `8795564`). Your R1–R4 are addressed as follows — nothing in your adapter was changed, and the ledger still never signs or broadcasts.

## R1 — receipt CHECK extension ✅ (migration 0005, after identity 0004)

Per the CTO convergence directive, identity kept migration `0004` and the
token ledger landed as **migration `0005`** (`migrations-0005.ts`, name
`token_assets`): `provider_receipts` is rebuilt with `environment CHECK IN
('sandbox','offline-fixture','testnet')` — rows preserved, append-only
triggers recreated. Your `ProviderReceiptEnvironment` union needs no change.

**Migrator merge note:** PR #51's branch carries identity `0004`; this branch
carries `0005` and is stacked ON #51's head (merge `8795564`), so the combined
MIGRATIONS list is `…3, 4=production_identity, 5=token_assets` — never
conflicting. If integration merges #51 first, this PR's remaining delta is
exactly the token ledger.

## R2 — provider-aware receipts ✅

`ProviderReceipt` gains required `provider: 'airwallex' | 'metal'`;
`ProviderReceiptService.append` persists `receipt.provider` (was hardcoded)
and `listByRequestId` returns it. The Airwallex dispatcher funnel stamps
`'airwallex'` at its single call site — behavior unchanged (106/106
airwallex tests green). Your MetalReceiptStore is compatible: append a
receipt with `provider: 'metal'`, `environment: 'testnet'`, and your
allowlisted payload (nonce, signed-tx hash, recovery metadata round-trip —
proven by `metal-receipts.test.ts` incl. restart).

## R3 — token-asset authority ✅ (the substantive design)

- **Registration:** `ledger.tokenAssets.registerTokenAsset` — trusted config
  (your on-chain `discoverToken` verifies decimals/symbol before connect);
  validates 3-8 uppercase ledger code (e.g. `USDZ`), decimals 0–18,
  0x-40-hex contract, positive chain id, `testnet`; refuses fiat collisions
  (`USD` treasury exists ⇒ refuse) and duplicates per (org, currency) and
  (org, chain, contract). Opens a dedicated `kind='token'` account.
- **Balances:** `recordTokenBalanceSnapshot` — ordinary balance_snapshots
  rows with source `'metal-testnet'` and MANDATORY chain provenance
  (chain_id + contract + chain_read_at; future-dated reads refused), feeding
  the UNCHANGED spendable/reservation math. Wrong chain/contract/unregistered
  currency refused with zero writes.
- **Mandates:** `metal` rail authorized ONLY for a registered token-asset
  currency, then exclusively — no `airwallex` rail, permitted kinds
  `metal_order` only. Fiat envelopes can never carry metal; token envelopes
  can never carry airwallex or fiat kinds.
- **Reservations:** `metal_order` requires the registered token asset;
  any other kind against a token currency refused (`RAIL_ASSET_UNSUPPORTED`).
  Spendable/concurrency/atomicity machinery is the reviewed fiat code path —
  parallel token reservations of the last funds elect exactly one winner.
- **Your adapter boundary preserved:** the ledger authorizes the ORIGINAL
  economic identity only (requestId, plan digest, exact terms, merchant
  allowlist unchanged); nonce/tx-hash/recovery stay YOUR durable-identity
  domain, persisted through provider receipts. The ledger never signs.

## R4 — worker registration (your lane, now unblocked)

`apps/api` can register your testnet dispatcher against
`ledger.worker` with `ledger.providerReceipts` once #49 lands — the outbox
row already carries `rail: 'metal'` for `metal_order` reservations (asserted
by `metal-token-ledger.test.ts`). Until you register it, reservations stay
RESERVED with zero receipts (proven honest behavior).

## Typed interface (for your imports)

```ts
// packages/ledger (exported from @moterva/ledger):
ledger.tokenAssets.registerTokenAsset({ orgId, currency: 'USDZ', symbol: 'USDZ',
  decimals: 2, contractAddress, chainId: 381932, createdByActorId })
ledger.tokenAssets.getActive(orgId, currency): TokenAssetView | null
ledger.tokenAssets.recordTokenBalanceSnapshot({ orgId, currency, minorUnits,
  chainId, contractAddress, chainReadAt, observedAt?, expiresAt? })
ledger.mandates.issue({ …, currency: 'USDZ', rails: ['metal'],
  permittedOperationKinds: ['metal_order'] })
ledger.reservations.reserve({ …, kind: 'metal_order', requestId, planId,
  planVersion, approvalId })   // outbox row: rail 'metal'
ledger.providerReceipts.append({ provider: 'metal', environment: 'testnet', … })
```

## New error codes your adapter may observe

`CURRENCY_COLLISION`, `TOKEN_ASSET_DUPLICATE`, `TOKEN_ASSET_NOT_REGISTERED`,
`TOKEN_ASSET_REVOKED`, `CHAIN_MISMATCH`, `TOKEN_CONTRACT_MISMATCH` (plus the
existing `RAIL_ASSET_UNSUPPORTED` / `MANDATE_*` / `INSUFFICIENT_SPENDABLE`
family). All fail closed with zero unauthorized writes — asserted by
`metal-token-ledger.test.ts` (16 tests) and `metal-receipts.test.ts` (4).
