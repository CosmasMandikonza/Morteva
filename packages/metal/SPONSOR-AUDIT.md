# Metal sponsor-network audit — correcting the execution path (2026-11-10)

**Scope:** issue #6 D1. The existing `packages/metal` targets Metallicus Tahoe
(chain id 381932, METAL gas, `https://tahoe.metalblockchain.org/ext/bc/C/rpc`).
That is NOT the hackathon sponsor path. This audit records what the sponsor
path actually is, verified from the official shipped tooling — not from
participant reports — and maps every existing file to keep / replace / isolate.

## Verified sponsor basis (sources checked 2026-11-10)

Primary source: the OFFICIAL npm packages `@metalntwx/metal-agent@0.3.3` and
`@metalntwx/metal-pay@0.3.4` (registry metadata + the actual shipped tarball of
metal-pay, whose `dist/networks.js` is the code that defines the networks).
Repo referenced by both packages: `github.com/mx56db/metal` (`sdks/metal-agent`,
`sdks/metal-pay`). Secondary: their READMEs (quoted below where load-bearing).

| Parameter                           | Verified value                                                                                                                                                                                                                                                                                                                     | Source                                                                                                                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Testnet chain id                    | **63825** (`eip155:63825`)                                                                                                                                                                                                                                                                                                         | metal-pay `dist/networks.js` (shipped code): `chainId: 63825`                                                                                                                                                            |
| Testnet RPC                         | Per-user endpoints issued by `https://console-testnet.metalntwx.com` (rpc `consoleUrl`; no shared default; `rpcUrlFor` throws with instructions). The founder's console issues endpoints under `rpc-testnet.metalntwx.com/v1/<endpoint-id>`; the endpoint URL is CREDENTIAL-BEARING and enters only via env                        | metal-pay `dist/networks.js` + `rpcUrlFor`; metal-agent README ("On testnet, `pay` and `fund` need no RPC. `status`, `account create` and every `mandate` command but `credential create` need an endpoint of your own") |
| Gas/payment asset                   | `*USDZ` ("USD Zero") at `0x000000000000000000000000000000000000B5d5`, **18 decimals**, EIP-712 domain version "1"; every offer MUST be priced in `*USDZ` (client refuses any other token before signing)                                                                                                                           | metal-pay `dist/networks.js` (`USDZ` const) + README ("refuse, before it signs, a Metal `exact` offer in any token but `*USDZ` or under any EIP-712 domain but USDZ's")                                                  |
| Money precision                     | Dollar amounts → 18-decimal base units; `baseUnits` REJECTS more fractional digits than the token has — "money is never rounded"                                                                                                                                                                                                   | metal-pay `dist/networks.js` (`baseUnits`)                                                                                                                                                                               |
| x402 facilitator (testnet)          | `https://x402-testnet.metalntwx.com/x402/facilitator` (settles for any seller; `/supported`, `GET /settlements?payTo=<payee>`)                                                                                                                                                                                                     | metal-pay `dist/networks.js` + README                                                                                                                                                                                    |
| Explorer (testnet)                  | `https://testnet.metalntwx.com` (pay/fund print an `explorer` line)                                                                                                                                                                                                                                                                | metal-agent README                                                                                                                                                                                                       |
| Faucet (testnet)                    | public faucet `POST /api/fund`, amount set by the faucet; rate-limited failures say what to do                                                                                                                                                                                                                                     | metal-agent README                                                                                                                                                                                                       |
| Demo payee (testnet)                | `https://x402-demo-testnet.metalntwx.com/quote` (x402 demo seller; the smoke's pay quickstart pays it and confirms the `MIP20Transfer` on chain)                                                                                                                                                                                   | metal-agent README + `scripts/testnet-smoke.ts` description                                                                                                                                                              |
| Agent key                           | P-256 mandate key the agent signs with; the OWNER's key lives outside the agent's reach ("an owner key moves the account's funds outside any mandate's limits")                                                                                                                                                                    | metal-agent README (Spending limits)                                                                                                                                                                                     |
| Mandate authority                   | Verifiable Intent mandate bound ON CHAIN to the owner's MetalAccount (smart account, factory `0x3dbED5DebA965A639bB0Fd40BE96b97922070FA8` on testnet); on-chain-enforced per-payment cap, lifetime budget (never resets), payment count, expiry, payee allowlist; refusals carry `mandate_*` reasons (e.g. `mandate_cap_exceeded`) | metal-agent README + metal-pay README (mandates)                                                                                                                                                                         |
| Payment identity                    | `pay` prints the payment `nonce` as soon as it signs; `mandate pull` takes `--payment-id` — a paid id reports `already paid` and sends nothing; refused ids may be re-sent with other values                                                                                                                                       | metal-agent README                                                                                                                                                                                                       |
| Failure taxonomy (pay)              | verification/facilitator/seller refusal → `payment refused: <reason>`; settlement refusal that moves nothing → `payment refused at settlement: <reason>` (tx hash when there is one); otherwise → `payment in doubt at settlement: <reason>` (may have settled); "nothing was paid" ends refusals                                  | metal-agent README                                                                                                                                                                                                       |
| Readback / independent verification | `metal-agent status <txHash> --rpc-url <endpoint>`; `mandate verify --credential … --issuer <public key file> --tx <hash> --signed-offer <text> --rpc-url <endpoint>` verifies the binding, credential, and each payment/refusal FROM THE CHAIN ALONE; trusts only the factory METAL_NETWORKS names                                | metal-agent README + metal-pay README (verifyMandate/verifyMandatePayment)                                                                                                                                               |
| Signed offer binding                | sellers may set `requireSignedOffer` (`extra.signedOffer: "required"`); `pay` prints the agent's signed order; `mandate verify --tx --signed-offer` checks it                                                                                                                                                                      | metal-agent + metal-pay READMEs                                                                                                                                                                                          |
| Direct payout (no seller)           | `mandate pull --payment-id <id> --to <address> --amount …`; exit codes: paid 0 / refused 1 / pending 3 / held 4; payout records under `~/.metal-agent/pulls/<mandate>/`                                                                                                                                                            | metal-agent README                                                                                                                                                                                                       |
| MCP                                 | `metal-agent mcp` serves pay/fund/status (+ mandate tools under a mandate); the model can choose no key, no mandate, no higher limit                                                                                                                                                                                               | metal-agent README                                                                                                                                                                                                       |

## What was participant-reported and is now VERIFIED (or not)

- `eip155:63825` — **verified** (shipped code).
- `rpc-testnet.metalntwx.com/v1/<endpoint-id>` — the endpoint URL SHAPE is
  participant-reported; the official source says only "create an endpoint in
  the console" and treats the URL as a user secret (metal-pay scrubs it from
  every error). The adapter therefore takes `METAL_RPC_URL` as env input and
  never hardcodes or logs it.
