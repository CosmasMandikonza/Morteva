# ADR 0007 — Metal testnet adapter: Tahoe C-Chain, nonce-durable identity, mandate-gated USDZ purchases

- **Status:** Proposed (delivered with issue #6; real-testnet gate BLOCKED on the hackathon Metal guide's USDZ token address + funded testnet wallet — adapter complete and adversarially tested offline)
- **Date:** 2026-11-08
- **Deciders:** Engineering (Agent D — provider integrations) per the Agent A/B/C/D/E ownership split
- **Review:** due at PR review (R3-sensitive); implements the Metal side of the provider seam ADR 0002/0003/0005 left deliberately separate

## Context

Issue #6 requires a genuine Metal testnet purchase under an enforced mandate: the paid-diagnostics journey (physical uncertainty → financial evaluation → authorized purchase/refusal → real provider interaction → independently checked outcome → separately verified information delivery). The hackathon's Metal sponsor is **Metal Blockchain (Metallicus)** — the sponsor page describes "L1 blockchain, docs, nodes, faucet, wallets + Slack support" with a "Funded Metal testnet wallet" setup. The ledger deliberately refuses the `metal_order` kind (`RAIL_ASSET_UNSUPPORTED`) until token-asset accounting exists, so this ADR records the adapter that IS built, the documentation basis for every chain interaction, and the exact BLOCKED state of the real-testnet gate.

## Verified API basis (official documentation, checked 2026-11-08)

| Fact | Value (verified) | Source |
| --- | --- | --- |
| Sponsor product | Metal = L1 blockchain (Metal Blockchain by Metallicus), nodes/faucet/wallets | airwallex.hackerearth.com sponsor page |
| Testnet name | **Tahoe** | docs.metalblockchain.org "Tahoe Workflow" |
| C-Chain (EVM) RPC | `https://tahoe.metalblockchain.org/ext/bc/C/rpc` | same |
| Chain ID | **381932** (symbol METAL) | same |
| Explorer | `https://tahoe.metalscan.io/` | same |
| Faucet | `https://faucet.metalblockchain.org` ("METAL … have no monetary value") | same |
| Wallet model | non-custodial web wallet; BIP39 24-word mnemonic → BIP44 `m/44'/60'/0'/0/{i}` C-Chain addresses; MetalJS networkID 5 | same |
| USDZ token on Tahoe | **NOT publicly documented.** The contract address comes from the hackathon's Metal guide (organizer-provided, private). The adapter REQUIRES it as validated configuration and re-verifies `decimals()`/`symbol()` on-chain at connect. | deliberate repository law: no invented addresses |
| SDK | No maintained official Node SDK for EVM C-Chain transfers; `viem` v2 (^2.57.17) used for local signing/ABI/keccak only, with a swappable JSON-RPC transport (same structural separation as ADR 0005) | viem docs; MetalGo is Go-only |

## Decision

### 1. Package shape — the same strict offline/real separation as Airwallex

`packages/metal` implements: config gate (`loadMetalConfig`), a JSON-RPC transport (`HttpJsonRpcTransport` with the Airwallex P0-1 exfiltration boundary — while signer credentials are configured, signed traffic is locked to the exact official Tahoe RPC origin and any `METAL_RPC_URL` override is a startup error; `redirect: 'error'`), a deterministic `FixtureJsonRpcTransport` for tests (marked `__offlineFixture`; `buildTestnetDispatcher` refuses it structurally), minimal ERC-20 helpers (viem ABI encode/decode only — no network), the server-only `MetalSigner`, conservative on-chain status normalization, `MetalDispatcher` (implements the frozen `RailDispatcher`), the `runMetalPurchaseJourney` harness, and gated smoke scripts. Fixture results are recorded `offline-fixture`/`simulated`; live results `testnet` — never interchangeable.

### 2. Money at the boundary — decimals are DISCOVERED, never assumed

Internal money is integer token minor units with the exponent equal to the chain-verified `decimals()` of the configured USDZ contract (config-expected AND on-chain cross-checked by `discoverToken`; a mismatch refuses startup). Conversions are exact BigInt/string math (`money.ts`): fractional minor units, zero/negative amounts, malformed decimals and > 2^53-1 all fail closed. This preserves the ledger law (no float money) while honoring the Metal difference: **a blockchain token has no provider-side unit convention — the token contract itself defines base units.**

### 3. Finality: broadcast is never settlement — and finality is an explicit, conservative threshold

- `dispatch()` returns `submitted` only for an accepted `eth_sendRawTransaction` and is typed so it **cannot** return `confirmed`.
- Only `reconcileByRequestId(requestId, scope)` may return `confirmed`, and only when ALL hold: (a) the durable dispatch record (persisted BEFORE broadcast) names the transaction; (b) an independent by-hash read (`eth_getTransactionByHash` + `eth_getTransactionReceipt`) succeeds; (c) the receipt succeeded (status `0x1`); (d) the decoded ERC-20 `Transfer` log names the configured token, THIS wallet as sender and the EXACT authorized merchant as recipient with the EXACT authorized amount; (e) the observation is at/beyond the configured finality confirmations (default 12; Tahoe's formal finality rule is not published in the public docs we rely on, so the threshold is explicit configuration, never a claim); (f) a COMPLETE settlement scope (org + operation + amount + currency + merchant, worker-bound) is present. Missing fields → `EVIDENCE_INCOMPLETE`; wrong values → `EVIDENCE_MISMATCH`; neither can ever confirm.
- `REVERTED` receipts (status `0x0`) map to `failed` → the ledger escalates to REQUIRES_HUMAN and retains exposure — the same law as Airwallex terminal failures.
- **Reorg honesty:** a same-height block-hash change between readbacks is `REORG_SUSPECTED` (status-unknown, monitored), never ignored. Readback transport failures are `READBACK_INCOMPLETE` — incomplete, never "empty".

### 4. Ambiguity, idempotency and the Metal identity difference (preserved explicitly)

Airwallex deduplicates by a provider-side `request_id` for 7 days. **A blockchain has no such mechanism** — imposing transfer semantics on a chain would be fabrication. The metal rail's durable identity instead rests on three facts:

- The **transaction hash is known at signature time** (keccak256 of the signed bytes) — the dispatcher persists `(txHash, nonce, chainId, token, merchant, amount)` durably BEFORE `eth_sendRawTransaction`. Crash before persist → the signed tx was never broadcast and is discarded; recovery re-signs with the SAME nonce (still free on-chain — verifiable). Crash after persist → recovery always reconciles by the recorded hash, never a new economic operation.
- The **EVM account nonce** makes double-spend structurally impossible for one recorded intent: two transactions sharing (from, nonce) cannot both execute. This is the chain-native equivalent of Airwallex's request-id dedupe. The signer additionally refuses a same-nonce second signature within a process.
- The **ledger's** `UNIQUE(org_id, request_id)` remains the authoritative economic-identity uniqueness. The namespaced request id (`mtv-{orgHash10}-{ledgerRequestId}`, same law as ADR 0005) is carried in receipt payloads for correlation; on-chain there is no request id and none is invented.
- Definitive non-execution: no dispatch record at all → nothing was ever signed+persisted, and broadcast happens strictly after persist — so nothing was broadcast. This maps to `failed NO_BROADCAST_FOR_REQUEST_ID` → REQUIRES_HUMAN (never auto-resubmission), mirroring the reviewed Airwallex `NO_TRANSFER_FOR_REQUEST_ID` behavior. A refused broadcast (JSON-RPC error — the node answered) is definitive `BROADCAST_REJECTED`. An unavailable broadcast (timeout/lost connection) is `status-unknown` — the transaction may still have propagated.

### 5. Adapter-boundary mandate checks (D7) — never a second approval engine

The ledger's atomic dispatch gate (claim + authority re-check + RESERVED→SUBMITTING) remains the ONLY approval engine. The adapter enforces provider-mechanical preconditions only, failing closed before any signature: kind must be `metal_order`; the operation beneficiary must equal the server-configured merchant address for the org (`MERCHANT_NOT_ALLOWED`/`NO_MERCHANT_CONFIGURED`); the amount must be a positive integer within the configured per-purchase cap (`PER_PURCHASE_CAP_EXCEEDED`); the token must be configured and on-chain-verified; the chain id is asserted live at connect AND embedded in the signature itself. The smoke harness additionally enforces quote freshness, mandate expiry and the information-value economics at ITS boundary and says so in its output — the planner/ledger integration is Agent A's contract (see `docs/contracts/metal-ledger-contract-request.md`).

### 6. The agentic paid-information journey (D6)

`runMetalPurchaseJourney` is the side-effect-free harness (CLI: `smoke:purchase`): a NAMED diagnostic product (`DiagnosticOffer.vendorId`/`productName`, labeled SYNTHETIC vendor in the smoke), a documented exact price + currency bound by a sha256 offer digest, and a first-class NO-PURCHASE outcome (`declined` with the failed gate: `QUOTE_EXPIRED`, `MANDATE_EXPIRED`, `MERCHANT_NOT_ALLOWED`, `PER_PURCHASE_CAP_EXCEEDED`, `INFORMATION_NOT_WORTH_PRICE`, `INSUFFICIENT_USDZ`) — the purchase decision is never contrived-always-buy. Purchase path: verified fresh balances (native gas floor + token balance) → durable intent BEFORE signature → dispatch through the mandate-checked dispatcher → reconcile passes to verified finality → **delivery evidence recorded SEPARATELY** from settlement evidence: the paid report is fetched, digested, shape-checked, and instruction-quarantined (`quarantineFindings`); payment proves payment — never data quality, never delivery. One durable intent per state directory (the ADR 0005 §8 smoke-safety model): exclusive lock held for the journey's duration, temp+rename atomic writes, missing/corrupt state never authorizes a new payment, rerun reconciles the SAME intent without fresh authorization, `--new-intent` requires the prior intent resolved and archives (never deletes) prior state.

### 7. The honest disabled state (current)

With no credentials configured (the actual environment), `loadMetalConfig` yields `enabled: false`; the API registers no dispatcher and `/api/system/status` reports the metal entry OFFLINE with the exact blocker. Even WITH credentials, worker registration stays dark until the ledger contract lands (token-asset accounting for `metal_order` + provider-aware receipt persistence — today's `provider_receipts` hardcodes the `airwallex` provider column and its environment CHECK excludes `testnet`, so a real testnet receipt could not be persisted truthfully). The gated smoke scripts carry the real-testnet path on a labeled durable JSONL journal (`FileReceiptStore`) in the operator's state directory until then. Enabling requires all of `METAL_ENV=testnet`, `METAL_SIGNER_PRIVATE_KEY`, `METAL_USDZ_TOKEN_ADDRESS`, `METAL_USDZ_DECIMALS`, `METAL_USDZ_SYMBOL`, `METAL_MERCHANT_ADDRESS` (half-configured is a startup error, never a silent partial rail) — and an owner-authorized `--confirm` for any actual purchase.

## Alternatives considered

- **Brale / metal.build**: researched and rejected as the hackathon "Metal" — the sponsor page describes an L1 blockchain with nodes/faucet/wallets (Metal Blockchain/Metallicus), and Brale's current public value-type list contains no USDZ. Recorded in the research notes to prevent re-litigating.
- **Ethereum mainnet-style "wait 1 confirmation"**: rejected — without a published finality rule, the conservative configurable depth (default 12) with reorg detection is the honest choice.
- **Ledger-side metal_order enablement in this PR**: rejected — `packages/ledger` is Agent A's; the frozen interface cannot yet express token-asset accounting safely, so a precise typed contract request is delivered instead of a bypass.

## Consequences / risks

- The real-testnet acceptance of issue #6 (one actual mandate-bounded testnet payment with independent on-chain readback + one denial path) remains **BLOCKED** on: the hackathon Metal guide's USDZ token address/decimals (private), a funded Tahoe testnet wallet (self-serve faucet), and the owner's explicit `--confirm` authorization of the specific purchase. No claim of a live chain interaction is made anywhere.
- Viem (^2.57.17) is a new production dependency of `@moterva/metal` only — the root lockfile change is coordinated with Agent C per the ownership split.
- The finality threshold is an assumption made explicit (configurable); if Metallicus publishes an official finality rule, the default should be updated to match.
- Gas estimation carries a 500k sanity cap: a reverting transfer (insufficient token balance) fails BEFORE signing rather than on-chain.
- Test coverage is offline-deterministic (simulated chain derives receipts from the ACTUAL signed transactions via signature recovery, so economic-identity validation is meaningful, not self-fulfilling); the live gate is exercised only by the gated smokes with real credentials.

## Where the guarantees are proven

`packages/metal/test/`: config-gate (disabled default, half-config failures, origin lock, chain-id lock), money (exact conversions, fractional/zero/negative/overflow rejection), signer-erc20 (1559 validity, same-nonce refusal, estimate-cap, fee fields, token discovery incl. code/metadata refusal, transfer-log decoding, observation ladder, reorg detection), dispatcher (persist-before-broadcast, merchant/kind/amount/cap refusals with zero RPC calls, broadcast refusal vs timeout, full reconcile ladder to `confirmed`, SCOPE_INCOMPLETE/NO_TENANT_SCOPE, REVERTED, TRANSACTION_NOT_FOUND, NO_BROADCAST_FOR_REQUEST_ID, DUPLICATE_DISPATCH_RECORDS, EVIDENCE_MISMATCH for wrong recipient/amount, REORG_SUSPECTED, READBACK_INCOMPLETE, wrong-chain refusal, builder guards), journey (no-purchase economics, stale quote, expired mandate, wrong merchant, cap breach, insufficient USDZ, empty gas wallet, purchase→verified-settlement→separate-delivery, vendor-unreachable, injection quarantine, unverified recovery of the SAME intent, new-intent archive/resolution gates, disabled-config honesty).
