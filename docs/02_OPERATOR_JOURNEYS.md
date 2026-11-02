# Operator journeys and screen-state contract

## Personas
- Fleet finance/operations manager: sets financial objectives, approves exceptional purchases, sees economic exposure.
- Technician/mission operator: supplies operating evidence, cannot expand finance authority.
- Finance approver: approves exact immutable transaction terms, not a vague AI recommendation.
- Auditor: read-only event replay and environment-labeled provider receipts.

## Journey A — First-run to trusted execution
1. Sign in; choose org and operating mission. Demo must label single-tenant or simulated auth if enterprise auth is absent.
2. Configure purpose, time window, budget envelope, protected reserve, per-action limit, approved counterparties, authorization expiry and required evidence.
3. Review compiled mandate; confirm only after reading exact restrictions.
4. Mission Treasury shows financial balances with provider/source timestamps and separate available, reserved, pending and spendable values.
5. Event enters Decision Room with asset provenance and freshness; review alternatives with total committed cost, time, assumptions, uncertainty and policy.
6. The agent can take a permitted next step or request exact approval; never require the user to click 'next' for each agent step.
7. Airwallex or Metal action shows `queued/submitted/unknown/settled` clearly and supports independent receipt inspection.
8. Evidence Replay links event, plan, approval, operation, provider receipt and independently observed operating outcome.

## Journey B — Two missions competing for one budget
Mission A reserves funds; Mission B attempts competing reservation. One cannot consume another's committed funds. Show exact denial, feasible alternative, and updated spendable cash; test concurrent requests, not just sequential examples.

## Journey C — Bad provider/evidence states
- Lost HTTP response: operation becomes STATUS_UNKNOWN; same economic intent never gets a new request ID.
- Price or beneficiary changes after approval: old approval invalid and signed digest mismatch.
- Expired or unapproved mandate: reject before spending.
- Paid digital service gives no useful result: financial transaction is recorded, evidence delivery remains missing.
- Stale machine observation: show age and refuse unsupported autonomous commitment.
- Provider settles but physical mission fails: keep financial and operating statuses separate.
- AI unavailability: case and financial state remain readable; no fake fallback financial authority.
- WebGL unavailable: 2D Mission Treasury and financial execution remain fully usable.

## Screen structure
1. **Mission Treasury**: priority actions, funding/commitment state, active missions, exceptions.
2. **Decision Room**: selected mission evidence, alternative plans, estimated effects, synchronized 3D/2D state.
3. **Authority & Execution**: exact terms, policy evaluations, action receipt and honest provider status.
4. **Evidence Replay**: immutable timeline, original/revised plans, linked approvals and provider vs operating results.

## Acceptance
At each step: loading, empty, blocked, pending, resolved and error states; mouse, keyboard, 320px mobile, touch and reduced motion. No dead controls or financial details hidden by hover.
