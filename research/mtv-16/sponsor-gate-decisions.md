# Sponsor gate decisions — issue #16 / #17 (Agent E, 2026-11-08)

## Visa (issue #16) — NO-GO (nothing built, nothing claimed)

Decision: **no-go** for the Visa track.

- The public event page lists a Visa award (US$15k); organizer Slack notes
  custom builds are permitted and the qualifying pathway named to
  participants is Airwallex sandbox + Metal testnet with genuine agency.
- No official Visa-specific eligibility criteria, API access or written
  confirmation is available to this repository. Per the assignment rule —
  no speculative middleware, no eligibility claim without access and written
  confirmation — nothing was built.
- Re-open condition: organizer-provided written eligibility criteria AND
  technical access. Any future work would follow the same disabled-until-
  credentialed pattern as the Airwallex adapter (ADR 0005).

## T:0 — NOT INTEGRATED (no requirement duplication)

No T:0 access exists in this environment. MOTERVA's ledger already performs
reconciliation (outbox replay, readback attestation, recovery-by-original-
request-id) as core, tested engine behavior. Adding a T:0 integration
without a genuine accounting-reconciliation requirement would duplicate the
ledger's own reconciliation purely for sponsor count — explicitly out of
scope. Not integrated; not claimed.

## AWS (issue #17) — OPTIONAL, NOT REQUIRED (deliberate)

The deployment kit (`deploy/`) is provider-neutral: plain Docker images +
Caddy on any Linux host. No AWS-proprietary service is used or needed for
the staging/demo topology; a ~US$5–6/month VPS class host suffices for demo
load. AWS would be adopted only if (a) sponsor credits materialize AND (b)
a concrete capability (e.g. managed secrets for #5 credentials) is
genuinely useful. A simple legitimate host is preferred over an impressive
but fragile cloud diagram — per the release-engineering assignment.
