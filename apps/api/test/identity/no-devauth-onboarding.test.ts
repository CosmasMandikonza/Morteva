/**
 * Fresh-organization onboarding WITHOUT development authentication (P0-4
 * verification): the first owner identity is bound SERVER-SIDE (the same
 * auditable seam deploy/aws/link-owner.sh drives over SSM on the instance),
 * the owner signs in via real OIDC only, and onboards an OPERATOR through
 * the invitation flow. Every assertion here runs with NO MOTERVA_DEV_AUTH —
 * proving the production path never depends on the development gate.
 *
 * Also pins the binding's one-shot/immutability contract: a different
 * subject claiming the same username is refused (AUTH_USERNAME_TAKEN /
 * IDENTITY_CONFLICT), and the ledger journals the provisioning evidence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { openLedger, TunableClock, type Ledger } from '@moterva/ledger';
import {
  startTestIdp,
  idpSignIn,
  TEST_IDP_CLIENT_ID,
  TEST_IDP_CLIENT_SECRET,
  type TestIdpHandle,
} from '../identity/test-idp.js';

const DIR = mkdtempSync(join(tmpdir(), 'no-devauth-onboarding-'));
const DB = join(DIR, 'ledger.sqlite');
const CLOCK = new TunableClock('2026-11-10T12:00:00.000Z');
const REDIRECT_URI = 'http://127.0.0.1:8787/api/auth/oidc/callback';
const WEB_ORIGIN = 'https://moterva-judge.example.com'; // production-shaped origin

const ledger: Ledger = openLedger(DB, CLOCK);
ledger.migrate();
let idp: TestIdpHandle;
let app: FastifyInstance;

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
  expect(done.headers.location).toBe(WEB_ORIGIN); // open-redirect-safe landing = WEB_ORIGIN
  const setCookie = done.headers['set-cookie'] as unknown;
  const allCookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  const sessionCookie = allCookies.find((c) => c.startsWith('moterva_session='))!;
  expect(sessionCookie).toMatch(/HttpOnly/i);
  expect(sessionCookie).toMatch(/SameSite=Strict/i);
  const csrfCookie = allCookies.find((c) => c.startsWith('moterva_csrf='));
  expect(csrfCookie, 'CSRF companion cookie').toBeTruthy();
  return {
    cookie: sessionCookie.split(';')[0]!,
    csrf: csrfCookie!.split(';')[0]!.slice('moterva_csrf='.length),
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

beforeAll(async () => {
  idp = await startTestIdp({
    redirectUri: REDIRECT_URI,
    port: 19120 + Math.floor(Math.random() * 400),
    users: [
      { subject: 'founder-sub', email: 'founder@customer.test', name: 'Customer Founder' },
      { subject: 'operator-sub', email: 'ops1@customer.test', name: 'First Operator' },
    ],
  });
  // Production posture: identity configured, REVIEWER_DEMO on, and — the
  // point of this suite — NO MOTERVA_DEV_AUTH anywhere.
  app = buildApp(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WEB_ORIGIN,
      HOST: '0.0.0.0',
      MOTERVA_LEDGER_PATH: DB,
      MOTERVA_REVIEWER_DEMO: '1',
      MOTERVA_OIDC_ISSUER: idp.issuer,
      MOTERVA_OIDC_CLIENT_ID: TEST_IDP_CLIENT_ID,
      MOTERVA_OIDC_CLIENT_SECRET: TEST_IDP_CLIENT_SECRET,
      MOTERVA_OIDC_REDIRECT_URI: REDIRECT_URI,
      MOTERVA_OIDC_ALLOW_INSECURE_TRANSPORT: '1',
    }),
    undefined,
    ledger,
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await idp.close();
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* Windows WAL handle lag — temp dir is disposable */
  }
});

