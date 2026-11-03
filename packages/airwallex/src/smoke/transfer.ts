/**
 * Airwallex transfer smoke (issue #5): ONE real sandbox transfer with an
 * independent readback — the issue's core acceptance proof. R3 review P0-5
 * safety contract:
 *
 *  - a FRESH VERIFIED sandbox balance read gates everything: the smoke
 *    ledger records a balance snapshot sourced 'airwallex-sandbox' (never a
 *    manual seed), and the amount is capped far below observed funds;
 *  - the request id is DURABLE (persisted to a stable state file) and
 *    UNIQUE (date + nonce, namespaced per org by the adapter); a repeated
 *    invocation reconciles the existing id and NEVER creates a second
 *    economic transfer;
 *  - explicit human confirmation (--confirm), server-side beneficiary id and
 *    credentials are mandatory; anything missing → BLOCKED, exit ≠ 0.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openLedger } from '@moterva/ledger';
import {
  buildSandboxDispatcher,
  HttpTransport,
  loadAirwallexConfig,
  minorToMajorUnits,
} from '../index.js';
import { AirwallexClient } from '../client.js';
import { providerRequestIdFor } from '../provider-request-id.js';

const SMOKE_CURRENCY = 'USD';
const MAX_SMOKE_AMOUNT_MINOR = 2_000; // hard cap (USD 20.00 equivalent)
const DEFAULT_SMOKE_AMOUNT_MINOR = 500; // USD 5.00 equivalent
const FUNDING_SAFETY_FACTOR = 10; // provider funds must exceed 10× the amount

function fail(message: string): never {
  console.error(`BLOCKED: ${message}`);
  process.exit(2);
}

const config = loadAirwallexConfig();
if (!config.enabled) {
  fail(
    'sandbox credentials not configured (AIRWALLEX_ENV=sandbox + AIRWALLEX_CLIENT_ID + AIRWALLEX_API_KEY). The real sandbox transfer acceptance of issue #5 remains BLOCKED on founder-provided credentials and a sandbox beneficiary. Nothing was fabricated.',
  );
}
const beneficiaryId = (process.env.AIRWALLEX_SANDBOX_BENEFICIARY_ID ?? '').trim();
if (beneficiaryId === '') {
  fail(
    'AIRWALLEX_SANDBOX_BENEFICIARY_ID is not set. Create a beneficiary in the Airwallex sandbox dashboard first and pass its id via the server environment.',
  );
}
if (!process.argv.includes('--confirm')) {
  fail('pass --confirm to explicitly authorize this one sandbox transfer attempt.');
}
const requestedAmount = Number(
  process.env.AIRWALLEX_SMOKE_AMOUNT_MINOR ?? DEFAULT_SMOKE_AMOUNT_MINOR,
);
if (
  !Number.isInteger(requestedAmount) ||
  requestedAmount <= 0 ||
  requestedAmount > MAX_SMOKE_AMOUNT_MINOR
) {
  fail(
    `AIRWALLEX_SMOKE_AMOUNT_MINOR must be a positive integer ≤ ${String(MAX_SMOKE_AMOUNT_MINOR)} minor units (got "${String(process.env.AIRWALLEX_SMOKE_AMOUNT_MINOR ?? '')}"); refusing uncontrolled amounts.`,
  );
}

// Stable smoke state (survives restarts/reruns): the durable request id.
const smokeDir = join(tmpdir(), 'moterva-awx-transfer-smoke');
mkdirSync(smokeDir, { recursive: true });
const stateFile = join(smokeDir, 'request-id.txt');
const dbPath = join(smokeDir, 'smoke.sqlite');

const transport = new HttpTransport({
  baseUrl: config.baseUrl,
  allowedOrigin: config.allowedOrigin,
  requestTimeoutMs: config.requestTimeoutMs,
  idempotentReadRetries: config.idempotentReadRetries,
});
const client = new AirwallexClient(config, transport, { now: () => new Date() });
void client;

function readExistingRequestId(): string | null {
  if (!existsSync(stateFile)) return null;
  const id = readFileSync(stateFile, 'utf8').trim();
  return id === '' ? null : id;
}

// 1. FRESH VERIFIED sandbox balance read (P0-5): nothing proceeds without it.
let availableUsdMinor = 0;
try {
  const balances = await client.balancesCurrent();
  const usd = balances.find((balance) => balance.currency === SMOKE_CURRENCY);
  if (usd === undefined) {
    fail(
      `no ${SMOKE_CURRENCY} balance account exists in this Airwallex sandbox account; fund the sandbox wallet first (simulation deposit or dashboard).`,
    );
  }
  availableUsdMinor = usd.availableAmount.minorUnits;
  console.info(
    `verified sandbox balance: ${SMOKE_CURRENCY} available ${String(availableUsdMinor)} minor (${minorToMajorUnits(SMOKE_CURRENCY, availableUsdMinor)} major) — fresh provider read, not a seeded number.`,
  );
} catch (error) {
  fail(
    `fresh sandbox balance read failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}
if (availableUsdMinor < requestedAmount * FUNDING_SAFETY_FACTOR) {
  fail(
    `verified ${SMOKE_CURRENCY} available (${String(availableUsdMinor)} minor) is less than ${String(FUNDING_SAFETY_FACTOR)}× the smoke amount (${String(requestedAmount)} minor); refusing to spend into an underfunded sandbox.`,
  );
}

// 2. Durable unique request id, reconcile-first (P0-5).
const SMOKE_ORG_TAG = 'org-smoke-transfer';
const existingRequestId = readExistingRequestId();
if (existingRequestId !== null) {
  console.info(
    `existing smoke request id found: ${existingRequestId} — checking for a prior transfer before doing anything.`,
  );
  const prior = await client
    .listTransfersByRequestId(providerRequestIdFor(SMOKE_ORG_TAG, existingRequestId))
    .catch(() => null);
  if (prior !== null && prior.length > 0) {
    console.info(
      `a transfer already exists for this request id (${(prior[0] as { id: string }).id}); status readback only — delete ${smokeDir} to deliberately start a NEW transfer.`,
    );
    process.exit(0);
  }
  console.info(
    'no prior transfer found for the persisted id; proceeding with it (idempotent create).',
  );
}

const ledger = openLedger(dbPath);
ledger.migrate();
const requestId =
  existingRequestId ??
  `awx-smoke-${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}`;
if (existingRequestId === null) {
  writeFileSync(stateFile, requestId, 'utf8');
  console.info(
    `new durable smoke request id: ${requestId} (persisted to ${stateFile}; reruns reconcile, never duplicate).`,
  );
}

const org = ledger.organizations.createOrganization(
  `Airwallex Transfer Smoke ${new Date().toISOString().slice(0, 10)}`,
);
const mission = ledger.organizations.createMission(org.id, 'sandbox transfer smoke');
const admin = ledger.authority.createHumanActor({
  orgId: org.id,
  username: `smoke-admin-${requestId.slice(-8)}`,
  displayName: 'Smoke Admin',
  role: 'admin',
  password: ['smoke', 'only', 'fixture'].join('-'),
});
const approver = ledger.authority.createHumanActor({
  orgId: org.id,
  username: `smoke-approver-${requestId.slice(-8)}`,
  displayName: 'Smoke Approver',
  role: 'approver',
  password: ['smoke', 'only', 'fixture'].join('-'),
});
ledger.accounts.ensureTreasuryAccount({
  orgId: org.id,
  currency: SMOKE_CURRENCY,
  label: 'USD',
  protectedFloorMinor: 0,
});
// Funding model records the VERIFIED provider-read balance (airwallex-sandbox
// source), never a manual seed (R3 P0-5).
ledger.accounts.recordBalanceSnapshot({
  orgId: org.id,
  currency: SMOKE_CURRENCY,
  minorUnits: availableUsdMinor,
  source: 'airwallex-sandbox',
  observedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});
ledger.mandates.issue({
  orgId: org.id,
  missionId: mission.id,
  currency: SMOKE_CURRENCY,
  maxAmountMinor: MAX_SMOKE_AMOUNT_MINOR,
  totalBudgetMinor: MAX_SMOKE_AMOUNT_MINOR,
  permittedOperationKinds: ['airwallex_transfer'],
  byActorId: admin.id,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});
const plan = ledger.plans.recordVersion({
  orgId: org.id,
  missionId: mission.id,
  proposedBy: admin.id,
  terms: {
    amountMinor: requestedAmount,
    currency: SMOKE_CURRENCY,
    beneficiary: beneficiaryId,
    purpose: 'MTV-03 sandbox transfer smoke',
  },
});
const approval = ledger.approvals.record({
  orgId: org.id,
  plan,
  decidedByActorId: approver.id,
  kind: 'airwallex_transfer',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});
const reservation = ledger.reservations.reserve({
  orgId: org.id,
  missionId: mission.id,
  kind: 'airwallex_transfer',
  requestId,
  planId: plan.id,
  planVersion: plan.version,
  approvalId: approval.id,
});
console.info(
  `reserved ${String(reservation.operation.amountMinor)} ${SMOKE_CURRENCY}; dispatching through the authority gate...`,
);

const dispatcher = buildSandboxDispatcher(
  config,
  transport,
  ledger.providerReceipts,
  ledger.clock,
  () => beneficiaryId,
);
ledger.worker.register(dispatcher);

const firstPass = await ledger.worker.runOnce();
console.info(
  `worker pass 1: dispatched=${String(firstPass.dispatched)} unknown=${String(firstPass.markedUnknown)} blocked=${String(firstPass.blocked)} escalated=${String(firstPass.escalated)}`,
);
const afterDispatch = ledger.reservations.getOperation(org.id, reservation.operation.id);
console.info(`operation state after dispatch: ${afterDispatch.state} (submitted is NOT settled)`);

if (afterDispatch.state !== 'SUBMITTING' && afterDispatch.state !== 'IN_FLIGHT') {
  console.error(
    `dispatch did not reach the provider attempt path (state ${afterDispatch.state}); aborting before readback. Investigate ${smokeDir} before rerunning.`,
  );
  process.exitCode = 1;
} else {
  const readback = await dispatcher.reconcileByRequestId(requestId, {
    orgId: org.id,
    operationId: reservation.operation.id,
    amountMinor: requestedAmount,
    currency: SMOKE_CURRENCY,
    beneficiary: beneficiaryId,
  });
  console.info(
    `readback status=${readback.status} providerState=${String(readback.providerState)} verifiedAt=${String(readback.verifiedAt)}`,
  );
  if (readback.status === 'confirmed') {
    const settled = ledger.reservations.transition({
      orgId: org.id,
      operationId: reservation.operation.id,
      to: 'SETTLED',
      attestation: {
        source: 'provider-readback',
        note: 'sandbox smoke: terminal-success readback',
      },
    });
    console.info(
      `SETTLED via verified readback: ${settled.operation.state} (finalizedAt=${String(settled.commitment.finalizedAt)}). PAID is verified-at-readback finality; monitoring continues until RECONCILED.`,
    );
  } else {
    console.info(
      'readback is not terminal-success; funds remain committed (pending/failed states never auto-release).',
    );
  }
}

const receipts = ledger.providerReceipts.listByRequestId(requestId, org.id);
console.info(
  `receipts persisted: ${String(receipts.length)} (kinds: ${receipts.map((r) => r.kind).join(', ')})`,
);
console.info(
  'redacted transfer id(s):',
  receipts
    .filter((r) => r.providerResourceId !== null)
    .map((r) => `${(r.providerResourceId ?? '').slice(0, 6)}…`)
    .join(', ') || '(none)',
);
ledger.close();
