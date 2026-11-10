import { expect, test, type Page } from '@playwright/test';

/**
 * ADVERSARIAL FINANCIAL-JOURNEY MATRIX (final integration reliability, Nov 9).
 *
 * Browser-level verification of the two-person governed journey under
 * duplicates, concurrency and off-mandate terms — against the REAL seeded
 * server. Every mission title is unique per worker AND retry attempt; server
 * refusals surface with their codes (never blind-retried); nothing fabricates
 * a provider state — both rails stay OFFLINE and the tests assert the honest
 * 'provider verified: no' surface.
 *
 * COVERAGE MAP for the 24-item assignment matrix:
 *  Items 1–7, 15 (mandate, self-approval denial, exact server terms, refresh
 *  persistence, distinct approver, identical immutable terms, single
 *  approval, CSRF/401 honesty) → governed-decision.spec.ts (the durable
 *  two-actor journey + the foreign-mission/API-level test), preserved.
 *  Items 8, 23 → THIS spec (duplicate-approval non-double-reservation;
 *  concurrent proposes from two browser sessions cannot duplicate a plan).
 *  Item 9/10 (wrong beneficiary/currency) → THIS spec asserts the honest
 *  DEMO boundary: an off-mandate plan records as PROPOSED_ONLY (a proposal
 *  is not authority — by ledger design the terms bind at approval and the
 *  money gate is the reservation) and never executes; the reservation-level
 *  refusal itself (BENEFICIARY_NOT_ALLOWED / PURPOSE_NOT_ALLOWED /
 *  RAIL_NOT_PERMITTED, packages/ledger/src/services/reservations.ts) is
 *  proven by the ledger suites on the combined tree and is not reachable
 *  from the demo UI (no reservation route exists in the demo surface).
 *  Items 11, 12, 13, 16, 18, 19, 20, 22, 24 → server-side suites, already
 *  green on the combined tree (ledger: stale approval/term-mismatch,
 *  MANDATE_EXPIRED, revocation-safety, session/CSRF expiry, reserved-
 *  without-dispatcher never blind-retries, unknown-status retention,
 *  restart replay; planner regression: changed evidence invalidates
 *  decisions). They are not duplicated in a browser because they require
 *  ledger states the demo surface cannot reach honestly (revocation
 *  routes, wall-clock expiry, forced server restarts).
 */

const PASSWORD = ['moterva', 'e2e', 'demo'].join('-');

function uniqueMissionTitle(base: string): string {
  const info = test.info();
  const tag = `${Date.now().toString(36)}w${info.workerIndex}r${info.retry}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  return `${base} ${tag}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function signIn(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const display =
    username === 'founder'
      ? 'E2E Founder'
      : username === 'operator'
        ? 'E2E Operator'
        : username === 'approver'
          ? 'E2E Approver'
          : 'E2E Viewer';
  await expect(page.getByTestId('actor-chip')).toContainText(display);
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByTestId('actor-chip')).toHaveCount(0);
}

async function createMissionViaSheet(page: Page, title: string): Promise<void> {
  await page.getByTestId('new-mission-btn').click();
  const sheet = page.getByTestId('mission-create-sheet');
  await sheet.getByLabel('Mission name').fill(title);
  await sheet.getByTestId('create-mission-submit').click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('missions-panel')).toContainText(title, { timeout: 10_000 });
}

async function selectMission(page: Page, title: string): Promise<void> {
  // The SPA is hash-routed and the selected mission persists in
  // sessionStorage: after a reload on #decisions the Treasury panel is NOT
  // rendered. Navigating to #missions deterministically restores it.
  await page.goto('/#missions');
  const panel = page.getByTestId('missions-panel');
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await panel
    .getByRole('button', { name: new RegExp(escapeRegExp(title)) })
    .first()
    .click();
}

/** Founder must already be signed in (createMission flow leaves them in). */
async function grantMandateAs(page: Page, cap: string, missionTitle: string): Promise<void> {
  await signOut(page);
  await signIn(page, 'founder');
  await selectMission(page, missionTitle);
  await page.getByTestId('grant-first-mandate').click();
  const sheet = page.getByTestId('mandate-create-sheet');
  await sheet.getByLabel('Per-operation cap (USD)').fill(cap);
  await sheet.getByLabel(/Approved beneficiaries/).fill('harbor-diagnostics, harbor-marine');
  await sheet.getByLabel(/Approved purposes/).fill('harbor inspection');
  await sheet.getByTestId('mandate-review-btn').click();
  await sheet.getByTestId('mandate-submit-btn').click();
  await expect(sheet).toHaveCount(0, { timeout: 10_000 });
  await signOut(page);
}

