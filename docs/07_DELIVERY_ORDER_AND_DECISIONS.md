# Delivery order, dependencies and founder decision register

## Rule for scoped implementation
One issue = one user-observable contract and acceptance evidence; **integrate continuously around the V0/V1 golden path in docs/08, not merely a set of isolated tickets**; one implementation PR at a time on overlapping files. No refactoring adjacent unrelated code. Read this file and STATE.md before coding. Write results back after merge. A checkbox in an issue is not evidence without logs, screenshots or provider receipts. Review and proactively merge passing work under docs/09; use exact expected head SHA to prevent merging a changed PR.

## Dependency-driven order
**Stage A, Nov 2–4:** choose stack via ADR; establish CI/local checks and financial domain contracts. Unblock sandbox and Metal accounts privately. Independent provider probes must happen early.
**Stage B, Nov 4–7:** money reservations, approval hashes, idempotency and provider adapters; compare feasible actions. First complete truthful finance operation.
**Vertical slice gate, no later than Nov 8:** the full financial flow works on a real Airwallex sandbox with authoritative provider readback; optional Metal result separately confirmed. See docs/08. Do not wait to combine providers, planner, UI and case replay until the end.
**Stage C, Nov 6–10:** reference board, approved design tokens, full operator flow; approved asset spike; synchronized 3D with 2D fallback.
**Stage D, Nov 10–13:** adversarial tests, visual/camera QA, second adapter only if primary finance path already passes; optional Visa/T:0 integrations behind timeboxes.
**Stage E, Nov 14–15:** stabilization, deployment, reproducible evidence, five-minute capture, verify submission and links. No major scope additions.

## Parallel work boundaries
Provider integrations and asset-reference research can proceed in parallel. Financial kernel must settle types/API before UI binding. Design/3D workers must not redefine finance statuses or invent backend outcomes. No concurrent edits to shared configuration without explicit owner. Maximum two simultaneous implementation PRs touching overlapping packages; if V0 golden path breaks, do not add sponsor or scene work until repaired.

## No-go decisions
- If Airwallex real sandbox operation cannot be independently verified, do NOT claim a working financial MVP; immediately raise blocker.
- If Metal mandate execution cannot be verified, do NOT claim Metal Award readiness; keep main Airwallex path honest.
- If Visa sponsor access is not established, park Visa integration as blocked rather than simulating qualification.
- If licensed 3D model cannot meet quality gate, retain full 2D functional product and pursue asset acquisition—do not pass a placeholder as final.
- If app/deployment tests fail at freeze, prioritize financial correctness and accessibility; no misleading optimistic 'success' UI.

## Decisions to record (ADR required before coding)
Framework/monorepo, persistence+transactions, session/tenant auth, runtime hosting, queue/webhook processing, provider SDK/REST choice, scene library, selected reference family and licensed asset, selected first vertical/mission type. For each: options, rationale, failure modes, reversibility, reviewer/date.

Recorded:
- 2026-11-02 — [ADR 0001: stack and runtime](adr/0001-stack-and-runtime.md) (npm-workspaces monorepo, Vite+React/Fastify, SQLite-first behind a storage port; auth/jobs/deployment plan of record). Reviewer/date pending PR review.

## Founder input gate (not an endless question loop)
Agent should make best-effort default choices backed by evidence; only request founder action for external credentials, paid services, legally binding approvals, or aesthetic reference selection. Maintain a single concise unblock list in STATE.md.
