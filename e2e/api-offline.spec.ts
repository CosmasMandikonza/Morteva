import { expect, test } from '@playwright/test';

/**
 * Negative UX case: backend offline / config missing. The shell must show an
 * explicit error state with a retry affordance — never a fake success badge.
 */
test('shows an explicit API-offline error state when the backend is unreachable', async ({
  page,
}) => {
  await page.route('**/api/system/status', (route) => route.abort('connectionrefused'));

  await page.goto('/');

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('API offline');
  await expect(alert).toContainText('/api/system/status');
  await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();

  // No OFFLINE badges may render from fabricated data in the error state.
  await expect(page.locator('.mv-badge--offline')).toHaveCount(0);
  await expect(page.getByText(/connected/i)).toHaveCount(0);
});

test('recovers from the error state once the API answers again', async ({ page }) => {
  let offline = true;
  await page.route('**/api/system/status', async (route) => {
    if (offline) {
      await route.abort('connectionrefused');
    } else {
      const response = await route.fetch();
      await route.fulfill({ response });
    }
  });

  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('API offline');

  offline = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('.mv-badge--offline')).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
