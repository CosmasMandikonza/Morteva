import { expect, test, type Page } from '@playwright/test';

/**
 * MTV-20 Authority & Execution surface — the full two-person flow seen from
 * the authority lens: exact terms, immutable digest, stepper truth, and the
 * journal-verified approval visible to the proposer afterwards.
 */
const PASSWORD = ['moterva', 'e2e', 'demo'].join('-');

async function signIn(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('actor-chip')).toBeVisible();
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByTestId('actor-chip')).toHaveCount(0);
}

test.describe('authority & execution surface', () => {
  test('operator → authority shows stepper and no approve grant; approver approves; proposer sees journal-verified state', async ({
    page,
  }) => {
    // founder: create + grant
    await signIn(page, 'founder');
    await page.getByTestId('new-mission-btn').click();
    const ms = page.getByTestId('mission-create-sheet');
    await ms.getByLabel('Mission name').fill('Authority surface mission');
    await ms.getByTestId('create-mission-submit').click();
    await expect(page.getByTestId('missions-panel')).toContainText('Authority surface mission', {
      timeout: 10_000,
    });
    await page.getByTestId('grant-first-mandate').click();
    const g = page.getByTestId('mandate-create-sheet');
    await g.getByLabel('Per-operation cap (USD)').fill('25000');
    await g.getByLabel(/Approved beneficiaries/).fill('harbor-diagnostics, harbor-marine');
    await g.getByLabel(/Approved purposes/).fill('harbor inspection');
    await g.getByTestId('mandate-review-btn').click();
    await g.getByTestId('mandate-submit-btn').click();
    await expect(g).toHaveCount(0, { timeout: 10_000 });
    await signOut(page);

    // operator: drive journey, propose, inspect the AUTHORITY surface
    await signIn(page, 'operator');
    await page
      .getByTestId('missions-panel')
      .getByRole('button', { name: /Authority surface mission/ })
      .first()
      .click();
    await page.getByRole('link', { name: 'Decision Room' }).click();
    await expect(page.getByTestId('start-synthetic')).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId('start-synthetic').click();
    await page.getByTestId('snapshot-baseline').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('introduce-incident').click();
    await page.getByTestId('snapshot-incident').waitFor({ state: 'visible', timeout: 15_000 });
    // Transient contention 409 possible on the first propose — retry.
    await expect(async () => {
      await page.getByTestId('propose-plan').click();
      await expect(page.getByTestId('decision-plan-row')).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });

    await page.getByRole('link', { name: 'Authority & Execution' }).click();
    const surface = page.getByTestId('authority-surface');
    await expect(surface).toBeVisible();
    await expect(surface).toContainText('per action'); // effective mandate cap
    await expect(surface).toContainText('% committed'); // envelope bar text equivalent
    await expect(surface.getByTestId('workflow-stepper')).toBeVisible();
    // stepper truth: Proposed done, Approved active, Reservation pending
    const stepper = surface.getByTestId('workflow-stepper');
    await expect(stepper).toContainText('Proposed');
    await expect(stepper).toContainText('different actor required');
    await expect(surface).toContainText('provider rail is offline'); // honest boundary
    // operator has no approve grant → no approval affordance
    await expect(surface.getByTestId('authority-open-approve')).toHaveCount(0);
    await signOut(page);

    // approver: sees persisted exact terms on the authority surface, approves
    await signIn(page, 'approver');
    await page
      .getByTestId('missions-panel')
      .getByRole('button', { name: /Authority surface mission/ })
      .first()
      .click();
    await page.getByRole('link', { name: 'Authority & Execution' }).click();
    const asurface = page.getByTestId('authority-surface');
    await expect(asurface).toContainText('harbor-marine'); // persisted server terms
    await expect(asurface).toContainText('harbor inspection');
    await asurface.getByTestId('authority-open-approve').click();
    const sheet = page.getByTestId('approve-plan-sheet');
    await sheet.getByTestId('approve-review-btn').click();
    await expect(sheet.getByTestId('approval-review')).toContainText('fingerprint');
    await sheet.getByTestId('approve-submit-btn').click();
    await expect(sheet).toHaveCount(0, { timeout: 15_000 });
    await expect(asurface.getByTestId('authority-approval')).toBeVisible({ timeout: 15_000 });
    await signOut(page);

    // operator returns: the journal-verified approval is visible to the proposer
    await signIn(page, 'operator');
    await page
      .getByTestId('missions-panel')
      .getByRole('button', { name: /Authority surface mission/ })
      .first()
      .click();
    await page.getByRole('link', { name: 'Authority & Execution' }).click();
    await expect(page.getByTestId('authority-approval')).toBeVisible({ timeout: 15_000 });
  });
});
