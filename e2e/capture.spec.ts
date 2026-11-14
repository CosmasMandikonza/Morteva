import { expect, test } from '@playwright/test';

/**
 * Manual screenshot capture for PR evidence — run with:
 *   CAPTURE=1 npx playwright test e2e/capture.spec.ts
 * Writes committed evidence images into docs/assets (never test-results).
 */
const shouldCapture = !!process.env.CAPTURE;

test.skip(!shouldCapture, 'screenshot capture is opt-in (CAPTURE=1)');

test('capture app shell at 1440x900 and 390x844', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.screenshot({ path: 'docs/assets/app-shell-1440x900.png' });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('missions-panel')).toBeVisible();
  await page.screenshot({ path: 'docs/assets/app-shell-390x844.png', fullPage: true });

  // Error-state evidence at desktop width: a business read failing announces
  // itself in its own panel (no fabricated data, no developer instructions).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/missions', (route) => route.abort('connectionrefused'));
  await page.goto('/');
  await page.getByLabel('Username').fill('founder');
  await page.getByLabel('Password').fill('moterva-e2e-demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await page.screenshot({ path: 'docs/assets/app-shell-api-offline-1440x900.png' });
});
