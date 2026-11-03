/**
 * Airwallex transfer smoke (issue #5): ONE real sandbox transfer with an
 * independent readback — the issue's core acceptance proof.
 *
 * REQUIREMENTS (all mandatory, checked before any provider call):
 *  - AIRWALLEX_ENV=sandbox + credentials (server environment only)
 *  - AIRWALLEX_SANDBOX_BENEFICIARY_ID (a beneficiary you created in sandbox)
 *  - --confirm flag on the command line (explicit human action)
 *
 * The smoke performs the reviewed sequence end-to-end against a THROWAWAY
 * ledger: authority-gated dispatch (request id persisted first) → provider
 * create → independent readback by request id → settlement ONLY if the
 * readback shows terminal success (PAID). Without credentials it reports
 * BLOCKED and exits non-zero — no fabricated transfer, ever.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '@moterva/ledger';
import { buildSandboxDispatcher, HttpTransport, loadAirwallexConfig } from '../index.js';

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

const ledger = openLedger(
  join(mkdtempSync(join(tmpdir(), 'moterva-awx-transfer-')), 'smoke.sqlite'),
);
ledger.migrate();

// A minimal trusted world: org/mission/mandate/approval/plan, then reserve →
// dispatch through the REAL authority-gated worker (exactly as production).
const org = ledger.organizations.createOrganization('Airwallex Smoke Org');
const mission = ledger.organizations.createMission(org.id, 'sandbox smoke');
const admin = ledger.authority.createHumanActor({
  orgId: org.id,
  username: 'smoke-admin',
  displayName: 'Smoke Admin',
  role: 'admin',
  password: ['smoke', 'only', 'fixture'].join('-'),
});
const approver = ledger.authority.createHumanActor({
  orgId: org.id,
  username: 'smoke-approver',
  displayName: 'Smoke Approver',
  role: 'approver',
  password: ['smoke', 'only', 'fixture'].join('-'),
});
ledger.accounts.ensureTreasuryAccount({
  orgId: org.id,
  currency: 'USD',
  label: 'USD',
  protectedFloorMinor: 0,
});
ledger.accounts.recordBalanceSnapshot({
  orgId: org.id,
  currency: 'USD',
  minorUnits: 1_000_000, // funding model; the provider sandbox holds the real money
  source: 'manual-seed',
  observedAt: ledger.clock.iso(),
  expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
});
ledger.mandates.issue({
  orgId: org.id,
  missionId: mission.id,
  currency: 'USD',
  maxAmountMinor: 2_000,
  totalBudgetMinor: 2_000,
  permittedOperationKinds: ['airwallex_transfer'],
  byActorId: admin.id,
  expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
});
const plan = ledger.plans.recordVersion({
  orgId: org.id,
  missionId: mission.id,
  proposedBy: admin.id,
  terms: {
    amountMinor: 2_000,
    currency: 'USD',
    beneficiary: beneficiaryId,
    purpose: 'MTV-03 sandbox smoke transfer',
  },
});
const approval = ledger.approvals.record({
  orgId: org.id,
  plan,
  decidedByActorId: approver.id,
  kind: 'airwallex_transfer',
  expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
});
const reservation = ledger.reservations.reserve({
  orgId: org.id,
  missionId: mission.id,
  kind: 'airwallex_transfer',
  requestId: 'awx-smoke-transfer-1',
  planId: plan.id,
  planVersion: plan.version,
  approvalId: approval.id,
});
console.info(
  `reserved ${reservation.operation.amountMinor} USD; outbox pending — dispatching through the authority gate...`,
);

const dispatcher = buildSandboxDispatcher(
  config,
  new HttpTransport({
    baseUrl: config.baseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    idempotentReadRetries: config.idempotentReadRetries,
  }),
  ledger.providerReceipts,
  ledger.clock,
  () => beneficiaryId,
);
ledger.worker.register(dispatcher);

const firstPass = await ledger.worker.runOnce();
console.info(
  `worker pass 1: dispatched=${firstPass.dispatched} unknown=${firstPass.markedUnknown} blocked=${firstPass.blocked} escalated=${firstPass.escalated}`,
);
const afterDispatch = ledger.reservations.getOperation(org.id, reservation.operation.id);
console.info(`operation state after dispatch: ${afterDispatch.state} (submitted is NOT settled)`);

if (afterDispatch.state !== 'SUBMITTING' && afterDispatch.state !== 'IN_FLIGHT') {
  console.error(
    `dispatch did not reach the provider attempt path (state ${afterDispatch.state}); aborting before readback.`,
  );
  process.exitCode = 1;
} else {
  // Independent readback by the ORIGINAL request id (the recovery contract).
  const readback = await dispatcher.reconcileByRequestId('awx-smoke-transfer-1');
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
      `SETTLED via verified readback: ${settled.operation.state} (finalizedAt=${String(settled.commitment.finalizedAt)})`,
    );
  } else {
    console.info(
      'readback is not terminal-success; funds remain committed (pending/failed states never auto-release).',
    );
  }
}

const receipts = ledger.providerReceipts.listByRequestId('awx-smoke-transfer-1', org.id);
console.info(
  `receipts persisted: ${receipts.length} (kinds: ${receipts.map((r) => r.kind).join(', ')})`,
);
console.info(
  'redacted transfer id(s):',
  receipts
    .filter((r) => r.providerResourceId !== null)
    .map((r) => `${r.providerResourceId!.slice(0, 6)}…`)
    .join(', ') || '(none)',
);
ledger.close();
