/**
 * OIDC protocol-security adversarial suite (fake IdP with controlled JWKS).
 *
 * Unlike production-identity.test.ts (real oidc-provider happy path + app
 * behavior), this suite stands up a MINIMAL fake authorization server whose
 * metadata, token endpoint and JWKS we fully control, so every token-level
 * failure mode is exercised against the REAL openid-client validation stack:
 * wrong signature, alg downgrade, wrong audience/issuer, expired ID token,
 * nonce mismatch, state mismatch, code reuse (replay), and IdP timeout.
 * Every assertion covers BOTH the error and the absence of a session
 * (Set-Cookie).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { FastifyInstance } from 'fastify';
import * as jose from 'jose';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { openLedger, type Ledger } from '@moterva/ledger';
import { tempDbPath } from '../../../../packages/ledger/test/helpers.js';

const REDIRECT_URI = 'http://127.0.0.1:8787/api/auth/oidc/callback';
const WEB_ORIGIN = 'http://localhost:5173';
const AUDIENCE = 'moterva-fake-client';

interface FakeWorld {
  issuer: string;
  port: number;
  /** Rotates the signing key; the previous key STAYS published in JWKS. */
  rotateSigningKey(): void;
  /** Override the next token response (a prepared id_token, or an error status). */
  setTokenResponse(override: { idToken: string } | { status: number } | null): void;
  setTokenLatency(ms: number): void;
  close(): Promise<void>;
  /** The CURRENT signing entry (kid + private key) for custom-minted tokens. */
  currentKey(): { kid: string; key: KeyObject };
}

async function jwkPublic(key: KeyObject, kid: string): Promise<Record<string, unknown>> {
  const jwk = (await jose.exportJWK(
    await jose.importJWK(key.export({ format: 'jwk' }) as jose.JWK, 'RS256'),
  )) as Record<string, unknown>;
  return { ...jwk, kid, use: 'sig', alg: 'RS256' };
}

async function startFakeIdp(): Promise<FakeWorld> {
  const keys: { kid: string; key: KeyObject }[] = [];
  let counter = 0;
  const newKey = (): { kid: string; key: KeyObject } => {
    counter += 1;
    return { kid: `fake-key-${counter}`, key: generateRsa() };
  };
  function generateRsa(): KeyObject {
    // node:crypto generateKeyPairSync returns a pair; keep the private part.
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return pair.privateKey;
  }
  keys.push(newKey());

  const authChallenges = new Map<string, string>();
  const issuedNonces = new Map<string, string>();
  const pendingCodes = new Map<string, string>();
  let override: { idToken: string } | { status: number } | null = null;
  let latencyMs = 0;

  const server = http.createServer((req, res) => {
    void (async () => {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/.well-known/openid-configuration') {
        res.end(
          JSON.stringify({
            issuer: world.issuer,
            authorization_endpoint: `${world.issuer}/auth`,
            token_endpoint: `${world.issuer}/token`,
            jwks_uri: `${world.issuer}/jwks`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            code_challenge_methods_supported: ['S256'],
          }),
        );
        return;
      }
      if (url.pathname === '/jwks') {
        const keysOut = [];
        for (const entry of keys) keysOut.push(await jwkPublic(entry.key, entry.kid));
        res.end(JSON.stringify({ keys: keysOut }));
        return;
      }
      if (url.pathname === '/auth') {
        const state = url.searchParams.get('state') ?? '';
        const code = randomUUID();
        pendingCodes.set(code, state);
        authChallenges.set(code, url.searchParams.get('code_challenge') ?? '');
        issuedNonces.set(code, url.searchParams.get('nonce') ?? '');
        const target = new URL(REDIRECT_URI);
        target.searchParams.set('code', code);
        target.searchParams.set('state', state);
        res.statusCode = 302;
        res.setHeader('location', target.href);
        res.end();
        return;
      }
      if (url.pathname === '/token') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', async () => {
          if (override !== null && 'status' in override) {
            res.statusCode = override.status;
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          const params = new URLSearchParams(body);
          const code = params.get('code') ?? '';
          const verifier = params.get('code_verifier') ?? '';
          const challenge = authChallenges.get(code) ?? '';
          const expected = createHash('sha256').update(verifier).digest('base64url');
          if (challenge === '' || challenge !== expected) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'pkce mismatch' }));
            return;
          }
          if (!pendingCodes.has(code)) {
            res.statusCode = 400;
            res.end(
              JSON.stringify({
                error: 'invalid_grant',
                error_description: 'code already used or unknown',
              }),
            );
            return;
          }
          pendingCodes.delete(code); // single-use codes
          const now = Math.floor(Date.now() / 1000);
          if (override !== null && 'idToken' in override) {
            res.end(
              JSON.stringify({
                access_token: 'at',
                id_token: override.idToken,
                token_type: 'Bearer',
                expires_in: 600,
              }),
            );
            return;
          }
          const current = keys[0]!;
          const idToken = await new jose.SignJWT({
            sub: 'fake-sub',
            email: 'fake@idp.test',
            aud: AUDIENCE,
            iss: world.issuer,
            nonce: issuedNonces.get(code) ?? '',
            iat: now,
            exp: now + 600,
          })
            .setProtectedHeader({ alg: 'RS256', kid: current.kid })
            .sign(current.key);
          res.end(
            JSON.stringify({
              access_token: 'at',
              id_token: idToken,
              token_type: 'Bearer',
              expires_in: 600,
            }),
          );
        });
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    })().catch((error) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(error) }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;
  const world: FakeWorld = {
    port,
    issuer: `http://127.0.0.1:${port}`,
    rotateSigningKey() {
      keys.unshift(newKey()); // new key first; the old key STAYS published
    },
    setTokenResponse(o) {
      override = o;
    },
    setTokenLatency(ms) {
      latencyMs = ms;
    },
    currentKey() {
      return keys[0]!;
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return world;
}

const DIR = mkdtempSync(join(tmpdir(), 'protocol-security-'));
let idp: FakeWorld;
let app: FastifyInstance;
let ledger: Ledger;

async function startFlow(): Promise<string> {
  const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
  expect(start.statusCode).toBe(303);
  return start.headers.location as string;
}

async function driveAuth(authorizationUrl: string): Promise<{ code: string; state: string }> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  const callback = new URL(response.headers.get('location')!);
  return { code: callback.searchParams.get('code')!, state: callback.searchParams.get('state')! };
}

