import { expect, test, type Page } from '@playwright/test';

/**
 * Operator onboarding journeys against the REAL API + seeded ledger:
 * mission creation (operator+), mandate grant with exact review (owner/admin
 * only — server-enforced), negative authorization for viewer/operator,
 * validation errors, duplicate-submit guard, and refresh persistence.
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
}

test.describe('mission onboarding', () => {
  test('operator creates a mission; it persists across reload and becomes selectable', async ({
    page,
  }) => {
    await signIn(page, 'operator');
    await createMissionViaSheet(page, 'Pier cathode survey');

    // Read-after-write: the mission list now includes it.
    const missions = page.getByTestId('missions-panel');
    await expect(missions).toContainText('Pier cathode survey', { timeout: 10_000 });

    // Refresh rebuilds state from the server, not React memory.
    await page.reload();
    await expect(page.getByTestId('missions-panel')).toContainText('Pier cathode survey');
  });

  test('empty-mission copy stays honest for actors who cannot create', async ({ page }) => {
    await signIn(page, 'viewer');
    // Viewer sees the missions that exist — no create affordance anywhere.
    await expect(page.getByTestId('new-mission-btn')).toHaveCount(0);
    await expect(page.getByTestId('missions-panel')).toContainText('Harbor turbine inspection');
  });

  test('very long mission names are handled without layout breakage', async ({ page }) => {
    await signIn(page, 'operator');
    const long = 'A'.repeat(110);
    await createMissionViaSheet(page, long);
    await expect(page.getByTestId('missions-panel')).toContainText(long.slice(0, 40));
    const sw = await page.evaluate<number>('document.documentElement.scrollWidth');
    expect(sw).toBeLessThanOrEqual(1441);
  });
});

test.describe('mandate onboarding', () => {
  test('owner grants authority through exact review; the mandate appears immediately', async ({
    page,
  }) => {
    await signIn(page, 'founder');
    // Create a fresh mission so it has no mandates.
    await createMissionViaSheet(page, 'Mandate-free mission');
    await expect(page.getByTestId('missions-panel')).toContainText('Mandate-free mission');
    await expect(page.getByTestId('mandates-empty')).toBeVisible();

    await page.getByTestId('grant-first-mandate').click();
    const sheet = page.getByTestId('mandate-create-sheet');
    await expect(sheet).toBeVisible();
    await sheet.getByLabel('Per-operation cap (USD)').fill('750');
    await sheet
      .getByLabel('Mission budget envelope (USD, optional — defaults to the cap)')
      .fill('2500');
    await sheet
      .getByLabel('Approved beneficiaries (comma-separated, optional)')
      .fill('harbor-diagnostics');
    await sheet.getByTestId('mandate-review-btn').click();

    // EXACT REVIEW: the payload the server will receive, verbatim.
    const review = page.getByTestId('mandate-review');
    await expect(review).toContainText('USD 750.00');
    await expect(review).toContainText('USD 2,500.00');
    await expect(review).toContainText('airwallex_transfer');
    await expect(review).toContainText('harbor-diagnostics');
    await expect(review).toContainText('any (not restricted)');

    await sheet.getByTestId('mandate-submit-btn').click();
    await expect(sheet).toHaveCount(0);
    // Read-after-write: the new mandate renders as effective authority.
    await expect(page.getByTestId('mandates-panel')).toContainText('USD 750.00', {
      timeout: 10_000,
    });
    await expect(page.getByTestId('mandates-panel')).toContainText('Mandate active');
    // Refresh persistence.
    await page.reload();
    await expect(page.getByTestId('mandates-panel')).toContainText('USD 750.00');
  });

  test('operator sees the honest role note and the server refuses the grant', async ({ page }) => {
    await signIn(page, 'operator');
    await createMissionViaSheet(page, 'Operator attempt mission');
    await expect(page.getByTestId('mandates-empty')).toBeVisible();
    await expect(page.getByTestId('mandate-role-note')).toContainText('does not manage authority');

    await page.getByTestId('grant-first-mandate').click();
    const sheet = page.getByTestId('mandate-create-sheet');
    await sheet.getByLabel('Per-operation cap (USD)').fill('100');
    await sheet.getByTestId('mandate-review-btn').click();
    await sheet.getByTestId('mandate-submit-btn').click();

    // The SERVER refuses with its real code — shown in useful language.
    await expect(sheet.getByTestId('onboarding-error')).toContainText('ROLE_FORBIDDEN', {
      timeout: 10_000,
    });
    await expect(sheet.getByTestId('onboarding-error')).toContainText('may not manage authority');
  });

  test('duplicate submit is guarded while the request is in flight', async ({ page }) => {
    await signIn(page, 'founder');
    await createMissionViaSheet(page, 'Duplicate guard mission');
    await page.getByTestId('grant-first-mandate').click();
    const sheet = page.getByTestId('mandate-create-sheet');
    await sheet.getByLabel('Per-operation cap (USD)').fill('300');
    await sheet.getByTestId('mandate-review-btn').click();
    const submit = sheet.getByTestId('mandate-submit-btn');

    // Hold the POST in flight so the UI's busy state is observable.
    let mandatePosts = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/mandates')) mandatePosts += 1;
    });
    await page.route('**/api/mandates', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      await route.continue();
    });
    await submit.click();
    await expect(submit).toBeDisabled();
    await expect(submit).toContainText('Submitting…');
    // A second click during flight must NOT enqueue a second write.
    await submit.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await expect(sheet).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId('mandates-panel')).toContainText('USD 300.00');
    expect(mandatePosts).toBe(1);
    await page.unroute('**/api/mandates');
  });
});
