import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, StartupConfigError } from '../src/config.js';
import { openLedger, type Ledger } from '@moterva/ledger';
import { TEST_PASSWORD, tempDbPath } from '../../../packages/ledger/test/helpers.js';
import type { FastifyInstance } from 'fastify';

/**
 * Issue #7 Phase 6: the HTTP trust boundary. Every financial route requires a
 * session from a verified actor; mutations require the session-bound CSRF
 * header; org scoping is taken from the ACTOR, never the request.
 */

function makeApp(options: { devAuth?: boolean; nodeEnv?: 'development' | 'production' } = {}) {
  const path = tempDbPath('mtv05-api-');
  const ledger: Ledger = openLedger(path);
  ledger.migrate();
  const config = loadConfig({
    NODE_ENV: options.nodeEnv ?? 'development',
    LOG_LEVEL: 'silent',
    MOTERVA_DEV_AUTH: options.devAuth ? '1' : undefined,
    WEB_ORIGIN: 'http://localhost:5173',
  });
  const app = buildApp(config, undefined, ledger);
  return { app, ledger, config };
}

function fundWorld(ledger: Ledger) {
  const org = ledger.organizations.createOrganization('HttpOrg');
  const mission = ledger.organizations.createMission(org.id, 'm');
  const owner = ledger.authority.createHumanActor({
    orgId: org.id,
    username: 'http-owner',
    displayName: 'O',
    role: 'owner',
    password: TEST_PASSWORD,
  });
  const approver = ledger.authority.createHumanActor({
    orgId: org.id,
    username: 'http-approver',
    displayName: 'A',
    role: 'approver',
    password: TEST_PASSWORD,
  });
  const operator = ledger.authority.createHumanActor({
    orgId: org.id,
    username: 'http-operator',
    displayName: 'Op',
    role: 'operator',
    password: TEST_PASSWORD,
  });
  const viewer = ledger.authority.createHumanActor({
    orgId: org.id,
    username: 'http-viewer',
    displayName: 'V',
    role: 'viewer',
    password: TEST_PASSWORD,
  });
  ledger.accounts.ensureTreasuryAccount({
    orgId: org.id,
    currency: 'USD',
    label: 'USD',
    protectedFloorMinor: 0,
  });
  ledger.accounts.recordBalanceSnapshot({
    orgId: org.id,
    currency: 'USD',
    minorUnits: 1_000_000,
    source: 'manual-seed',
    observedAt: ledger.clock.iso(),
    expiresAt: new Date(ledger.clock.now().getTime() + 24 * 3_600_000).toISOString(),
  });
  return { org, mission, owner, approver, operator, viewer };
}

async function login(
  app: FastifyInstance,
  username: string,
  password: string,
  orgId?: string,
): Promise<{ cookie: string; csrfToken: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password, orgId },
  });
  if (response.statusCode !== 200)
    throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  const setCookie = response.headers['set-cookie'] as unknown;
  const firstCookie = Array.isArray(setCookie) ? (setCookie[0] as string) : String(setCookie);
  const cookie = firstCookie.split(';')[0]!;
  return { cookie, csrfToken: (response.json() as { csrfToken: string }).csrfToken };
}

