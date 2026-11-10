# ADR 0008 — Metal sponsor network: x402 over metalntwx testnet, mandate-enforced agent payments

- **Status:** Proposed (issue #6 D1–D4; supersedes the Metallicus Tahoe execution path of ADR 0007, which is explicitly isolated as legacy — its invariant logic is preserved and its tests still prove it, but it is NOT the sponsor network)
- **Date:** 2026-11-10
- **Deciders:** Engineering (Agent D) per the sponsor-network correction directive
- **Review:** R3-sensitive; the one-line production change is in ADR 0007's execution transport

## Context

ADR 0007 modeled the sponsor as Metallicus Tahoe (chain 381932, METAL gas, own-key EIP-1559
broadcast of an ERC-20 transfer). The founder's actual sponsor access is the Metal
**metalntwx** testnet: `console-testnet.metalntwx.com` ($50 RPC credits), RPC endpoints under
`rpc-testnet.metalntwx.com/v1/<endpoint-id>`, and the official packages `@metalntwx/metal-agent`
(0.3.3) / `@metalntwx/metal-pay` (0.3.4). Participant-reported `eip155:63825` is now VERIFIED
from the shipped sponsor code rather than adopted on report.

## Verified network basis (official shipped tooling, 2026-11-10)

From `@metalntwx/metal-pay@0.3.4` `dist/networks.js` (the shipped code that defines the
networks) and the two packages' READMEs:

| Parameter | Value | Source |
| --- | --- | --- |
| Testnet chain | `eip155:63825` / chainId 63825 | shipped `networks.js` |
| Testnet RPC | per-user endpoints from `console-testnet.metalntwx.com`; the URL is credential-bearing and scrubbed from all errors by the official SDK | shipped `rpcUrlFor` + `rpcTransport` |
| Money | `*USDZ` ("USD Zero") 18 decimals at `0x000000000000000000000000000000000000B5d5`; ERC-3009 `TransferWithAuthorization`, EIP-712 domain version "1"; extra fractional digits REFUSED — money never rounded | shipped `USDZ` + `baseUnits` |
| Facilitator | `https://x402-testnet.metalntwx.com/x402/facilitator` (`/supported`, `GET /settlements?payTo=`) | shipped `networks.js` |
| Explorer / faucet / demo payee | `https://testnet.metalntwx.com` / public faucet `POST /api/fund` / `https://x402-demo-testnet.metalntwx.com/quote` | metal-agent README |
| Failure taxonomy | `payment refused: <reason>`; `payment refused at settlement: <reason>` (+tx, nothing moved); `payment in doubt at settlement: <reason>` (MAY have settled); mandate refusals carry `mandate_*` reasons | metal-agent README |
| Mandates | P-256 agent key; owner's MetalAccount (factory `0x3dbED5DebA965A639bB0Fd40BE96b97922070FA8` on testnet); on-chain per-payment cap, lifetime budget, expiry, payee allowlist; `--payment-id` idempotency; `mandate verify --tx --signed-offer` rebuilds payments from the chain alone | metal-agent + metal-pay READMEs |

## Decision

1. **Sponsor execution via the official CLI.** `packages/metal/src/sponsor/agent-cli.ts` is the
   ONLY payment boundary: it shells out to `npx -y @metalntwx/metal-agent` (`pay`,
   `status`, `mandate verify`) and classifies the documented outcomes. The model can never
   choose a key, a mandate or a limit — the caller fixes them from config (official MCP
   semantics). No key material is ever read; paths and the RPC URL enter via env and are
   redacted from all printable commands.
2. **Config gate.** `sponsor/config.ts` enables only with `METAL_SPEND_ENV=sponsor-testnet`,
   a console-issued `METAL_RPC_URL`, `METAL_AGENT_KEY_FILE` and `METAL_MANDATE_CREDENTIAL`
   (never half-configured). Signed spend additionally requires `METAL_SPEND_APPROVED` — the
   stop-before-signing gate. The per-payment cap and the value-of-information gate convert
   integer cents / decimal `*USDZ` to exact 18-decimal base units with integer math.
3. **Journey.** `sponsor/journey.ts`: fetch and verify the offer (`*USDZ`-only, positive,
   complete identity, in-cap, fresh) → value-of-information gate (the no-purchase case is
   first-class) → durable intent binding seller/case/price/identity/digest BEFORE payment →
   pay under the on-chain mandate → **independent settlement verification**
   (`mandate verify --tx --signed-offer` from the chain alone) → fetch and digest-bind the
   delivery SEPARATELY (an x402 payment does not prove the diagnostic is true; injective
   content is quarantined) → planner handoff shape for C's safety validation.
4. **Legacy isolation.** The Tahoe execution transport (`signer.ts`/`dispatcher.ts`/Tahoe
   smoke) stays as tested legacy: its 60+ invariant tests still prove nonce-durable identity,
   broadcast ambiguity handling and economic-identity validation, but it is not the sponsor
   path and is not wired anywhere the sponsor config governs. `sponsor/config` refuses any
   `METAL_SPEND_ENV` other than `sponsor-testnet` and names Tahoe as not-a-substitute.

## Consequences / honest limits

- No signed transaction exists yet: the sponsor smoke (`smoke:sponsor-purchase`) is gated on
  the founder's console endpoint, an agent key, a bound mandate and explicit
  `METAL_SPEND_APPROVED` (+ `--confirm`); without these it exits BLOCKED at every stage. The
  Metal Award readiness claim remains unmade until the founder-authorized smoke produces a
  real explorer tx and independent readback.
- The facilitator's live behavior (timeouts, duplicate settlement, the exact refusal reasons)
  is modeled from the documented taxonomy and tested via fixtures; live verification happens
  in the gated smoke.
- The diagnostic seller for the demo is the sponsor's own x402 demo payee unless the founder
  supplies a real diagnostic seller; the content of anything bought is digested, shape-checked
  and instruction-quarantined and NEVER directly trusted.

## Where the guarantees are proven

`packages/metal/test/sponsor-config.test.ts` (15 tests: constants, gates, redaction, *USDZ
semantics, CLI outcome classification) and `packages/metal/test/sponsor-journey.test.ts`
(20 tests: the full D4 matrix — mandate refusals verbatim, refusal-at-settlement with tx,
in-doubt terminality, no-purchase economics, stale quote, seller outage, delivery refusal,
injection quarantine, reconcile-without-repay, corrupt state, disabled/unapproved gates),
plus the retained legacy suite (99 tests total in the package).
