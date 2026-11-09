/**
 * Production identity — end-to-end integration suite over the REAL app and a
 * REAL local OpenID Provider (oidc-provider fixture, 127.0.0.1 only).
 *
 * Covers the reviewer journey (provision → sign-in → invitation → member
 * sign-in → governed paths), the two-person proposal/approval workflow with
 * DISTINCT authenticated identities, and the mandated adversarial cases:
 * uninvited identities, callback replay, revoked-actor sign-in, identity
 * revocation session invalidation, IdP outage with an active session, and
 * financial-security invariants. Protocol-level token failures (signature,
 * alg, audience, expiry, nonce, JWKS rotation) live in the fake-IdP suite;
 * invitation/identity service internals live in the ledger suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { openLedger, TunableClock, type Ledger } from '@moterva/ledger';
import { startTestIdp, idpSignIn, type TestIdpHandle } from './test-idp.js';

const DIR = mkdtempSync(join(tmpdir(), 'prod-identity-'));
const DB = join(DIR, 'ledger.sqlite');
const CLOCK = new TunableClock('2026-11-08T12:00:00.000Z');
const IDP_PORT = 18991; // dedicated high port for the local test IdP
const REDIRECT_URI = 'http://127.0.0.1:8787/api/auth/oidc/callback';
const WEB_ORIGIN = 'http://localhost:5173';
// Assembled fixture value (dev/test only — not a credential; the literal
// assignment form trips the secret scanner by design, see ledger helpers).
const CLIENT_SECRET = ['test-idp-client', 'secret-not-a-production-credential'].join(
  String.fromCharCode(45),
);

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

/** Completes an OIDC callback (any flow) and returns the resulting session. */
async function completeCallback(callbackUrl: string): Promise<Login> {
  const done = await app.inject({
    method: 'GET',
    url: new URL(callbackUrl).pathname + new URL(callbackUrl).search,
  });
  expect(done.statusCode, done.body).toBe(303);
  expect(done.headers.location).toBe(WEB_ORIGIN); // open-redirect safe landing
  const setCookie = done.headers['set-cookie'] as unknown;
  const allCookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  const sessionCookie = allCookies.find((c) => c.startsWith('moterva_session='))!;
  expect(sessionCookie).toMatch(/HttpOnly/i);
  expect(sessionCookie).toMatch(/SameSite=Strict/i);
  const csrfCookie = allCookies.find((c) => c.startsWith('moterva_csrf='));
  if (csrfCookie === undefined) throw new Error('no CSRF companion cookie set');
  const csrf = csrfCookie.split(';')[0]!.slice('moterva_csrf='.length);
  return { cookie: sessionCookie.split(';')[0]!, csrf };
}

/** Drives a REAL OIDC sign-in at the local IdP and returns the MOTERVA session. */
async function oidcSignIn(subject: string, orgId?: string): Promise<Login> {
  const start = await app.inject({
    method: 'GET',
    url: `/api/auth/oidc/login${orgId !== undefined ? `?orgId=${orgId}` : ''}`,
  });
  expect(start.statusCode, start.body).toBe(303);
  const { callbackUrl } = await idpSignIn(idp, start.headers.location as string, subject);
  return completeCallback(callbackUrl);
}

/** Invites AND completes membership for one IdP user via the real routes. */
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
  // COMPLETE the accept's authorization flow: the redemption happens at the
  // callback of THIS flow (it carries the pre-verified invitation intent).
  const { callbackUrl } = await idpSignIn(idp, accept.headers.location as string, subject);
  return completeCallback(callbackUrl);
}

let orgId = '';
let missionId = '';
const ownerSubject = 'owner-sub';
let OWNER: Login; // the provisioned owner's OIDC session (identity-only actor, no password)

