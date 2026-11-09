import { test } from '@playwright/test';

test('probe: what does the Playwright page see', async ({ page }) => {
  await page.goto('/mission-viewer.html?fixture=primary');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2500);
  const probe = await page.evaluate(() => {
    const w = window as { __MPV_DEBUG?: unknown; __MPV_FIXTURES_RAW?: Record<string, unknown> };
    return {
      hasDebug: !!w.__MPV_DEBUG,
      hasRaw: !!w.__MPV_FIXTURES_RAW,
      rawKeys: w.__MPV_FIXTURES_RAW ? Object.keys(w.__MPV_FIXTURES_RAW) : null,
      url: location.href,
      title: document.title,
    };
  });
  console.info('PROBE:', JSON.stringify(probe));
});
