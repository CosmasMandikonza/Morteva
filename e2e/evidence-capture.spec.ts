import { expect, test, type Page } from '@playwright/test';

/**
 * Evidence Replay visual capture (screen-owner pass): reference screenshots
 * at 1440×900 / 1024×900 / 390×844 / 320×844 in dark and light, plus the
 * inspector state — written to research/mtv-20-evidence/ for the PR's
 * before/after comparison. Each viewport/theme pair runs in its own test
 * (fresh context; the seeded ledger restores per test) so no state carries
 * between captures.
 */
async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill('founder');
  await page.getByLabel('Password').fill('moterva-e2e-demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('actor-chip')).toBeVisible();
}

async function openTimelineReady(page: Page): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: 'Evidence Replay' }).click();
  await expect(page.getByTestId('evidence-panel')).toBeVisible();
  await expect(page.getByTestId('evidence-list').locator('.mv-evrow__title').first()).toBeVisible();
}

const SHOTS = 'research/mtv-20-evidence';
const VIEWPORTS = [
  [1440, 900],
  [1024, 900],
  [390, 844],
  [320, 844],
] as const;

for (const theme of ['dark', 'light'] as const) {
  for (const [width, height] of VIEWPORTS) {
    test(`timeline ${theme} ${width}x${height}`, async ({ page }) => {
      await page.addInitScript((t) => {
        window.localStorage.setItem('moterva-theme', t as string);
      }, theme);
      await page.setViewportSize({ width, height });
      await signIn(page);
      await openTimelineReady(page);
      await page.screenshot({
        path: `${SHOTS}/timeline-${theme}-${width}x${height}.png`,
        fullPage: width < 700,
      });
    });
  }
}

test('timeline inspector 1440x900', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await openTimelineReady(page);
  await page.getByTestId('evidence-list').locator('.mv-evrow__select').first().click();
  await expect(page.getByTestId('evidence-detail')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/timeline-inspector-1440x900.png` });
});

test('timeline zoom-200 (720x450 CSS budget)', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 450 });
  await signIn(page);
  await openTimelineReady(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${SHOTS}/timeline-zoom200-720x450.png`, fullPage: true });
});
