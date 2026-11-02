# Founder/CTO risk review — Nov 2, 2026

**Scope:** Review of an *empty* repo plus initial proposed documentation/issues. No product code, payment result, benchmark, or screenshots existed when these findings were recorded. This is an internal risk analysis, not a claim of commercial validation or hackathon likelihood.

## The failure pattern to avoid
Code volume, number of integrations, polished mock screens and test counts are **proxies**. The actual win condition is a complete user job: authentic financial state → contextual agent decision → enforceable authorization → genuine provider action → verified result → understandable product outcome. No number of separate 'completed' issues substitutes for that chain.

## Five ranked risks and direct responses

| Priority | Failure mode | Early detection | Countermeasure / gate |
|---|---|---|---|
| **P0** | 17 tickets complete independently, but no complete customer flow | A reviewer cannot finish one mission from setup to reconciled receipt | **Vertical slice V0/V1 below**; integrate continuously, not on Nov 13 |
| **P0** | Sandboxed API access is blocked; agent fabricates "paid" | No provider receipt independently looked up from actual sandbox/testnet | Real sandbox/testnet probe early; fake adapters explicitly OFFLINE ONLY; no "success" claim |
| **P0** | Multiple AI workers create contradictory domain models and lost authorization | Alternative field/status names across backend/UI; money units misread | Freeze domain/operation schema and authority contract before parallel implementation |
| **P0** | Financial operations are economically unsafe after failures/retries | Duplicate transfer, stale approval, unknown status freed, incorrect amount | Durable outbox, idempotency, atomic reservation, replay-and-fault-injection acceptance |
| **P1** | Beautiful 3D covers an ordinary or broken financial app | Turning off WebGL makes product unusable; evaluator can only watch | Financial first; 2D-parity; selected asset/decision/receipt all driven by same event log |

Additional material risks: inadequate buyer validation, sponsor integrations as logos, Visa access delays, shaky licensing, dashboard design by taste, unreviewable giant PRs, public strategic disclosures, uncertain economics, password/token leaks, provider downtime during recording, model costs and hidden recurring operational spending.

## One demonstrable vertical slice — the actual release spine

**V0 — Finance first (before polishing scenes):**
1. A seeded, explicitly simulated inspection operation exists with one verified provider balance or prominently marked offline balance.
2. A real mission mandate with exact budget, reserve, permitted vendor, amount, currency, evidence constraints and expiry is persisted.
3. The planner compares two viable plans and can choose **no payment**; financial policy rejects an over-limit case.
4. An authorized Airwallex **sandbox** transfer is submitted, original request identity persisted, and provider status independently read back. Pending remains pending until provider confirms; no fake settlement.
5. Page refresh/server restart reconstructs case, plan and evidence without another financial call.

**V1 — Metal changes the decision:**
6. An agent rationally evaluates the marginal value of a paid diagnostic and may decline it.
7. A real Metal **testnet** mandate-bound purchase receives a verifiable hash; a failed mandate request is denied.
8. The data delivered is recorded with provenance, **not** assumed true because it was purchased. It updates the feasible plan in a documented test where changing evidence truly changes the action.
9. If additional approval is required, a real authenticated approver (or clearly labeled single-user demo authorization) approves exact immutable terms.
10. A complete case timeline links simulated operational events, actual provider receipts and separate simulated outcome confirmation.

**V2 — Exceptional visible product and commercial proof:**
11. Reference-approved design tokens and real component references power four connected screens; no empty/dead controls.
12. One licensed realistic 3D asset is synchronized to case/event state with camera constraints; WebGL loss leaves 2D full financial function.
13. Fault-injection and baseline results are reproducible, including cases where simpler methods tie/win.
14. A second physical adapter consumes the same planner and provider contract **without duplicating money rules**.
15. A sub-five-minute first-time-user demonstration proves the case and finishes on specific first-buyer value.

### Golden path test (must be runnable continuously)
`mission_created -> event_ingested -> alternatives_compared -> mandate_enforced -> approved_or_denied -> provider_intent_persisted -> real_provider_result_read -> case_replayed`.

Use a deterministic synthetic fixture with fixed clock/seed for offline CI, plus a separately triggered authorized provider smoke test. Never represent the offline test as sandbox integration proof.

## Prevent cascading busywork
- **WIP limit:** at most 2 code PRs open concurrently across overlapping packages; one owns finance contracts. Design research/3D asset evaluation may run in parallel but not mutate shared financial state.
- **One owner per domain contract.** No independent redesign of money, approval, provider statuses in web and backend. Shared API contracts first.
- **Fast merge** for self-contained docs/low-risk code after review and available CI; **deep gate** for money/auth, concurrency and deployments. A merge is not independent QA.
- **Stop condition:** no new feature if golden path is broken; fix the integration path before adding another screen or sponsor.
- **Timeboxes are investigation limits, not permission to ship dishonest placeholders.** If an external prerequisite fails, show a clearly labeled blocked/missing capability and direct effort into functioning core paths.
- **No premature performance claims.** FPS, economics, latency, API success, customer value require actual measurements.

## MVP acceptance, not generic "done"
- **A reviewer can make a financially consequential choice in a functioning app** using real provider confirmation and see its exact authority/evidence.
- **A failed or ambiguous financial operation cannot masquerade as success** or consume funds twice.
- **The UI makes the next action obvious** to a first-time finance/ops user; screen recording shows click path, error and accessible fallback.
- **The planner responds to changes that were not hard-coded solely for the demo.** It handles unknowns and declines uneconomic actions.
- **Submission claims distinguish** verified software, provider sandbox/testnet, synthetic physical systems, and business assumptions.

## Award-maximizing resource allocation
Founder/Judges require coherent economics, real technical depth and user delight; Metal award requires agentic mandate-controlled testnet payments; Visa award is conditional upon verified sponsor eligibility. Chase Visa only if its real tooling is available, distinctive and does not endanger V0/V1. AWS/T:0 are enabling infrastructure, not proof of award eligibility.

## Public repository risk
Repo is public, so issues/docs disclose competitive concepts. Do not publish private credentials, unpublished vendor relationships, customer names, nonpublic participant Slack, or secret demo keys. Consider private visibility only if organizer repo-submission requirements allow; do not change repo visibility without founder choice.

## Near-term gate review
- **Nov 2:** repo initialized, source of truth, reviewed merge.
- **Nov 3–4:** executable bootstrap and Airwallex/Metal access probes, verified or explicitly blocked.
- **Nov 5–8:** V0/V1 complete across backend and first functional screen; put no extra sponsor before this.
- **Nov 9–12:** UX, reference/3D polish, negative cases and benchmarks on integrated system.
- **Nov 13:** feature freeze after real golden-path rehearsal.
- **Nov 14–15:** release, video, factual evidence, submission verification.

These dates are intent, not a promise or proof of completion. Do not confuse a documentation milestone with a code milestone.
