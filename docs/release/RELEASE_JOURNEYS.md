# Release E2E journeys — where each is proven, or exactly what blocks it (issue #19)

Maps the six release-level journeys to EXECUTABLE evidence on the
integration head (`8ce4601`). No journey is marked satisfied by an agent
claim or an open PR; a journey only moves to PASS when the named command
passes against the implemented contracts. Fake endpoints are never created
to make a row green.

## Journey A — successful governed decision — PASS (with one sub-gap)

| Step | Evidence (executable) |
|---|---|
| Authorized user signs in | `e2e/authenticated.spec.ts` "login renders real ledger data…" (real cookie session) |
| Creates or selects a mission | Same spec: mission selection drives content ("Subsea mooring survey" click) |
| Creates an exact mandate | Unit: `apps/api/test` mandate issuance/validation suites; UI list shows envelopes + superseded/lapsed states |
| Admits synthetic physical baseline + incident | `e2e/physical-decision.spec.ts` (serial): SYNTHETIC incident admitted, journal-visible |
| Records evaluation / revised evaluation | Planner evaluate suites (112/112) + Decision Room before/after view (same spec) |
| Selects a valid proposal | Same spec: `ASSET_SAFETY_BLOCKED` → "Hire vessel-inspection" selection |
| Logs out / DIFFERENT approver signs in | Auth suite: logout + session isolation (`verify-demo-auth-security.mjs` S7/S8); separation of duties unit-enforced (proposer ≠ approver) |
| Retrieves persisted immutable plan terms | `/api/operations/:id` exact terms; approval digest binding unit tests |
| Approves; authorization permits next operation | MTV-05 approval/reservation suites (105 ledger tests; approval gate is the dispatch precondition) |
| Provider state shown honestly | `/api/system/status` OFFLINE/DISABLED (P1b); operations ladder shows SUBMITTED ≠ SETTLED |
| Evidence Replay links the same IDs | `e2e/investigation.spec.ts` "one identity" (operation id filters the journal) |

Sub-gap (not blocking, recorded): the two-actor UI handoff (sign out → sign
in as approver → approve THE plan) is exercised through API-level tests +
per-screen UI specs, not yet as ONE continuous browser spec. Owner: #19 E2E
authors (also addresses D-2/D-3 hardening).

## Journey B — refusal — PASS

- Planner refusal/escalation: planner adversarial suite (insufficient
  budget, safety-blocked alternatives) + reliability matrix FI family
  (12/12, incl. refusals and zero-side-effect evidence-only cases).
- Over-budget denial journaled and replayed: `mission-history-routes.test.ts`
  (PR #37 evidence).
- No unauthorized plan/payment appears: spendable clamps to 0 /
  INSUFFICIENT_SPENDABLE paths in ledger suites; UI refuses with machine codes.
- Refresh/replay preserves explanation: journal append-only + investigation
  spec reload stability.

## Journey C — changed terms — PASS (engine level); UI journey NOT_PRESENT

- Changed amount/beneficiary/mandate/quote/evidence structurally invalidates
  an approval (digest binding): ledger approval-term-mismatch suites; MTV-05
  CTO-reviewed regressions (revocation after gate, envelope shrink, supersede).
- An explicit new decision + authorization is required: enforced by
  reservation re-validation; tested.
- BLOCKED-as-UI-journey: no browser spec walks "stale approval rejected in
  the approve screen" — the screen flow for re-approval is Agent B/#19 E2E
  work. Recorded; not simulated.

## Journey D — uncertain external state — PASS (offline proof)

- Provider timeout/ambiguous → STATUS_UNKNOWN retains commitment: ledger
  crash/timeout suites; Airwallex adapter transport ladder (read-only
  retries; writes never auto-retry) — 106/106 adapter tests.
- Restart does not duplicate the payment: outbox replay-by-original-id tests
  (crash-after-accept, create-lane-empty rerun) incl. the smoke runner
  acceptance tests.
- Readback uses original identity: reconciliation scope tests (R3 P0-2/3).
- UI never marks success without verification: green only for
  readback-attested SETTLED (design contract enforced by the token checker);
  STATUS_UNKNOWN renders as Unknown with resolve-by-original-id guidance
  (investigation spec).
- Note: all of the above is offline/harness proof; the LIVE sandbox variant
  remains BLOCKED on credentials (issue #5) — never claimed otherwise.

## Journey E — visualization failure — NOT_APPLICABLE at this head

The production shell has no WebGL surface (3D is issue #11). The design lab
exercises a SYNTHETIC SVG staging with its own fallback states; nothing in
production can fail at rendering and mutate ledger state — the shell has no
mutation surface without DEMO_AUTH (verified: P2 fail-closed). Revisit when
#11 lands (owner Agent C).

## Journey F — independent reviewer — PARTIAL

- PASS: `docs/release/REVIEWER_ACCESS.md` — documented access, no hidden
  admin knowledge; fresh checkout → `node scripts/release/demo.mjs` → sign
  in → find mission → inspect evidence/decision/outcome; synthetic vs
  verified distinction is on every screen.
- BLOCKED (hosted): a public URL serving the FULL journey needs real
  reviewer authentication (Agent A). The hosted read-only shell +
  honest status deploys today via `deploy/` with no financial surface.
