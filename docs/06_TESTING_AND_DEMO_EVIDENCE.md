# Quality gates, evidence format and release criteria

## Gate 0 — truth and reproducibility
Every PR records base/head SHA, exact commands, results, environment, missing permissions and *untested* areas. Issue closure is not proof. Never invent performance numbers, test counts or receipts. No merge without review.

## Gate 1 — financial trust
- One true Airwallex sandbox operation, persisted request/provider IDs and independently retrieved status.
- One true Metal mandate-controlled testnet payment, verified hash, denial/rejection test and source evidence.
- No unresolved unauthorized transfer, tenant crossover, overcommitment, stale approval, wrong money units, or double economic operation.
- Submitted is not settled; unknown retains commitments. Durable replay after restart must not invoke provider again.

## Gate 2 — adaptive agent decisions
Typed context and model interpretations generate candidate plans. Trusted evaluator chooses only feasible plans and requires approval where needed. New balance, price, evidence, deadline or risk must provoke justified replanning; repeated input must remain stable. AI never receives signer or bank credentials.

## Gate 3 — full operator UX
End-to-end financial journey, no dead controls; real loading/blocked/pending/unknown/error/settled states. Keyboard, focus restoration, screen-reader labels, 320px, 390px, 768px, 1024px, 1440x900, 1920px, reduced motion, and browser 200% zoom.

## Gate 4 — visual quality
Licensed 3D asset; source-approved design references; realistic framing, scale and motion; no occlusion or lost object on zoom; measured FPS/device/scene footprint and 2D fallback. Captures at wide/selected/fault/replan/approved/submitted/verified/mobile/zoom extrema/WebGL recovery.

## Gate 5 — submission evidence
Working hosted flow, README, reproducible setup and seeded synthetic scenarios, CI results, provider receipts with sensitive fields redacted, baseline comparison with limitations, recorded demonstration under five minutes, tested backup replay clearly labeled as replay.

## Required PR evidence
```yaml
issue:
head_sha:
environment:
commands:
test_results:
screenshots:
provider_receipts_redacted:
adversarial_cases:
accessibility:
asset_license:
known_failures:
out_of_scope:
reviewed_by:
```

## Benchmarks
Compare against cheapest-first, deadline-first and safe static policy on reproducible synthetic scenarios. Measure simulated objective completion, exposure, budget violations, duplicate transfers and time-to-decision; include cases where a baseline ties or wins. Never assert unmeasured real-world savings.

## Deadline
Organizer Slack supplied by participant extends due date to **Nov 15, 2026 at 11:59 PM PST**, ahead of the public page's older Nov 13 date. Recheck official dashboard before submission; no late major features.