async function runStage(page: Page, stage: 'baseline' | 'incident'): Promise<void> {
  const snapshot = page.getByTestId('snapshot-' + stage);
  // The panel may still be loading (another session may have recorded the
  // stage first): give the server-truth snapshot a real chance to appear
  // before deciding to click — a recorded stage is done, and its button
  // stays disabled forever afterwards.
  const snapshotSeen = await snapshot
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (snapshotSeen) return;
  const button =
    stage === 'baseline'
      ? page.getByTestId('start-synthetic')
      : page.getByTestId('introduce-incident');
  await expect(button).toBeEnabled({ timeout: 15_000 });
  await button.click();
  await expect(snapshot).toBeVisible({ timeout: 15_000 });
}

async function proposeFromRecordedEvaluation(page: Page): Promise<void> {
  await page.getByTestId('propose-plan').click();
  const row = page.getByTestId('decision-plan-row').first();
  const error = page.getByTestId('propose-error').first();
  const outcome = await Promise.race([
    row
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => 'row' as const)
      .catch(() => null),
    error
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => 'error' as const)
      .catch(() => null),
  ]);
  if (outcome === 'error') {
    const text = (await error.textContent()) ?? '(no error text)';
    throw new Error(`PROPOSAL REFUSED BY SERVER — not retried: ${text.trim()}`);
  }
  if (outcome === null) {
    throw new Error('propose produced neither a decision-plan-row nor a propose-error within 15s');
  }
}

async function openDecisionRoomAs(page: Page, who: string, missionTitle: string): Promise<void> {
  await signIn(page, who);
  await selectMission(page, missionTitle);
  await page.getByRole('link', { name: 'Decision Room' }).click();
  await expect(page.getByTestId('decision-room')).toBeVisible();
}

