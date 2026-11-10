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
} catch (error) {
  console.error(
    `airwallex connection proof failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
