import { expect, test, type Page } from '@playwright/test';

/**
 * Manual screenshot capture for MTV-08 design-lab PR evidence — run with:
 *   CAPTURE=1 VITE_DESIGN_LAB=1 npx playwright test e2e/design-lab-capture.spec.ts
 * against a lab-enabled build. Writes committed evidence images into
 * docs/assets/design-lab (never test-results). Mirrors capture.spec.ts.
 */
const shouldCapture = !!process.env.CAPTURE;

test.skip(!shouldCapture, 'screenshot capture is opt-in (CAPTURE=1)');

const WIDTHS: Array<{ label: string; w: number; h: number }> = [
  { label: '320', w: 320, h: 800 },
  { label: '390', w: 390, h: 844 },
  { label: '768', w: 768, h: 1024 },
  { label: '1024', w: 1024, h: 800 },
  { label: '1440x900', w: 1440, h: 900 },
  { label: '1920', w: 1920, h: 1000 },
];

const DIR = 'docs/assets/design-lab';

async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(700); // fonts + entrance animations settle
}

test('capture both candidates: treasury + decision across widths', async ({ page }) => {
  for (const c of ['a', 'b'] as const) {
    for (const vp of WIDTHS) {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.goto(`/design-lab.html?c=${c}&screen=treasury`);
      await settle(page);
      await expect(page.locator(`[data-lab="${c}"]`)).toBeVisible();
      await page.screenshot({ path: `${DIR}/${c}-treasury-${vp.label}.png`, fullPage: true });

      if (['390', '768', '1440x900', '1920'].includes(vp.label)) {
        await page.goto(`/design-lab.html?c=${c}&screen=decision`);
        await settle(page);
        await page.screenshot({ path: `${DIR}/${c}-decision-${vp.label}.png`, fullPage: true });
      }
    }
  }
});

test('capture authority + replay at desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const c of ['a', 'b'] as const) {
    await page.goto(`/design-lab.html?c=${c}&screen=authority`);
    await settle(page);
    await page.screenshot({ path: `${DIR}/${c}-authority-1440x900.png`, fullPage: true });

    await page.goto(`/design-lab.html?c=${c}&screen=replay`);
    await settle(page);
    await page.screenshot({ path: `${DIR}/${c}-replay-1440x900.png`, fullPage: true });
  }
});

test('capture honest-state highlights (submitted, unknown, offline, stale, 3D fallback)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const c of ['a', 'b'] as const) {
    // SUBMITTED (amber, honest) on the authority console
    await page.goto(`/design-lab.html?c=${c}&screen=authority`);
    await settle(page);
    for (const label of [
      /Reserve USD 2,150/,
      /Approve exact terms/,
      /Submit to Airwallex/,
      /Dispatching/,
    ]) {
      await page.getByRole('button', { name: label }).click();
    }
    await expect(page.getByTestId('authority-state')).toHaveAttribute('data-state', 'SUBMITTED');
    await page.screenshot({ path: `${DIR}/${c}-authority-submitted-1440x900.png` });

    // STATUS UNKNOWN
    await page.getByRole('button', { name: /Simulate lost response|lost response/ }).click();
    await expect(page.getByTestId('authority-state')).toHaveAttribute(
      'data-state',
      'STATUS_UNKNOWN',
    );
    await page.screenshot({ path: `${DIR}/${c}-authority-unknown-1440x900.png` });

    // Provider offline (treasury) + 3D fallback (decision)
    await page.goto(`/design-lab.html?c=${c}`);
    await page.getByRole('button', { name: /State laboratory|state lab/ }).click();
    await page.getByRole('radio', { name: /Provider offline/ }).click();
    await settle(page);
    await page.screenshot({ path: `${DIR}/${c}-treasury-offline-1440x900.png`, fullPage: true });

    await page.getByRole('radio', { name: /3D unavailable/ }).click();
    await page.getByRole('link', { name: /Decision Room/ }).click();
    await settle(page);
    await expect(page.getByTestId('viewport-fallback')).toBeVisible();
    await page.screenshot({
      path: `${DIR}/${c}-decision-webgl-fallback-1440x900.png`,
      fullPage: true,
    });

    // Stale balance
    await page.getByRole('radio', { name: /Stale balance/ }).click();
    await page.getByRole('link', { name: /Mission Treasury/ }).click();
    await settle(page);
    await page.screenshot({ path: `${DIR}/${c}-treasury-stale-1440x900.png`, fullPage: true });
  }
});

test('capture 200% zoom equivalent (720 CSS px @2x dpr) + compare console', async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 720, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  for (const c of ['a', 'b'] as const) {
    await page.goto(`/design-lab.html?c=${c}&screen=treasury`);
    await settle(page);
    await page.screenshot({ path: `${DIR}/${c}-treasury-zoom200-720.png`, fullPage: true });
  }
  await ctx.close();

  const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page2.goto('/design-lab.html');
  await settle(page2);
  await page2.screenshot({ path: `${DIR}/founder-compare-1440x900.png` });
  await page2.close();
});
