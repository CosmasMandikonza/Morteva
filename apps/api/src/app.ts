/**
 * App factory. Routes in MTV-01 are exactly: GET /healthz (liveness) and
 * GET /api/system/status (honest read-only integration status).
 *
 * Everything else fails closed with 404 — including future financial routes
 * that do not exist yet, and wrong HTTP methods (docs/01 security boundary:
 * no public payment endpoints, no partially wired routes).
 */
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import { systemStatusView } from './routes/system-status.js';
import { healthView } from './routes/health.js';

export function buildApp(config: AppConfig): FastifyInstance {
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

  app.get('/api/system/status', async () => systemStatusView(config));

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