describe('config: DEMO_AUTH gate', () => {
  it('refuses public-facing development bootstraps and origins', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'development',
        MOTERVA_DEV_AUTH: '1',
        HOST: '0.0.0.0',
        WEB_ORIGIN: 'http://localhost:5173',
      }),
    ).toThrowError(/loopback HOST/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'development',
        MOTERVA_DEV_AUTH: '1',
        HOST: '127.0.0.1',
        WEB_ORIGIN: 'https://public-preview.example',
      }),
    ).toThrowError(/loopback WEB_ORIGIN/);
  });

  it('does not register password login when DEMO_AUTH is disabled', async () => {
    const { app, ledger } = makeApp({ devAuth: false });
    fundWorld(ledger);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'http-owner', password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
    ledger.close();
  });

  it('refuses to boot when MOTERVA_DEV_AUTH=1 meets production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', MOTERVA_DEV_AUTH: '1', LOG_LEVEL: 'silent' }),
    ).toThrowError(StartupConfigError);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', MOTERVA_DEV_AUTH: '1', LOG_LEVEL: 'silent' }),
    ).toThrowError(/demo authentication cannot be enabled in production/);
  });

  it('devAuth is off by default and on only when explicitly enabled in non-production', () => {
    expect(loadConfig({ NODE_ENV: 'development', LOG_LEVEL: 'silent' }).devAuth).toBe(false);
    expect(
      loadConfig({ NODE_ENV: 'development', MOTERVA_DEV_AUTH: '1', LOG_LEVEL: 'silent' }).devAuth,
    ).toBe(true);
    expect(
      loadConfig({ NODE_ENV: 'test', MOTERVA_DEV_AUTH: '1', LOG_LEVEL: 'silent' }).warnings.join(
        ' ',
      ),
    ).toMatch(/DEMO_AUTH is ACTIVE/);
  });
});

