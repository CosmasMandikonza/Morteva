import { expect, test } from '@playwright/test';

/**
 * Production shell smoke (MTV-08.2): navigation, honest status, the real
 * Mission Treasury session gate, theme switching and narrow-viewport
 * integrity. In CI the API runs WITHOUT the DEMO_AUTH gate, so financial
 * routes are absent (404) and the Treasury must render its honest
 * "not available" deployment state — never fixture data.
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

    // Breadcrumb orientation.
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
      'Mission Treasury',
    );

    // Real visible status from the live API (proxied): providers OFFLINE.
    await expect(page.getByRole('heading', { name: 'System status' })).toBeVisible();
    await expect(page.locator('.mv-provider__name', { hasText: 'airwallex' })).toBeVisible();
    await expect(page.locator('.mv-provider__name', { hasText: 'metal' })).toBeVisible();
    await expect(page.locator('.mv-badge--offline')).toHaveCount(2);
    await expect(page.getByText(/provider mode/i)).toContainText(/offline/i);

    // Honesty contract: the shell must never claim a provider is connected.
    await expect(page.getByText(/connected/i)).toHaveCount(0);
  });

  test('Mission Treasury shows the honest not-available state without DEMO_AUTH (CI parity)', async ({
    page,
  }) => {
    await page.goto('/');

    const gate = page.getByTestId('auth-unavailable');
    const response = await page.request.get('/api/auth/session');
    if (response.status() === 404) {
      // Financial routes are not registered in this deployment.
      await expect(gate).toBeVisible();
      await expect(gate).toContainText('does not expose the financial API');
      await expect(gate).toContainText('No simulated or fixture data');
    } else {
      // Local run with the demo gate: the sign-in panel renders instead.
      await expect(page.getByTestId('signin-panel')).toBeVisible();
    }
    // Never fixture money in the production UI.
    await expect(page.getByText('USD 184,250')).toHaveCount(0);
  });

  test('primary navigation switches surfaces with honest planned states', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('link', { name: 'Decision Room' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Decision Room' })).toBeVisible();
    await expect(page.getByTestId('planned-status')).toContainText('#13');
    await expect(page.getByTestId('planned-status')).toContainText('No mock data');

    await page.getByRole('link', { name: 'Authority & Execution' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Authority & Execution' }),
    ).toBeVisible();
    await expect(page.getByTestId('planned-status')).toContainText('#7');
  });

  test('theme toggle switches the semantic tokens', async ({ page }) => {
    await page.goto('/');
    const body = page.locator('body');
    await expect(body).toHaveCSS('background-color', 'rgb(10, 10, 11)');

    await page.getByRole('button', { name: 'Light mode' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(body).toHaveCSS('background-color', 'rgb(244, 244, 245)');
    await expect(page.getByRole('button', { name: 'Dark mode' })).toBeVisible();
  });

  test('no horizontal overflow at 320px and 390px on the treasury', async ({ page }) => {
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      const scrollWidth = await page.evaluate<number>('document.documentElement.scrollWidth');
      expect(scrollWidth).toBeLessThanOrEqual(width + 1);
    }
  });

  test('health endpoint is live through the dev/preview proxy', async ({ request }) => {
    const response = await request.get('/healthz');
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('moterva-api');
  });
});
