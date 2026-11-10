import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * REAL browser two-person journey through a REAL local OpenID Provider
 * (oidc-provider fixture): IdP-hosted sign-in form → authorization code +
 * PKCE + nonce → MOTERVA session cookie → governed financial workflow with
 * DISTINCT authenticated identities, and the reviewer invitation-accept
 * journey. Server: e2e/scripts/identity-server.mjs (SPA preview :4174,
 * API :8788, IdP :18995).
 */

const SPA = 'http://127.0.0.1:4174';
const API = 'http://127.0.0.1:8788';

interface StateFile {
  orgId: string;
  missionId: string;
  invitationId: string;
  invitationSecret: string;
  issuer: string;
}
function state(): StateFile {
  // The server writes it under its tmp dir; the LIVE server's file is the
  // most recently MODIFIED one (pid order is meaningless).
  const dirs = readdirSync(tmpdir()).filter((d) => d.startsWith('moterva-e2e-identity-'));
  const candidates = dirs
    .map((d) => join(tmpdir(), d, 'identity-e2e-state.json'))
    .filter((p) => existsSync(p))
    .map((p) => ({ p, m: statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (candidates.length === 0) {
    throw new Error(
      `identity e2e state file not found — is identity-server.mjs running? (tmpdir=${tmpdir()}, dirs=${dirs.join(',')})`,
    );
  }
  return JSON.parse(readFileSync(candidates[0]!.p, 'utf8')) as StateFile;
}

const IDP_LOGIN = 'input[name="login"]';
const IDP_PASSWORD = 'input[name="password"]';
const IDP_SIGNIN = 'button:has-text("Sign-in")';

/** Completes the IdP's dev-interaction forms in the live browser. */
async function idpBrowserSignIn(page: Page, subject: string): Promise<void> {
  await page.waitForSelector(IDP_LOGIN, { timeout: 15_000 });
  await page.fill(IDP_LOGIN, subject);
  await page.fill(IDP_PASSWORD, `idp-${subject}`);
  await page.click(IDP_SIGNIN);
  // Consent (dev interaction) — any button that continues the flow.
  const confirm = page
    .locator('button')
    .filter({ hasText: /Continue|Consent|Allow|Confirm/ })
    .first();
  if (await confirm.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await confirm.click();
  }
  await page.waitForURL(`${SPA}/**`, { timeout: 20_000 });
}

async function csrfToken(page: Page): Promise<string> {
  const cookie = await page
    .context()
    .cookies()
    .then((all) => all.find((c) => c.name === 'moterva_csrf'));
  if (cookie === undefined || cookie.value === '') throw new Error('no moterva_csrf cookie');
  return cookie.value;
}

async function apiFetch(
  page: Page,
  method: string,
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: string }> {
  return page.evaluate(
    async ({ method, path, payload, csrf }) => {
      const response = await fetch(path, {
        method,
        credentials: 'include',
        headers: {
          'x-csrf-token': csrf,
          // No content-type without a body: Fastify rejects empty JSON bodies.
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      return { status: response.status, body: await response.text() };
    },
    { method, path, payload, csrf: await csrfToken(page) },
  );
}

async function signInViaIdp(context: BrowserContext, subject: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${API}/api/auth/oidc/login`);
  await idpBrowserSignIn(page, subject);
  return page;
}

let STATE: StateFile;

test.beforeAll(() => {
  STATE = state();
});

test.describe('browser OIDC identity journeys', () => {
  test('owner signs in through the IdP and reads the organization session', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await signInViaIdp(context, 'owner-sub');
    const session = await page.evaluate(async () => {
      const r = await fetch('/api/auth/session', { credentials: 'include' });
      return { status: r.status, body: await r.json() };
    });
    expect(session.status).toBe(200);
    expect((session.body as { actor: { role: string; username: string } }).actor.role).toBe(
      'owner',
    );
    expect((session.body as { authMode: string }).authMode).toBe('oidc');
    await context.close();
  });

  test('operator proposes; a DIFFERENT approver authorizes the persisted exact terms', async ({
    browser,
  }) => {
    const operator = await signInViaIdp(await browser.newContext(), 'operator-sub');
    // Record the durable baseline → incident snapshots, then propose.
    const baseline = await apiFetch(
      operator,
      'POST',
      `/api/missions/${STATE.missionId}/decision-snapshots`,
      { stage: 'baseline' },
    );
    expect(baseline.status, baseline.body).toBe(200);
    // The fixture ingests the incident physical event shortly after the
    // durable baseline snapshot lands — poll briefly for it.
    let incident = { status: 0, body: '' };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      incident = await apiFetch(
        operator,
        'POST',
        `/api/missions/${STATE.missionId}/decision-snapshots`,
        { stage: 'incident' },
      );
      if (incident.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(incident.status, incident.body).toBe(200);
    const evaluationId = (JSON.parse(incident.body) as { snapshot: { evaluationId: string } })
      .snapshot.evaluationId;
    const propose = await apiFetch(
      operator,
      'POST',
      `/api/missions/${STATE.missionId}/decision-snapshots/${evaluationId}/propose-plan`,
    );
    expect(propose.status, propose.body).toBe(200);
    const plan = (JSON.parse(propose.body) as { plan: { id: string; version: number } }).plan;
    // Self-approval stays forbidden inside the browser too.
    const selfApprove = await apiFetch(operator, 'POST', '/api/approvals', {
      missionId: STATE.missionId,
      planId: plan.id,
      planVersion: plan.version,
      kind: 'airwallex_transfer',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(selfApprove.status).toBeGreaterThanOrEqual(400);
    // Operator signs out (server-side session destroyed).
    const out = await apiFetch(operator, 'POST', '/api/auth/logout');
    expect(out.status).toBe(200);

    // A DIFFERENT human completes their own IdP sign-in and authorizes the
    // exact persisted terms.
    const approver = await signInViaIdp(await browser.newContext(), 'approver-sub');
    const plans = await apiFetch(
      approver,
      'GET',
      `/api/missions/${STATE.missionId}/decision-plans`,
    );
    expect(plans.status).toBe(200);
    const listed = JSON.parse(plans.body) as {
      plans: Array<{ plan: { id: string; version: number } }>;
    };
    const match = listed.plans.find((p) => p.plan.id === plan.id);
    expect(match).toBeDefined();
    const approval = await apiFetch(approver, 'POST', '/api/approvals', {
      missionId: STATE.missionId,
      planId: plan.id,
      planVersion: plan.version,
      kind: 'airwallex_transfer',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(approval.status).toBe(200);
    const approvalId = (JSON.parse(approval.body) as { approval: { id: string } }).approval.id;
    const reserve = await apiFetch(approver, 'POST', '/api/operations/reserve', {
      missionId: STATE.missionId,
      kind: 'airwallex_transfer',
      requestId: 'identity-browser-two-person-1',
      planId: plan.id,
      planVersion: plan.version,
      approvalId,
    });
    expect(reserve.status).toBe(200);
    expect((JSON.parse(reserve.body) as { duplicate: boolean }).duplicate).toBe(false);
    await approver.close();
    await operator.close();
  });

  test('reviewer accepts an invitation in the browser and lands read-only', async ({ browser }) => {
    const page = await browser.newContext().then((c) => c.newPage());
    // Accept endpoint is PRE-authentication: the secret is the credential.
    await page.goto(`${SPA}/`); // same-origin context for cookies
    // redirect:'manual' via the context's request (shares the cookie jar) —
    // browser fetch would follow the cross-origin 303 into opaque-CORS failure.
    const accept = await page.context().request.post(`${SPA}/api/auth/invitations/accept`, {
      maxRedirects: 0,
      data: { invitationId: STATE.invitationId, secret: STATE.invitationSecret },
      failOnStatusCode: false,
    });
    expect(accept.status()).toBe(303);
    const acceptLocation = accept.headers()['location'];
    expect(acceptLocation).toBeTruthy();
    // Follow the IdP sign-in in the REAL browser, then the callback lands us
    // signed-in with the INVITED role.
    await page.goto(acceptLocation!, { waitUntil: 'domcontentloaded' });
    await idpBrowserSignIn(page, 'reviewer-sub');
    const session = await page.evaluate(async () => {
      const r = await fetch('/api/auth/session', { credentials: 'include' });
      return { status: r.status, body: await r.json() };
    });
    expect(session.status).toBe(200);
    expect((session.body as { actor: { role: string } }).actor.role).toBe('viewer');
    // Read-only: reviewer can read Treasury but cannot propose.
    const overview = await page.evaluate(async () => {
      const r = await fetch('/api/financial/overview', { credentials: 'include' });
      return r.status;
    });
    expect(overview).toBe(200);
    const propose = await apiFetch(
      page,
      'POST',
      `/api/missions/${STATE.missionId}/decision-snapshots`,
      { stage: 'baseline' },
    );
    expect(propose.status).toBe(403);
  });

  test('an uninvited IdP identity gains nothing in the browser', async ({ browser }) => {
    const page = await browser.newContext().then((c) => c.newPage());
    await page.goto(`${API}/api/auth/oidc/login`);
    await idpBrowserSignIn(page, 'stranger-sub').catch(() => {
      // The callback responds 403 with a JSON body — the browser shows it.
    });
    const noSession = await page.evaluate(async () => {
      const r = await fetch('/api/auth/session', { credentials: 'include' });
      return r.status;
    });
    expect(noSession).toBe(401);
    await page.close();
  });
});

// ---------------------------------------------------------------- MTV-20/R3
// UI-driven journeys for the InvitationAccept component and the read-only
// capabilities discovery (R3 P0-2/P0-3): the tests below use the ACTUAL
// visible UI — they never POST to the API directly on the happy path.

test('capabilities discovery is read-only and offers ONLY the IdP entry (OIDC deployment)', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let oidcLoginHits = 0;
  let writeHits = 0;
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/api/auth/oidc/login')) oidcLoginHits += 1;
    if (r.method() !== 'GET' && u.includes('/api/')) writeHits += 1;
  });
  await page.goto(`${SPA}/`);
  await page.waitForTimeout(800);
  // OIDC deployment → the IdP entry, NOT a local username/password form.
  await expect(page.getByTestId('oidc-signin')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('signin-panel')).toContainText('identity provider');
  await expect(page.locator('input[name="username"]')).toHaveCount(0);
  // Discovery side effects: only the capabilities read — zero OIDC flow
  // starts, zero financial/membership writes.
  expect(oidcLoginHits).toBe(0);
  expect(writeHits).toBe(0);
  // The capabilities read itself:
  const caps = await page.evaluate(async () => {
    const r = await fetch('/api/auth/capabilities', { credentials: 'include' });
    return { status: r.status, body: (await r.json()) as { authMode: string } };
  });
  expect(caps.status).toBe(200);
  expect(caps.body.authMode).toBe('oidc');
  await context.close();
});

test('invitation acceptance through the REAL visible UI — one POST, IdP continuation', async ({
  browser,
  request,
}) => {
  // Provision a FRESH invitation via the owner API (this is admin setup, not
  // the redemption under test — the redemption below goes through the UI).
  const owner = await browser.newContext().then((c) => c.newPage());
  await owner.goto(`${API}/api/auth/oidc/login`);
  await idpBrowserSignIn(owner, 'owner-sub');
  const created = await apiFetch(owner, 'POST', '/api/invitations', {
    role: 'viewer',
    email: 'ui-invitee@idp.test',
  });
  expect(created.status).toBe(200);
  const { invitation, secret } = JSON.parse(created.body) as {
    invitation: { id: string };
    secret: string;
  };
  await owner.close();

  const context = await browser.newContext();
  const page = await context.newPage();
  let acceptPosts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/auth/invitations/accept')) {
      acceptPosts += 1;
    }
  });

  // The REAL visible UI at the #invite entry.
  await page.goto(`${SPA}/#invite`);
  const panel = page.getByTestId('invite-accept');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await panel.getByLabel('Invitation id').fill(invitation.id);
  await panel.getByLabel('One-time secret').fill(secret);
  await panel.getByRole('button', { name: 'Accept invitation' }).click();

  // Exactly ONE redemption POST; the browser follows the server-issued IdP URL.
  await page.waitForURL(`${API.replace(':8788', ':18995')}/**`, { timeout: 30_000 });
  expect(acceptPosts).toBe(1);
  // The secret never appears in any URL.
  expect(page.url()).not.toContain(secret);
  expect(page.url()).not.toContain(invitation.id);

  // Complete the IdP journey → invited role lands.
  await idpBrowserSignIn(page, 'ui-invitee-sub');
  const session = await page.evaluate(async () => {
    const r = await fetch('/api/auth/session', { credentials: 'include' });
    return { status: r.status, body: (await r.json()) as { actor: { role: string } } };
  });
  expect(session.status).toBe(200);
  expect(session.body.actor.role).toBe('viewer');
  await context.close();
  // Cleanup: revoke so later suites see a clean slate is unnecessary — the
  // invitation is redeemed exactly once by this test.
  void request;
});

test('invitation UI renders the server refusal inline for a wrong secret (no second POST)', async ({
  browser,
}) => {
  const owner = await browser.newContext().then((c) => c.newPage());
  await owner.goto(`${API}/api/auth/oidc/login`);
  await idpBrowserSignIn(owner, 'owner-sub');
  const created = await apiFetch(owner, 'POST', '/api/invitations', {
    role: 'operator',
    email: 'wrong-secret@idp.test',
  });
  expect(created.status).toBe(200);
  const { invitation } = JSON.parse(created.body) as { invitation: { id: string } };
  await owner.close();

  const context = await browser.newContext();
  const page = await context.newPage();
  let acceptPosts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/auth/invitations/accept')) {
      acceptPosts += 1;
    }
  });
  await page.goto(`${SPA}/#invite`);
  const panel = page.getByTestId('invite-accept');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await panel.getByLabel('Invitation id').fill(invitation.id);
  await panel.getByLabel('One-time secret').fill('not-the-secret');
  await panel.getByRole('button', { name: 'Accept invitation' }).click();
  // Server refusal renders inline in useful language; input re-enabled.
  await expect(page.getByTestId('invite-error')).toContainText('INVITATION_SECRET_INVALID', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('invite-error')).toContainText('do not match');
  // Exactly one POST for the failed attempt (no phantom retries).
  expect(acceptPosts).toBe(1);
  await context.close();
});
