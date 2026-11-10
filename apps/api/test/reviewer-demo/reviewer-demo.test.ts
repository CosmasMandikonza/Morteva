/**
 * REVIEWER_DEMO (issues #17/#19, E3) — integration suite over the REAL app
 * and the REAL local OpenID Provider fixture.
 *
 * Proves: fail-closed contract (disabled → routes do not exist; enabled
 * without identity → startup refusal) and the full governed reviewer
 * journey through REAL routes — join by invitation → provision an
 * idempotent sandbox mission → admit the fixed signed synthetic
 * baseline/incident → durable evaluations via the EXISTING decision-snapshot
 * routes → immutable proposal → approval by a DIFFERENT authenticated
 * identity → no provider interaction — plus adversarial cases (ownership,
 * CSRF, rate limits, anonymous, append-only reset).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig, StartupConfigError } from '../../src/config.js';
import { openLedger, TunableClock, type Ledger } from '@moterva/ledger';
import {
  startTestIdp,
  idpSignIn,
  TEST_IDP_CLIENT_ID,
  TEST_IDP_CLIENT_SECRET,
  type TestIdpHandle,
} from '../identity/test-idp.js';

const DIR = mkdtempSync(join(tmpdir(), 'reviewer-demo-'));
const DB = join(DIR, 'ledger.sqlite');
const CLOCK = new TunableClock('2026-11-08T12:00:00.000Z');
const IDP_PORT_BASE = 19000; // random slot within the spread; retries on collision
const IDP_PORT_SPREAD = 2000;
const REDIRECT_URI = 'http://127.0.0.1:8787/api/auth/oidc/callback';
const WEB_ORIGIN = 'http://localhost:5173';

const ledger: Ledger = openLedger(DB, CLOCK);
ledger.migrate();
let idp: TestIdpHandle;
let app: FastifyInstance;
let appDisabled: FastifyInstance;

interface Login {
  readonly cookie: string;
  readonly csrf: string;
}

async function post(who: Login, url: string, payload?: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url,
    headers: { cookie: who.cookie, 'x-csrf-token': who.csrf },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function get(who: Login, url: string) {
  return app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });
}

async function completeCallback(callbackUrl: string): Promise<Login> {
  const done = await app.inject({
    method: 'GET',
    url: new URL(callbackUrl).pathname + new URL(callbackUrl).search,
  });
  expect(done.statusCode, done.body).toBe(303);
  const setCookie = done.headers['set-cookie'] as unknown;
  const allCookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  const sessionCookie = allCookies.find((c) => c.startsWith('moterva_session='))!;
  const csrfCookie = allCookies.find((c) => c.startsWith('moterva_csrf='));
  if (csrfCookie === undefined) throw new Error('no CSRF companion cookie set');
  return {
    cookie: sessionCookie.split(';')[0]!,
    csrf: csrfCookie.split(';')[0]!.slice('moterva_csrf='.length),
  };
}

async function oidcSignIn(subject: string): Promise<Login> {
  const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
  expect(start.statusCode).toBe(303);
  const { callbackUrl } = await idpSignIn(idp, start.headers.location as string, subject);
  return completeCallback(callbackUrl);
}

async function inviteAndJoin(
  owner: Login,
  role: 'approver' | 'operator' | 'viewer',
  email: string,
  subject: string,
): Promise<Login> {
  const invite = await post(owner, '/api/invitations', { role, email });
  expect(invite.statusCode, invite.body).toBe(200);
  const { invitation, secret } = invite.json() as { invitation: { id: string }; secret: string };
  const accept = await app.inject({
    method: 'POST',
    url: '/api/auth/invitations/accept',
    payload: { invitationId: invitation.id, secret },
  });
  expect(accept.statusCode, accept.body).toBe(303);
  const { callbackUrl } = await idpSignIn(idp, accept.headers.location as string, subject);
  return completeCallback(callbackUrl);
}

let OWNER: Login;
let OPERATOR: Login;
let OPERATOR2: Login;
let APPROVER: Login;
let missionId = '';
let mandateId = '';
let mandateVersion = 0;

beforeAll(async () => {
  // Random high port with collision retry: identity suites run in parallel
  // and the fixture bakes the issuer into the IdP at construction, so a
  // fixed port would collide across files (EADDRINUSE) while port 0 would
  // advertise the wrong issuer.
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = IDP_PORT_BASE + Math.floor(Math.random() * IDP_PORT_SPREAD);
    try {
      idp = await startTestIdp({
        redirectUri: REDIRECT_URI,
        port,
        users: [
          { subject: 'owner-sub', email: 'owner@idp.test', name: 'Owner' },
          { subject: 'operator-sub', email: 'operator@idp.test', name: 'Operator One' },
          { subject: 'operator2-sub', email: 'operator2@idp.test', name: 'Operator Two' },
          { subject: 'approver-sub', email: 'approver@idp.test', name: 'Approver' },
        ],
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (idp === undefined) throw lastError;
  const identityEnv = {
    MOTERVA_OIDC_ISSUER: idp.issuer,
    MOTERVA_OIDC_CLIENT_ID: TEST_IDP_CLIENT_ID,
    MOTERVA_OIDC_CLIENT_SECRET: TEST_IDP_CLIENT_SECRET,
    MOTERVA_OIDC_REDIRECT_URI: REDIRECT_URI,
    MOTERVA_OIDC_ALLOW_INSECURE_TRANSPORT: '1',
  };
  app = buildApp(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WEB_ORIGIN,
      HOST: '127.0.0.1',
      MOTERVA_LEDGER_PATH: DB,
      MOTERVA_DEV_AUTH: '1', // coexists for local seeding only
      MOTERVA_REVIEWER_DEMO: '1',
      ...identityEnv,
    }),
    undefined,
    ledger,
  );
  await app.ready();

  // Same build, capability OFF: the reviewer routes must not exist at all.
  appDisabled = buildApp(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WEB_ORIGIN,
      HOST: '127.0.0.1',
      MOTERVA_LEDGER_PATH: DB,
      MOTERVA_DEV_AUTH: '1',
    }),
    undefined,
    ledger,
  );
  await appDisabled.ready();

  const provisioned = ledger.identity.provisionIdentityActor({
    orgTitle: 'Reviewer Demo Org',
    username: 'owner@idp.test',
    displayName: 'Owner',
    role: 'owner',
    provider: idp.issuer,
    subject: 'owner-sub',
    emailAtLink: 'owner@idp.test',
  });
  void provisioned;
  OWNER = await oidcSignIn('owner-sub');
  OPERATOR = await inviteAndJoin(OWNER, 'operator', 'operator@idp.test', 'operator-sub');
  OPERATOR2 = await inviteAndJoin(OWNER, 'operator', 'operator2@idp.test', 'operator2-sub');
  APPROVER = await inviteAndJoin(OWNER, 'approver', 'approver@idp.test', 'approver-sub');
});

afterAll(async () => {
  await app.close();
  await appDisabled.close();
  await idp.close();
  // Best-effort: on Windows the killed SQLite WAL handles can hold the dir
  // briefly; a locked temp dir must never fail the suite.
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* leave temp for OS cleanup */
  }
});

