import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FastifyInstance } from 'fastify';

const offlineApp = buildApp(loadConfig({ MOTERVA_PROVIDER_MODE: 'offline', LOG_LEVEL: 'silent' }));
const simulatedApp = buildApp(
  loadConfig({ MOTERVA_PROVIDER_MODE: 'simulated', LOG_LEVEL: 'silent' }),
);

const apps: FastifyInstance[] = [offlineApp, simulatedApp];
afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

describe('GET /healthz — genuine health route', () => {
  it('reports liveness with service identity, never provider claims', async () => {
    const response = await offlineApp.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('moterva-api');
    expect(body.providerMode).toBe('offline');
    expect(JSON.stringify(body).toLowerCase()).not.toContain('connected');
  });

  it('echoes build provenance when GIT_SHA is provided', async () => {
    const app = buildApp(loadConfig({ GIT_SHA: 'deadbeef', LOG_LEVEL: 'silent' }));
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.json().gitSha).toBe('deadbeef');
    await app.close();
  });
});

describe('GET /api/system/status — honest integration status', () => {
  it('lists both providers OFFLINE with explicit, non-connected wording', async () => {
    const response = await offlineApp.inject({ method: 'GET', url: '/api/system/status' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.service).toBe('moterva-api');
    expect(body.providerMode).toBe('offline');
    expect(body.providers).toHaveLength(2);
    for (const provider of body.providers) {
      expect(provider.label).toBe('OFFLINE');
      expect(provider.environment).toBe('offline');
    }
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toContain('connected');
  });

  it('never claims live provider state in offline mode', async () => {
    const response = await offlineApp.inject({ method: 'GET', url: '/api/system/status' });
    for (const provider of response.json().providers) {
      expect(provider.label).toBe('OFFLINE');
    }
  });

  it('carries the DEMO_SIMULATED notice only in simulated mode', async () => {
    const simulated = await simulatedApp.inject({ method: 'GET', url: '/api/system/status' });
    expect(simulated.json().simulationNotice).toContain('DEMO_SIMULATED');
    const offline = await offlineApp.inject({ method: 'GET', url: '/api/system/status' });
    expect(offline.json().simulationNotice).not.toContain('DEMO_SIMULATED');
    // Simulated demo data must not upgrade provider labels to anything live-sounding.
    for (const provider of simulated.json().providers) {
      expect(provider.label).toBe('OFFLINE');
    }
  });

  it('reports local ledger facts when wired, without provider claims (MTV-02)', async () => {
    const app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }), () => ({
      ok: true,
      schemaVersion: 1,
      integrity: 'ok',
      pendingDispatches: 0,
    }));
    const response = await app.inject({ method: 'GET', url: '/api/system/status' });
    const body = response.json();
    expect(body.ledger).toEqual({
      ok: true,
      schemaVersion: 1,
      integrity: 'ok',
      pendingDispatches: 0,
    });
    // Ledger facts are local persistence only — still no provider claim.
    expect(JSON.stringify(body.ledger).toLowerCase()).not.toContain('settled');
    await app.close();
  });

  it('omits the ledger section when no ledger is wired (backwards-compatible shape)', async () => {
    const response = await offlineApp.inject({ method: 'GET', url: '/api/system/status' });
    expect(response.json().ledger).toBeUndefined();
  });
});

describe('fail-closed routing (negative/adversarial requests)', () => {
  it('financial routes do not exist and fail closed with 404', async () => {
    for (const url of ['/api/operations', '/api/transfers', '/api/payments', '/api/wallets']) {
      const response = await offlineApp.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    }
  });

  it('unauthorized/admin-style paths fail closed the same way', async () => {
    for (const url of ['/api/admin', '/api/admin/secrets', '/api/users', '/api/debug/config']) {
      const response = await offlineApp.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
      const serialized = JSON.stringify(response.json()).toLowerCase();
      expect(serialized).not.toContain('stack');
      expect(serialized).not.toContain('apikey');
    }
  });

  it('wrong HTTP methods are rejected (POST /healthz, PUT /api/system/status)', async () => {
    const post = await offlineApp.inject({ method: 'POST', url: '/healthz', payload: {} });
    expect(post.statusCode).toBeGreaterThanOrEqual(400);
    const put = await offlineApp.inject({ method: 'PUT', url: '/api/system/status', payload: {} });
    expect(put.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('CORS only allows the configured web origin', async () => {
    const allowed = await offlineApp.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const evil = await offlineApp.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://evil.example.net' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('internal errors return a generic 500 without stack traces', async () => {
    const app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
    app.get('/boom-for-test', async () => {
      throw new Error('secret internals at src/routes/deep/inner.ts:42');
    });
    const response = await app.inject({ method: 'GET', url: '/boom-for-test' });
    expect(response.statusCode).toBe(500);
    const serialized = JSON.stringify(response.json());
    expect(serialized).toContain('INTERNAL');
    expect(serialized).not.toContain('secret internals');
    expect(serialized).not.toContain('at ');
    await app.close();
  });
});
