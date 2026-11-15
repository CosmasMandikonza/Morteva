import { expect, test } from '@playwright/test';

/**
 * MTV-21 — public landing integration (issue #21).
 *
 * The public landing lives at /; the authenticated Mission Treasury app moved
 * to /app with its hash-section deep links intact. These tests cover the
 * public surface honestly: sample-scenario labeling, no financial data
 * exposure, working entrance, legacy deep-link compatibility, theme and
 * reduced-motion behavior.
 */
test.describe('public landing', () => {
  test('/ renders the editorial landing without financial data', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('landing')).toBeVisible();

    // Mandated hero copy.
    await expect(page.locator('.lp-title').first()).toContainText(
      'When the mission changes, the money should know.',
    );

    // Honest sample-scenario provenance.
    await expect(page.locator('.lp-consequence__provenance')).toContainText(
      'Sample scenario from the documented demo mission',
    );

    // No financial data leaks to the public page.
    await expect(page.getByText(/USD 164,000|USD 76,500/)).toHaveCount(0);
    await expect(page.getByTestId('missions-panel')).toHaveCount(0);
    await expect(page.getByTestId('signin-panel')).toHaveCount(0);
    await expect(page.getByTestId('system-status')).toHaveCount(0);

    // The four chapters link into the real app surfaces.
    for (const link of ['Evidence Replay', 'Decision Room', 'Authority & Execution']) {
      await expect(page.locator('.lp-chapter__link', { hasText: link }).first()).toBeVisible();
    }
    await expect(page.locator('.lp-chapter__link[href="/app#decisions"]').first()).toBeVisible();
  });

  test('the signature interaction advances baseline → incident → alternative → proposal', async ({
    page,
  }) => {
    await page.goto('/');
    const headline = page.locator('.lp-consequence__headline');
    await expect(headline).toContainText('The plan holds — hold the spend.');

    await page.getByRole('button', { name: /signed wind incident lands/ }).click();
    await expect(headline).toContainText('24.6 kt against a 22 kt modeled limit.');

    await page
      .getByRole('button', { name: /vessel alternative becomes the feasible path/ })
      .click();
    await expect(headline).toContainText('The feasible set changes');

    await page
      .getByRole('button', { name: /Governed proposal — a human approves exact terms/ })
      .click();
    await expect(headline).toContainText('Proposed — not paid. A separate person approves.');
    await expect(page.locator('.lp-consequence__facts')).toContainText('awaiting approval');
  });

  test('the entrance CTA opens the real app with auth intact', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('lp-enter')).toContainText('Enter MOTERVA');
    await page.getByTestId('lp-enter').click();
    await page.waitForURL('**/app');
    // The app shell renders (sign-in gate on an unauthenticated session).
    await expect(page.getByTestId('signin-panel')).toBeVisible({ timeout: 10_000 });
  });

  test('legacy deep links still reach the app sections', async ({ page }) => {
    // Old bare-origin hash links.
    await page.goto('/#decisions');
    await page.waitForURL('**/app#decisions');
    await expect(page.getByTestId('decision-room')).toBeVisible({ timeout: 10_000 });

    // Old path-style links.
    await page.goto('/authority');
    await page.waitForURL('**/app#authority');
    await expect(page.getByTestId('authority-surface')).toBeVisible({ timeout: 10_000 });
  });

  test('light/dark theme persists across landing and app', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Light mode' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.goto('/app');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.getByRole('button', { name: 'Dark mode' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('landing is responsive without horizontal overflow (320/390/768/1440)', async ({ page }) => {
    await page.goto('/');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      const sw = await page.evaluate<number>('document.documentElement.scrollWidth');
      expect(sw, `scrollWidth at ${String(width)}`).toBeLessThanOrEqual(width);
      await expect(page.locator('.lp-title').first()).toBeVisible();
    }
  });

  test('reduced motion still renders the complete landing', async ({ browser }) => {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.getByTestId('landing')).toBeVisible();
    await expect(page.locator('.lp-title').first()).toContainText('When the mission changes');
    await expect(page.locator('.lp-consequence__headline')).toBeVisible();
    await page.close();
  });
});