- USDZ **contract semantics**: `*USDZ` is priced via the metalUsd parser with
  ERC-3009 `TransferWithAuthorization` (EIP-712, domain version "1"). The
  address is a sentinel-style system address (0x…B5d5) — treat it as the
  network's system token, verified from shipped code.

## Existing file disposition (keep / replace / isolate)

| File                                                 | Disposition                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config.ts` (Tahoe constants, chain 381932 gate) | **Isolate as legacy-tahoe**: kept for the invariant tests, but the sponsor path is a NEW config (`src/sponsor/config.ts`) that is the only enableable execution path; ADR 0008 records that Tahoe is not the sponsor network                                                                 |
| `src/chain-transport.ts`                             | **Keep** (generic JSON-RPC with origin guard + fixture bar) — reusable for status/mandate reads on any chain                                                                                                                                                                                 |
| `src/signer.ts`, `src/erc20.ts`, `src/dispatcher.ts` | **Isolate as legacy-tahoe execution** (own-key EIP-1559 broadcast is not the sponsor model: sponsor payments are ERC-3009/x402 through the facilitator, signed by the agent's P-256 mandate key via the OFFICIAL CLI) — dispatcher still proves the invariants the sponsor journey preserves |
| `src/status.ts`                                      | **Keep** (receipt observation is chain-generic)                                                                                                                                                                                                                                              |
| `src/money.ts`                                       | **Keep** + new `src/sponsor/usdz.ts` (18-decimal verified semantics; extra fractional digits rejected — money never rounded)                                                                                                                                                                 |
| `src/journey.ts`, `src/smoke/*`                      | **Replace** with sponsor equivalents (`src/sponsor/journey.ts`, `smoke/purchase` re-targeted) — Tahoe smoke modes disabled                                                                                                                                                                   |
| `src/file-receipt-store.ts`                          | **Keep** (journey receipt journal)                                                                                                                                                                                                                                                           |
| `src/adapter-status.ts`, `src/status-entry.ts`       | **Update** wording to the sponsor path                                                                                                                                                                                                                                                       |

## Honest unknowns (not verifiable from public sources today)

- The exact testnet `*USDZ` transfer event signature and explorer URL
  parameters beyond the base URL (the smoke confirms `MIP20Transfer` via the
  official CLI; our readback uses the CLI rather than re-deriving chain
  formats).
- Whether the founder's console endpoint supports `eth_*` JSON-RPC for our
  generic transport reads (the assignment says an "RPC endpoint"; `metal-agent
status` needs one, so ours should too — verified at smoke time, not assumed).
- Live behavior of the facilitator (timeouts, duplicate settlement) — modeled
  from the documented taxonomy and tested via fixtures; live behavior requires
  the founder-authorized smoke.

## Addendum (2026-11-11): console endpoint "Require a credential" — probe matrix and resolution

The founder's console endpoint (`alta-testnet`, endpoint ID `1a4d7d7f…`, verified by the
founder: `eth_chainId` → `0xf951`) has **Require a credential: On**. Access attempts WITHOUT
the secret (plain URL, exactly as the shipped CLI constructs it) are rejected server-side:

| Attempt | Result |
| --- | --- |
| POST `eth_chainId` plain URL | `{"code":-32001,"message":"invalid or revoked credential","reason":"invalid_or_revoked_credential","x402":{"url":"…/v1"}}` |
| GET plain URL | 401 |
| Official CLI `metal-agent status <tx> --rpc-url <url>` | `Status: 401 / Requested resource not found` |
| Official CLI x402 `pay <rpc-url>` (the documented flow for RPC endpoints sold over x402) | 401 invalid credential BEFORE any offer is served |
| Bearer / x-api-key / raw Authorization / x-mrpc-key headers with the Endpoint Secret | all rejected, same error |
| URL-embedded Basic (secret as user / as password / empty-user), URL-encoded | all rejected, same error |
| Path `/v1/<id>/<secret>`, `/v1/<secret>`, `?secret=` query | rejected / 404 |
| Shipped CLI/SDK support for endpoint-secret headers | **none in 0.3.3/0.3.4**: `rpcClient` uses plain viem `http(url)`; `rpcTransport` scrubs URL `user:password` but the server rejects every presentation probed |

**Conclusion:** the shipped official CLI has no supported way to present the console Secret or
a JWT; the server rejects all probed presentations of this endpoint's credential. Per the CTO
directive, the resolution is founder-approved option 2: a **separate disposable testnet RPC
endpoint with "Require a credential" OFF** (tight daily cap via the console, privately held
rotated URL, revocable at any time), used with the official CLI as designed — never disabling
security on the primary endpoint, never hardcoding a secret.

**Live evidence captured while blocked (no signing, no RPC reads):**
- Agent key (disposable, outside repo, owner-only ACLs): address `0x2636Bc67b099645745Be2A1c423E826109B583F2`.
- Faucet funding: **100 *USDZ**; tx `0x1345bc559da38f042f45a5cf458314551d6182d201935febc62eac8a0234c896`; explorer tx page HTTP 200.
- LIVE seller offer (official demo seller, HTTP 402 header decoded): 0.01 *USDZ on
  `eip155:63825`, asset `0x…B5d5`, ERC-3009 `TransferWithAuthorization`, exact-scheme payee
  `0xa1ea44afe3948831194c90438f23827c8b458f88` — all matching the verified constants.
- LIVE refusal test: official CLI refused pre-sign against the real seller (`--max` below the
  offer) — zero spend.
- REAL smoke `--plan` against the LIVE seller: all gates pass, outcome plan-only, no payment
  id/nonce/tx; and the no-purchase gate verifiably declines when no information value is
  configured.
