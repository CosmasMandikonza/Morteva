# Airwallex read-only connection proof (issue #5, A1)

**Status: EXECUTED — the genuine proof succeeded on 2026-11-11** with the
founder-provisioned read-only sandbox key (login fixed, real balances and
beneficiaries read, durable receipts persisted; see docs/STATE.md for the
redacted record). This document remains the procedure and law reference.
No credential is committed, logged or printed anywhere.

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

## Credential provisioning (founder action — exact procedure)

The adapter reads the SERVER environment only. The smoke scripts load the
gitignored root `.env` themselves (Node 24 `--env-file-if-exists=../../.env`
in the workspace scripts; real process env always wins; production injects
real environment variables and never reads local files) — NO shell exports
are needed:

1. Create `.env` in the repo root (already `.gitignore`d — verify with
   `git check-ignore .env`) containing exactly:

   ```
   AIRWALLEX_ENV=sandbox
   AIRWALLEX_CLIENT_ID=<paste client id>
   AIRWALLEX_API_KEY=<paste API key>
   # optional single-read targets for the connection proof:
   AIRWALLEX_SANDBOX_BENEFICIARY_ID=<paste one beneficiary id from the UI>
   AIRWALLEX_SANDBOX_TRANSFER_ID=<optional, only if a transfer id should be read>
   # the DISTINCT least-privilege Transfers-Write pair — ONLY when the founder
   # has provisioned that separate key AND approved the exact transfer:
   #AIRWALLEX_WRITE_CLIENT_ID=<paste write client id>
   #AIRWALLEX_WRITE_API_KEY=<paste write api key>
   ```

   The smoke scripts then run with a single command each
   (`npm run smoke:connection -w @moterva/airwallex`,
   `npm run smoke:transfer -w @moterva/airwallex` — the latter BLOCKS exit 2
   unless the WRITE pair above exists AND is provably distinct from the read
   pair; a write pair identical to the read pair is refused as a
   least-privilege violation).

2. IP allowlist: the sandbox key only answers from allowlisted public egress
   IPs. Add THIS machine's current public egress IP before running; an AWS
   host's EIP is a different public source IP and must be allowlisted
   separately when the proof runs there. CONFIRMED DIAGNOSTIC (2026-11-11
   live attempt): a non-allowlisted source IP gets an HTML `403 Forbidden`
   page from the edge even on UNAUTHENTICATED requests — while an
   allowlisted IP without credentials gets a JSON 401 (missing credentials).
   The connection proof classifies the authenticated 403 explicitly
   (`scope-or-ip`) instead of misreporting an empty account or an error.
3. Key separation (never weakened, now ENFORCED in code): the founder's
   initial key is READ-ONLY and stays read-only. A sandbox WRITE requires a
   DISTINCT least-privilege Transfers-Write sandbox key
   (`AIRWALLEX_WRITE_CLIENT_ID`/`AIRWALLEX_WRITE_API_KEY`); `smoke:transfer`
   refuses to run without it and refuses a write pair identical to the read
   pair. The read-only connection proof never sends a write.

4. Run and capture redacted evidence (values above are never printed; the
   bearer token is held in memory only):

   ```
   npm run build -w @moterva/airwallex
   npm run smoke:connection -w @moterva/airwallex
   ```

   The output classifies honestly: authentication + USD balance + bounded
   beneficiary list + payout readiness (which beneficiaries are LOCAL/SWIFT
   payable, USD available in minor units) — distinguishing EMPTY resources
   (a real empty sandbox account) from scope/IP blocks (403) from plain
   failures, and one durable `balance-read` receipt
   (`environment='sandbox'`) per run in
   `%TEMP%/moterva-awx-connection-proof/ledger.sqlite`.

## Sandbox transfer — founder authorization proposal (STOP gate)

A transfer is proposed ONLY in this exact shape; execution happens exclusively
after the founder's explicit approval of THIS proposal (and requires the
separate Transfers-Write key above):

- **Beneficiary:** one beneficiary chosen from the connection proof's
  payout-ready list (LOCAL-transferable), named by the founder — never any
  real-world owner banking details; the sandbox beneficiary factory objects
  the sandbox UI creates are the only valid targets.
- **Currency / amount:** USD, 500 minor units (= USD 5.00, the smoke default
  `DEFAULT_SMOKE_AMOUNT_MINOR`), well under the runner's hard cap and checked
  against a 3× funding-safety factor on a VERIFIED provider-read balance.
- **Request identity:** `moterva-smoke-<YYYY-MM-DD>-<8 hex>` — the ledger
  request id is namespaced (`org:` prefix) as `provider_request_id`, persisted
  in the durable intent state BEFORE dispatch, and is the ONLY id used for
  reconciliation (Airwallex dedupes `request_id` for 7 days).
- **Known fees:** LOCAL USD payouts in sandbox cost 0 (per D's Nov-8 audit of
  the official guide; EUR SWIFT would be a flat EUR 12.85 — not used here), so
  the authorized amount equals the settled amount for this shape.
- **Path (already implemented, immutable):** mandate (admin) → plan binding
  the exact terms → separate-role approval → reservation → outbox →
  `AirwallexDispatcher` → independent readback; the read-only key can prepare
  everything but the create call itself fails 403 fail-closed with a receipt
  rather than fabricating anything.

## After an authorized transfer — evidence demonstration

The smoke's durable ledger is a real ledger: serving the API against it
exposes the full product read path for the SAME org/mission/plan/operation
identity (no rebuild, no fixture):

```
MOTERVA_LEDGER_PATH=%TEMP%/moterva-awx-transfer-smoke/ledger.sqlite \
  npm run dev -w @moterva/api        # then, authenticated:
# GET /api/operations                       (Treasury list: the operation)
# GET /api/operations/:id/provider-evidence (redacted receipt chain, environment=sandbox)
# GET /api/missions/:missionId/evidence     (Evidence Replay: journal events)
```

Status-unknown outcomes stay STATUS_UNKNOWN with exposure retained; only a
verified readback settles; nothing is ever reported successful because an
internal fixture, an API submission or an approval succeeded.
