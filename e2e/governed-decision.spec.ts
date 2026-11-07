import { expect, test, type Page } from '@playwright/test';

/**
 * Governed Decision Room follow-through against the REAL plan/approval APIs:
 * propose (operator+), exact-terms approval against a real mandate (approver+),
 * role refusals shown as first-class outcomes, and honest unavailable states.
 * POLICY-ONLY evaluation; no provider call is made or implied.
 */
async function signIn(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('moterva-e2e-demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('actor-chip')).toBeVisible();
}

async function createMissionViaSheet(page: Page, title: string): Promise<void> {
  await page.getByTestId('new-mission-btn').click();
  const sheet = page.getByTestId('mission-create-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByLabel('Mission name').fill(title);
  await sheet.getByTestId('create-mission-submit').click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('missions-panel')).toContainText(title, { timeout: 10_000 });
}

async function grantMandate(page: Page, cap: string): Promise<void> {
  await page.getByTestId('grant-first-mandate').click();
  const sheet = page.getByTestId('mandate-create-sheet');
  await sheet.getByLabel('Per-operation cap (USD)').fill(cap);
  await sheet.getByLabel(/Approved beneficiaries/).fill('harbor-diagnostics');
  await sheet.getByLabel(/Approved purposes/).fill('diagnostic sweep');
  await sheet.getByTestId('mandate-review-btn').click();
  await sheet.getByTestId('mandate-submit-btn').click();
  await expect(sheet).toHaveCount(0, { timeout: 10_000 });
}

/** Drive the synthetic journey to the incident stage on the CURRENT mission. */
async function runIncidentJourney(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Decision Room' }).click();
  await expect(page.getByTestId('decision-room')).not.toContainText(
    'Loading actual journal and planner results',
  );
  if (await page.getByTestId('start-synthetic').isEnabled()) {
    await page.getByTestId('start-synthetic').click();
  }
  await expect(async () => {
    const introEnabled = await page.getByTestId('introduce-incident').isEnabled();
    const incidentPresent = (await page.getByTestId('physical-incident').count()) > 0;
    expect(introEnabled || incidentPresent).toBe(true);
  }).toPass({ timeout: 15_000 });
  if (await page.getByTestId('introduce-incident').isEnabled()) {
    await page.getByTestId('introduce-incident').click();
  }
  await expect(page.getByTestId('physical-incident')).toContainText('24.6 kt');
  await expect(page.getByTestId('governed-actions')).toContainText('governed action');
}

test.describe('governed decision follow-through', () => {
  test('owner proposes exact terms and records an approval against a real mandate', async ({
    page,
  }) => {
    await signIn(page, 'founder');
    await createMissionViaSheet(page, 'Governed flow mission');
    await grantMandate(page, '750');
    await runIncidentJourney(page);

    // Propose: exact typed terms, reviewed before submission.
    await page.getByTestId('open-propose').click();
    const sheet = page.getByTestId('propose-plan-sheet');
    await expect(sheet).toBeVisible();
    await sheet.getByLabel('Amount (USD)').fill('600');
    await sheet.getByLabel(/Beneficiary/).fill('harbor-diagnostics');
    await sheet.getByLabel(/Purpose/).fill('diagnostic sweep');
    await sheet.getByTestId('propose-review-btn').click();
    const review = sheet.getByTestId('plan-review');
    await expect(review).toContainText('USD 600.00');
    await expect(review).toContainText('harbor-diagnostics');
    await expect(review).toContainText('diagnostic sweep');
    await sheet.getByTestId('propose-submit-btn').click();
    await expect(sheet).toHaveCount(0);

    const planBlock = page.getByTestId('plan-recorded');
    await expect(planBlock).toContainText('Plan recorded');
    await expect(planBlock).toContainText('a proposal only');
    await expect(page.getByTestId('governed-actions')).toContainText('Terms digest');

    // The server ENFORCES separation of duties — the UI must say so, not promise
    // a same-actor approval.
    await expect(page.getByTestId('governed-actions')).toContainText(
      'server enforces separation of duties',
    );

    // Approve: exact terms against the real mandate, digest shown; the sheet is
    // honest that self-approval will be refused.
    await page.getByTestId('open-approve').click();
    const approve = page.getByTestId('approve-plan-sheet');
    await expect(approve.getByTestId('self-approval-note')).toContainText('refuse self-approval');
    await approve.getByTestId('approve-review-btn').click();
    const approvalReview = approve.getByTestId('approval-review');
    await expect(approvalReview).toContainText('fingerprint');
    await expect(approvalReview).toContainText('airwallex_transfer');
    await expect(approvalReview).toContainText('USD v1');
    await approve.getByTestId('approve-submit-btn').click();

    // The SERVER refuses self-approval with its real code and useful language —
    // rendered as a first-class outcome, not swallowed.
    await expect(approve.getByTestId('governed-error')).toContainText('AUTH_SELF_APPROVAL', {
      timeout: 10_000,
    });
    await expect(approve.getByTestId('governed-error')).toContainText(
      'separation of duties requires a different approver',
    );
  });

  test('operator can propose but the server refuses the approval with ROLE_FORBIDDEN', async ({
    page,
  }) => {
    await signIn(page, 'operator');
    await createMissionViaSheet(page, 'Operator governed attempt');
    // Operator cannot grant mandates; grant is skipped — approval will refuse
    // on both role and (owner-only) mandate grounds. Propose still works.
    await runIncidentJourney(page);

    await page.getByTestId('open-propose').click();
    const sheet = page.getByTestId('propose-plan-sheet');
    await sheet.getByLabel('Amount (USD)').fill('250');
    await sheet.getByLabel(/Beneficiary/).fill('harbor-diagnostics');
    await sheet.getByLabel(/Purpose/).fill('diagnostic sweep');
    await sheet.getByTestId('propose-review-btn').click();
    await sheet.getByTestId('propose-submit-btn').click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('plan-recorded')).toContainText('Plan recorded');

    // The approval affordance is observable; the server refuses the role.
    await page.getByTestId('open-approve').click();
    const approve = page.getByTestId('approve-plan-sheet');
    await expect(approve.getByTestId('approve-role-note')).toContainText('cannot approve');
    await approve.getByTestId('approve-review-btn').click();
    await approve.getByTestId('approve-submit-btn').click();
    await expect(approve.getByTestId('governed-error')).toContainText('ROLE_FORBIDDEN', {
      timeout: 10_000,
    });
  });

  test('viewer gets an honest refusal from the operate-gated synthetic journey', async ({
    page,
  }) => {
    await signIn(page, 'viewer');
    // Mission A ships with a journaled demo incident (read-only replay is fine
    // for a viewer). Select mission B — no journey yet — so the operate-gated
    // POST is actually attempted and the server's refusal becomes observable.
    await page
      .getByTestId('missions-panel')
      .getByRole('button', { name: /Subsea mooring survey/ })
      .click();
    await page.getByRole('link', { name: 'Decision Room' }).click();
    await expect(page.getByTestId('decision-room')).toBeVisible();
    const start = page.getByTestId('start-synthetic');
    await expect(start).toBeEnabled({ timeout: 10_000 });
    await start.click();
    await expect(page.getByTestId('decision-room')).toContainText(
      /ROLE_FORBIDDEN|may not operate|403/i,
      {
        timeout: 10_000,
      },
    );
  });
});
