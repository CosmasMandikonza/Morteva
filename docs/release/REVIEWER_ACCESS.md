# Reviewer access — how to run and evaluate MOTERVA (issue #19)

Two access paths exist today, and the difference between them is deliberate:

1. **Hosted (public URL)** — honest, read-only: the web shell + live system
   status. The full authenticated journey is not exposed publicly because
   MOTERVA has no production reviewer authentication yet; the development
   auth gate is structurally loopback-only and refused in production mode.
2. **Local golden path (this document)** — the complete mission-to-money
   journey on your machine in under five minutes, backed by the same build
   CI verifies.

Nothing in path 2 requires hidden administrator knowledge; every step is
below. All data is a seeded throwaway ledger; no bank, provider or vehicle is
contacted, and every screen says so.

## Prerequisites

- Node.js **24+** (`node --version`) and npm 10+.
- ~5 minutes and ~1.5 GB disk for dependencies.

## Steps

```bash
git clone https://github.com/CosmasMandikonza/Morteva moterva
cd moterva
git checkout <release-sha>        # use the exact SHA from the submission
npm ci                            # cold install; verifies the committed lockfile
npm run build                     # compiles API + packages + web shell
node scripts/release/demo.mjs     # seeds a throwaway ledger, boots API + web
```

Open **http://localhost:4173** and sign in:

| Username  | Password         | Role you're exercising |
|-----------|------------------|------------------------|
| `founder` | `moterva-e2e-demo` | owner (full view) |
| `approver` | `moterva-e2e-demo` | independent human approver |
| `operator` | `moterva-e2e-demo` | operator |

Ctrl+C stops everything and deletes the throwaway ledger.

## What to look for (the 3-minute evaluation)

1. **Mission Treasury** — missions "Harbor turbine inspection" and "Subsea
   mooring survey"; EFFECTIVE authority excludes the clock-lapsed GBP
   mandate; envelope math (USD 76,500.00 of 150,000.00 effective); balance
   provenance "seeded demo data / internal record, not provider-verified".
2. **Financial position** — engine-computed spendable with the exact math
   (USD: 250,000.00 − 500.00 floor − 72,000.00 reserved − 13,500.00
   unknown = 164,000.00 spendable; verify against
   `curl -b <cookie> .../api/financial/overview` if you like).
3. **Operations** — deterministic lifecycle: STATUS_UNKNOWN (ambiguity
   retained, resolve-by-original-request-ID guidance), REQUIRES_HUMAN
   (exposure stays held), RECONCILED. Select one; the inspector shows exact
   terms and why it matters.
4. **Evidence Replay** — the same operation identity links journal events in
   order; topics are labeled; SYNTHETIC provenance is explicit.
5. **Decision Room** — admit a synthetic incident; the planner's REAL
   selection changes (e.g. ASSET_SAFETY_BLOCKED → hire the vessel option)
   with the financial consequence of each candidate.
6. **Honesty contract** — no screen claims provider verification; submitted
   ≠ settled; DEMO_AUTH banner on every authenticated view.

## Automated verification you can rerun

```bash
npx playwright test                         # full E2E against these servers
node scripts/release/verify-production.mjs   # 15 production fail-closed scenarios
node scripts/release/verify-demo-auth-security.mjs  # 12 auth/CSRF/tenant scenarios
```

## Hosted URL status

See `docs/release/EVIDENCE_INDEX.md` for the current hosted deployment state.
It will always render the shell + honest status; the full hosted journey
activates only when real reviewer authentication lands (tracked in the
acceptance matrix, gate 3/18).