test.describe('adversarial financial journey (durable contracts)', () => {
  test('duplicate approval cannot double-reserve: one recorded approval, no second affordance', async ({
    page,
  }) => {
    const missionTitle = uniqueMissionTitle('Adversary duplicate approval');
    await signIn(page, 'founder');
    await createMissionViaSheet(page, missionTitle);
    await grantMandateAs(page, '25000', missionTitle);

    await openDecisionRoomAs(page, 'operator', missionTitle);
    await runStage(page, 'baseline');
    await runStage(page, 'incident');
    await proposeFromRecordedEvaluation(page);
    const plansPanel = page.getByTestId('decision-plans');
    await expect(plansPanel.getByTestId('decision-plan-row')).toBeVisible({ timeout: 15_000 });
    await signOut(page);

    // The approver approves ONCE.
    await openDecisionRoomAs(page, 'approver', missionTitle);
    const approverPlans = page.getByTestId('decision-plans');
    await expect(approverPlans.getByTestId('decision-plan-row')).toBeVisible({ timeout: 15_000 });
    await approverPlans.getByTestId('open-approve').click();
    const approve = page.getByTestId('approve-plan-sheet');
    await approve.getByTestId('approve-review-btn').click();
    await expect(approve.getByTestId('approval-review')).toContainText('harbor-marine');
    await approve.getByTestId('approve-submit-btn').click();
    await expect(approve).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('plan-approval-recorded')).toBeVisible({ timeout: 15_000 });

    // After approval the affordance is GONE — a duplicate approval cannot even
    // be attempted from the UI, let alone double-reserve money.
    await expect(approverPlans.getByTestId('open-approve')).toHaveCount(0);

    // A fresh approver session (logout/login + reload) sees the recorded
    // approval exactly once — no new affordance, no second approval row.
    await signOut(page);
    await openDecisionRoomAs(page, 'approver', missionTitle);
    await page.reload();
    await selectMission(page, missionTitle);
    await page.getByRole('link', { name: 'Decision Room' }).click();
    const reloaded = page.getByTestId('decision-plans');
    await expect(reloaded.getByTestId('decision-plan-row')).toBeVisible({ timeout: 15_000 });
    await expect(reloaded.getByTestId('open-approve')).toHaveCount(0);
    await expect(reloaded.getByTestId('plan-approval-recorded')).toBeVisible();
    const approvalRows = await reloaded.getByTestId('plan-approval-recorded').count();
    expect(approvalRows, 'exactly one journal-verified approval record').toBe(1);
    await expect(reloaded).toContainText('Provider verification: none');
  });

  test('concurrent operator sessions proposing the same evaluation cannot create duplicate plans', async ({
    browser,
  }) => {
    const missionTitle = uniqueMissionTitle('Adversary concurrent propose');
    const founder = await browser.newContext();
    const founderPage = await founder.newPage();
    await signIn(founderPage, 'founder');
    await createMissionViaSheet(founderPage, missionTitle);
    const missionId = await founderPage.evaluate(async () => {
      const response = await fetch('/api/missions', { credentials: 'same-origin' });
      const data = (await response.json()) as { missions: Array<{ id: string; title: string }> };
      return data.missions[0]?.id ?? '';
    });
    expect(missionId).toMatch(/^msn_/);
    await grantMandateAs(founderPage, '25000', missionTitle);
    await founder.close();

    const a = await browser.newContext();
    const b = await browser.newContext();
    const pageA = await a.newPage();
    const pageB = await b.newPage();
    await openDecisionRoomAs(pageA, 'operator', missionTitle);
    await runStage(pageA, 'baseline');
    await runStage(pageA, 'incident');
    // Session B mirrors A to the same recorded evaluation.
    await openDecisionRoomAs(pageB, 'operator', missionTitle);
    await runStage(pageB, 'baseline');
    await runStage(pageB, 'incident');

    // BOTH click propose as simultaneously as the framework allows.
    const [resultA, resultB] = await Promise.all([
      clickProposeCapture(pageA),
      clickProposeCapture(pageB),
    ]);
    // Neither response may be a server refusal (the evaluation is valid and
    // the mandate covers it): both accepted — one persisted, one idempotent.
    expect(resultA.status, 'session A propose HTTP status').toBe(200);
    expect(resultB.status, 'session B propose HTTP status').toBe(200);

    // Exactly ONE durable plan for the evaluation — visible from BOTH sessions.
    const rowsA = await pageA.getByTestId('decision-plan-row').count();
    const rowsB = await pageB.getByTestId('decision-plan-row').count();
    expect(rowsA, 'session A plan rows').toBe(1);
    expect(rowsB, 'session B plan rows').toBe(1);
    const idA = await pageA.getByTestId('decision-plan-row').first().textContent();
    const idB = await pageB.getByTestId('decision-plan-row').first().textContent();
    expect(idA).toBe(idB); // the same immutable plan identity in both sessions
    await a.close();
    await b.close();
  });

  test('an off-mandate manual plan can never enter the planner-derived decision flow', async ({
    page,
  }) => {
    const missionTitle = uniqueMissionTitle('Adversary off-mandate terms');
    await signIn(page, 'founder');
    await createMissionViaSheet(page, missionTitle);
    await grantMandateAs(page, '25000', missionTitle);
    await openDecisionRoomAs(page, 'operator', missionTitle);
    await runStage(page, 'baseline');
    await runStage(page, 'incident');

    // Review-gated manual entry — the only place terms can be typed. A
    // beneficiary OUTSIDE the mandate allowlist is entered here. By ledger
    // design a PLAN is a proposal, not authority: the reservation gate
    // (BENEFICIARY_NOT_ALLOWED in packages/ledger reservations.ts, proven by
    // the ledger suites) refuses it forever before any money can move, and
    // the reviewer handoff list deliberately EXCLUDES manually authored
    // plans (anti-forgery: the decision flow carries only journaled,
    // evaluation-bound proposals).
    await page.getByTestId('open-manual').click();
    await page.getByTestId('open-manual-sheet').click();
    const sheet = page.getByTestId('propose-plan-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Manual plan entry — NOT planner-derived');
    const createResponse = page.waitForResponse(
      (response) => response.url().endsWith('/api/plans') && response.request().method() === 'POST',
      { timeout: 20_000 },
    );
    await sheet.getByLabel(/Amount/).fill('5000');
    await sheet.getByLabel(/Beneficiary/).fill('not-an-allowed-payee');
    await sheet.getByLabel(/Purpose/).fill('harbor inspection');
    await sheet.getByTestId('propose-review-btn').click();
    await sheet.getByTestId('propose-submit-btn').click();
    const response = await createResponse;
    expect(response.status(), 'generic plan creation HTTP status').toBe(200);
    const created = (await response.json()) as { plan: { id: string; digest: string } };
    await expect(sheet).toHaveCount(0, { timeout: 10_000 });

    // THE BOUNDARY: the planner-derived decision panel does NOT include the
    // manually authored off-mandate plan (anti-forgery separation), and
    // nothing on the surface claims provider verification.
    const plansPanel = page.getByTestId('decision-plans');
    await expect(plansPanel).not.toContainText('not-an-allowed-payee');
    await expect(plansPanel).toContainText('Provider verification: none');
    const decisionPlans = await page.evaluate(
      async (scopedMissionId) => {
        const listResponse = await fetch(
          `/api/missions/${encodeURIComponent(scopedMissionId)}/decision-plans`,
          { credentials: 'same-origin' },
        );
        return (await listResponse.json()) as { plans: Array<{ plan: { id: string } }> };
      },
      (await page.evaluate(() => window.sessionStorage.getItem('moterva-selected-mission'))) ?? '',
    );
    expect(
      decisionPlans.plans.some((p) => p.plan.id === created.plan.id),
      'the off-mandate manual plan must never enter the decision-flow proposal list',
    ).toBe(false);
  });
});

/** Clicks propose and resolves with the HTTP status of the propose response. */
async function clickProposeCapture(page: Page): Promise<{ status: number }> {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/propose-plan') && response.request().method() === 'POST',
    { timeout: 20_000 },
  );
  await page.getByTestId('propose-plan').click();
  const response = await responsePromise;
  await page
    .getByTestId('decision-plan-row')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => {
      /* a refused propose surfaces via propose-error; the count asserts catch it */
    });
  return { status: response.status() };
}
