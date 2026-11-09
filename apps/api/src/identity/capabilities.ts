/**
 * Anonymous authentication-capabilities read (MTV-19, identity/v1).
 *
 * `GET /api/auth/capabilities` — public (no session): lets a signed-out
 * browser decide whether to offer OIDC sign-in or local demo login.
 *
 * Deliberately MINIMAL: the response is `{ authMode, demoLogin }` where
 * authMode is 'oidc' | 'demo' | 'none'. It NEVER includes the issuer URL,
 * client id, redirect URI, membership data, or anything else about the
 * identity configuration — a signed-out caller learns only which login
 * affordance to render, and the sign-in navigation itself goes through
 * `GET /api/auth/oidc/login`, which is what actually involves the IdP.
 *
 * Registered on the PUBLIC app (not inside the authenticated scope) so it
 * works in every deployment posture; the values are pure config projection.
 */
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';

export function registerAuthCapabilitiesRoute(app: FastifyInstance, config: AppConfig): void {
  app.get('/api/auth/capabilities', async () => {
    const authMode = config.identity !== null ? 'oidc' : config.devAuth ? 'demo' : 'none';
    return {
      authMode,
      // Demo username/password login affordance is only rendered when the
      // DEMO_AUTH gate is actually active (loopback, non-production).
      demoLogin: config.devAuth,
    };
  });
}