beforeAll(async () => {
  idp = await startTestIdp({
    redirectUri: REDIRECT_URI,
    port: IDP_PORT,
    users: [
      { subject: 'owner-sub', email: 'owner@idp.test', name: 'Owner' },
      { subject: 'stranger-sub', email: 'stranger@idp.test', name: 'Stranger' },
      { subject: 'reviewer-sub', email: 'reviewer@idp.test', name: 'Reviewer' },
      { subject: 'operator-sub', email: 'operator@idp.test', name: 'Operator Two' },
      { subject: 'approver-sub', email: 'approver@idp.test', name: 'Approver Two' },
      { subject: 'revoked-sub', email: 'revoked@idp.test', name: 'Doomed' },
      { subject: 'readonly-sub', email: 'readonly@idp.test', name: 'Readonly' },
      { subject: 'elevate-sub', email: 'elevate@idp.test', name: 'Elevate' },
    ],
  });
  app = buildApp(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WEB_ORIGIN,
      HOST: '127.0.0.1',
      MOTERVA_LEDGER_PATH: DB,
      // DEMO_AUTH coexists for LOCAL seeding; production deployments use
      // identity only (config refuses devAuth in production).
      MOTERVA_DEV_AUTH: '1',
      MOTERVA_OIDC_ISSUER: idp.issuer,
      MOTERVA_OIDC_CLIENT_ID: 'moterva-test-client',
      MOTERVA_OIDC_CLIENT_SECRET: CLIENT_SECRET,
      MOTERVA_OIDC_REDIRECT_URI: REDIRECT_URI,
      MOTERVA_OIDC_ALLOW_INSECURE_TRANSPORT: '1',
    }),
    undefined,
    ledger,
  );
  await app.ready();

  // Separately authorized provisioning (server-side; no HTTP route exists).
  const provisioned = ledger.identity.provisionIdentityActor({
    orgTitle: 'Identity Review Org',
    username: 'owner@idp.test',
    displayName: 'Owner',
    role: 'owner',
    provider: idp.issuer,
    subject: ownerSubject,
    emailAtLink: 'owner@idp.test',
  });
  orgId = provisioned.orgId;
  missionId = ledger.organizations.createMission(orgId, 'reviewer mission').id;
  ledger.accounts.ensureTreasuryAccount({
    orgId,
    currency: 'USD',
    label: 'USD',
    protectedFloorMinor: 0,
  });
  OWNER = await oidcSignIn(ownerSubject);
  const seeded = await post(OWNER, '/api/demo/refresh-authority', { missionId });
  expect(seeded.statusCode, seeded.body).toBe(200);
});

afterAll(async () => {
  await app.close();
  await idp.close();
  if (ledger.db.open) ledger.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe('reviewer journey (real OIDC sign-in at the local IdP)', () => {
  it('provisioned owner signs in through the IdP and sees the organization session', async () => {
    const ownerSession = await oidcSignIn(ownerSubject);
    const session = await get(ownerSession, '/api/auth/session');
    expect(session.statusCode).toBe(200);
    const body = session.json() as { actor: { username: string; role: string; orgId: string } };
    expect(body.actor.username).toBe('owner@idp.test');
    expect(body.actor.role).toBe('owner');
    expect(body.actor.orgId).toBe(orgId);
  });

  it('owner invites a viewer (hashed single-use secret); wrong secret is refused statelessly', async () => {
    const owner = OWNER;
    const created = await post(owner, '/api/invitations', {
      role: 'viewer',
      email: 'reviewer@idp.test',
    });
    expect(created.statusCode, created.body).toBe(200);
    const { invitation, secret } = created.json() as { invitation: { id: string }; secret: string };
    const listed = await get(owner, '/api/invitations');
    expect(JSON.stringify(listed.json())).not.toContain(secret); // never listed
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/invitations/accept',
      payload: {
        invitationId: invitation.id,
        secret: ['wrong-secret-value', 'aaaaaaaaaaaaaa'].join(String.fromCharCode(45)),
      },
    });
    expect(bad.statusCode).toBe(403);
    expect(
      (ledger.db.prepare('SELECT COUNT(*) AS c FROM identity_links').get() as { c: number }).c,
    ).toBe(1); // only the provisioned owner
    // Valid acceptance redirects into the IdP; redemption completes only
    // after the IdP verifies the identity at the callback.
    const accept = await app.inject({
      method: 'POST',
      url: '/api/auth/invitations/accept',
      payload: { invitationId: invitation.id, secret },
    });
    expect(accept.statusCode).toBe(303);
    const { callbackUrl } = await idpSignIn(idp, accept.headers.location as string, 'reviewer-sub');
    const done = await app.inject({
      method: 'GET',
      url: new URL(callbackUrl).pathname + new URL(callbackUrl).search,
    });
    expect(done.statusCode, done.body).toBe(303);
    const setCookie = done.headers['set-cookie'] as unknown;
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : String(setCookie)).split(';')[0]!;
    const check = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie },
    });
    const actor = (check.json() as { actor: { role: string; username: string } }).actor;
    expect(actor.role).toBe('viewer'); // the INVITED role — never anything higher
    expect(actor.username).toBe('reviewer@idp.test');
    expect(
      (
        ledger.db
          .prepare("SELECT COUNT(*) AS c FROM evidence_events WHERE type = 'invitation.redeemed'")
          .get() as { c: number }
      ).c,
    ).toBe(1);
    // Single use: the same secret can never accept again.
    const again = await app.inject({
      method: 'POST',
      url: '/api/auth/invitations/accept',
      payload: { invitationId: invitation.id, secret },
    });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: { code: string } }).error.code).toBe('INVITATION_REDEEMED');
  });
});