describe('HTTP auth boundary', () => {
  it('login sets an HttpOnly SameSite=Strict cookie and returns a CSRF token; wrong password is 401 without an oracle', async () => {
    const { app, ledger } = makeApp({ devAuth: true });
    fundWorld(ledger);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'http-approver', password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'] as unknown;
    const cookieHeader = Array.isArray(setCookie)
      ? (setCookie as string[]).join('; ')
      : String(setCookie);
    expect(cookieHeader).toMatch(/HttpOnly/i);
    expect(cookieHeader).toMatch(/SameSite=Strict/i);
    expect(cookieHeader).toMatch(/moterva_session=/);
    expect((response.json() as { csrfToken: string }).csrfToken).toHaveLength(43);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'http-approver', password: 'wrong-password' },
    });
    expect(bad.statusCode).toBe(401);
    expect((bad.json() as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
    const ghost = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'no-such-user', password: TEST_PASSWORD },
    });
    expect(ghost.statusCode).toBe(401);
    await app.close();
    ledger.close();
  });

  it('repeated failed logins are rate limited (429)', async () => {
    const { app, ledger } = makeApp({ devAuth: true });
    fundWorld(ledger);
    for (let i = 0; i < 5; i += 1) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'http-owner', password: 'nope' },
      });
      expect(r.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'http-owner', password: TEST_PASSWORD },
    });
    expect(blocked.statusCode).toBe(429);
    expect((blocked.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    await app.close();
    ledger.close();
  });

  it('unauthenticated financial access is 401; session echo works; logout invalidates', async () => {
    const { app, ledger } = makeApp({ devAuth: true });
    fundWorld(ledger);
    const anon = await app.inject({ method: 'GET', url: '/api/missions' });
    expect(anon.statusCode).toBe(401);
    expect((anon.json() as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');

    const session = await login(app, 'http-viewer', TEST_PASSWORD);
    const echo = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: session.cookie },
    });
    expect(echo.statusCode).toBe(200);
    expect((echo.json() as { actor: { role: string } }).actor.role).toBe('viewer');

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    });
    expect(logout.statusCode).toBe(200);
    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/missions',
      headers: { cookie: session.cookie },
    });
    expect(afterLogout.statusCode).toBe(401);
    await app.close();
    ledger.close();
  });

  it('mutations without a CSRF header are 403 CSRF_INVALID', async () => {
    const { app, ledger } = makeApp({ devAuth: true });
    fundWorld(ledger);
    const session = await login(app, 'http-owner', TEST_PASSWORD);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/missions',
      headers: { cookie: session.cookie },
      payload: { title: 'x' },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect((noCsrf.json() as { error: { code: string } }).error.code).toBe('CSRF_INVALID');
    const badCsrf = await app.inject({
      method: 'POST',
      url: '/api/missions',
      headers: { cookie: session.cookie, 'x-csrf-token': 'forged' },
      payload: { title: 'x' },
    });
    expect(badCsrf.statusCode).toBe(403);
    await app.close();
    ledger.close();
  });

  it('role matrix on financial routes: viewer read-only, operator cannot approve, service never approves', async () => {
    const { app, ledger } = makeApp({ devAuth: true });
    const world = fundWorld(ledger);
    const viewer = await login(app, 'http-viewer', TEST_PASSWORD);
    const operator = await login(app, 'http-operator', TEST_PASSWORD);
    const approver = await login(app, 'http-approver', TEST_PASSWORD);

    // Viewer reads but cannot create missions or approve.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/missions',
          headers: { cookie: viewer.cookie },
        })
      ).statusCode,
    ).toBe(200);
    const viewerWrite = await app.inject({
      method: 'POST',
      url: '/api/missions',
      headers: { cookie: viewer.cookie, 'x-csrf-token': viewer.csrfToken },
      payload: { title: 'nope' },
    });
    expect(viewerWrite.statusCode).toBe(403);
    expect((viewerWrite.json() as { error: { code: string } }).error.code).toBe('ROLE_FORBIDDEN');

    // Operator proposes a plan; cannot approve it (SoD is structural anyway).
    const planResponse = await app.inject({
      method: 'POST',
      url: '/api/plans',
      headers: { cookie: operator.cookie, 'x-csrf-token': operator.csrfToken },
      payload: {
        missionId: world.mission.id,
        terms: { amountMinor: 50_000, currency: 'USD', beneficiary: 'acme', purpose: 'repair' },
      },
    });
    expect(planResponse.statusCode).toBe(200);
    const { plan } = planResponse.json() as {
      plan: { id: string; version: number; digest: string };
    };

    const owner = await login(app, 'http-owner', TEST_PASSWORD);
    const mandateResponse = await app.inject({
      method: 'POST',
      url: '/api/mandates',
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken },
      payload: {
        missionId: world.mission.id,
        currency: 'USD',
        maxAmountMinor: 500_000,
        totalBudgetMinor: 500_000,
        permittedOperationKinds: ['airwallex_transfer'],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(mandateResponse.statusCode).toBe(200);
    const { mandate } = mandateResponse.json() as { mandate: { id: string } };

    const operatorApprove = await app.inject({
      method: 'POST',
      url: '/api/approvals',
      headers: { cookie: operator.cookie, 'x-csrf-token': operator.csrfToken },
      payload: {
        missionId: world.mission.id,
        planId: plan.id,
        planVersion: plan.version,
        kind: 'airwallex_transfer',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(operatorApprove.statusCode).toBe(403);

    // The approver approves the operator's proposal (separation of duties ok).
    const approvalResponse = await app.inject({
      method: 'POST',
      url: '/api/approvals',
      headers: { cookie: approver.cookie, 'x-csrf-token': approver.csrfToken },
      payload: {
        missionId: world.mission.id,
        planId: plan.id,
        planVersion: plan.version,
        kind: 'airwallex_transfer',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(approvalResponse.statusCode).toBe(200);
    const { approval } = approvalResponse.json() as { approval: { id: string } };

    // Operator issues a mandate? No — that's admin authority.
    const operatorMandate = await app.inject({
      method: 'POST',
      url: '/api/mandates',
      headers: { cookie: operator.cookie, 'x-csrf-token': operator.csrfToken },
      payload: {
        missionId: world.mission.id,
        currency: 'USD',
        maxAmountMinor: 500_000,
        permittedOperationKinds: ['airwallex_transfer'],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(operatorMandate.statusCode).toBe(403);

    // Operator reserves using the approval.
    const reserveResponse = await app.inject({
      method: 'POST',
      url: '/api/operations/reserve',
      headers: { cookie: operator.cookie, 'x-csrf-token': operator.csrfToken },
      payload: {
        missionId: world.mission.id,
        kind: 'airwallex_transfer',
        requestId: 'http-reserve-1',
        planId: plan.id,
        planVersion: plan.version,
        approvalId: approval.id,
      },
    });
    expect(reserveResponse.statusCode).toBe(200);
    const { operation } = reserveResponse.json() as { operation: { id: string; state: string } };
    expect(operation.state).toBe('RESERVED');

    // Cross-tenant read is 404: a second org's actor cannot see this operation.
    const other = fundWorld(ledger);
    const ambiguous = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'http-owner', password: TEST_PASSWORD, orgId: other.org.id },
    });
    expect(ambiguous.statusCode).toBe(200);
    const setCookie = ambiguous.headers['set-cookie'] as unknown;
    const otherCookie = (
      Array.isArray(setCookie) ? (setCookie[0] as string) : String(setCookie)
    ).split(';')[0]!;
    const crossRead = await app.inject({
      method: 'GET',
      url: `/api/operations/${operation.id}`,
      headers: { cookie: otherCookie },
    });
    expect(crossRead.statusCode).toBe(404);

    // Same-org viewer CAN read it.
    const okRead = await app.inject({
      method: 'GET',
      url: `/api/operations/${operation.id}`,
      headers: { cookie: viewer.cookie },
    });
    expect(okRead.statusCode).toBe(200);

    // Owner revokes the mandate → a further reserve attempt is denied 403.
    const revokeResponse = await app.inject({
      method: 'POST',
      url: `/api/mandates/${mandate.id}/revoke`,
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken },
      payload: { missionId: world.mission.id, reason: 'halt' },
    });
    expect(revokeResponse.statusCode).toBe(200);
    const plan2Response = await app.inject({
      method: 'POST',
      url: '/api/plans',
      headers: { cookie: operator.cookie, 'x-csrf-token': operator.csrfToken },
      payload: {
        missionId: world.mission.id,
        terms: { amountMinor: 10_000, currency: 'USD', beneficiary: 'acme', purpose: 'more' },
      },
    });
    const plan2 = (plan2Response.json() as { plan: { id: string; version: number } }).plan;
    const approval2Response = await app.inject({
      method: 'POST',
      url: '/api/approvals',
      headers: { cookie: approver.cookie, 'x-csrf-token': approver.csrfToken },
      payload: {
        missionId: world.mission.id,
        planId: plan2.id,
        planVersion: plan2.version,
        kind: 'airwallex_transfer',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    const approval2 = (approval2Response.json() as { approval: { id: string } }).approval;
    const denied = await app.inject({
      method: 'POST',
      url: '/api/operations/reserve',
      headers: { cookie: operator.cookie, 'x-csrf-token': operator.csrfToken },
      payload: {
        missionId: world.mission.id,
        kind: 'airwallex_transfer',
        requestId: 'http-reserve-2',
        planId: plan2.id,
        planVersion: plan2.version,
        approvalId: approval2.id,
      },
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error: { code: string } }).error.code).toBe('MANDATE_REVOKED');

    await app.close();
    ledger.close();
  });

  it('service actors cannot operate without a mission grant and never approve over HTTP', async () => {
    const { app, ledger } = makeApp({ devAuth: true });
    const world = fundWorld(ledger);
    const owner = await login(app, 'http-owner', TEST_PASSWORD);
    const service = ledger.authority.createServiceActor({
      orgId: world.org.id,
      username: 'http-service',
      displayName: 'svc',
    });

    // Operator proposes + approver approves on behalf of a test flow.
    const operator = await login(app, 'http-operator', TEST_PASSWORD);
    const approver = await login(app, 'http-approver', TEST_PASSWORD);
    const mandateResponse = await app.inject({
      method: 'POST',
      url: '/api/mandates',
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken },
      payload: {
        missionId: world.mission.id,
        currency: 'USD',
        maxAmountMinor: 500_000,
        totalBudgetMinor: 500_000,
        permittedOperationKinds: ['airwallex_transfer'],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    void mandateResponse;
    const planResponse = await app.inject({
      method: 'POST',
      url: '/api/plans',
      headers: { cookie: operator.cookie, 'x-csrf-token': operator.csrfToken },
      payload: {
        missionId: world.mission.id,
        terms: { amountMinor: 20_000, currency: 'USD', beneficiary: 'acme', purpose: 'svc-test' },
      },
    });
    const plan = (planResponse.json() as { plan: { id: string; version: number } }).plan;
    const approvalResponse = await app.inject({
      method: 'POST',
      url: '/api/approvals',
      headers: { cookie: approver.cookie, 'x-csrf-token': approver.csrfToken },
      payload: {
        missionId: world.mission.id,
        planId: plan.id,
        planVersion: plan.version,
        kind: 'airwallex_transfer',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    const approval = (approvalResponse.json() as { approval: { id: string } }).approval;

    // A service session: machine actors have no password; emulate the session
    // by creating one directly (the trusted adapter boundary) and using it.
    const session = ledger.authority.createSession(service.id);
    const svcCookie = `moterva_session=${session.token}`;

    const noGrant = await app.inject({
      method: 'POST',
      url: '/api/operations/reserve',
      headers: { cookie: svcCookie, 'x-csrf-token': session.csrfToken },
      payload: {
        missionId: world.mission.id,
        kind: 'airwallex_transfer',
        requestId: 'svc-1',
        planId: plan.id,
        planVersion: plan.version,
        approvalId: approval.id,
      },
    });
    expect(noGrant.statusCode).toBe(403);
    expect((noGrant.json() as { error: { code: string } }).error.code).toBe(
      'MISSION_GRANT_MISSING',
    );

    const approve = await app.inject({
      method: 'POST',
      url: '/api/approvals',
      headers: { cookie: svcCookie, 'x-csrf-token': session.csrfToken },
      payload: {
        missionId: world.mission.id,
        planId: plan.id,
        planVersion: plan.version,
        kind: 'airwallex_transfer',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(approve.statusCode).toBe(403);
    expect((approve.json() as { error: { reason: string } }).error.reason).toBe('ROLE_FORBIDDEN');

    // Grant the mission → the service actor may now operate within it.
    ledger.authority.grantMissionAccess({
      orgId: world.org.id,
      missionId: world.mission.id,
      actorId: service.id,
      byActorId: world.owner.id,
    });
    const withGrant = await app.inject({
      method: 'POST',
      url: '/api/operations/reserve',
      headers: { cookie: svcCookie, 'x-csrf-token': session.csrfToken },
      payload: {
        missionId: world.mission.id,
        kind: 'airwallex_transfer',
        requestId: 'svc-2',
        planId: plan.id,
        planVersion: plan.version,
        approvalId: approval.id,
      },
    });
    // svc-1 was denied before consuming the approval, so this reserve succeeds.
    expect(withGrant.statusCode).toBe(200);
    expect((withGrant.json() as { operation: { state: string } }).operation.state).toBe('RESERVED');
    await app.close();
    ledger.close();
  });
});

describe('dev bootstrap', () => {
  it('creates a demo org exactly once, only when DEMO_AUTH is enabled', async () => {
    const { app, ledger } = makeApp({ devAuth: true });
    const first = await app.inject({ method: 'POST', url: '/api/auth/dev-bootstrap' });
    expect(first.statusCode).toBe(200);
    const body = first.json() as {
      orgId: string;
      actors: Array<{ username: string; password: string }>;
    };
    expect(body.actors.map((a) => a.username).sort()).toEqual([
      'admin',
      'approver',
      'operator',
      'owner',
      'viewer',
    ]);
    // The generated password actually logs in.
    const owner = body.actors.find((a) => a.username === 'owner')!;
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'owner', password: owner.password, orgId: body.orgId },
    });
    expect(login.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/api/auth/dev-bootstrap' });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { code: string } }).error.code).toBe('ALREADY_BOOTSTRAPPED');
    await app.close();
    ledger.close();
  });

  it('the bootstrap route does not exist when DEMO_AUTH is disabled', async () => {
    const { app, ledger } = makeApp({ devAuth: false });
    const response = await app.inject({ method: 'POST', url: '/api/auth/dev-bootstrap' });
    expect(response.statusCode).toBe(404);
    await app.close();
    ledger.close();
  });
});
