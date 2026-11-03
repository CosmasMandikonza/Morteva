# ADR 0001 — Stack and runtime for MOTERVA

- **Status:** Proposed (delivered with MTV-01, issue #3)
- **Date:** 2026-11-02
- **Deciders:** Engineering (agent) per docs/07 founder-input gate; founder reserved decisions (brand, paid services) untouched
- **Review:** due at PR review; supersession requires a new ADR

## Context

Issue #3 requires choosing the stack before any application work, comparing two practical options against: local-first development, persistent database transaction semantics, safe background idempotent jobs, hosting/credits, secret isolation, React-Three-Fiber (R3F) interoperability for the later 3D view (issues #11/#14), test tooling, and the hackathon deadline (Nov 15, 2026). docs/01 already proposes a module layout (`apps/web`, `apps/api`, typed `packages/*`) and hard boundaries: provider credentials never reach the browser; the planner never calls provider SDKs; money math is server-side and typed.

This ADR freezes the runtime choices needed to unblock #4–#14. It deliberately does **not** design a microservice fleet.

## Options compared

### Option A — Single Next.js application (App Router + route handlers + managed Postgres)

One Next.js app serving UI and API routes; Prisma/Drizzle against a hosted Postgres (Neon/Supabase); deployed on Vercel.

- Local-first: requires network or a local Postgres container for realistic transactional work; offline dev degrades to mocks.
- Transaction semantics: managed Postgres gives real row-locking transactions, but every financial invariant then depends on a managed service during a hackathon.
- Jobs/webhooks: serverless functions have per-invocation time limits; the durable outbox worker (docs/01 "Outbox and crash window") needs a long-lived process or a separate queue product.
- Hosting/cost: Vercel free tier is fine for demos; a background worker is not part of that tier.
- Secret isolation: route handlers are server-side, fine; but one deployment unit makes it easy to accidentally import server code into client bundles.
- R3F: works, but SSR/hydration adds friction for WebGL scenes (disable SSR per route).
- Test tooling: Jest/Vitest + Playwright all work.
- Time: one framework to learn/configure, but serverless+worker+managed-DB integration debugging is exactly the class of time sink docs/08 warns about.

### Option B — npm-workspaces monorepo: Vite React SPA + Fastify Node API + shared typed packages (CHOSEN)

Two small apps and shared packages in one repo, one Node process per app, one lockfile:

- `apps/web` — Vite + React 19 SPA (TypeScript strict). Talks to the API same-origin through a dev/preview proxy.
- `apps/api` — Fastify 5 server (TypeScript strict). Owns all routes, validation, provider adapters and secrets.
- `packages/domain` — pure money/state contracts, single owner (docs/07).
- `packages/providers` — provider port contracts + honest OFFLINE descriptors.
- Persistence: **SQLite first, behind a storage port, Postgres later** (see Decision 3).
- Tooling: npm workspaces + `npm ci`, TypeScript project references, ESLint + Prettier, Vitest, Playwright (chromium), GitHub Actions.

## Decision

**Option B.** Explicit reasons against each handoff criterion:

1. **Local-first development.** Two `npm run dev` processes and a file-based database; `git clone → npm ci → npm run dev` works on a train with no network. No managed-service signup is needed to reach a truthful financial flow.
2. **Persistent DB transaction semantics.** SQLite (WAL) gives real ACID transactions with simple, synchronous code — ideal for the atomic org+currency reservations in #4 — with none of the connection-pool/managed-service failure modes during a two-week build. The storage code sits behind a narrow port so switching the write path to Postgres when concurrent writers or hosted multi-process deployment arrive is a contained change, not a rewrite. This defers, deliberately, the moment we must operate a database server.
3. **Safe background idempotent jobs.** A plain Node worker process consuming a durable outbox table in the same database gives at-least-once execution with no queue product and no serverless timeout; recovery-by-original-request-id (docs/01 §4) is straightforward to implement and to fault-inject in #4/#5.
4. **Hosting/credits.** Nothing hosted yet (MTV-01 deploys nothing). Later: either free-tier static web + one small container (~US$5–10/month) or sponsor credits if legitimately available; CI is free on a public repo. No cost is incurred before the vertical slice proves value.
5. **Secret isolation.** Provider credentials exist only in the API's server-side environment. The web bundle physically cannot import them (separate package, no shared server code), and the API is fail-closed: routes that don't exist 404, CORS is a strict one-origin allowlist, financial routes are absent until #5/#6 ship behind authentication.
6. **R3F interoperability.** Plain React 19 + Vite is the most direct host for `@react-three/fiber` v9 later; no SSR/hydration caveats for WebGL, and the 2D fallback (docs/04) is just another React view of the same state.
7. **Test tooling.** Vitest for unit (money invariants already tested), Fastify `inject` for API integration tests without sockets, Playwright against the real built servers for E2E — all running in one CI job on a cold checkout.
8. **Hackathon time.** Two small boring processes beat one framework with three deployment paradigms when the deadline is fixed and the win condition is a truthful financial flow (docs/08).

## Consequences and trade-offs accepted

- Two processes instead of one; solved by `npm run dev` (concurrently) and the same-origin proxy, and documented in the README.
- No SSR/SEO — irrelevant for an authenticated operator console.
- CORS/origin config exists — validated at startup with a strict allowlist and negative tests.
- SPA means the API must never rely on the client for security — already a hard boundary in docs/01.
- npm workspaces (not pnpm): one fewer tool to install; installs are fast enough at this repo size. Revisit only if install times hurt.

## Required coverage per handoff (how each is met now or planned)

- **Transactions/persistence:** storage port spec'd here; SQLite in #4; Postgres migration is a contained adapter swap (and its own mini-ADR at that time).
- **Jobs/webhooks:** outbox worker design lands with #4; webhook route + signature verification lands with #5 (Airwallex) and #6 (Metal).
- **Authentication:** MTV-01 ships no user auth and therefore no authenticated routes — the API is fail-closed read-only. When #4/#7 need real users: server-side sessions (cookie, HttpOnly, SameSite) for the web console, per-org tenant scoping enforced in every route, machine tokens for the future agent runtime; credentials in the secret manager, never in the repo. This paragraph is the plan of record; implementing it is scoped to those issues.
- **Deployment:** not in MTV-01. Target: one container for the API + static hosting for the web; `GIT_SHA` env stamps `/healthz` for provenance. Rollback = redeploy previous image; DB migrations forward-only.
- **Cost:** $0 now; bounded (~$10/month) after first deployment; no paid service required by any planned issue through #19.
- **Rollback (repo level):** git revert; no data migrations exist yet.

## Failure modes / risks

- **SQLite under concurrent writers** — single-writer reality; acceptable for one-org demo scale; the storage port keeps the Postgres escape hatch one adapter away.
- **Two-process drift (API/UI contract)** — mitigated by `packages/domain` owning every shared type; CI typechecks the whole graph.
- **Windows/dev-host quirks** — IPv4 binding pinned explicitly (`127.0.0.1`) after a real Playwright failure; path handling in scripts made separator-safe.

## Reversibility

High: every choice is contained (swap storage adapter; swap bundler; move routes). The expensive-to-change decisions (domain money semantics, operation lifecycle, provider ports) live in `packages/*` and are exactly the ones docs/08 says to freeze first — they are now frozen in typed code, not prose.

## References

- Issue #3 and its implementation handoff comment
- [Architecture and domain boundaries](../01_ARCHITECTURE_AND_DOMAIN.md)
- [CTO risk review and vertical slice](../08_CTO_RISK_REVIEW_AND_VERTICAL_SLICE.md)
- [Delivery order and decision register](../07_DELIVERY_ORDER_AND_DECISIONS.md)
