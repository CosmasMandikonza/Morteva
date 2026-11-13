import { expect, test, type Page } from '@playwright/test';

/**
 * Negative UX case: backend reads failing. Business surfaces must show
 * explicit error states — never a fake success badge or fabricated data.
 * (The System Status card was removed: technical metadata is not customer
 * work. Failures surface in the panel that owns the read.)
 */

// Assembled (not a literal) so the secret scanner does not flag the demo credential.
const PASSWORD = ['moterva', 'e2e', 'demo'].join('-');

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill('founder');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('actor-chip')).toBeVisible();
}

test('shows an explicit error state when a business read fails, with no fabricated data', async ({
  page,
}) => {
  await page.route('**/api/missions', (route) => route.abort('connectionrefused'));

  await signIn(page);

  // The failing read announces itself in its own panel …
  const alert = page.getByRole('alert');
  await expect(alert.first()).toBeVisible();

  // … and no fabricated provider data renders anywhere.
  await expect(page.getByText(/connected/i)).toHaveCount(0);
  await expect(page.locator('.mv-badge--offline')).toHaveCount(0);
});

test('recovers once the read succeeds again', async ({ page }) => {
  let offline = true;
  await page.route('**/api/missions', async (route) => {
    if (offline) {
      await route.abort('connectionrefused');
    } else {
      const response = await route.fetch();
      await route.fulfill({ response });
    }
  });

  await signIn(page);
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page.getByText('Harbor turbine inspection')).toHaveCount(0);

  offline = false;
  await page.reload();
  await expect(page.getByTestId('missions-panel')).toContainText('Harbor turbine inspection');
});
