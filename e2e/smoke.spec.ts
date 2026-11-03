import { expect, test } from '@playwright/test';

/**
 * Real browser smoke: loads the app shell, asserts the honest visible status
 * and the primary navigation (issue #3 acceptance).
 */
test.describe('app shell smoke', () => {
  test('shows MOTERVA shell with primary navigation and honest OFFLINE status', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1, name: 'Mission Treasury' })).toBeVisible();
    await expect(page.getByText('MOTERVA').first()).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav).toBeVisible();
    for (const label of [
      'Mission Treasury',
      'Decision Room',
      'Authority & Execution',
      'Evidence Replay',
    ]) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible();
    }

    // Real visible status from the live API (proxied): providers OFFLINE.
    const status = page.getByRole('heading', { name: 'System status' });
    await expect(status).toBeVisible();
    await expect(page.locator('.provider__name', { hasText: 'airwallex' })).toBeVisible();
    await expect(page.locator('.provider__name', { hasText: 'metal' })).toBeVisible();
    await expect(page.locator('.badge--offline')).toHaveCount(2);
    await expect(page.getByText(/provider mode/i)).toContainText(/offline/i);

    // Honesty contract: the shell must never claim a provider is connected.
    await expect(page.getByText(/connected/i)).toHaveCount(0);
  });

  test('primary navigation switches sections with honest not-implemented states', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('planned-status')).toContainText('Not implemented in MTV-01');

    await page.getByRole('link', { name: 'Decision Room' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Decision Room' })).toBeVisible();
    await expect(page.getByTestId('planned-status')).toContainText('#13');

    await page.getByRole('link', { name: 'Authority & Execution' }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Authority & Execution' }),
    ).toBeVisible();
    await expect(page.getByTestId('planned-status')).toContainText('#7');
  });

  test('health endpoint is live through the dev/preview proxy', async ({ request }) => {
    const response = await request.get('/healthz');
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('moterva-api');
  });
});
