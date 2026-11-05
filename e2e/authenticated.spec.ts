import { expect, test } from '@playwright/test';

/**
 * Authenticated operator journey against the REAL API + seeded throwaway
 * ledger (e2e/scripts/demo-auth-server.mjs): login → missions → mandate
 * envelope math → lapsed-expiry honesty → mission switch → reload keeps the
 * session → sign out works with the persisted CSRF token.
 */
test.describe('authenticated treasury journey', () => {
  test('login renders real ledger data with honest mandate states', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Username').fill('founder');
    await page.getByLabel('Password').fill('moterva-e2e-demo');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByTestId('actor-chip')).toContainText('E2E Founder');

    // Real missions from the ledger.
    const missions = page.getByTestId('missions-panel');
    await expect(missions).toContainText('Harbor turbine inspection');
    await expect(missions).toContainText('Subsea mooring survey');

    // Real envelope math: USD 150,000.00 total, 60,000.00 committed → 90,000.00 remaining.
    const mandates = page.getByTestId('mandates-panel');
    await expect(mandates).toContainText('USD 90,000.00');
    await expect(mandates).toContainText('of 150,000.00 envelope');
    await expect(mandates).toContainText('40% committed');

    // Honest status semantics: three active mandates (USD, EUR and the
    // clock-lapsed GBP), a superseded history row, and the lapsed surfacing.
    await expect(mandates.locator('.mv-chip--info', { hasText: 'Mandate active' })).toHaveCount(3);
    await expect(mandates.locator('.mv-chip--neutral', { hasText: 'Superseded' })).toBeVisible();
    await expect(page.getByTestId('lapsed-tag')).toContainText('expiry passed');
    await expect(mandates.getByText('— lapsed')).toBeVisible();

    // Mission selection actually drives the content.
    await page.getByRole('button', { name: /Subsea mooring survey/ }).click();
    await expect(page.getByTestId('mission-hero')).toContainText('Subsea mooring survey');
    await expect(page.getByTestId('mandates-panel')).toContainText('USD 48,000.00');

    // The fixture-free honesty contract still holds.
    await expect(page.getByText('USD 184,250')).toHaveCount(0);
  });

  test('session survives reload and sign out works with the persisted CSRF token', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByLabel('Username').fill('founder');
    await page.getByLabel('Password').fill('moterva-e2e-demo');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('actor-chip')).toBeVisible();

    // Reload: cookie session + stored CSRF token must keep Sign out functional.
    await page.reload();
    await expect(page.getByTestId('actor-chip')).toContainText('E2E Founder');
    await expect(page.getByTestId('missions-panel')).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByTestId('signin-panel')).toBeVisible();
    await expect(page.getByTestId('actor-chip')).toHaveCount(0);
  });

  test('wrong password shows the server error, never a session', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Username').fill('founder');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('invalid credentials');
    await expect(page.getByTestId('signin-panel')).toBeVisible();
    await expect(page.getByTestId('actor-chip')).toHaveCount(0);
  });
});
