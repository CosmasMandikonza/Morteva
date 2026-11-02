# System architecture, domain contracts and boundaries

## Architecture (proposed)
- `apps/web`: Mission Treasury, Decision Room, Authority/Execution, Evidence Replay; never holds banking/signing credentials.
- `apps/api`: authenticated server routes; organization/mission authorization; typed read models and commands.
- `packages/domain`: typed money, entities, state transitions, invariants, pure policy functions.
- `packages/planner`: evidence normalization, candidate action proposals, deterministic feasible-plan evaluation.
- `packages/providers/airwallex`: server-side auth, balances, FX and transfers; provider result normalization.
- `packages/providers/metal`: backend-only wallet signing, mandate checks, order execution and receipt reads.
- `packages/physical-adapters`: deterministic simulated mission events and later third-party read-only adapters.
- `packages/evidence`: append-only event journal, references, provenance and replay.
- `packages/scene`: licensed asset renderer, subscriber to domain snapshots; a 2D equivalent always available.
Paths are a proposal, not an assumed framework. The first architecture issue selects stack, database and deployment after recording an ADR.

## Domain objects
`Org`, `UserRole`, `Mission`, `Asset`, `OperationalEvent`, `Evidence`, `Mandate` (immutable version), `CandidatePlan` (immutable version), `Approval`, `Commitment`, `FinancialOperation`, `ProviderReceipt`, `DeliveryEvidence`, `OutcomeEvidence`.
All records carry `org_id`, stable IDs, source, timestamps and status as appropriate. Evidence references a digest; changed economic terms produce a new plan/approval scope.

Money is stored internally as integer minor units together with ISO currency and correct currency exponent; provider payload conversion happens at adapter boundaries. **Airwallex's sandbox APIs use major units**; never send internal cents directly as major-unit amounts. Avoid binary floating point for money and rate math.

## Operation lifecycle
`PROPOSED -> RESERVED -> APPROVED/AUTO_AUTHORIZED -> SUBMITTING -> IN_FLIGHT -> SETTLED -> RECONCILED`.
Alternate paths: `REJECTED`, `EXPIRED`, `STATUS_UNKNOWN`, `CANCELLED`, `REQUIRES_HUMAN`. Provider-specific statuses are mapped conservatively and original raw evidence retained. A `STATUS_UNKNOWN` operation continues to consume the appropriate commitment until resolved, not treated as failed or safe to retry.

## Core transaction sequence
1. Validate user/org/mission/mandate version and trusted evidence freshness.
2. Evaluate feasible candidate; attach exact quote/beneficiary/amount/currency and evidence digest.
3. Acquire org+currency guarded budget reservation transactionally; reject competing spend beyond capacity.
4. Persist provider operation identity and request_id before any network call.
5. Invoke provider through server-side adapter; persist provider identity and raw status.
6. Poll/read or verify a signed webhook; reconcile asynchronously, reject duplicate/out-of-order events.
7. Release/settle commitments only according to verified operation state.
8. Ingest operational outcome separately; payment never implies delivery or repair.

## Contract gate
Each provider adapter must expose capability discovery, a typed request/response schema, idempotency behavior, live/test environment label, observable pending/error results and a receipt-verification method. No direct provider SDK calls from the UI or planner.

## Cross-cutting
Structured error codes; correlation IDs; read model rebuilding from journal; tenant isolation; secrets managed server-side; least privilege; clock and currency precision; deployment config validation.

## Sources
https://airwallexdev.com/guide
