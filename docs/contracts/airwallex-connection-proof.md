# Airwallex read-only connection proof (issue #5, A1)

**Status:** implemented, ready to execute the moment founder-provisioned
sandbox credentials exist in the server environment. Nothing in this document
claims a live provider interaction has occurred — the real-provider gate
stays BLOCKED until then, and no credential is requested through public
channels (never commit, log or print one).

## What it proves (once run with credentials)

`npm run smoke:connection -w @moterva/airwallex` executes a strictly READ-ONLY
sequence against the sandbox and prints redacted evidence:

1. **Authentication** — `POST /api/v1/authentication/login` with
   `x-client-id`/`x-api-key` headers; the 30-minute bearer token is held in
   memory only and is never printed, persisted or logged. A successful
   account-scoped read IS the identity proof: the token is issued to the
   configured client id and every subsequent read is scoped to that account.
2. **USD balance** — `GET /api/v1/balances/current`, per-currency available/
   pending/reserved in internal minor units AND provider major units. One
   durable `balance-read` receipt (`environment='sandbox'`) is appended to a
   state-dir ledger (`provider_receipts`), giving durable evidence of the
   authenticated read.
3. **Beneficiary list** — `GET /api/v1/beneficiaries` (`page_size=10`,
   `page_num=1`) with `has_more` reported honestly. The projection is
   identity-only: `id`, `nickname`, `transfer_methods`. Bank details, card
   and digital-wallet payloads are dropped at the parse boundary and can
   never reach a receipt, log line or caller.
4. **Optional single reads** — with `AIRWALLEX_SANDBOX_BENEFICIARY_ID` set,
   `GET /api/v1/beneficiaries/{id}`; with `AIRWALLEX_SANDBOX_TRANSFER_ID` set,
   `GET /api/v1/transfers/{id}` projected through the receipt minimizer
   (id/status/request_id/amount/currency/provider timestamps; failure CODE
   only, never free text).

Exit codes: `0` success, `1` failure (provider or parse), `2` BLOCKED
(credentials not configured — no provider call is made and nothing is
fabricated).

## Why beneficiary/transfer reads are not persisted as receipts

Provider receipts are financial-act evidence by contract (`dispatch-create`,
`readback-*`, `definitive-rejection`, `ambiguous-failure`, `webhook`,
`balance-read`). The connection proof is a read-only tool, not a financial
act; only the balance read (an account observation relevant to reconciliation)
persists a receipt under the existing `balance-read` kind. No schema change is
introduced for this proof.

## Execution-authority wiring already in place (A2 — verified, not rebuilt)

The approved-plan → dispatch chain exists and is adversarially tested at this
base: approval binds the exact plan digest; `reserve()` opens the outbox
intent with `rail` by kind inside the authority gate; the registered
`AirwallexDispatcher` (server-side credentials only; `buildSandboxDispatcher`
refuses fixture transports and disabled configs) creates the provider transfer
from server-verified reservation terms with a namespaced `request_id`, then
reconciles by independent readback; webhooks verify HMAC over raw bytes and
observe-only. `test/provider-boundary.test.ts` walks the full 14-behavior
journey; `test/two-worker-race.test.ts` proves exactly-one dispatch across
racing workers; `test/ledger-e2e.test.ts` proves crash-after-SUBMITTING →
STATUS_UNKNOWN → restart reconciles by the SAME request id (never a second
submission). The browser/model/telemetry have no path to mandates, approvals
or budgets — authority stays server-side.

## Controlled sandbox transfer (A3) — GATED

The gated transfer path (`npm run smoke:transfer -w @moterva/airwallex`) is
complete: one durable economic intent per state directory enforced by the
DURABLE LEDGER, `--confirm` authorization, stable request id persisted before
dispatch, independent readback to the documented terminal condition, honest
STATUS_UNKNOWN otherwise, and no blind resubmission after ambiguous responses.

**The first sandbox write requires CTO review of this branch plus an explicit
founder authorization of the specific bounded transfer.** Until both exist,
no write is executed and none is claimed. Never use a real-money account.

## Provider-evidence read contract (A4 — for Agent B)

`GET /api/operations/:id/provider-evidence` (read guard, org-scoped,
404-indistinguishable cross-tenant) returns:

```ts
{
  operationId: string;
  requestId: string;
  evidence: ProviderEvidenceView[]; // seq-ordered
}
// ProviderEvidenceView = { seq, provider, environment, kind, requestId,
//   transferId, httpStatus, providerStatus, recordedAt }
```

The stored receipt `payload_json` is never disclosed here; the journal's
disclosure projection remains the replayable record. This is additive —
`OperationReadView` is unchanged.
