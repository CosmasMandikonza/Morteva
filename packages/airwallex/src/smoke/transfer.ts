/**
 * Airwallex transfer smoke CLI (issue #5): ONE real sandbox transfer with an
 * independent readback. Safety contract lives in transfer-runner.ts (final
 * review P0-1): one durable economic intent per state directory, enforced by
 * the durable ledger — reruns reopen the same operation (never a second
 * transfer), a fresh verified balance read gates every invocation, and
 * --confirm + AIRWALLEX_SANDBOX_BENEFICIARY_ID are mandatory. A separate
 * intent requires --new-intent (explicit new authorization).
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAirwallexConfig, HttpTransport } from '../index.js';
import { DEFAULT_SMOKE_AMOUNT_MINOR, runSmokeTransfer } from './transfer-runner.js';

const config = loadAirwallexConfig();
if (!config.enabled) {
  console.error(
    'BLOCKED: sandbox credentials not configured (AIRWALLEX_ENV=sandbox + AIRWALLEX_CLIENT_ID + AIRWALLEX_API_KEY). The real sandbox transfer acceptance of issue #5 remains BLOCKED on founder-provided credentials and a sandbox beneficiary. Nothing was fabricated.',
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

if (result.outcome === 'blocked' || result.outcome === 'requires-human') {
  console.error(`${result.outcome === 'blocked' ? 'BLOCKED' : 'REQUIRES_HUMAN'}: ${result.reason}`);
  process.exit(result.outcome === 'blocked' ? 2 : 1);
} else {
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
      ? 'PAID confirmed by independent identity-verified readback; monitoring continues until RECONCILED (rerun to re-check).'
      : 'not terminal yet: funds remain committed; rerun to reconcile — never a second transfer for this intent.',
  );
}