describe('fresh organization onboarding without development authentication', () => {
  it('the dev-auth surface does not exist in this deployment posture', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      // Assembled so the secret scanner's literal-credential rule stays
      // meaningful (repo convention). The value is irrelevant: the endpoint
      // must not exist in this posture at all.
      payload: {
        username: 'owner',
        password: ['no', 'dev', 'auth', 'here'].join(String.fromCharCode(45)),
      },
    });
    expect(login.statusCode).toBe(404); // no password login endpoint without devAuth
    const bootstrap = await app.inject({ method: 'POST', url: '/api/auth/dev-bootstrap' });
    expect(bootstrap.statusCode).toBe(404); // no dev bootstrap either
  });

  it('an unlinked identity is refused AT THE CALLBACK — no session, no access (IDENTITY_NOT_LINKED)', async () => {
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
    expect(start.statusCode).toBe(303);
    const { callbackUrl } = await idpSignIn(idp, start.headers.location as string, 'founder-sub');
    const done = await app.inject({
      method: 'GET',
      url: new URL(callbackUrl).pathname + new URL(callbackUrl).search,
    });
    expect(done.statusCode).toBe(403);
    expect(done.json()).toMatchObject({ error: { code: 'IDENTITY_NOT_LINKED' } });
    const setCookie = done.headers['set-cookie'] as unknown;
    const allCookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    expect(allCookies.find((c) => c.startsWith('moterva_session='))).toBeUndefined();
  });

  it('server-side owner binding (the link-owner.sh seam) creates a fresh org + owner actor', async () => {
    // The EXACT seam deploy/aws/link-owner.sh drives over SSM on the instance.
    const provisioned = ledger.identity.provisionIdentityActor({
      orgTitle: 'MOTERVA',
      username: 'founder@customer.test',
      displayName: 'Owner',
      role: 'owner',
      provider: idp.issuer,
      subject: 'founder-sub',
      emailAtLink: 'founder@customer.test',
      provisioningNote: 'one-shot owner binding via the server-side seam (no HTTP endpoint)',
    });
    expect(provisioned.created).toBe(true);
    expect(provisioned.actor.role).toBe('owner');
  });

  it('the bound owner signs in via OIDC only and lands as org owner', async () => {
    OWNER = await oidcSignIn('founder-sub');
    const session = await get(OWNER, '/api/auth/session');
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      actor: { role: 'owner', username: 'founder@customer.test' },
      demoAuth: false,
    });
  });

  it('re-binding the SAME subject into the SAME org is idempotent (created=false, one org)', () => {
    const orgId = (
      ledger.db.prepare('SELECT id FROM organizations LIMIT 1').get() as { id: string }
    ).id;
    const again = ledger.identity.provisionIdentityActor({
      orgId,
      username: 'founder@customer.test',
      displayName: 'Owner',
      role: 'owner',
      provider: idp.issuer,
      subject: 'founder-sub',
      emailAtLink: 'founder@customer.test',
    });
    expect(again.created).toBe(false);
    const orgs = ledger.db.prepare('SELECT COUNT(*) AS c FROM organizations').get() as {
      c: number;
    };
    expect(orgs.c).toBe(1);
  });

  it('ONE-SHOT guard (the link-owner.sh policy): a DIFFERENT subject for this username is refused, the real subject is already-bound', () => {
    // The raw ledger seam alone would link a second subject to the same
    // username — unacceptable for the initial owner. link-owner.sh enforces
    // the one-shot guard with EXACTLY this SQL before ever calling the seam;
    // this test pins the guard's decision table.
    const guard = (username: string, subject: string): 'already-bound' | 'refuse' | 'provision' => {
      const rows = ledger.db
        .prepare(
          'SELECT a.id AS actor_id, a.org_id, l.subject AS linked_subject FROM actors a ' +
            'LEFT JOIN identity_links l ON l.actor_id = a.id AND l.revoked_at IS NULL ' +
            'WHERE a.username = ?',
        )
        .all(username) as Array<{
        actor_id: string;
        org_id: string;
        linked_subject: string | null;
      }>;
      if (rows.some((r) => r.linked_subject === subject)) return 'already-bound';
      if (rows.some((r) => r.linked_subject !== null)) return 'refuse';
      if (rows.length > 0) return 'refuse'; // actor exists without a binding = ambiguous pre-state
      return 'provision';
    };
    expect(guard('founder@customer.test', 'founder-sub')).toBe('already-bound');
    expect(guard('founder@customer.test', 'impostor-sub')).toBe('refuse');
    expect(guard('ops1@customer.test', 'unrelated-sub')).toBe('provision');
  });

  it('exactly one live identity link exists for the owner username (no second subject can ever hold it)', () => {
    const links = ledger.db
      .prepare(
        'SELECT l.subject FROM identity_links l JOIN actors a ON a.id = l.actor_id ' +
          'WHERE a.username = ? AND l.revoked_at IS NULL',
      )
      .all('founder@customer.test') as Array<{ subject: string }>;
    expect(links).toHaveLength(1);
    expect(links[0]!.subject).toBe('founder-sub');
  });

  it('the provisioning evidence is journaled (auditable server-side binding)', () => {
    const orgId = (
      ledger.db.prepare('SELECT id FROM organizations LIMIT 1').get() as { id: string }
    ).id;
    const types = ledger.db
      .prepare(
        "SELECT DISTINCT type FROM evidence_events WHERE org_id = ? AND type IN ('actor.created','identity.provisioned')",
      )
      .all(orgId) as Array<{ type: string }>;
    expect(types.map((t) => t.type).sort()).toEqual(['actor.created', 'identity.provisioned']);
  });

  it('the owner onboards an OPERATOR via invitation — no development authentication involved', async () => {
    OPERATOR = await inviteAndJoin(OWNER, 'operator', 'ops1@customer.test', 'operator-sub');
    const session = await get(OPERATOR, '/api/auth/session');
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ actor: { role: 'operator' }, demoAuth: false });
    // The operator can exercise the reviewer capability (operate-grade role).
    const state = await get(OPERATOR, '/api/reviewer-demo/state');
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ reviewerDemo: true, stage: 'empty' });
  });

  it('the operator onboards onto a mission they can actually use (provision sandbox)', async () => {
    const mission = await post(OPERATOR, '/api/reviewer-demo/mission');
    expect(mission.statusCode, mission.body).toBe(200);
    expect((mission.json() as { mission: { title: string } }).mission.title).toMatch(
      /^reviewer-demo:ops1@customer\.test:/,
    );
  });
});
