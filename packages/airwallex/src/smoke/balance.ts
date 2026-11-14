/**
 * Airwallex balance smoke (issue #5): ONE real sandbox balance read.
 *
 * Without sandbox credentials this exits non-zero with an explicit BLOCKED
 * report — it never fabricates a provider result. With credentials it calls
 * POST /authentication/login then GET /balances/current, persists a
 * balance-read receipt (redacted) into a throwaway ledger, and prints
 * per-currency available balances in BOTH internal minor units and provider
 * major units.
 *
 * Usage: AIRWALLEX_ENV=sandbox AIRWALLEX_CLIENT_ID=... AIRWALLEX_API_KEY=... \
 *        npm run smoke:balance -w @moterva/airwallex
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '@moterva/ledger';
import { AirwallexClient } from '../client.js';
import { HttpTransport } from '../http-transport.js';
import { loadAirwallexConfig } from '../config.js';
import { minorToMajorUnits } from '../money.js';

function fail(message: string): never {
  console.error(`BLOCKED: ${message}`);
  process.exit(2);
}

const config = loadAirwallexConfig();
if (!config.enabled) {
  fail(
    "Airwallex sandbox credentials are not configured in the server environment (need AIRWALLEX_ENV=sandbox plus AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY). Issue #5's real-provider gate — one actual sandbox balance read and one safe transfer with independent readback — remains BLOCKED on founder-provided credentials. Nothing was fabricated.",
  );
}

const ledger = openLedger(join(mkdtempSync(join(tmpdir(), 'moterva-awx-smoke-')), 'smoke.sqlite'));
ledger.migrate();
const org = ledger.organizations.createOrganization('Airwallex Smoke Org');

try {
  const transport = new HttpTransport({
    baseUrl: config.baseUrl,
    allowedOrigin: config.allowedOrigin,
    requestTimeoutMs: config.requestTimeoutMs,
    idempotentReadRetries: config.idempotentReadRetries,
  });
  const client = new AirwallexClient(config, transport, { now: () => new Date() });
  const balances = await client.balancesCurrent();
  console.info(`airwallex sandbox balance read OK (${balances.length} currency account(s)):`);
  for (const balance of balances) {
    if (balance.availableAmount !== null) {
      console.info(
        `  ${balance.currency}: available ${balance.availableAmount.minorUnits} minor units (provider major units: ${minorToMajorUnits(balance.currency, balance.availableAmount.minorUnits)}) account_type=${balance.accountType}`,
      );
    } else {
      console.info(
        `  ${balance.currency}: available ${String(balance.providerAvailableMajor)} (provider major units) — currency NOT in the internal money table; reported honestly, not converted`,
      );
    }
  }
  ledger.providerReceipts.append({
    provider: 'airwallex',
    orgId: org.id,
    operationId: null,
    requestId: 'smoke-balance-read',
    providerResourceId: null,
    kind: 'balance-read',
    environment: 'sandbox',
    httpStatus: 200,
    providerStatus: null,
    payloadJson: JSON.stringify({
      supported: balances
        .filter((b) => b.availableAmount !== null)
        .map((b) => ({
          currency: b.currency,
          available: b.availableAmount!.minorUnits,
          pending: b.pendingAmount!.minorUnits,
          reserved: b.reservedAmount!.minorUnits,
        })),
      unsupported: balances
        .filter((b) => b.availableAmount === null)
        .map((b) => ({ currency: b.currency, providerAvailableMajor: b.providerAvailableMajor })),
    }),
    recordedAt: new Date().toISOString(),
  });
  console.info('receipt persisted (environment=sandbox, kind=balance-read).');
  console.info('NOTE: balance read verified; NO transfer was attempted by this smoke.');
} catch (error) {
  console.error(
    `airwallex balance smoke failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  ledger.close();
}