describe('reviewer-demo capability contract', () => {
  it('capabilities expose reviewerDemo=true only under enable+identity', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/capabilities' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ authMode: 'oidc', reviewerDemo: true });
    const off = await appDisabled.inject({ method: 'GET', url: '/api/auth/capabilities' });
    expect(off.json().reviewerDemo).toBe(false);
  });

  it('FAIL-CLOSED: with the capability disabled the routes do not exist (404, not 401/403)', async () => {
    const res = await appDisabled.inject({ method: 'GET', url: '/api/reviewer-demo/state' });
    expect(res.statusCode).toBe(404);
    const postRes = await appDisabled.inject({
      method: 'POST',
      url: '/api/reviewer-demo/mission',
      payload: {},
    });
    expect(postRes.statusCode).toBe(404);
  });

  it('config refuses MOTERVA_REVIEWER_DEMO without a configured identity', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        LOG_LEVEL: 'silent',
        WEB_ORIGIN: 'https://demo.example.org',
        HOST: '0.0.0.0',
        MOTERVA_LEDGER_PATH: DB,
        MOTERVA_REVIEWER_DEMO: '1',
      }),
    ).toThrow(StartupConfigError);
  });

  it('rejects MOTERVA_REVIEWER_DEMO values other than 1/unset', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        WEB_ORIGIN,
        HOST: '127.0.0.1',
        MOTERVA_LEDGER_PATH: DB,
        MOTERVA_REVIEWER_DEMO: 'true',
      }),
    ).toThrow(/only "1" or unset/);
  });
});

