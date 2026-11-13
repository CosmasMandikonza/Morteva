/**
 * Airwallex transfer smoke CLI (issue #5): ONE real sandbox transfer with an
 * independent readback. Safety contract lives in transfer-runner.ts: one
 * durable economic intent per state directory enforced by the DURABLE LEDGER
 * (a missing state file never authorizes another payment in any state; a
 * separate intent needs --new-intent after every prior intent is resolved).
 *
 * Two operating modes:
 *   --prepare-only  build the full governed chain (mandate → plan →
 *                   separate-role approval → reservation → durable intent
 *                   persisted) and STOP. No dispatcher, no provider write,
 *                   no --confirm needed. Prints the exact intent identity
 *                   for founder review.
 *   --confirm       EXECUTE (or resume/reconcile) the intent. Requires the
 *                   DISTINCT least-privilege Transfers-Write credential.
 *
 * Outcome reporting is unambiguous:
 *   BLOCKED        nothing was submitted (strictly pre-attempt)     exit 2
 *   PREPARED       governed intent persisted; NOT dispatched        exit 0
 *   STATUS_UNKNOWN a provider attempt may have occurred; funds      exit 0
 *                  remain committed; recover ONLY by reconciling
 *                  this same intent — never a new identity
 *   REQUIRES_HUMAN explicit escalation; investigation required     exit 1
 *   CONFIRMED      identity-verified PAID readback at verifiedAt,  exit 0
 *                  ledger state SETTLED/RECONCILED; late failure
 *                  remains possible and monitored
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAirwallexConfig, loadAirwallexWriteConfig, HttpTransport } from '../index.js';
import { DEFAULT_SMOKE_AMOUNT_MINOR, runSmokeTransfer } from './transfer-runner.js';

const prepareOnly = process.argv.includes('--prepare-only');

let config;
try {
  if (prepareOnly) {
    // PREPARE mode: a READ-level operation (fresh balance gate only). The
    // read-only credential is sufficient — the intent is persisted RESERVED
    // and execution still requires the Transfers-Write key + --confirm later.
    config = loadAirwallexConfig();
    if (!config.enabled) {
      console.error(
        'BLOCKED: sandbox credentials not configured (AIRWALLEX_ENV=sandbox + AIRWALLEX_CLIENT_ID + AIRWALLEX_API_KEY) — the read-only pair is required to verify the funding gate for preparation. Nothing was fabricated.',
      );
      process.exit(2);
    }
  } else {
    // LEAST-PRIVILEGE SEPARATION: an EXECUTION run requires the DISTINCT
    // Transfers-Write credential pair — the read-only key is never reused for
    // write authority, and a write pair identical to the read pair is refused.
    config = loadAirwallexWriteConfig();
  }
} catch (error) {
  console.error(
    `BLOCKED: ${error instanceof Error ? error.message : String(error)} Nothing was fabricated and no provider call was made.`,
  );
  process.exit(2);
}

const result = await runSmokeTransfer({
  config,
  transport: new HttpTransport({
    baseUrl: config.baseUrl,
    allowedOrigin: config.allowedOrigin,
    requestTimeoutMs: config.requestTimeoutMs,
    idempotentReadRetries: config.idempotentReadRetries,
  }),
  beneficiaryId: process.env.AIRWALLEX_SANDBOX_BENEFICIARY_ID ?? '',
  amountMinor: Number(process.env.AIRWALLEX_SMOKE_AMOUNT_MINOR ?? DEFAULT_SMOKE_AMOUNT_MINOR),
  confirm: process.argv.includes('--confirm'),
  prepareOnly,
  newIntent: process.argv.includes('--new-intent'),
  stateDir: join(tmpdir(), 'moterva-awx-transfer-smoke'),
});

if (result.outcome === 'blocked') {
  console.error(`BLOCKED: ${result.reason} (no submission occurred)`);
  process.exit(2);
}
if (result.outcome === 'prepared') {
  console.info('PREPARED — governed intent persisted; NOTHING was dispatched (no provider write):');
  console.info(`  org=${result.orgId}`);
  console.info(`  mission=${result.missionId}`);
  console.info(`  mandate=${result.mandateId}`);
  console.info(
    `  plan=${result.planId} (exact terms: ${String(result.amountMinor)} minor ${result.currency} → beneficiary ${result.beneficiaryId})`,
  );
  console.info(`  approval=${result.approvalId} (separate approver role)`);
  console.info(`  operation=${result.operationId} state=${result.operationState}`);
  console.info(`  request=${result.ledgerRequestId} provider_request=${result.providerRequestId}`);
  console.info(
    `  funding gate: verified USD available ${String(result.verifiedUsdAvailableMinor)} minor ≥ 10× the amount`,
  );
  console.info(
    '  EXECUTION requires BOTH: (1) the founder explicitly approving THIS intent (beneficiary/amount/currency/fees), and (2) the distinct least-privilege Transfers-Write key. Then rerun with --confirm (no other flags) — it resumes THIS intent; never a new identity.',
  );
  process.exit(0);
}
if (result.outcome === 'unverified') {
  console.error(`STATUS_UNKNOWN: ${result.reason}`);
  console.error(
    `intent: request=${result.ledgerRequestId} provider_request=${result.providerRequestId} operation=${result.operationId.slice(0, 8)}… — rerun this script to reconcile THIS intent.`,
  );
  process.exit(0);
}
if (result.outcome === 'requires-human') {
  console.error(`REQUIRES_HUMAN: ${result.reason}`);
  console.error(
    `intent: request=${result.ledgerRequestId} provider_request=${result.providerRequestId} operation=${result.operationId.slice(0, 8)}… state=${result.operationState}`,
  );
  process.exit(1);
}

console.info(
  `outcome=${result.outcome} operation=${result.operationId.slice(0, 8)}… state=${result.operationState} request=${result.ledgerRequestId} provider_request=${result.providerRequestId}`,
);
console.info(
  `worker pass: claimed=${String(result.workerReport.claimed)} dispatched=${String(result.workerReport.dispatched)} reconciled=${String(result.workerReport.reconciled)} unknown=${String(result.workerReport.markedUnknown)} escalated=${String(result.workerReport.escalated)}`,
);
console.info(
  `readback status=${result.readbackStatus} providerState=${String(result.readbackProviderState)} verifiedAt=${String(result.verifiedAt)}; receipts persisted=${String(result.receiptCount)}`,
);
console.info(
  result.outcome === 'confirmed'
    ? `PAID confirmed by an identity-verified readback at ${String(result.verifiedAt)}; ledger state ${result.operationState}. PAID is verified-at-readback finality, NOT irreversible delivery — late failure remains possible and monitored until RECONCILED (rerun to re-check).`
    : 'not terminal yet: funds remain committed; rerun to reconcile — never a second transfer for this intent.',
);
