# MOTERVA commercial memo — issue #18 (source-backed, one page + model)

Prepared for submission review, 2026-11-08. Every claim is tagged:
**[S] sourced** (vendor documentation or credible public data, links at end) ·
**[M] model-estimated** (stated assumptions) · **[P] measured prototype
behavior** (reproducible in this repository) · **[U] unvalidated sales
assumption**. Nothing here asserts real customers, real savings or verified
provider funds.

## The product in one sentence

When something changes in the physical world, MOTERVA determines what that
means for the mission's money, proposes an authorized response, gets
independent human approval, executes with the payment provider, and preserves
replayable evidence of every decision. Category: **mission-scoped financial
autonomy for physical operations** — the governance layer between field
telemetry and company money.

## Why the first buyer cares

Small/mid autonomous-inspection operators (drones/ROV, 10–50 staff) that
subcontract external providers already live the workflow gap **[U, grounded
in the matrix below]**: a mid-mission scope change ("wind grounds the UAV —
subhire the vessel survey or wait?") is decided over email/WhatsApp, then
chases a PO approval, then reconciles afterwards. The economic stakes are
asymmetric: inspection-class UAV services run ~$150–500/hr / $2.5k–12k per
building package **[S: 13]**, while the vessel alternative runs ~$28–36k/day
(PSV, 2024) **[S: 15]**. A single avoided wrong-mode or de-risked decision is
a $10k-class event **[M]**. Downtime-cost literature (vendor-published,
treat as upper bound: ~$9k/min average) **[S: 16]** says approval latency on
live assets is expensive even discounted 90% **[M]**.

**Buyer persona [U]:** Operations Director (economic buyer) + mission
coordinator (daily user). Job-to-be-done: "when field evidence changes the
mission's scope, commit the cheapest compliant response in hours, not days,
with an audit trail my client and my CFO both accept."

## Competitive matrix (what incumbents' own docs say they cover)

| Category (example) | Physical evidence | Adaptive economic decision | Governed financial execution | Replayable causal proof |
|---|---|---|---|---|
| FSM — ServiceTitan **[S: 1]**, Salesforce FS **[S: 2]** | ◐ work orders/forms | ○ scheduling only | ◐ back-office invoicing | ○ job history |
| Robotics ops — Percepto **[S: 4]**, FlytBase **[S: 5]** | ● fleet/dock telemetry | ○ risk dashboards | ○ none (verified pricing pages) | ◐ mission logs |
| ERP — SAP Ariba **[S: 6]**, NetSuite **[S: 7]** | ○ | ○ static approval rules | ● PO/budget workflows | ◐ approval trail |
| Payments — Airwallex **[S: 8]**, Ramp **[S: 9]** | ○ | ◐ static policies (Ramp) | ● transfers/approvals — **SoD manual, not enforced** (Airwallex docs) | ◐ status trail |
| Workflow — ServiceNow **[S: 10]**, n8n **[S: 11]** | ○ | ◐ approval nodes | ○ | ◐ execution logs |
| **MOTERVA [P]** | ● authenticated (synthetic-labeled) mission evidence | ● policy-only planner comparing spend options under safety constraints | ● reservation ledger + enforced separation of duties + exact-term approvals + revocation safety | ● append-only evidence replay, same-ID linkage |

**Differentiation that survives scrutiny [I]:** incumbents cover at most two
of the four pillars; each would have to build the other's pillar to close
the loop. MOTERVA's defensible v1 asset is the **workflow contract** —
evidence-gated, exact-term, revocable, replayable approvals — executed over
commodity rails. Citable wedge: Airwallex's own approvals documentation
leaves separation-of-duties to manual configuration **[S: 8]**; MOTERVA
enforces it in the ledger **[P]**.

## Financial assumptions model (one honest page)

**Layer 1 — measured prototype behavior [P, reproducible]:** 45/45
deterministic reliability scenarios; planner benchmarks beat/tie/lose vs
cheapest-first, deadline-first and static baselines (ties and losses
included, `apps/api/src/mission-events/reliability/results/summary.md`);
exact-term approvals structurally invalidated by changed terms; unknown
states retain commitments; zero provider calls to date.

**Layer 2 — model-estimated operating economics [M]:** single-host
deployment ≈ $5–6/month VPS class; one Node process + SQLite + static shell
(no per-transaction infrastructure cost modeled below ~10⁴ missions/month);
per-mission marginal cost ≈ $0 (deterministic policy planner, no LLM
inference in the decision path).

**Layer 3 — real provider results:** NONE yet. Airwallex sandbox adapter
merged, DISABLED pending credentials (issue #5). Metal explicitly
RAIL_ASSET_UNSUPPORTED (issue #6). No settlement claim is made.

**Layer 4 — hypothetical customer savings [M, not validated]:** pricing
hypothesis $75–150/ops-user/month (anchors: Salesforce FS dispatcher
$175/user/mo official **[S: 2b]**; ServiceTitan reported ~$245–500/tech/mo
**[S: 14, third-party]**), or 1–2% of managed mission spend. One averted
vessel-day (~$30k **[S: 15]**) covers 2+ years of a 5-seat deployment at
$125/user **[M]**. Savings are NOT claimed as achieved anywhere.

**Layer 5 — unvalidated sales assumptions [U]:** persona exists and will
pay; episodic missions generate enough decision-worthy forks for per-seat
SaaS; buyers accept attested-evidence workflows without SOC2 initially;
external providers accept settlement via customer-chosen rails.

## Reasons buyers might reject (known, not hidden)

1. Synthetic physical provenance ≠ field-verified evidence.
2. No SOC2/indemnification vs Ramp/Airwallex bank-grade expectations.
3. Integration burden: buyers already paid $5–50k standing up FSM **[S: 14,
   reported]**; MOTERVA must interconnect fleet APIs + ERP + rails.
4. Episodic usage vs per-seat pricing.
5. "Airwallex already does approvals" — countered only by enforced SoD +
   evidence gating + revocable reservations.
6. Counterparty onboarding for external providers.

## Validation status — OUTSTANDING

No buyer conversation has occurred. Interview protocol (first 5 questions):
(1) walk me through the last mid-mission scope change and where the money
decision happened; (2) what did the delay cost; (3) who approved, and how
did you prove it afterwards; (4) what would you need to trust an automated
proposal; (5) what would you pay for it. No quotations, customers or
commitments are fabricated for submission.

## Sources

1. servicetitan.com/features/dispatch-software · 2. salesforce.com/service/field-service-management (+ /pricing) · 3. ifs.com/en/products/fsm · 4. percepto.com/autonomous-site-inspections · 5. flytbase.com/pricing · 6. help.sap.com (Ariba approval process) · 7. docs.oracle.com (NetSuite approvals) · 8. airwallex.com/docs (batch-transfer approvals) · 9. ramp.com/corporate-cards · 10. servicenow.com/docs (approvals) · 11. n8n.io/features · 12. docs.deltaquad.com/evo/auterion-suite · 13. uavcoach.com/drone-services-pricing (+skyebrowse, dronebundle) · 14. third-party reported ServiceTitan pricing (GetApp/ITQlick — uncorroborated) · 15. rivieramm.com (PSV day rates) · 16. load1.com / tractian.com (downtime cost, vendor-published upper bounds).
