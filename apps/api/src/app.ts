/**
 * App factory. Public routes: GET /healthz (liveness) and
 * GET /api/system/status (honest read-only status incl. local ledger facts).
 *
 * When a ledger is wired, authenticated financial routes are registered
 * (issue #7): session-cookie identity, role policy, CSRF-protected mutations,
 * org-scoped queries. The login/dev-bootstrap endpoints exist only under the
 * explicit DEMO_AUTH gate (non-production; config refuses production+devAuth
 * at boot). Everything else fails closed with 404 — including any provider
 * write path, which does not exist until issues #5/#6.
 */
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { LedgerStatusView } from '@moterva/domain';
import type { Ledger } from '@moterva/ledger';
import type { AppConfig } from './config.js';
import { systemStatusView, type AirwallexRailFacts } from './routes/system-status.js';
import type { MetalAdapterStatusInput } from '@moterva/metal';
import { healthView } from './routes/health.js';
import { attachSession } from './auth.js';
import { registerAuthAndFinancialRoutes } from './routes.js';
import { registerDemoDecisionRoutes } from './integration/demo-routes.js';

export function buildApp(
  config: AppConfig,
  ledgerStatus?: () => LedgerStatusView,
  ledger?: Ledger,
  airwallexFacts?: () => AirwallexRailFacts,
  metalStatus?: () => MetalAdapterStatusInput,
): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  void app.register(cors, {
    // Strict allowlist: only the configured web origin may call this API from a browser.
    origin: [config.webOrigin],
    methods: ['GET'],
  });

  app.get('/healthz', async () => healthView(config));

  app.get('/api/system/status', async () =>
    systemStatusView(config, ledgerStatus?.(), airwallexFacts?.(), metalStatus),
  );

  if (ledger !== undefined && config.devAuth) {
    // Fail closed: there is NO production human IdP yet. Financial endpoints
    // are a loopback-only DEMO_AUTH workflow, not a production authentication
    // surface. A migrated dev session must never authorize deployed routes.
    // One encapsulated scope: cookie parsing, the session decorator/hook and
    // the routes share context, so every guarded route sees request.session.
    void app.register(async (scope) => {
      await scope.register(cookie);
      attachSession(scope, ledger);
      registerAuthAndFinancialRoutes(scope, config, ledger);
      // Controlled local-only physical-to-money demo; never mounted in production.
      registerDemoDecisionRoutes(scope, ledger);
    });
  }

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found. Unknown or not-yet-implemented routes fail closed by design.',
      },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'unhandled error');
    void reply.code(500).send({
      error: {
        code: 'INTERNAL',
        // Deliberately generic: never leak stack traces or internals to clients.
        message: 'Internal server error.',
      },
    });
  });

  return app;
}
