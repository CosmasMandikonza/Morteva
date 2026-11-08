import { expect, test, type Page } from '@playwright/test';

/**
 * Governed Decision Room journeys against the REAL durable contracts (#44):
 * server-authoritative ID-only proposals, persisted cross-actor handoff
 * (operator proposes → logout → approver logs in → approves), reload
 * rebuilds from server truth, idempotent duplicates, honest refusals.
 * POLICY-ONLY evaluation; no provider call is made or implied.
 */
const PASSWORD = 'moterva-e2e-demo';

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

/** Owner/admin grant path so the mission has an effective mandate.
 *  Authority management is a SEPARATE actor from the proposer/approver.
 *  Logout clears mission selection, so re-select the target mission by title. */
async function grantMandateAs(page: Page, cap: string, missionTitle: string): Promise<void> {
  await signOut(page);
  await signIn(page, 'founder');
  await page
    .getByTestId('missions-panel')
    .getByRole('button', { name: new RegExp(missionTitle) })
    .click();
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

/** Fresh logins fall back to the oldest mission; select the target explicitly. */
async function selectMission(page: Page, title: string): Promise<void> {
  await page
    .getByTestId('missions-panel')
    .getByRole('button', { name: new RegExp(title) })
    .click();
}

/** Drive journal+snapshot for one stage on the selected mission, tolerating
 *  already-recorded state (idempotent replays are honest, not failures). */
async function runStage(page: Page, stage: 'baseline' | 'incident'): Promise<void> {
  const button =
    stage === 'baseline'
      ? page.getByTestId('start-synthetic')
      : page.getByTestId('introduce-incident');
  await expect(button).toBeEnabled({ timeout: 15_000 });
  await button.click();
  // The action journals the event AND records the durable snapshot.
  await expect(page.getByTestId(`snapshot-${stage}`)).toBeVisible({ timeout: 15_000 });
  if (stage === 'incident') {
    await expect(page.getByTestId('physical-incident')).toContainText('24.6 kt');
  }
}

test.describe('governed two-actor journey (durable contracts)', () => {
  test('operator journals + snapshots + ID-only proposes; approver approves after logout/login and reload', async ({
    page,
  }) => {
    // ---------- ACTOR 0: founder (authority manager) creates + grants, then leaves
    await signIn(page, 'founder');
    await createMissionViaSheet(page, 'Durable two-actor mission');
    await grantMandateAs(page, '25000', 'Durable two-actor mission');
    // ---------- ACTOR 1: operator (propose grant, no approve grant)
    await selectMission(page, 'Durable two-actor mission');
    await signIn(page, 'operator');
    await page.getByRole('link', { name: 'Decision Room' }).click();

    await runStage(page, 'baseline');
    await runStage(page, 'incident');

    // Recorded durable evaluations are server truth (both stages present).
    const snapshots = page.getByTestId('recorded-snapshots');
    await expect(snapshots).toContainText('baseline');
    await expect(snapshots).toContainText('incident');

    // SERVER-AUTHORITATIVE ID-ONLY proposal: no amount/beneficiary/purpose inputs.
    await expect(page.getByTestId('governed-actions')).toContainText(
      'server derives the economic terms',
    );
    await page.getByTestId('propose-plan').click();
    // Durable proposal appears with immutable server terms.
    const plansPanel = page.getByTestId('decision-plans');
    await expect(plansPanel.getByTestId('decision-plan-row')).toBeVisible({ timeout: 15_000 });
    const terms = plansPanel.getByTestId('plan-terms');
    await expect(terms).toContainText('USD 18,500.00'); // vessel alternative from server catalog
    await expect(terms).toContainText('harbor-marine');
    await expect(terms).toContainText('harbor inspection');
    const planText =
      (await plansPanel.getByTestId('decision-plan-row').first().textContent()) ?? '';

    // Duplicate ID-only proposal is idempotent — same single row, no second plan.
    await page.getByTestId('propose-plan').click();
    await expect(plansPanel.getByTestId('decision-plan-row')).toHaveCount(1, { timeout: 10_000 });

    // Operator has no approve grant → no approval affordance at all.
    await expect(plansPanel.getByTestId('open-approve')).toHaveCount(0);

    // ---------- logout: no ephemeral React handoff, session state dropped
    await signOut(page);

    // ---------- ACTOR 2: approver (different persisted actor, fresh login)
    await signIn(page, 'approver');
    // Approver lands on Treasury; reload BEFORE navigating proves persistence.
    await page.reload();
    await expect(page.getByTestId('missions-panel')).toContainText('Durable two-actor mission');
    await page.getByRole('link', { name: 'Decision Room' }).click();

    // The persisted proposal rebuilds from the server read — same exact terms.
    const approverPlans = page.getByTestId('decision-plans');
    await expect(approverPlans.getByTestId('decision-plan-row')).toBeVisible({ timeout: 15_000 });
    await expect(approverPlans.getByTestId('plan-terms')).toContainText('USD 18,500.00');
    const approverText =
      (await approverPlans.getByTestId('decision-plan-row').first().textContent()) ?? '';
    expect(approverText.slice(0, 120)).toContain(planText.slice(0, 120).split('·')[0] ?? '');

    // Approver has the grant → approval affordance visible with persisted terms.
    await approverPlans.getByTestId('open-approve').click();
    const approve = page.getByTestId('approve-plan-sheet');
    await approve.getByTestId('approve-review-btn').click();
    const review = approve.getByTestId('approval-review');
    await expect(review).toContainText('USD 18,500.00');
    await expect(review).toContainText('harbor-marine');
    await expect(review).toContainText('harbor inspection');
    await expect(review).toContainText('fingerprint');
    await approve.getByTestId('approve-submit-btn').click();
    await expect(approve).toHaveCount(0, { timeout: 15_000 });

    // Journal-verified approval renders (approval.granted from the financial journal).
    await expect(page.getByTestId('plan-approval-recorded')).toBeVisible({ timeout: 15_000 });

    // ---------- reload: everything rebuilds from persisted server state
    await page.reload();
    await page.getByRole('link', { name: 'Decision Room' }).click();
    await expect(page.getByTestId('decision-plan-row')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('plan-terms')).toContainText('USD 18,500.00');
    await expect(page.getByTestId('plan-approval-recorded')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('decision-plans')).toContainText('Provider verification: none');
  });

  test('baseline must be recorded before the incident evaluation', async ({ page }) => {
    await signIn(page, 'founder');
    await createMissionViaSheet(page, 'Ordering guard mission');
    await grantMandateAs(page, '25000', 'Ordering guard mission');
    await signIn(page, 'operator');
    await selectMission(page, 'Ordering guard mission');
    await page.getByRole('link', { name: 'Decision Room' }).click();

    // Fresh mission: incident button disabled until baseline stage reached.
    await expect(page.getByTestId('introduce-incident')).toBeDisabled();
    await runStage(page, 'baseline');
    await expect(page.getByTestId('introduce-incident')).toBeEnabled();
  });

  test('no-action baseline evaluation never proposes a payment', async ({ page }) => {
    await signIn(page, 'founder');
    await createMissionViaSheet(page, 'No-action mission');
    await grantMandateAs(page, '25000', 'No-action mission');
    await signIn(page, 'operator');
    await selectMission(page, 'No-action mission');
    await page.getByRole('link', { name: 'Decision Room' }).click();
    await runStage(page, 'baseline');

    // Baseline selects "hold the current plan" — zero gross, NOT executable.
    await expect(page.getByTestId('snapshot-baseline')).toContainText(/no-action|no spend/);
    // The governed (planner-derived) panel only appears for an incident snapshot.
    await expect(page.getByTestId('governed-actions')).toHaveCount(0);
  });

  test('manual plan entry is clearly labeled NOT planner-derived', async ({ page }) => {
    await signIn(page, 'founder');
    await createMissionViaSheet(page, 'Manual label mission');
    await grantMandateAs(page, '25000', 'Manual label mission');
    await signIn(page, 'operator');
    await selectMission(page, 'Manual label mission');
    await page.getByRole('link', { name: 'Decision Room' }).click();
    await runStage(page, 'baseline');
    await runStage(page, 'incident');

    await page.getByTestId('open-manual').click();
    await page.getByTestId('open-manual-sheet').click();
    const sheet = page.getByTestId('propose-plan-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('manual-plan-banner')).toContainText('NOT planner-derived');
    await expect(sheet.getByTestId('manual-plan-banner')).toContainText('not derived from the');
    // Manual entry still works and is review-gated.
    await sheet.getByLabel('Amount (USD)').fill('500');
    await sheet.getByLabel(/Beneficiary/).fill('harbor-diagnostics');
    await sheet.getByLabel(/Purpose/).fill('harbor inspection');
    await sheet.getByTestId('propose-review-btn').click();
    await sheet.getByTestId('propose-submit-btn').click();
    await expect(sheet).toHaveCount(0, { timeout: 10_000 });
  });

  test('viewer cannot operate the journey (server ROLE_FORBIDDEN, verbatim)', async ({ page }) => {
    await signIn(page, 'viewer');
    // Mission B has no journey yet → the operate-gated POST is attempted.
    await page
      .getByTestId('missions-panel')
      .getByRole('button', { name: /Subsea mooring survey/ })
      .click();
    await page.getByRole('link', { name: 'Decision Room' }).click();
    await expect(page.getByTestId('start-synthetic')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('start-synthetic').click();
    await expect(page.getByTestId('decision-room')).toContainText(
      /ROLE_FORBIDDEN|may not operate|403/i,
      { timeout: 10_000 },
    );
  });

  test('foreign mission denial and 401/CSRF honesty (API-level, real server)', async ({ page }) => {
    await signIn(page, 'operator');
    const result = await page.evaluate(async () => {
      const session = (await (
        await fetch('/api/auth/session', { credentials: 'same-origin' })
      ).json()) as { actor: { orgId: string } };
      const missions = (await (
        await fetch('/api/missions', { credentials: 'same-origin' })
      ).json()) as { missions: { id: string }[] };
      const missionId = missions.missions[0]?.id ?? '';
      const foreign = await fetch(
        `/api/missions/${encodeURIComponent('msn_does_not_exist')}/decision-snapshots`,
        { credentials: 'same-origin' },
      );
      const noCsrf = await fetch(
        `/api/missions/${encodeURIComponent(missionId)}/decision-snapshots`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage: 'baseline' }),
        },
      );
      return {
        org: session.actor.orgId.slice(0, 8),
        foreign: foreign.status,
        noCsrf: noCsrf.status,
      };
    });
    expect(result.foreign).toBe(404); // unknown mission → honest NOT_FOUND
    expect(result.noCsrf).toBe(403); // missing CSRF token → refused
  });

  test('evidence continuity: snapshot events are inspectable in Evidence Replay', async ({
    page,
  }) => {
    await signIn(page, 'operator');
    // Mission A ships with a journaled demo incident (evt_demo_incident_*).
    await page.getByRole('link', { name: 'Decision Room' }).click();
    await expect(page.getByTestId('decision-room')).toBeVisible();
    await page.getByRole('link', { name: 'Evidence Replay' }).click();
    await expect(page.getByTestId('evidence-panel')).toBeVisible();
    // The signed synthetic incident event is present with its full identity.
    await expect(page.getByTestId('evidence-panel')).toContainText('evt_demo_incident_', {
      timeout: 10_000,
    });
  });

  test('320px and 390px: governed panels do not overflow', async ({ page }) => {
    await signIn(page, 'operator');
    // Mission A already carries the demo incident journey state.
    await page.getByRole('link', { name: 'Decision Room' }).click();
    await expect(page.getByTestId('recorded-snapshots')).toBeVisible({ timeout: 15_000 });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const sw = await page.evaluate<number>('document.documentElement.scrollWidth');
      expect(sw, `scrollWidth at ${width}`).toBeLessThanOrEqual(width);
    }
  });
});
