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
import { buildApp } from './app.js';
import { StartupConfigError, loadConfig, loadDotEnvForDev } from './config.js';

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

  const app = buildApp(config, () => ({
    ok: ledger.db.open,
    schemaVersion: ledger.schemaVersion(),
    integrity: 'ok',
    pendingDispatches: ledger.outbox.pendingCount(),
  }));

  for (const warning of config.warnings) {
    app.log.warn(warning);
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `moterva-api ${config.providerMode} listening on ${config.host}:${config.port} (ledger v${ledger.schemaVersion()} at ${ledgerPath}, ${integrity.counts.pendingDispatches} pending dispatch(es))`,
  );

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
  console.error('moterva-api: fatal startup error', error);
  process.exit(1);
});