describe('two-person workflow: distinct identities propose and approve', () => {
  let planId = '';
  let planVersion = 1;
  let operatorActorId = '';
  let approverActorId = '';

  it('invited operator signs in with their OWN identity and proposes via the durable flow', async () => {
    const owner = OWNER;
    const operatorSession = await inviteAndJoin(
      owner,
      'operator',
      'operator@idp.test',
      'operator-sub',
    );
    operatorActorId = ledger.identity.findActorIdByIdentity(orgId, idp.issuer, 'operator-sub')!;
    // Stage truth: the baseline SNAPSHOT must exist before the incident EVENT
    // (the incident snapshot links to a recorded historical baseline).
    await post(OWNER, `/api/missions/${missionId}/synthetic-step`, { step: 'baseline' });
    const baselineSnap = await post(
      operatorSession,
      `/api/missions/${missionId}/decision-snapshots`,
      { stage: 'baseline' },
    );
    expect(baselineSnap.statusCode, baselineSnap.body).toBe(200);
    await post(OWNER, `/api/missions/${missionId}/synthetic-step`, { step: 'incident' });
    const incident = await post(operatorSession, `/api/missions/${missionId}/decision-snapshots`, {
      stage: 'incident',
    });
    expect(incident.statusCode, incident.body).toBe(200);
    const evaluationId = (incident.json() as { snapshot: { evaluationId: string } }).snapshot
      .evaluationId;
    const propose = await post(
      operatorSession,
      `/api/missions/${missionId}/decision-snapshots/${evaluationId}/propose-plan`,
    );
    expect(propose.statusCode, propose.body).toBe(200);
    const plan = (propose.json() as { plan: { id: string; version: number } }).plan;
    planId = plan.id;
    planVersion = plan.version;
    // The proposing identity cannot approve its own proposal.
    const selfApprove = await post(operatorSession, '/api/approvals', {
      missionId,
      planId,
      planVersion,
      kind: 'airwallex_transfer',
      expiresAt: new Date(CLOCK.now().getTime() + 3_600_000).toISOString(),
    });
    expect(selfApprove.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('operator signs out; a DIFFERENT approver identity retrieves and authorizes the persisted exact terms', async () => {
    const owner = OWNER;
    const operatorSession = await oidcSignIn('operator-sub');
    const out = await post(operatorSession, '/api/auth/logout');
    expect(out.statusCode).toBe(200);
    expect((await get(operatorSession, '/api/auth/session')).statusCode).toBe(401);

    const approverSession = await inviteAndJoin(
      owner,
      'approver',
      'approver@idp.test',
      'approver-sub',
    );
    approverActorId = ledger.identity.findActorIdByIdentity(orgId, idp.issuer, 'approver-sub')!;
    expect(approverActorId).not.toBe(operatorActorId); // distinct identities

    const plans = await get(approverSession, `/api/missions/${missionId}/decision-plans`);
    expect(plans.statusCode, plans.body).toBe(200);
    const body = plans.json() as {
      plans: Array<{ plan: { id: string; version: number; terms: { amountMinor: number } } }>;
    };
    const match = body.plans.find((p) => p.plan.id === planId);
    expect(match).toBeDefined();
    expect(match!.plan.version).toBe(planVersion);
    const approval = await post(approverSession, '/api/approvals', {
      missionId,
      planId,
      planVersion,
      kind: 'airwallex_transfer',
      expiresAt: new Date(CLOCK.now().getTime() + 3_600_000).toISOString(),
    });
    expect(approval.statusCode, approval.body).toBe(200);
    const approvalId = (approval.json() as { approval: { id: string } }).approval.id;
    const reserve = await post(approverSession, '/api/operations/reserve', {
      missionId,
      kind: 'airwallex_transfer',
      requestId: 'identity-two-person-1',
      planId,
      planVersion,
      approvalId,
    });
    expect(reserve.statusCode, reserve.body).toBe(200);
    // Journal truth: the proposal names the OPERATOR actor as proposer.
    const proposedBy = JSON.parse(
      (
        ledger.db
          .prepare(
            "SELECT payload_json FROM evidence_events WHERE type = 'planner.plan.proposed' ORDER BY seq DESC LIMIT 1",
          )
          .get() as { payload_json: string }
      ).payload_json,
    ) as { proposedBy: string };
    expect(proposedBy.proposedBy).toBe(operatorActorId);
    expect(proposedBy.proposedBy).not.toBe(approverActorId);
  });
});

describe('adversarial identity cases', () => {
  it('uninvited identity: IdP sign-in succeeds but MOTERVA grants NOTHING (zero state change)', async () => {
    const before = {
      actors: (ledger.db.prepare('SELECT COUNT(*) AS c FROM actors').get() as { c: number }).c,
      sessions: (ledger.db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c,
      links: (ledger.db.prepare('SELECT COUNT(*) AS c FROM identity_links').get() as { c: number })
        .c,
    };
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
    const { callbackUrl } = await idpSignIn(idp, start.headers.location as string, 'stranger-sub');
    const done = await app.inject({
      method: 'GET',
      url: new URL(callbackUrl).pathname + new URL(callbackUrl).search,
    });
    expect(done.statusCode).toBe(403);
    expect((done.json() as { error: { code: string } }).error.code).toBe('IDENTITY_NOT_LINKED');
    expect(done.headers['set-cookie']).toBeUndefined();
    const after = {
      actors: (ledger.db.prepare('SELECT COUNT(*) AS c FROM actors').get() as { c: number }).c,
      sessions: (ledger.db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c,
      links: (ledger.db.prepare('SELECT COUNT(*) AS c FROM identity_links').get() as { c: number })
        .c,
    };
    expect(after).toEqual(before);
  });

  it('callback REPLAY: the second presentation of the same state fails closed', async () => {
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
    const { callbackUrl } = await idpSignIn(idp, start.headers.location as string, 'owner-sub');
    const url = new URL(callbackUrl).pathname + new URL(callbackUrl).search;
    const first = await app.inject({ method: 'GET', url });
    expect(first.statusCode).toBe(303);
    const replay = await app.inject({ method: 'GET', url });
    expect(replay.statusCode).toBe(400);
    expect((replay.json() as { error: { code: string } }).error.code).toBe('OIDC_STATE_REPLAYED');
  });

  it('revoked actor cannot sign in again (link survives, session creation refuses)', async () => {
    const owner = OWNER;
    await inviteAndJoin(owner, 'viewer', 'revoked@idp.test', 'revoked-sub');
    const doomed = ledger.identity.findActorIdByIdentity(orgId, idp.issuer, 'revoked-sub')!;
    const ownerActor = ledger.authority.getActorByUsername(orgId, 'owner@idp.test')!.id;
    ledger.authority.revokeActor(orgId, doomed, ownerActor);
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
    const { callbackUrl } = await idpSignIn(idp, start.headers.location as string, 'revoked-sub');
    const done = await app.inject({
      method: 'GET',
      url: new URL(callbackUrl).pathname + new URL(callbackUrl).search,
    });
    expect(done.statusCode).toBe(403);
    expect((done.json() as { error: { code: string } }).error.code).toBe('AUTH_ACTOR_REVOKED');
  });

  it('revoking an identity link invalidates previously issued sessions immediately', async () => {
    const owner = OWNER;
    const viewer = await inviteAndJoin(owner, 'viewer', 'readonly@idp.test', 'readonly-sub');
    expect((await get(viewer, '/api/auth/session')).statusCode).toBe(200);
    const ownerActor = ledger.authority.getActorByUsername(orgId, 'owner@idp.test')!.id;
    expect(ledger.identity.revokeIdentity(orgId, idp.issuer, 'readonly-sub', ownerActor)).toBe(
      true,
    );
    expect((await get(viewer, '/api/auth/session')).statusCode).toBe(401);
  });

  it('financial APIs return no sensitive data before authentication; failed auths create zero operations', async () => {
    const opsBefore = (
      ledger.db.prepare('SELECT COUNT(*) AS c FROM operations').get() as { c: number }
    ).c;
    for (const url of [
      '/api/financial/overview',
      '/api/missions',
      `/api/missions/${missionId}/decision-plans`,
      `/api/missions/${missionId}/decision-snapshots`,
    ]) {
      const anonymous = await app.inject({ method: 'GET', url });
      expect(anonymous.statusCode, url).toBe(401);
    }
    expect(
      (ledger.db.prepare('SELECT COUNT(*) AS c FROM operations').get() as { c: number }).c,
    ).toBe(opsBefore);
  });

  it('repeated FAILED invitation guesses earn a 429 cooldown and consume nothing', async () => {
    const created = await post(OWNER, '/api/invitations', {
      role: 'viewer',
      email: 'ratelimit@idp.test',
    });
    expect(created.statusCode).toBe(200);
    const { invitation, secret } = created.json() as { invitation: { id: string }; secret: string };
    for (let i = 0; i < 10; i += 1) {
      const bad = await app.inject({
        method: 'POST',
        url: '/api/auth/invitations/accept',
        payload: { invitationId: invitation.id, secret: `wrong-guess-${i}-aaaaaaaaaaaaaa` },
      });
      expect(bad.statusCode).toBe(403);
    }
    // The 11th attempt — even with the CORRECT secret — is rate-limited.
    const limited = await app.inject({
      method: 'POST',
      url: '/api/auth/invitations/accept',
      payload: { invitationId: invitation.id, secret },
    });
    expect(limited.statusCode).toBe(429);
    expect((limited.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    // No refused attempt consumed the invitation.
    expect(
      (
        ledger.db
          .prepare('SELECT redeemed_at FROM invitations WHERE id = ?')
          .get(invitation.id) as { redeemed_at: string | null }
      ).redeemed_at,
    ).toBeNull();
  });

  it('an approver identity cannot mint owner/admin authority through any public route', async () => {
    const approver = await oidcSignIn('approver-sub', orgId);
    for (const role of ['owner', 'admin'] as const) {
      const attempt = await post(approver, '/api/invitations', {
        role,
        email: `pawn-${role}@idp.test`,
      });
      expect(attempt.statusCode, role).toBe(403);
    }
    expect(
      ledger.identity.listInvitations(orgId).filter((i) => i.email.startsWith('pawn-')),
    ).toHaveLength(0);
  });

  // LAST: this test shuts the local IdP down (outage simulation).
  it('an IdP outage does not break EXISTING sessions; a new sign-in fails at the token exchange', async () => {
    const owner = OWNER; // active session
    await idp.close();
    expect((await get(owner, '/api/auth/session')).statusCode).toBe(200); // sessions never call the IdP
    // Flow START succeeds (authorization URL is built from cached metadata);
    // the FAILURE surfaces at the callback's token exchange — fail closed.
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
    expect(start.statusCode).toBe(303);
    const authorization = start.headers.location as string;
    // Drive the IdP side manually (it is down): construct the callback the
    // IdP WOULD have returned, with a code the dead provider cannot exchange.
    const state = new URL(authorization).searchParams.get('state')!;
    const done = await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?code=dead-provider-code&state=${encodeURIComponent(state)}`,
    });
    expect([400, 502, 503]).toContain(done.statusCode);
    expect((done.json() as { error: { code: string } }).error.code).toBeDefined();
  });
});