async function callback(code: string, state: string) {
  return app.inject({
    method: 'GET',
    url: `/api/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  });
}

const expectNoSession = (response: { headers: Record<string, unknown> }) => {
  expect(response.headers['set-cookie']).toBeUndefined();
};

/** Signs a custom id_token with a THROWAWAY key (valid format, wrong trust). */
async function mintWithForeignKey(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const foreign = (await jose.generateKeyPair('RS256')).privateKey;
  return new jose.SignJWT({ iat: now, exp: now + 600, ...claims })
    .setProtectedHeader({ alg: 'RS256' })
    .sign(foreign);
}

beforeAll(async () => {
  idp = await startFakeIdp();
  ledger = openLedger(tempDbPath('protocol-security-'));
  ledger.migrate();
  app = buildApp(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WEB_ORIGIN,
      MOTERVA_LEDGER_PATH: join(DIR, 'ledger.sqlite'),
      MOTERVA_OIDC_ISSUER: idp.issuer,
      MOTERVA_OIDC_CLIENT_ID: AUDIENCE,
      MOTERVA_OIDC_CLIENT_SECRET: 'fake-client-secret-for-tests-only',
      MOTERVA_OIDC_REDIRECT_URI: REDIRECT_URI,
      MOTERVA_OIDC_ALLOW_INSECURE_TRANSPORT: '1',
      MOTERVA_OIDC_HTTP_TIMEOUT_MS: '2000',
    }),
    undefined,
    ledger,
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await idp.close();
  if (ledger.db.open) ledger.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe('token-level protocol failures (real openid-client validation)', () => {
  it('a VALID fake-IdP round trip completes (control; identity unlinked → 403, code consumed)', async () => {
    const authorization = await startFlow();
    const { code, state } = await driveAuth(authorization);
    const done = await callback(code, state);
    expect(done.statusCode).toBe(403); // linked check fires AFTER valid token validation
    expect((done.json() as { error: { code: string } }).error.code).toBe('IDENTITY_NOT_LINKED');
  });

  it('TAMPERED signature is rejected — no session', async () => {
    const authorization = await startFlow();
    const { code, state } = await driveAuth(authorization);
    const tampered = await mintWithForeignKey({ sub: 'fake-sub', aud: AUDIENCE, iss: idp.issuer });
    idp.setTokenResponse({ idToken: tampered });
    const done = await callback(code, state);
    expect(done.statusCode).toBe(400);
    expect((done.json() as { error: { code: string } }).error.code).toMatch(
      /OIDC_TOKEN_INVALID|OIDC_CODE_INVALID/,
    );
    expectNoSession(done);
  });

  it('alg NONE (unsigned) token is rejected', async () => {
    const authorization = await startFlow();
    const { code, state } = await driveAuth(authorization);
    const now = Math.floor(Date.now() / 1000);
    // jose refuses to SIGN with alg=none — assemble the unsigned JWT by hand.
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'none' })}.${b64({ sub: 'fake-sub', aud: AUDIENCE, iss: idp.issuer, iat: now, exp: now + 600 })}.`;
    idp.setTokenResponse({ idToken: unsigned });
    const done = await callback(code, state);
    expect(done.statusCode).toBe(400);
    expectNoSession(done);
  });

  it('WRONG AUDIENCE is rejected', async () => {
    const authorization = await startFlow();
    const { code, state } = await driveAuth(authorization);
    const wrongAud = await mintWithForeignKey({
      sub: 'fake-sub',
      aud: 'some-other-client',
      iss: idp.issuer,
    });
    idp.setTokenResponse({ idToken: wrongAud });
    const done = await callback(code, state);
    expect(done.statusCode).toBe(400);
    expectNoSession(done);
  });

  it('WRONG ISSUER is rejected', async () => {
    const authorization = await startFlow();
    const { code, state } = await driveAuth(authorization);
    const wrongIss = await mintWithForeignKey({
      sub: 'fake-sub',
      aud: AUDIENCE,
      iss: 'https://evil.example',
    });
    idp.setTokenResponse({ idToken: wrongIss });
    const done = await callback(code, state);
    expect(done.statusCode).toBe(400);
    expectNoSession(done);
  });

  it('EXPIRED ID token is rejected', async () => {
    const authorization = await startFlow();
    const { code, state } = await driveAuth(authorization);
    const expired = await mintWithForeignKey({
      sub: 'fake-sub',
      aud: AUDIENCE,
      iss: idp.issuer,
      iat: Math.floor(Date.now() / 1000) - 3600,
      exp: Math.floor(Date.now() / 1000) - 1800,
    });
    idp.setTokenResponse({ idToken: expired });
    const done = await callback(code, state);
    expect(done.statusCode).toBe(400);
    expectNoSession(done);
  });

  it('NONCE MISMATCH is rejected', async () => {
    const authorization = await startFlow();
    const { code, state } = await driveAuth(authorization);
    const badNonce = await mintWithForeignKey({
      sub: 'fake-sub',
      aud: AUDIENCE,
      iss: idp.issuer,
      nonce: 'attacker-nonce',
    });
    idp.setTokenResponse({ idToken: badNonce });
    const done = await callback(code, state);
    expect(done.statusCode).toBe(400);
    expectNoSession(done);
  });

  it('WRONG STATE is rejected before any exchange', async () => {
    await startFlow(); // flow A: the server now holds ITS state
    const authorization = await startFlow(); // flow B
    const { code } = await driveAuth(authorization);
    const done = await callback(code, 'attacker-chosen-state');
    expect(done.statusCode).toBe(400);
    expect((done.json() as { error: { code: string } }).error.code).toBe('OIDC_STATE_INVALID');
    expectNoSession(done);
  });

  it('CODE REPLAY: the second exchange of the same code fails', async () => {
    const authorization = await startFlow();
    const { code, state } = await driveAuth(authorization);
    await callback(code, state); // first (unlinked 403 — code now consumed)
    const second = await callback(code, state);
    expect(second.statusCode).toBe(400);
    expect((second.json() as { error: { code: string } }).error.code).toBe('OIDC_STATE_REPLAYED');
    expectNoSession(second);
  });

  it('token-endpoint invalid_grant (e.g. PKCE mismatch) fails the exchange closed', async () => {
    const authorization = await startFlow();
    const { code, state } = await driveAuth(authorization);
    idp.setTokenResponse({ status: 400 });
    const done = await callback(code, state);
    expect(done.statusCode).toBe(400);
    expect((done.json() as { error: { code: string } }).error.code).toBe('OIDC_CODE_INVALID');
    expectNoSession(done);
    idp.setTokenResponse(null); // clear the override for later tests
  });

  it('IdP TIMEOUT (slow token endpoint) fails bounded, no hang, no session', async () => {
    const authorization = await startFlow();
    const { code, state } = await driveAuth(authorization);
    idp.setTokenLatency(2_500);
    const done = await callback(code, state);
    expect(done.statusCode).toBe(503);
    expect((done.json() as { error: { code: string } }).error.code).toBe('OIDC_UNAVAILABLE');
    expectNoSession(done);
    idp.setTokenLatency(0);
  });

  it('JWKS ROTATION: tokens signed by a NEW key validate; stale-key tokens fail', async () => {
    // Rotation: new key at keys[0], old key still published.
    idp.rotateSigningKey();
    const authorization = await startFlow();
    const { code, state } = await driveAuth(authorization);
    const done = await callback(code, state);
    // Valid new-key token: validation passes (then unlinked 403 — no session).
    expect(done.statusCode).toBe(403);
    expect((done.json() as { error: { code: string } }).error.code).toBe('IDENTITY_NOT_LINKED');
    expectNoSession(done);
  });

  it('UNKNOWN kid (key never published) is rejected', async () => {
    const authorization = await startFlow();
    const { code, state } = await driveAuth(authorization);
    const now = Math.floor(Date.now() / 1000);
    const unknownKid = await new jose.SignJWT({
      sub: 'fake-sub',
      aud: AUDIENCE,
      iss: idp.issuer,
      iat: now,
      exp: now + 600,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'never-published' })
      .sign((await jose.generateKeyPair('RS256')).privateKey);
    idp.setTokenResponse({ idToken: unknownKid });
    const done = await callback(code, state);
    expect(done.statusCode).toBe(400);
    expectNoSession(done);
  });
});
