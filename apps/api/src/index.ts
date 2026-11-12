/**
 * Entry point. Startup order:
 *  1. load development .env (optional, local only);
 *  2. validate configuration — on failure print actionable errors and exit(1)
 *     BEFORE binding a port (negative case "bad env");
 *  3. open the financial ledger, run migrations, verify integrity (MTV-02) —
 *     a corrupted or newer-schema database refuses to boot;
 *  4. listen; print warnings; shut down gracefully on SIGINT/SIGTERM.
 */
import { resolve } from 'node:path';
import { openLedger, type Ledger } from '@moterva/ledger';
import { buildSandboxDispatcher, HttpTransport, loadAirwallexConfig } from '@moterva/airwallex';
import { loadMetalConfig } from '@moterva/metal/status';
import { buildApp } from './app.js';
import { StartupConfigError, loadConfig, loadDotEnvForDev } from './config.js';
import { SourceKeyCustodyError } from './integration/source-key-custody.js';

loadDotEnvForDev();

let shuttingDown = false;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof StartupConfigError) {
      console.error(`moterva-api: refusing to start — ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  // Ledger startup: migrate forward, then verify persisted invariants. Both
  // fail closed — the API never boots against a database it cannot trust.
  let ledger: Ledger;
  const ledgerPath = resolve(config.ledgerPath);
  try {
    ledger = openLedger(ledgerPath);
    const migrationReport = ledger.migrate();
    if (migrationReport.applied.length > 0) {
      console.info(
        `moterva-api: ledger migrations applied: ${migrationReport.applied.map((m) => `v${m.version} ${m.name}`).join(', ')}`,
      );
    }
  } catch (error) {
    console.error(
      `moterva-api: refusing to start — ledger at ${ledgerPath} failed to open/migrate: ${String(error)}`,
    );
    process.exit(1);
    return;
  }
  const integrity = ledger.recovery.verify();
  if (integrity.integrity !== 'ok') {
    console.error(`moterva-api: refusing to start — ledger integrity violations at ${ledgerPath}:`);
    for (const violation of integrity.violations) console.error(`  - ${violation}`);
    ledger.close();
    process.exit(1);
    return;
  }

  // Airwallex sandbox rail (issue #5): registered ONLY when the server env
  // explicitly enables sandbox mode with credentials present. Without both,
  // the rail stays dark and status honestly reports disabled/blocked.
  let airwallex: { enabled: boolean; environment: 'sandbox' | 'disabled'; detail: string };
  try {
    const awxConfig = loadAirwallexConfig();
    if (awxConfig.enabled) {
      const beneficiaryForOrg = (orgId: string): string | undefined =>
        (
          process.env[`AIRWALLEX_BENEFICIARY_ID_${orgId}`] ??
          process.env.AIRWALLEX_BENEFICIARY_ID ??
          ''
        ).trim() || undefined;
      const dispatcher = buildSandboxDispatcher(
        awxConfig,
        new HttpTransport({
          baseUrl: awxConfig.baseUrl,
          allowedOrigin: awxConfig.allowedOrigin,
          requestTimeoutMs: awxConfig.requestTimeoutMs,
          idempotentReadRetries: awxConfig.idempotentReadRetries,
        }),
        ledger.providerReceipts,
        ledger.clock,
        beneficiaryForOrg,
      );
      ledger.worker.register(dispatcher);
      airwallex = {
        enabled: true,
        environment: 'sandbox',
        detail:
          'sandbox dispatcher registered; transfers dispatch through the atomic authority gate',
      };
    } else {
      airwallex = {
        enabled: false,
        environment: 'disabled',
        detail:
          'disabled: no sandbox credentials configured (AIRWALLEX_ENV/AIRWALLEX_CLIENT_ID/AIRWALLEX_API_KEY). Real-provider gate remains BLOCKED; no provider call is made or claimed.',
      };
    }
  } catch (error) {
    console.error(
      `moterva-api: refusing to start — invalid Airwallex configuration: ${String(error)}`,
    );
    ledger.close();
    process.exit(1);
    return;
  }

  // Metal Tahoe testnet rail (issue #6): the adapter in packages/metal is
  // complete and adversarially tested, but WORKER REGISTRATION stays dark
  // until the ledger can express metal honestly (Agent A contract):
  //  (a) reserve() refuses kind metal_order (RAIL_ASSET_UNSUPPORTED) — no
  //      token-asset account exists, so no metal operation can be authorized;
  //  (b) provider_receipts cannot persist a metal receipt truthfully (the
  //      provider column is hardcoded 'airwallex'; the environment CHECK
  //      excludes 'testnet').
  // Registering a dispatcher whose evidence cannot be persisted truthfully
  // would be exactly the dishonesty the repo forbids, so status reports the
  // precise blocker instead. The gated smoke (packages/metal smoke:purchase)
  // carries the live testnet path on its own labeled durable journal until
  // the contract lands. An env with METAL_* set AND an invalid configuration
  // still fails startup (never half-configured).
  let metal: { detail: string };
  try {
    const metalConfig = loadMetalConfig();
    metal = {
      detail: metalConfig.enabled
        ? 'adapter configured and ready (testnet signer + USDZ token + merchant); worker registration blocked on the ledger contract: metal_order token-asset accounting (RAIL_ASSET_UNSUPPORTED today) + provider-aware testnet receipt persistence — see docs/contracts/metal-ledger-contract-request.md. The gated smoke:purchase flow carries real testnet verification meanwhile.'
        : 'disabled: no testnet signer/token configuration (METAL_ENV/METAL_SIGNER_PRIVATE_KEY/METAL_USDZ_TOKEN_ADDRESS/METAL_MERCHANT_ADDRESS). Real-testnet gate BLOCKED; no chain call is made or claimed.',
    };
  } catch (error) {
    console.error(`moterva-api: refusing to start — invalid Metal configuration: ${String(error)}`);
    ledger.close();
    process.exit(1);
    return;
  }

  const app = buildApp(
    config,
    () => ({
      ok: ledger.db.open,
      schemaVersion: ledger.schemaVersion(),
      integrity: 'ok',
      pendingDispatches: ledger.outbox.pendingCount(),
    }),
    ledger,
    () => ({
      registered: airwallex.enabled,
      receiptCount: (
        ledger.db
          .prepare("SELECT COUNT(*) AS c FROM provider_receipts WHERE environment = 'sandbox'")
          .get() as { c: number }
      ).c,
      readbackCount: (
        ledger.db
          .prepare(
            "SELECT COUNT(*) AS c FROM provider_receipts WHERE environment = 'sandbox' AND kind LIKE 'readback%'",
          )
          .get() as { c: number }
      ).c,
    }),
    () => ({
      registered: false,
      receiptCount: 0,
      readbackCount: 0,
      detail: metal.detail,
    }),
  );

  for (const warning of config.warnings) {
    app.log.warn(warning);
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `moterva-api ${config.providerMode} listening on ${config.host}:${config.port} (ledger v${ledger.schemaVersion()} at ${ledgerPath}, ${integrity.counts.pendingDispatches} pending dispatch(es))`,
  );
  app.log.info(
    `airwallex rail: ${airwallex.enabled ? 'SANDBOX ENABLED' : 'DISABLED'} — ${airwallex.detail}`,
  );
  app.log.info(
    `metal rail: DISABLED (worker registration blocked on ledger contract) — ${metal.detail}`,
  );
  void airwallex;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    await app.close();
    ledger.close();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  console.error('moterva-api: unhandled rejection', reason);
  process.exitCode = 1;
});

main().catch((error) => {
  // Source-key custody gate (CTO review PR #64): buildApp refuses to boot on an
  // unrecoverable custody state — never a fallback to a predictable key. The
  // message names env vars and KEK fingerprints only, never key material.
  if (error instanceof SourceKeyCustodyError) {
    console.error(`moterva-api: refusing to start — ${error.message}`);
    process.exit(1);
  }
  console.error('moterva-api: fatal startup error', error);
  process.exit(1);
});
