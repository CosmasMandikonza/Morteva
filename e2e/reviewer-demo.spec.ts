import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * E4 — the REVIEWER_DEMO browser journey through the REAL local OpenID
 * Provider: a reviewer joins as operator (invitation accept in the REAL
 * browser), provisions their own sandbox mission, admits the FIXED signed
 * synthetic baseline/incident through the reviewer-demo routes, records the
 * durable evaluations and the immutable plan proposal via the governed
 * production routes, and survives a refresh. Server:
 * e2e/scripts/identity-server.mjs (SPA preview :4174, API :8788).
 */

const SPA = 'http://127.0.0.1:4174';

const IDP_LOGIN = 'input[name="login"]';
const IDP_PASSWORD = 'input[name="password"]';
const IDP_SIGNIN = 'button:has-text("Sign-in")';

function newestStateDir(): string {
  const dirs = readdirSync(tmpdir())
    .filter((d) => d.startsWith('moterva-e2e-identity-'))
    .map((d) => join(tmpdir(), d))
    .filter((d) => existsSync(join(d, 'identity-e2e-state.json')))
    .sort(
      (a, b) =>
        statSync(join(b, 'identity-e2e-state.json')).mtimeMs -
        statSync(join(a, 'identity-e2e-state.json')).mtimeMs,
    );
  if (dirs.length === 0)
    throw new Error('identity e2e state file not found — is identity-server.mjs running?');
  return dirs[0]!;
}

interface ServerState {
  orgId: string;
  issuer: string;
  operatorInvitationId: string;
  operatorInvitationSecret: string;
}

async function idpBrowserSignIn(page: Page, subject: string): Promise<void> {
  await page.waitForSelector(IDP_LOGIN, { timeout: 15_000 });
  await page.fill(IDP_LOGIN, subject);
  await page.fill(IDP_PASSWORD, `idp-${subject}`);
  await page.click(IDP_SIGNIN);
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

test('reviewer signs in by invitation, exercises the governed synthetic journey, and survives refresh', async ({
  browser,
}) => {
  const state = JSON.parse(
    readFileSync(join(newestStateDir(), 'identity-e2e-state.json'), 'utf8'),
  ) as ServerState;

  const page = await browser.newContext().then((c) => c.newPage());
  // Accept the OPERATOR invitation (pre-auth: the secret is the credential),
  // completing the accept → IdP sign-in → role-bound landing in the browser.
  await page.goto(`${SPA}/`);
  const accept = await page.context().request.post(`${SPA}/api/auth/invitations/accept`, {
    maxRedirects: 0,
    data: {
      invitationId: state.operatorInvitationId,
      secret: state.operatorInvitationSecret,
    },
    failOnStatusCode: false,
  });
  expect([200, 303]).toContain(accept.status());
  const acceptLocation = accept.headers()['location'];
  if (acceptLocation !== undefined) {
    await page.goto(acceptLocation, { waitUntil: 'domcontentloaded' });
    await idpBrowserSignIn(page, 'demoer-sub');
  } else {
    // Already-accepted state from a prior run against the same server.
    await page.goto(`${SPA}/`);
    await idpBrowserSignIn(page, 'demoer-sub');
  }

  // Signed in as the invited OPERATOR with a real session + CSRF pair.
  const session = await page.evaluate(async () => {
    const r = await fetch('/api/auth/session', { credentials: 'include' });
    return {
      status: r.status,
      body: (await r.json()) as { actor?: { role?: string } },
    };
  });
  expect(session.status).toBe(200);
  expect(session.body.actor?.role).toBe('operator');
  const csrf = await csrfToken(page);

  const post = async (path: string, payload: unknown) =>
    page.evaluate(
      async ({ path, payload, csrf }) => {
        const r = await fetch(path, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify(payload),
        });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      },
      { path, payload, csrf },
    );

  // (1) Provision the reviewer's own sandbox mission (idempotent).
  const provisioned = await post('/api/reviewer-demo/mission', {});
  expect(provisioned.status).toBe(200);
  const mission = provisioned.body.mission as { id: string; title: string };
  expect(mission.title).toMatch(/^reviewer-demo:/);
  const replayProvision = await post('/api/reviewer-demo/mission', {});
  expect(replayProvision.body.replayed).toBe(true);

  // (2) Admit the FIXED signed synthetic baseline (the browser cannot send
  // any sensor field — only the step name).
  const baseline = await post(`/api/missions/${mission.id}/reviewer-synthetic-step`, {
    step: 'baseline',
  });
  expect(baseline.status).toBe(200);

  // (3) Record the durable baseline evaluation through the governed route.
  const baselineSnap = await post(`/api/missions/${mission.id}/decision-snapshots`, {
    stage: 'baseline',
  });
  expect(baselineSnap.status).toBe(200);

  // (4) The world moves: admit the signed incident, record its evaluation.
  const incident = await post(`/api/missions/${mission.id}/reviewer-synthetic-step`, {
    step: 'incident',
  });
  expect(incident.status).toBe(200);
  const incidentSnap = await post(`/api/missions/${mission.id}/decision-snapshots`, {
    stage: 'incident',
  });
  expect(incidentSnap.status).toBe(200);
  const evaluationId = incidentSnap.body.snapshot.evaluationId as string;

  // The recorded planning response actually CHANGED with the incident —
  // this is the physical-cause → governed-financial-consequence moment.
  const snapshots = await page.evaluate(async (mid) => {
    const r = await fetch(`/api/missions/${mid}/decision-snapshots`, { credentials: 'include' });
    return (await r.json()) as {
      snapshots: Array<{
        stage: string;
        decision: { outcome: string; selected: { id: string } | null };
      }>;
    };
  }, mission.id);
  const stages = Object.fromEntries(
    snapshots.snapshots.map((s) => [s.stage, s.decision]),
  ) as Record<string, unknown>;
  // The recorded planning response actually CHANGED with the incident — the
  // physical-cause → governed-financial-consequence moment. Decisions are
  // compared structurally (selection, outcome, or reasons may move).
  const baselineDecision = JSON.stringify(stages['baseline']);
  const incidentDecision = JSON.stringify(stages['incident']);
  if (baselineDecision === incidentDecision) {
    throw new Error(
      `planning response did not change after the incident: baseline=${baselineDecision} incident=${incidentDecision}`,
    );
  }

  // (5) Immutable proposal from the incident evaluation.
  const proposal = await post(
    `/api/missions/${mission.id}/decision-snapshots/${evaluationId}/propose-plan`,
    {},
  );
  expect(proposal.status).toBe(200);
  expect(proposal.body.plan.digest).toBeTruthy();

  // (6) Refresh: session + the same immutable evidence survive.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const afterReload = await page.evaluate(async (mid) => {
    const s = await fetch('/api/auth/session', { credentials: 'include' });
    const plans = await fetch(`/api/missions/${mid}/decision-plans`, { credentials: 'include' });
    return { session: s.status, plans: await plans.json() };
  }, mission.id);
  expect(afterReload.session).toBe(200);
  expect(Array.isArray(afterReload.plans.plans)).toBe(true);
  expect(afterReload.plans.plans.length).toBeGreaterThanOrEqual(1);
});
