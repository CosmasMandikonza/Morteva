# MOTERVA — Product narrative and submission copy

This is the public-facing story for MOTERVA. It describes an actual product architecture and the first market we intend to serve; it is not a claim of paying customers, live financial settlement, or deployed production infrastructure.

## Positioning

**Category:** Mission Treasury / evidence-bound financial operations.

**Tagline:** When the mission changes, the money should know.

**One sentence:** MOTERVA turns changes in the physical world into explainable, authorized financial decisions — with the operational evidence, spending rules, approvals and provider outcome linked to the same mission.

**Short description (submission-ready):**

An inspection drone is grounded by weather. Do you wait, book a vessel, or spend more to recover the mission? MOTERVA connects physical operations to financial authority. It ingests authenticated field observations, recalculates feasible options under real mission budgets and safety rules, and prepares exact financial actions for the right approver. Every change, refusal, commitment and provider result has a replayable evidence trail. We're starting with inspection and asset-intensive operations, where a change in the field can become an expensive financial decision.

**Extended description:**

Field operations and finance rarely move at the same speed. An inspection team can know a drone cannot fly while the finance team is still working from yesterday's plan. The decision is not merely which supplier is cheapest: it is what remains operationally feasible, which delay costs more, whether protected cash can be touched, who is allowed to approve revised terms, and what evidence proves the money actually moved.

MOTERVA is Mission Treasury for that gap. Teams configure a mission's assets, objective, counterparties, economic assumptions, constraints and financial authority. Source-authenticated operational observations enter a durable journal. A policy-driven planner evaluates the new reality and compares alternatives, including waiting, escalating or taking no action. When spending is justified, MOTERVA creates an exact plan tied to a mandate, requires independent approval where appropriate, reserves capacity, and maintains the original economic identity through provider execution and reconciliation. An interactive physical Decision Room connects the change on the ground to the change in the financial plan; Evidence Replay connects the decision to its source.

The first intended buyer is an inspection-fleet operations/finance leader dealing with weather, equipment availability and subcontractor decisions. Over time, the same financial authority and evidence layer could serve other robotic and asset-intensive workflows without changing the financial-control model for every machine type.

## The thesis — what makes this different

| Existing product category | What it excels at | The gap MOTERVA targets |
| --- | --- | --- |
| Connected-operations / fleet platforms | Observing assets, telemetry, alerts and safety conditions | Connecting an operational exception to a financial alternative with bounded spending authority |
| Procurement / spend orchestration | Suppliers, purchasing workflows, approvals and budgets | Re-evaluating those decisions in response to authenticated machine-level conditions |
| Business banking and treasury APIs | Balances, payments, FX and provider state | Making a particular mission's physical evidence part of the reason money is committed |

The differentiation is the **shared mission identity** carried from evidence to decision to authorization to provider receipt, not a claim that no other company can or does connect these systems. MOTERVA is not a new bank, a drone autopilot, or a model allowed to move money by itself.

## First beachhead and commercial hypothesis

- **Initial customer:** drone/maritime/industrial inspection operators and their finance or operations leaders; especially teams coordinating subcontractors when assets or weather change.
- **Urgent job:** decide whether to wait, substitute a supplier, or escalate without losing mission economics, exceeding authority, or paying twice.
- **Potential expansion:** other physically constrained workflows (warehouses, robotics, marine survey, equipment servicing), using the same mission/policy/approval/receipt backbone.
- **Metrics to validate in pilots:** time from incident to approved plan; fraction of changes with clear cost/reason; avoided duplicate/unauthorized commitments; exception-reconciliation time; mission completion cost versus policy-only or manual baseline.
- **Commercial status:** these are target customers and hypotheses, not published customer traction, signed pilots, revenue or measured ROI.

## Five-minute story for a judge

| Segment | What must be visibly proved |
| --- | --- |
| 0:00–0:30 — The problem | A physical interruption forces a financially consequential choice; show the Decision Room, not slides of architecture |
| 0:30–1:10 — Mission and authority | Identify the mission's real configured economics, budget and who can approve; distinguish sample assumptions |
| 1:10–2:10 — Evidence changes | Show the initial option, admit the signed *sample* wind incident, and watch the server-evaluated feasible alternatives change |
| 2:10–3:10 — Governed financial decision | Show the selected alternative, cost, refusal reason for the unsafe option, exact proposal and separate authorization |
| 3:10–4:10 — Evidence and provider boundary | Follow event → decision → approval → reservation → replay; show an actual verified sandbox receipt only if one has been obtained |
| 4:10–4:50 — Why it becomes a company | First buyer, why a field-to-money operating layer matters, and how a general registered mission handles unfamiliar values |

Leave time for an honest status statement and a clear close. Never script a provider success, a real sensor measurement or a model invocation that did not happen.

## Evidence and claim guardrails

**Implemented and code-tested:** mission specifications, server-side tenancy and authority, sealed source credentials, signed event ingestion, deterministic feasible-plan evaluation, exact economic proposals, distinct approvals, guarded reservations/outbox, 3D harbor visualization with non-spatial fallback, and historical replay.

**Observed with external services:** Airwallex sandbox login/balances/beneficiaries and Metal testnet funding/live x402 seller offer/refusal checks, as recorded in the repository's evidence reports.

**Not yet independently demonstrated as completed:** a live authorized Airwallex transfer and reconciled final state, a signed Metal purchase, live model interpretation with a configured provider, public AWS production deployment, paying customers or outcome-based ROI.

The code has a bounded model adapter, but its optional presence is not evidence that the model ran. Source authentication means a source claimed a reading with a valid credential, not that the physical instrument was independently calibrated. A financial proposal or reservation is not proof that a provider transferred or settled money.

## Reviewer links

- [README / runnable product](../README.md)
- [State and verification history](STATE.md)
- [Customer workflow](design/mtv-13-customer-workflow.md)
- [Security and provider gates](05_FINANCIAL_SECURITY_AND_PROVIDER_GATES.md)
- [AWS deployment and operational risks](release/AWS_DEPLOYMENT.md)
- [Official Airwallex hackathon](https://airwallex.hackerearth.com/)
- [Airwallex builder guide](https://airwallexdev.com/guide)

The competition offers several treasury and agentic-commerce starter paths; our product should be evaluated on whether it demonstrably joins operational evidence to governed financial decisions, not by claiming a larger feature checklist.
