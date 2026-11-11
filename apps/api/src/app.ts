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
import type { MetalAdapterStatusInput } from '@moterva/metal/status';
import { healthView } from './routes/health.js';
import { attachSession } from './auth.js';
import { registerAuthAndFinancialRoutes } from './routes.js';
import { registerProductionIdentityRoutes } from './identity/routes.js';
import { createOidcClient, type OidcClient } from './identity/oidc-client.js';
import { registerAuthCapabilitiesRoute } from './identity/capabilities.js';
import { registerDemoDecisionRoutes } from './integration/demo-routes.js';
import { registerReviewerDemoRoutes } from './reviewer-demo/routes.js';
import { registerWarehouseDemoRoutes } from './integration/warehouse-demo-routes.js';
import { registerPhysicalViewRoute } from './integration/physical-view.js';
import { registerMissionSpecRoutes } from './integration/mission-spec.js';
import { registerMissionOperationsRoutes } from './integration/mission-operations.js';
import { registerMachineIngestRoutes } from './integration/source-credentials.js';
import { resolveMissionSpec } from './integration/decision-snapshots.js';
import {
  registerDecisionAuthorityRoutes,
  registerDemoAuthorityRefreshRoute,
} from './integration/decision-snapshots.js';

export function buildApp(
  config: AppConfig,
  ledgerStatus?: () => LedgerStatusView,
  ledger?: Ledger,
  airwallexFacts?: () => AirwallexRailFacts,
  metalStatus?: () => MetalAdapterStatusInput,

  /**
   * Test seam ONLY: a pre-built OIDC client (e.g. pointed at the local test
   * IdP) so hermetic suites can exercise production posture without live
   * discovery. Production boots ALWAYS discover the configured issuer —
   * config validation and the identity===null gate still apply regardless.
   */

  identityClient?: OidcClient,
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

  // Anonymous auth-mode discovery (identity/v1): a signed-out browser learns
  // which login affordance to render. Public by design; minimal projection.
  registerAuthCapabilitiesRoute(app, config);

  if (ledger !== undefined && (config.devAuth || config.identity !== null)) {
    // Authenticated scope: mounted for DEMO_AUTH (loopback-only development,
    // unchanged) OR for a fully configured production identity provider —
    // never for an anonymous deployment. One encapsulated scope: cookie
    // parsing, the session decorator/hook and the routes share context, so
    // every guarded route sees request.session.
    void app.register(async (scope) => {
      await scope.register(cookie);
      attachSession(scope, ledger);
      // Financial + mission routes (read + governed mutations). The demo
      // login/dev-bootstrap endpoints inside remain devAuth-gated; logout and
      // session inspection work for any active authentication method.
      registerAuthAndFinancialRoutes(scope, config, ledger);
      // Durable decision snapshots + guarded proposal bridge (#19) + the
      // reviewer plan read — role-gated, CSRF-protected, safe in production.
      registerDecisionAuthorityRoutes(scope, ledger);
      // Sanitized live physical timeline (Agent C physical-view.v1 contract).
      registerPhysicalViewRoute(scope, ledger);
      // Shared C1/C5 domain-scoped mission spec read, no implicit authority.
      registerMissionSpecRoutes(scope, ledger, (orgId, mId) =>
        resolveMissionSpec(ledger, orgId, mId),
      );
      // P0 PRODUCTIZATION: the production mission-operations pathway —
      // authenticated spec registration, source credential issuance
      // (server-generated HMAC custody, SEALED at rest — no plaintext key
      // reaches the journal), human-gated signed event ingestion, journal-
      // derived evaluation, credential revocation/rotation, and bounded
      // model assistance. RBAC + CSRF protected; mounted OUTSIDE the
      // DEMO_AUTH gate (disclosed to Agent E; no identity/config/deploy
      // file touched).
      registerMissionOperationsRoutes(scope, ledger);
      // P0-1 machine-to-machine ingestion: headless telemetry integrations
      // authenticate with the EVENT'S OWN HMAC credential — no cookie, no
      // CSRF token. Tenant is pinned by the credential journal; the route
      // REFUSES cookie-bearing requests. Human administrative surfaces keep
      // their gates (CTO review PR #64 P0-1).
      registerMachineIngestRoutes(scope, ledger);
      if (config.identity !== null) {
        // Production identity: OIDC (code flow + PKCE), invitation accept,
        // invitation management. Registered ONLY with complete config.
        const client = identityClient ?? (await createOidcClient(config.identity));
        registerProductionIdentityRoutes(scope, config, ledger, client);
      }
      if (config.reviewerDemo && config.identity !== null) {
        // Fixed server-signed synthetic reviewer scenario, gated by production OIDC.
        registerReviewerDemoRoutes(scope, ledger);
      }
      if (config.devAuth) {
        // Controlled local-only physical-to-money demo; never mounted outside
        // the DEMO_AUTH gate (unchanged from #19).
        registerDemoDecisionRoutes(scope, ledger);
        registerDemoAuthorityRefreshRoute(scope, ledger);
        registerWarehouseDemoRoutes(scope, ledger);
      }
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
