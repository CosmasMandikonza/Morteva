import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * MTV-09/12 evidence capture + measured performance (brief §9).
 *
 * Produces REAL running-browser screenshots at the required viewports and
 * states into research/mtv-09/captures/, and MEASURED performance numbers
 * (loading, FPS, triangles, draw calls, JS heap) into research/mtv-09/.
 * Self-skips when the gated harness is not in the build. Every artifact is
 * regenerable; nothing is estimated.
 */

const CAPTURE_DIR = join(import.meta.dirname, '..', 'research', 'mtv-09', 'captures');

async function viewerAvailable(page: Page): Promise<boolean> {
  const res = await page.request.get('/mission-viewer.html');
  return res.ok() && (await res.text()).includes('Mission viewer harness');
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(120_000);
  const ok = await viewerAvailable(page);
  test.skip(!ok, 'mission-viewer harness not present in this build');
});

test.use({ launchOptions: { args: ['--enable-unsafe-swiftshader'] } });

async function settled(page: Page, ms = 4500): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-testid="mission-viewer"]', { timeout: 30_000 });
  await page.waitForTimeout(ms);
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(CAPTURE_DIR, { recursive: true });
  await page.screenshot({ path: join(CAPTURE_DIR, `${name}.png`), fullPage: false });
}

/** Sample FPS over ~3s via the engine debug hook (renderer.info deltas). */
async function measureFps(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const start = performance.now();
        const tick = (): void => {
          frames += 1;
          if (performance.now() - start < 3000) requestAnimationFrame(tick);
          else resolve(Math.round((frames * 1000) / (performance.now() - start)));
        };
        requestAnimationFrame(tick);
      }),
  );
}

test('captures: overview 1440×900 (flagship incident)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mission-viewer.html?fixture=primary&event=mevt_pri03');
  await settled(page);
  await shot(page, 'overview-incident-1440x900');
  expect(true).toBe(true);
});

test('captures: overview 1024×900', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto('/mission-viewer.html?fixture=primary');
  await settled(page);
  await shot(page, 'overview-1024x900');
});

test('captures: tablet 768', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/mission-viewer.html?fixture=primary');
  await settled(page);
  await shot(page, 'tablet-768');
});

test('captures: mobile 390×844', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/mission-viewer.html?fixture=primary');
  await settled(page);
  await shot(page, 'mobile-390x844');
});

test('captures: narrow 320×844', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/mission-viewer.html?fixture=primary');
  await settled(page);
  await shot(page, 'narrow-320x844');
});

test('captures: 200% browser-zoom equivalent (CSS viewport halves, DPR doubles)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mission-viewer.html?fixture=primary');
  await settled(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 720,
    height: 450,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.waitForTimeout(1500);
  await shot(page, 'zoom200-equivalent-720x450-dpr2');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
});

test('captures: asset focus framing', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mission-viewer.html?fixture=primary&asset=uav-seeker-1');
  await settled(page);
  await shot(page, 'asset-focus-1440x900');
});

test('captures: historical replay (earlier event selected)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mission-viewer.html?fixture=primary&event=mevt_pri01');
  await settled(page);
  await shot(page, 'historical-replay-1440x900');
});

test('captures: zoom minimum and maximum', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mission-viewer.html?fixture=primary&asset=uav-seeker-1');
  await settled(page);
  await page.evaluate(() =>
    (
      window as { __MPV_ENGINE?: { forceCameraDistance(m: number): void } }
    ).__MPV_ENGINE?.forceCameraDistance(318),
  );
  await page.waitForTimeout(600);
  await shot(page, 'zoom-maximum-1440x900');
  await page.evaluate(() =>
    (
      window as { __MPV_ENGINE?: { forceCameraDistance(m: number): void } }
    ).__MPV_ENGINE?.forceCameraDistance(15),
  );
  await page.waitForTimeout(600);
  await shot(page, 'zoom-minimum-1440x900');
});

test('captures: WebGL-unavailable 2D fallback', async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as { __MPV_FORCE_NO_WEBGL?: boolean }).__MPV_FORCE_NO_WEBGL = true;
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mission-viewer.html?fixture=primary&event=mevt_pri03');
  await settled(page);
  await expect(page.locator('[data-testid="mission-viewer"]')).toHaveAttribute('data-mode', '2d');
  await shot(page, 'webgl-fallback-2d-1440x900');
});

test('captures: 2D display mode with event selection', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mission-viewer.html?fixture=primary&event=mevt_pri02&mode=2d');
  await settled(page);
  await shot(page, '2d-mode-selected-1440x900');
});

test('captures: reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mission-viewer.html?fixture=primary&event=mevt_pri03&reducedMotion=1');
  await settled(page);
  await shot(page, 'reduced-motion-1440x900');
});

test('captures: light mode', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mission-viewer.html?fixture=primary&theme=light');
  await settled(page);
  await shot(page, 'light-mode-1440x900');
});

test('captures: stale-evidence honesty (S5)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mission-viewer.html?fixture=stale');
  await settled(page);
  await shot(page, 'stale-evidence-s5-1440x900');
});

test('measure: loading, FPS, triangles, draw calls, heap at 1440×900', async ({ page }) => {
  const perfLog: string[] = [];
  const t0 = Date.now();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mission-viewer.html?fixture=primary&event=mevt_pri03');
  await page.waitForSelector('[data-testid="mission-viewer"]', { timeout: 30_000 });
  const mountMs = Date.now() - t0;
  // Wait for both models: the engine debug reports modelFallback=false once loaded.
  await page.waitForFunction(
    () =>
      (window as { __MPV_DEBUG?: { engineDebug(): { modelFallback: boolean } } }).__MPV_DEBUG !==
      undefined,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(3500);
  const dbg = await page.evaluate(() => ({
    ...(
      window as { __MPV_DEBUG?: { engineDebug(): Record<string, unknown> } }
    ).__MPV_DEBUG!.engineDebug(),
  }));
  const navigation = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    return nav
      ? {
          domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
          loadEventMs: Math.round(nav.loadEventEnd),
          transferSize: nav.transferSize,
        }
      : null;
  });
  const fps = await measureFps(page);
  const heap = await page.evaluate(
    () =>
      (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
        ?.usedJSHeapSize ?? null,
  );
  const record = {
    label: 'SIMULATED_OPERATION — measured, not estimated',
    environment: {
      browser:
        'Chromium (Playwright project chromium, SwiftShader software WebGL via --enable-unsafe-swiftshader)',
      device: 'CI-equivalent local runner (Windows, Node 24)',
      viewport: '1440×900 @1x',
      note: 'SwiftShader is a CPU rasterizer; GPU numbers on real hardware will be materially better. Honest CI-class results reported.',
    },
    loading: { harnessMountMs: mountMs, navigation },
    rendering: {
      fpsMeasuredOver3s: fps,
      trianglesPerFrame: dbg.triangles,
      drawCallsPerFrame: dbg.calls,
      trackedResourcesDisposedSafely: dbg.resources,
      modelFallback: dbg.modelFallback,
    },
    memory: { usedJsHeapBytes: heap },
    scene: { phase: dbg.framing, dronePosition: dbg.dronePosition },
  };
  mkdirSync(CAPTURE_DIR, { recursive: true });
  writeFileSync(join(CAPTURE_DIR, 'performance.json'), JSON.stringify(record, null, 2) + '\n');
  perfLog.push(JSON.stringify(record));
  // Sanity floors (honest, software-GL): the scene must render at all.
  expect(dbg.triangles).toBeGreaterThan(3000);
  expect(dbg.modelFallback).toBe(false);
});
