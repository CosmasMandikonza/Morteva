/**
 * Airwallex transfer smoke CLI (issue #5): ONE real sandbox transfer with an
 * independent readback. Safety contract lives in transfer-runner.ts: one
 * durable economic intent per state directory enforced by the DURABLE LEDGER
 * (a missing state file never authorizes another payment in any state; a
 * separate intent needs --new-intent after every prior intent is resolved).
 *
 * Outcome reporting is unambiguous:
 *   BLOCKED        nothing was submitted (strictly pre-attempt)     exit 2
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
import { loadAirwallexWriteConfig, HttpTransport } from '../index.js';
import { DEFAULT_SMOKE_AMOUNT_MINOR, runSmokeTransfer } from './transfer-runner.js';

let config;
try {
  // LEAST-PRIVILEGE SEPARATION: a transfer run requires the DISTINCT
  // Transfers-Write credential pair — the read-only key is never reused for
  // write authority, and a write pair identical to the read pair is refused.
  config = loadAirwallexWriteConfig();
} catch (error) {
  console.error(
    `BLOCKED: ${error instanceof Error ? error.message : String(error)} The real sandbox transfer acceptance of issue #5 remains BLOCKED on the founder's distinct Transfers-Write key and explicit authorization of the exact beneficiary/amount/currency/fees. Nothing was fabricated and no provider call was made.`,
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
  newIntent: process.argv.includes('--new-intent'),
  stateDir: join(tmpdir(), 'moterva-awx-transfer-smoke'),
});

if (result.outcome === 'blocked') {
  console.error(`BLOCKED: ${result.reason} (no submission occurred)`);
  process.exit(2);
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
