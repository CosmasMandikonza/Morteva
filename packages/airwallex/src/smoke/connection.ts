/**
 * Airwallex connection-proof CLI (issue #5 / A1): READ-ONLY sandbox proof.
 *
 * Without sandbox credentials this exits non-zero with an explicit BLOCKED
 * report — it never fabricates a provider result. With credentials it proves
 * authentication, the USD balance, a bounded beneficiary list and (when ids
 * are provided) a single-beneficiary / single-transfer READ — no write of any
 * kind, no transfer creation.
 *
 * Usage: AIRWALLEX_ENV=sandbox AIRWALLEX_CLIENT_ID=... AIRWALLEX_API_KEY=... \
 *        [AIRWALLEX_SANDBOX_BENEFICIARY_ID=...] [AIRWALLEX_SANDBOX_TRANSFER_ID=...] \
 *        npm run smoke:connection -w @moterva/airwallex
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAirwallexConfig } from '../config.js';
import { HttpTransport } from '../http-transport.js';
import {
  CONNECTION_STATE_DIR_DEFAULT,
  classifyConnectionFailure,
  payoutReadiness,
  printConnectionProof,
  runConnectionProof,
} from './connection-proof.js';

const config = loadAirwallexConfig();
if (!config.enabled) {
  console.error(
    'BLOCKED: sandbox credentials not configured (AIRWALLEX_ENV=sandbox + AIRWALLEX_CLIENT_ID + AIRWALLEX_API_KEY). The read-only connection proof of issue #5 remains BLOCKED on founder-provided credentials. Nothing was fabricated and no provider call was made.',
  );
  process.exit(2);
}

try {
  const result = await runConnectionProof({
    config,
    transport: new HttpTransport({
      baseUrl: config.baseUrl,
      allowedOrigin: config.allowedOrigin,
      requestTimeoutMs: config.requestTimeoutMs,
      idempotentReadRetries: config.idempotentReadRetries,
    }),
    stateDir: join(tmpdir(), CONNECTION_STATE_DIR_DEFAULT),
    beneficiaryId: process.env.AIRWALLEX_SANDBOX_BENEFICIARY_ID,
    transferId: process.env.AIRWALLEX_SANDBOX_TRANSFER_ID,
  });
  printConnectionProof(result);
  const readiness = payoutReadiness(result);
  console.info('payout readiness (from the READ-ONLY account view):');
  console.info(
    `  USD available: ${readiness.usdAvailableMinor === null ? 'NO USD ACCOUNT (reported honestly)' : String(readiness.usdAvailableMinor) + ' minor units'}`,
  );
  console.info(
    `  payout-ready beneficiaries: ${readiness.payoutReadyBeneficiaries.length === 0 ? '(none on this page)' : readiness.payoutReadyBeneficiaries.join(', ')}`,
  );
  if (readiness.nonPayoutReadyBeneficiaries.length > 0) {
    console.info(
      `  NOT payout-ready (no transfer methods): ${readiness.nonPayoutReadyBeneficiaries.join(', ')}`,
    );
  }
  console.info(
    '  NOTE: the founder key is intentionally READ-ONLY — a sandbox transfer requires a separate least-privilege Transfers Write sandbox key (never by weakening this key).',
  );
} catch (error) {
  const c = classifyConnectionFailure(error);
  console.error(`airwallex connection proof failed (${c.kind}): ${c.detail}`);
  if (c.kind === 'scope-or-ip') {
    console.error(
      'This is a credentials/IP configuration issue, not a code failure — the account IS reachable (TLS + DNS fine) but the key or network is not authorized for this resource.',
    );
  }
  process.exitCode = 1;
}
