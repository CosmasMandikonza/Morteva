# Financial correctness and provider verification

## Non-negotiable invariants
1. Every write is tenant-scoped and authorized by server-side role/policy; operational telemetry cannot grant spending authority.
2. Available-to-commit is based on verified provider funds **minus** protected floors and outstanding reserved/unknown commitments; concurrency-safe accounting prevents simultaneous overcommitment.
3. Store monetary value in integer minor units internally with currency exponent; Airwallex API examples expect **major units**. All external money conversion must be explicit and unit-tested.
4. Approvals bind exact org, mission, plan version, beneficiary, amount, currency, purchase purpose, quote terms and evidence digest; term changes invalidate old approvals.
5. Persist a stable request_id before a transfer; only reuse it for a retry of the **same** economic operation according to provider contract. Never blind-retry a timed-out transfer.
6. Pending / submitted / sent are NOT settled. Provider-specific terminal states must be mapped by verified status, and out-of-order/duplicate webhooks cannot regress state.
7. Model output and external invoices are untrusted; only typed, validated server-side tools can perform bank operations.
8. Metal and Airwallex live in separate TEST environments. Never claim direct real fiat-stablecoin conversion or a production bridge.
9. Diagnostic purchase settlement does not imply the purchased report is accurate or delivered. Supplier settlement does not imply a physical machine recovered.
10. Secrets are never in public issues, UI, logs, screenshots, tests or Git. Redact client IDs, wallets and sensitive provider metadata before publishing evidence.

## Airwallex gate
- Confirm sandbox account and scoped key through private configuration.
- Read balance with freshness; inspect exact provider docs for beneficiary/transfer/FX fields and fees.
- Issue one safe sandbox action; store returned request ID, provider ID, status and receipt.
- Independently retrieve its state and record final status. Test expired FX, insufficient balance, cancelled payout, unknown response and duplicate requests.
- Airwallex's hackathon guide says request_id is operation-specific, provider amount fields are major units, transfers may be SENT before final and failures may surface as CANCELLED. Validate this against the actual endpoints used.

## Metal gate
- Confirm testnet-funded wallet, token, mandate and RPC access; keys remain server-side.
- Execute one real mandate-bounded signed order and independently verify on-chain transaction and failure/denial path.
- Bind paid evidence to a plan revision if it actually changes the decision, not merely because a model narrates a change.

## Optional partners
- Visa: exact eligible product/API and credential access must be confirmed by organizers; reference implementation by itself is not sufficient proof of prize eligibility.
- T:0: obtain proper access privately; reconcile only if API supports needed evidence.
- AWS: infrastructure only if necessary and cost-managed; never infer cash award eligibility from credits.
- Coinbase and Base44: use only when they solve an independent product need.

## Tests
Property tests for money conservation/units and authorization; concurrency tests with two missions and one reserve; integration/fault-injection tests for provider timeout, duplicate/out-of-order webhook, expired quote, changed payee, vendor prompt injection, stale telemetry, service not delivered, AI outage and recovery-after-restart.

## Primary source
https://airwallexdev.com/guide