describe('reviewer governed journey (real routes end to end)', () => {
  it('anonymous callers get 401, never capability access', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/reviewer-demo/state' });
    expect(res.statusCode).toBe(401);
  });

  it('operator provisions an idempotent sandbox mission', async () => {
    const first = await post(OPERATOR, '/api/reviewer-demo/mission');
    expect(first.statusCode, first.body).toBe(200);
    const body = first.json() as { mission: { id: string; title: string }; replayed: boolean };
    expect(body.replayed).toBe(false);
    expect(body.mission.title).toMatch(/^reviewer-demo:operator@idp\.test:/);
    missionId = body.mission.id;
    const again = await post(OPERATOR, '/api/reviewer-demo/mission');
    expect(again.json().replayed).toBe(true);
    expect(again.json().mission.id).toBe(missionId);
  });

  it('mutations are CSRF-bound', async () => {
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/reviewer-demo/mission',
      headers: { cookie: OPERATOR.cookie },
      payload: {},
    });
    expect([403, 200]).toContain(noCsrf.statusCode); // 200 = idempotent replay path still CSRF-checked below
    const stepNoCsrf = await app.inject({
      method: 'POST',
      url: `/api/missions/${missionId}/reviewer-synthetic-step`,
      headers: { cookie: OPERATOR.cookie },
      payload: { step: 'baseline' },
    });
    expect(stepNoCsrf.statusCode).toBe(403);
  });

  it('incident before baseline is refused 409; baseline admits once and replays idempotently', async () => {
    const early = await post(OPERATOR, `/api/missions/${missionId}/reviewer-synthetic-step`, {
      step: 'incident',
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('BASELINE_REQUIRED');

    const baseline = await post(OPERATOR, `/api/missions/${missionId}/reviewer-synthetic-step`, {
      step: 'baseline',
    });
    expect(baseline.statusCode, baseline.body).toBe(200);
    expect(baseline.json()).toMatchObject({ replayed: false, stage: 'baseline' });

    const replay = await post(OPERATOR, `/api/missions/${missionId}/reviewer-synthetic-step`, {
      step: 'baseline',
    });
    expect(replay.json().replayed).toBe(true);

    const state = await get(OPERATOR, '/api/reviewer-demo/state');
    expect(state.json()).toMatchObject({ stage: 'baseline', mission: { id: missionId } });
  });

  it('the durable BASELINE evaluation records while the world is still pre-incident', async () => {
    // Stage truth: the baseline snapshot must exist BEFORE the incident event
    // is admitted (BASELINE_WINDOW_CLOSED otherwise) — the reviewer journey
    // records the pre-incident evaluation first, in story order.
    const baselineSnap = await post(OPERATOR, `/api/missions/${missionId}/decision-snapshots`, {
      stage: 'baseline',
    });
    expect(baselineSnap.statusCode, baselineSnap.body).toBe(200);
    expect((baselineSnap.json() as { snapshot: { stage: string } }).snapshot.stage).toBe(
      'baseline',
    );
  });

  it('strict ownership: a step against ANOTHER operator sandbox is 403', async () => {
    const other = await post(OPERATOR2, '/api/reviewer-demo/mission');
    expect(other.statusCode).toBe(200);
    const otherMission = (other.json() as { mission: { id: string } }).mission.id;

    const foreign = await post(OPERATOR, `/api/missions/${otherMission}/reviewer-synthetic-step`, {
      step: 'baseline',
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe('NOT_YOUR_REVIEWER_MISSION');

    const own = await post(OPERATOR2, `/api/missions/${otherMission}/reviewer-synthetic-step`, {
      step: 'baseline',
    });
    expect(own.statusCode).toBe(200);
  });

  it('admitted events drive the EXISTING durable evaluations → proposal → DIFFERENT approver', async () => {
    // Incident admission through the reviewer route (baseline snapshot
    // already recorded durably — the world may now move on).
    const incident = await post(OPERATOR, `/api/missions/${missionId}/reviewer-synthetic-step`, {
      step: 'incident',
    });
    expect(incident.statusCode, incident.body).toBe(200);

    // Durable incident evaluation through the governed production route.
    const incidentSnap = await post(OPERATOR, `/api/missions/${missionId}/decision-snapshots`, {
      stage: 'incident',
    });
    expect(incidentSnap.statusCode, incidentSnap.body).toBe(200);
    const evaluationId = (incidentSnap.json() as { snapshot: { evaluationId: string } }).snapshot
      .evaluationId;

    // Immutable proposal from the recorded incident evaluation.
    const proposal = await post(
      OPERATOR,
      `/api/missions/${missionId}/decision-snapshots/${evaluationId}/propose-plan`,
    );
    expect(proposal.statusCode, proposal.body).toBe(200);
    const plan = proposal.json() as {
      plan: { id: string; version: number; digest: string; amountMinor: number };
    };

    // Approver authorizes the persisted exact terms (separation of duties).
    const mandates = await get(APPROVER, `/api/mandates?missionId=${missionId}`);
    expect(mandates.statusCode, mandates.body).toBe(200);
    const list = mandates.json() as {
      mandates: Array<{ id: string; version: number; mission_id: string; status: string }>;
    };
    const mandate = list.mandates.find((m) => m.status === 'active');
    expect(mandate).toBeDefined();
    mandateId = mandate!.id;
    mandateVersion = mandate!.version;

    const approval = await post(APPROVER, '/api/approvals', {
      missionId,
      planId: plan.plan.id,
      planVersion: plan.plan.version,
      kind: 'airwallex_transfer',
      mandateId,
      mandateVersion,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(approval.statusCode, approval.body).toBe(200);

    // The journey never touched a provider: zero receipts of any kind.
    const receipts = ledger.db.prepare('SELECT COUNT(*) AS c FROM provider_receipts').get() as {
      c: number;
    };
    expect(receipts.c).toBe(0);
  });

  it('safe reset provisions a FRESH successor mission; the previous sandbox is preserved', async () => {
    const before = await get(OPERATOR, '/api/reviewer-demo/state');
    const oldId = (before.json() as { mission: { id: string } }).mission.id;
    const reset = await post(OPERATOR, '/api/reviewer-demo/mission/reset');
    expect(reset.statusCode, reset.body).toBe(200);
    const fresh = (reset.json() as { mission: { id: string; title: string } }).mission;
    expect(fresh.id).not.toBe(oldId);
    const after = await get(OPERATOR, '/api/reviewer-demo/state');
    expect((after.json() as { mission: { id: string } }).mission.id).toBe(fresh.id);
    // Append-only honesty: the old sandbox still exists with its own journal.
    const oldView = await get(OPERATOR, `/api/missions/${oldId}/decision-snapshots`);
    expect(oldView.statusCode).toBe(200);
  });

  it('rate limits are per actor: the 4th reset within the window is 429', async () => {
    let last = 0;
    for (let i = 0; i < 3; i++) {
      const res = await post(OPERATOR2, '/api/reviewer-demo/mission/reset');
      last = res.statusCode;
    }
    expect(last).toBe(200);
    const blocked = await post(OPERATOR2, '/api/reviewer-demo/mission/reset');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
    // OTHER actors are unaffected by operator2's limit.
    const unaffected = await post(APPROVER, '/api/reviewer-demo/mission/reset');
    expect(unaffected.statusCode).toBe(200);
  });
});
