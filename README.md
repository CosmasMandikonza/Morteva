# MOTERVA · Mission Treasury

**Proposed financial autonomy platform for physical operations.** Repo name is `Morteva` (as created); product name is `MOTERVA`. This is a hackathon-build project, not a production banking service.

> **Truth as of 2026-11-02:** Repository contains planning/engineering documentation only. No working app, tests, deployed service, Airwallex sandbox transfers, Metal testnet operations, or live robotics integrations have been verified here. Read [STATE](docs/STATE.md) before making claims.

## Start here
- [Release epic #2](https://github.com/CosmasMandikonza/Morteva/issues/2): goals and prize-oriented release requirements.
- [Foundation review PR #1](https://github.com/CosmasMandikonza/Morteva/pull/1): audit history, findings and implementation contract.
- [Delivery dependencies / decision register](docs/07_DELIVERY_ORDER_AND_DECISIONS.md)
- [Product charter](docs/00_PRODUCT_AND_COMPETITION.md) and [operator journeys](docs/02_OPERATOR_JOURNEYS.md)
- [Financial architecture](docs/01_ARCHITECTURE_AND_DOMAIN.md) and [security/provider gates](docs/05_FINANCIAL_SECURITY_AND_PROVIDER_GATES.md)
- [Reference-led UI](docs/03_UI_REFERENCES_AND_DESIGN_GATE.md) and [3D quality](docs/04_3D_ASSET_AND_CAMERA_GATE.md)
- [Verification / demo criteria](docs/06_TESTING_AND_DEMO_EVIDENCE.md)
- [CTO risk analysis and first vertical slice](docs/08_CTO_RISK_REVIEW_AND_VERTICAL_SLICE.md)
- [Risk-weighted PR review and safe-merge protocol](docs/09_PR_REVIEW_AND_MERGE_PROTOCOL.md)
- [Truthful status](docs/STATE.md)

## Recommended issue order

**Infrastructure and finance first:** [#3 Stack/CI](https://github.com/CosmasMandikonza/Morteva/issues/3) → [#4 durable financial state](https://github.com/CosmasMandikonza/Morteva/issues/4), [#5 Airwallex sandbox](https://github.com/CosmasMandikonza/Morteva/issues/5), [#6 Metal testnet](https://github.com/CosmasMandikonza/Morteva/issues/6), [#7 exact policy/approval](https://github.com/CosmasMandikonza/Morteva/issues/7), [#8 adaptive planner](https://github.com/CosmasMandikonza/Morteva/issues/8), [#9 mission adapters](https://github.com/CosmasMandikonza/Morteva/issues/9).

**Reference-led visual work in parallel:** [#10 design approval](https://github.com/CosmasMandikonza/Morteva/issues/10) → [#11 3D asset spike](https://github.com/CosmasMandikonza/Morteva/issues/11) → [#12 Mission Treasury](https://github.com/CosmasMandikonza/Morteva/issues/12), [#13 Decision Room](https://github.com/CosmasMandikonza/Morteva/issues/13), [#14 state-linked 3D](https://github.com/CosmasMandikonza/Morteva/issues/14).

**Prove and ship:** [#15 adversarial evaluations](https://github.com/CosmasMandikonza/Morteva/issues/15), [#18 buyer/value case](https://github.com/CosmasMandikonza/Morteva/issues/18) → [#19 final release](https://github.com/CosmasMandikonza/Morteva/issues/19). [#16 Visa](https://github.com/CosmasMandikonza/Morteva/issues/16) and [#17 T:0/AWS](https://github.com/CosmasMandikonza/Morteva/issues/17) are *conditional* and must not derail the core.

## Contribution contract
One bounded issue per PR with real commands, tests, screenshots and redacted provider evidence where applicable. Review and merge promptly when the appropriate documented risk-tier evidence is complete and the exact head SHA matches; never merge on green labels or summaries alone. No invented financial success, speculative performance claims, placeholder licensed assets or uncontrolled spending. An unknown payment state is not a failed payment and must not be blindly retried. No secrets or personal data in this **public repository**.

## Official sources
- [Airwallex builder guide](https://airwallexdev.com/guide)
- [Hackathon page](https://airwallex.hackerearth.com/)
- Participant-provided organizer Slack extended submission to **Nov 15, 2026 11:59 PM PST**. Reconfirm in submission dashboard; public page still lists an earlier date.
