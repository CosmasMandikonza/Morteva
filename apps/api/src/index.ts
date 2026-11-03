/**
 * Entry point. Startup order (issue #3 acceptance):
 *  1. load development .env (optional, local only);
 *  2. validate configuration — on failure print actionable errors and exit(1)
 *     BEFORE binding a port (negative case "bad env");
 *  3. listen; print warnings; shut down gracefully on SIGINT/SIGTERM.
 */
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

  const app = buildApp(config);

  for (const warning of config.warnings) {
    app.log.warn(warning);
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`moterva-api ${config.providerMode} listening on ${config.host}:${config.port}`);

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    await app.close();
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
