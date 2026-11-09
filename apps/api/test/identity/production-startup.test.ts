/**
 * Production-mode identity startup gates (MTV-19).
 *
 * Proves the deployment posture Agent E's release kit depends on:
 *  - production + complete OIDC config (no devAuth): identity routes are
 *    LIVE, demo login/bootstrap are structurally absent (404), financial
 *    routes still demand a session (fail-closed anonymous).
 *  - production WITHOUT identity: every identity route is 404 (fail-closed
 *    by construction, not by middleware).
 *  - production + devAuth: refused at startup (pre-existing invariant,
 *    re-proven here so the identity feature cannot regress it).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { openLedger, type Ledger } from '@moterva/ledger';
import { tempDbPath } from '../../../../packages/ledger/test/helpers.js';
import type { OidcClient } from '../../src/identity/oidc-client.js';

const REDIRECT_URI = 'https://app.example.com/api/auth/oidc/callback';
const COMPLETE_IDENTITY = {
  MOTERVA_OIDC_ISSUER: 'https://idp.example.com',
  MOTERVA_OIDC_CLIENT_ID: 'moterva-prod',
  MOTERVA_OIDC_CLIENT_SECRET: 'a-real-server-side-secret-value',
  MOTERVA_OIDC_REDIRECT_URI: REDIRECT_URI,
};

/**
 * Hermetic production-posture suite: a stub OIDC client (test seam on
 * buildApp) stands in for live discovery so these gates never depend on a
 * reachable IdP. Real protocol behavior is covered by the real-IdP suites.
 */
const STUB_CLIENT: OidcClient = {
  issuer: COMPLETE_IDENTITY.MOTERVA_OIDC_ISSUER,
  async beginFlow(redirectUri: string) {
    const url = new URL('https://idp.example.com/auth');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('code_challenge', 'stub-challenge');
    url.searchParams.set('state', 'stub-state');
    url.searchParams.set('nonce', 'stub-nonce');
    return {
      authorizationUrl: url.href,
      state: 'stub-state',
      nonce: 'stub-nonce',
      codeVerifier: 'stub-verifier',
    };
  },
  async completeFlow() {
    throw new Error('not exercised in this suite');
  },
};

describe('production startup with identity', () => {
  let ledger: Ledger;
  let app: FastifyInstance;

  beforeAll(async () => {
    ledger = openLedger(tempDbPath('identity-prod-'));
    ledger.migrate();
    app = buildApp(
      loadConfig({ NODE_ENV: 'production', ...COMPLETE_IDENTITY }),
      undefined,
      ledger,
      undefined,
      STUB_CLIENT,
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (ledger.db.open) ledger.close();
  });

  it('identity login start is LIVE (302/303 into the IdP authorization flow)', async () => {
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
    expect([302, 303]).toContain(start.statusCode);
    const location = start.headers.location as string;
    expect(location).toContain('https://idp.example.com');
    expect(location).toContain('response_type=code');
    expect(location).toContain('code_challenge_method=S256'); // PKCE mandated
  });

  it('invitation accept endpoint exists (400 on empty body, not 404)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/invitations/accept',
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
  });

  it('DEMO routes are structurally absent in production (404, not 401/403)', async () => {
    for (const [method, url] of [
      ['POST', '/api/auth/login'],
      ['POST', '/api/auth/dev-bootstrap'],
      ['POST', '/api/demo/refresh-authority'],
    ] as const) {
      const r = await app.inject({ method, url, payload: {} });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('financial endpoints stay fail-closed for anonymous callers (401, no data)', async () => {
    for (const url of ['/api/financial/overview', '/api/missions']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(401);
    }
    const body = await app.inject({ method: 'GET', url: '/api/financial/overview' });
    expect(body.body).not.toContain('spendable');
  });

  it('no identity secrets appear in any response body or cookie', async () => {
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
    const everything = JSON.stringify({
      location: start.headers.location,
      cookies: start.headers['set-cookie'] ?? null,
      body: start.body,
    });
    expect(everything).not.toContain('a-real-server-side-secret-value');
  });
});

describe('production startup WITHOUT identity', () => {
  let ledger: Ledger;
  let app: FastifyInstance;

  beforeAll(async () => {
    ledger = openLedger(tempDbPath('identity-prod-off-'));
    ledger.migrate();
    app = buildApp(loadConfig({ NODE_ENV: 'production' }), undefined, ledger);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (ledger.db.open) ledger.close();
  });

  it('every identity route is 404 — fail-closed by construction', async () => {
    for (const [method, url] of [
      ['GET', '/api/auth/oidc/login'],
      ['GET', '/api/auth/oidc/callback?code=x&state=y'],
      ['POST', '/api/auth/invitations/accept'],
      ['POST', '/api/invitations'],
      ['GET', '/api/invitations'],
    ] as const) {
      const r = await app.inject({ method, url, payload: {} });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('and the authenticated financial scope is absent too (no anonymous surface)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/financial/overview' });
    expect(r.statusCode).toBe(404);
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200); // liveness remains
  });
});

describe('production + devAuth remains refused (identity cannot soften it)', () => {
  it('MOTERVA_DEV_AUTH=1 with production NODE_ENV is a startup error even with full identity config', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', MOTERVA_DEV_AUTH: '1', ...COMPLETE_IDENTITY }),
    ).toThrow(/demo authentication cannot be enabled in production/);
  });
});
