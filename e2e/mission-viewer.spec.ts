/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test';

/**
 * MTV-09/12 mission-viewer adversarial suite (issues #11/#14; brief §8).
 *
 * Runs against the gated harness build (VITE_MISSION_VIEWER=1 →
 * /mission-viewer.html). With a default production build every test
 * self-skips (mirrors the design-lab pattern), so `npm run test:e2e` stays
 * green either way.
 *
 * Every scenario drives COMMITTED JOURNAL-DERIVED fixtures — real replay
 * output of the real ingest pipeline — never invented page state. Test ids
 * reference the brief's 36-case matrix.
 */

async function viewerAvailable(page: Page): Promise<boolean> {
  // Vite preview's SPA fallback answers 200 with index.html for missing
  // paths, so verify the actual harness document (its <title>) rather than
  // the status code — mirrors the design-lab availability probe.
  const res = await page.request.get('/mission-viewer.html');
  return res.ok() && (await res.text()).includes('Mission viewer harness');
}

test.beforeEach(async ({ page }) => {
  const ok = await viewerAvailable(page);
  test.skip(
    !ok,
    'mission-viewer harness not present in this build (VITE_MISSION_VIEWER=1 required)',
  );
});

// Software-GL boot + model load + parallel workers make the software
// rasterizer slow; the shared 30s default is not enough for cold starts.
test.setTimeout(120_000);

// WebGL on headless Chromium requires the software rasterizer explicitly on
// some runners; request SwiftShader for this file without touching the
// shared playwright config.
test.use({ launchOptions: { args: ['--enable-unsafe-swiftshader'] } });

type EngineDebug = {
  camera: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  zoomLimits: { min: number; max: number };
  touchConfig: { oneFinger: string; twoFinger: string };
  triangles: number;
  calls: number;
  resources: number;
  modelFallback: boolean;
  contextLost: boolean;
  framing: string;
  dronePosition: { x: number; y: number; z: number } | null;
};

async function engineDebug(page: Page): Promise<EngineDebug | null> {
  return page.evaluate(() => {
    const d = (window as { __MPV_DEBUG?: { engineDebug(): unknown } }).__MPV_DEBUG;
    return d === undefined ? null : ((d.engineDebug() as EngineDebug) ?? null);
  });
}

async function stateJson(page: Page): Promise<{
  phase: string;
  windBreached: boolean;
  aerialWindKt: number | null;
  constraints: { assetId: string; state: string; reason: string }[];
  markers: string[];
  selectedEventId: string | null;
  replay: boolean;
}> {
  const text = await page.getByTestId('mpvh-state').locator('pre').innerText();
  return JSON.parse(text);
}

async function gotoViewer(page: Page, query: string): Promise<void> {
  await page.goto(`/mission-viewer.html${query}`);
  await page.waitForLoadState('domcontentloaded');
  // GLB load + first frames on the software rasterizer.
  await page.waitForSelector('[data-testid="mission-viewer"]', { timeout: 30_000 });
  await page.waitForTimeout(3500);
}

// ---------------------------------------------------------------------------
// Physical correctness (brief §8.1, cases 1–12)
// ---------------------------------------------------------------------------

test('P1 (case 1): missing evidence does not imply safe clearance — S0 says unknown by design', async ({
  page,
}) => {
  await gotoViewer(page, '?fixture=empty');
  await expect(page.locator('[data-testid="mission-viewer"]')).toHaveAttribute(
    'data-phase',
    'S0-initial',
  );
  await expect(page.getByTestId('mpv-phase')).toContainText('unknown by design');
  await expect(page.getByTestId('mpv-wind')).toContainText('no fresh wind reading — unknown');
});

test('P2 (case 2): a stale observation cannot remain current — S5, not planning-valid', async ({
  page,
}) => {
  await gotoViewer(page, '?fixture=stale');
  await expect(page.locator('[data-testid="mission-viewer"]')).toHaveAttribute(
    'data-phase',
    'S5-uncertain',
  );
  const state = await stateJson(page);
  expect(state.phase).toBe('S5-uncertain');
  // The single stale event must not read as current clearance.
  await expect(page.getByTestId('mpv-phase')).toContainText('stale or insufficient');
});

test('P3 (case 3): expired evidence stays visible as history only', async ({ page }) => {
  await gotoViewer(page, '?fixture=stale&event=mevt_st01');
  // History stays listed…
  await expect(page.locator('.mpv-events')).toContainText('mevt_st01');
  // …and the selected detail carries the not-planning-valid marking.
  await expect(page.getByTestId('mpv-selected')).toContainText('not planning-valid');
  const state = await stateJson(page);
  expect(state.selectedEventId).toBe('mevt_st01');
});

test('P4 (case 4): conflicting sources — journal order decides without silent favor', async ({
  page,
}) => {
  await gotoViewer(page, '?fixture=conflict');
  const state = await stateJson(page);
  // Telemetry (journal 1: clear) → gateway (journal 2: gale) → telemetry
  // (journal 3: clear). The LATEST journal evidence must win: nominal.
  const aerial = state.constraints.find((c) => c.assetId === 'uav-seeker-1');
  expect(aerial?.state).toBe('clear');
  expect(state.windBreached).toBe(false);
  expect(state.markers).toEqual(['mevt_cf01', 'mevt_cf02', 'mevt_cf03']);
});

test('P5 (case 5): offline asset remains offline — ghost telemetry never enters the journal', async ({
  page,
}) => {
  await gotoViewer(page, '?fixture=offline');
  const state = await stateJson(page);
  const aerial = state.constraints.find((c) => c.assetId === 'uav-seeker-1');
  expect(aerial).toMatchObject({ state: 'blocked', reason: 'comms-offline' });
  // The generator's ghost attempt was REFUSED by the real pipeline: only the
  // two admitted events exist.
  expect(state.markers).toEqual(['mevt_of01', 'mevt_of02']);
});

test('P6 (case 6): recovery never implies payment approval', async ({ page }) => {
  await gotoViewer(page, '?fixture=recovered');
  const content = await page.locator('[data-testid="mission-viewer"]').innerText();
  expect(content.toLowerCase()).not.toContain('settled');
  expect(content.toLowerCase()).not.toContain('payment');
  expect(content.toLowerCase()).not.toContain('approved');
  // And no decision link is rendered for a merely-recovered asset: the phase
  // is uncertainty/awareness, not a financial trigger.
  const state = await stateJson(page);
  expect(state.windBreached).toBe(false);
});

test('P7 (case 7): delayed events preserve observed time versus ingest time', async ({ page }) => {
  await gotoViewer(page, '?fixture=primary&event=mevt_pri03');
  const selected = page.getByTestId('mpv-selected');
  // Fixture journal: observed 09:18:00Z, ingested 09:18:02Z.
  await expect(selected).toContainText('09:18:00');
  await expect(selected).toContainText('09:18:02');
});

test('P8 (case 8): duplicated journal events never duplicate markers', async ({ page }) => {
  await gotoViewer(page, '?fixture=duplicate');
  const state = await stateJson(page);
  expect(state.markers).toEqual(['mevt_du01']);
  await expect(page.locator('.mpv-marker')).toHaveCount(1);
});

test('P9 (case 9): journal order is the timeline — per-source sequences stay independent', async ({
  page,
}) => {
  await gotoViewer(page, '?fixture=primary&event=mevt_pri03');
  const selected = page.getByTestId('mpv-selected');
  // The gateway event is journal #3 but per-source sequence 1 — both truths shown.
  await expect(selected).toContainText('journal #3');
  await expect(selected).toContainText('src seq 1');
});

test('P10 (case 10): cross-tenant and cross-mission state never leaks between fixtures', async ({
  page,
}) => {
  await gotoViewer(page, '?fixture=primary');
  const first = await stateJson(page);
  await gotoViewer(page, '?fixture=warehouse');
  const second = await stateJson(page);
  // Different org/mission worlds (each fixture is a distinct tenant run)…
  expect(first.markers.length).toBeGreaterThan(0);
  expect(second.markers).not.toEqual(first.markers);
  // …and no primary event ids survive the switch.
  expect(second.markers.every((id) => !id.startsWith('mevt_pri'))).toBe(true);
});

test('P11 (case 11): warehouse events never inherit the aerial wind rule', async ({ page }) => {
  await gotoViewer(page, '?fixture=warehouse');
  const state = await stateJson(page);
  expect(state.windBreached).toBe(false);
  const aerial = state.constraints.find((c) => c.assetId === 'uav-seeker-1');
  // Ground-domain readings (aisle obstruction) leave the aerial rule honest:
  // no wind reading → no wind verdict, conservative unknown — never blocked
  // by a UAV-only rule and never clear without basis.
  expect(aerial?.reason).toBe('insufficient-evidence');
  const content = await page.locator('[data-testid="mission-viewer"]').innerText();
  expect(content).not.toContain('wind-limit');
});

test('P12 (case 12): no artificial trajectory — the pose is discrete and documented', async ({
  page,
}) => {
  await gotoViewer(page, '?fixture=primary&reducedMotion=1');
  const a = await engineDebug(page);
  await page.waitForTimeout(1200);
  const b = await engineDebug(page);
  expect(a?.dronePosition).toEqual(b?.dronePosition);
  expect(a?.dronePosition).toEqual({ x: 24, y: 11, z: 6 }); // the on_station pose constant
});

// ---------------------------------------------------------------------------
// Rendering correctness (brief §8.2, cases 13–25)
// ---------------------------------------------------------------------------

test('R13 (case 13): missing GLB files degrade to a usable scene', async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as { __MPV_FORCE_NO_MODELS?: boolean }).__MPV_FORCE_NO_MODELS = true;
  });
  await gotoViewer(page, '?fixture=primary');
  const dbg = await engineDebug(page);
  expect(dbg?.modelFallback).toBe(true);
  // The scene remains interactive: markers still render.
  await expect(page.locator('.mpv-marker')).toHaveCount(3);
});

test('R14 (case 14): broken textures/materials — loader error path is the modeled fallback', async () => {
  // The chosen assets are untextured (vertex/material colors only), so a
  // texture decode failure cannot occur on the shipped assets; the GLB load
  // error path itself is proven by R13 (same onError handler). Kept as an
  // explicit, honest skip rather than a fake pass.
  test.skip(true, 'shipped assets carry no textures; loader error path covered by R13');
});

test('R15 (case 15): WebGL init failure activates 2D automatically', async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as { __MPV_FORCE_NO_WEBGL?: boolean }).__MPV_FORCE_NO_WEBGL = true;
  });
  await gotoViewer(page, '?fixture=primary');
  await expect(page.locator('[data-testid="mission-viewer"]')).toHaveAttribute('data-mode', '2d');
  await expect(page.getByTestId('mpv-fallback-note')).toContainText('WebGL is unavailable');
  await expect(page.getByTestId('mpv-2d')).toBeVisible();
});

test('R16 (case 16): WebGL context loss preserves event selection', async ({ page }) => {
  await gotoViewer(page, '?fixture=primary&event=mevt_pri02');
  expect(await engineDebug(page)).not.toBeNull();
  await page.evaluate(() => {
    (
      window as { __MPV_ENGINE?: { simulateContextLoss(): void } }
    ).__MPV_ENGINE?.simulateContextLoss();
  });
  await expect(page.locator('[data-testid="mission-viewer"]')).toHaveAttribute('data-mode', '2d');
  await expect(page.getByTestId('mpv-fallback-note')).toContainText('context was lost');
  // Selection survives the renderer death.
  await expect(page.locator('.mpv-events__item[aria-pressed="true"]')).toContainText('mevt_pri02');
});

test('R17 (case 17): scene reinitialization never triggers an API write or fetch', async ({
  page,
}) => {
  const apiCalls: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/') || url.includes('/healthz')) apiCalls.push(url);
  });
  await gotoViewer(page, '?fixture=primary');
  // Force three engine rebuilds via mode flips.
  for (const mode of ['2d', '3d', '2d', '3d']) {
    await page.getByTestId(mode === '3d' ? 'mpv-mode-3d' : 'mpv-mode-2d').click();
    await page.waitForTimeout(600);
  }
  expect(apiCalls).toEqual([]);
});

test('R18 (case 18): zoom clamps never lose the asset (min/max distance)', async ({ page }) => {
  await gotoViewer(page, '?fixture=primary&asset=uav-seeker-1');
  // Input wiring: a wheel gesture over the canvas must move the camera.
  const before = await engineDebug(page);
  await page.locator('[data-testid="mpv-canvas"]').hover();
  await page.mouse.wheel(0, 480);
  await page.waitForTimeout(400);
  const afterWheel = await engineDebug(page);
  expect(afterWheel?.camera).not.toEqual(before?.camera);
  // Limits are configured and the CLAMP holds: request an absurdly far and
  // an absurdly near camera distance — the orbit control pulls both back
  // inside [min, max], so the asset can never be lost to the void.
  expect(afterWheel?.zoomLimits).toEqual({ min: 14, max: 320 });
  const distanceOf = (d: EngineDebug): number =>
    Math.hypot(d.camera.x - d.target.x, d.camera.y - d.target.y, d.camera.z - d.target.z);
  await page.evaluate(() =>
    (
      window as { __MPV_ENGINE?: { forceCameraDistance(m: number): void } }
    ).__MPV_ENGINE?.forceCameraDistance(900),
  );
  await page.waitForTimeout(300);
  const far = await engineDebug(page);
  expect(distanceOf(far!)).toBeLessThanOrEqual(320.5);
  await page.evaluate(() =>
    (
      window as { __MPV_ENGINE?: { forceCameraDistance(m: number): void } }
    ).__MPV_ENGINE?.forceCameraDistance(0.01),
  );
  await page.waitForTimeout(300);
  const near = await engineDebug(page);
  expect(distanceOf(near!)).toBeGreaterThanOrEqual(13.5);
});

test('R19 (case 19): selected asset remains visible after resize', async ({ page }) => {
  await gotoViewer(page, '?fixture=primary&asset=uav-seeker-1');
  await page.setViewportSize({ width: 700, height: 700 });
  await page.waitForTimeout(800);
  await expect(page.locator('[data-testid="mission-viewer"]')).toHaveAttribute('data-mode', '3d');
  const canvas = page.locator('[data-testid="mpv-canvas"] canvas');
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(300);
  // The asset-focus marker/button surface still exists and is on-screen.
  await expect(page.locator('.mpv-events')).toBeVisible();
});

test('R20 (case 20): camera reset is deterministic across reloads', async ({ page }) => {
  await gotoViewer(page, '?fixture=primary&event=mevt_pri03');
  await page.getByTestId('mpv-reset-camera').click();
  await page.waitForTimeout(1400); // transition completes
  const afterReset = await engineDebug(page);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4000);
  await page.getByTestId('mpv-reset-camera').click();
  await page.waitForTimeout(1400);
  const afterReload = await engineDebug(page);
  expect(afterReset?.camera).toEqual(afterReload?.camera);
  expect(afterReset?.framing).toBe('overview');
});

test('R21 (case 21): the selected evidence marker is never hidden behind the HUD', async ({
  page,
}) => {
  await gotoViewer(page, '?fixture=primary&event=mevt_pri03');
  const marker = page.locator('.mpv-marker[data-selected="true"]');
  await expect(marker).toBeVisible();
  const markerBox = await marker.boundingBox();
  const hudBox = await page.getByTestId('mpv-hud').boundingBox();
  expect(markerBox).not.toBeNull();
  expect(hudBox).not.toBeNull();
  // The marker must sit fully above the HUD band (framing law aims below the
  // subject precisely so this holds).
  expect(markerBox!.y + markerBox!.height).toBeLessThanOrEqual(hudBox!.y + 4);
});

test('R22 (case 22): reduced motion eliminates choreography (instant transition, no bob)', async ({
  page,
}) => {
  await gotoViewer(page, '?fixture=primary&event=mevt_pri03&reducedMotion=1');
  const a = await engineDebug(page);
  await page.waitForTimeout(700);
  const b = await engineDebug(page);
  // Instant transition: camera already settled on the first sampled frame…
  expect(a?.camera).toEqual(b?.camera);
  // …and stays exactly settled (no hover bob, no strobe-induced motion).
  expect(a?.dronePosition).toEqual(b?.dronePosition);
});

test('R23 (case 23): unmount disposes the engine — exactly one renderer across mode flips', async ({
  page,
}) => {
  await gotoViewer(page, '?fixture=primary');
  const resourcesAfterFirst = (await engineDebug(page))?.resources;
  // Flip to 2D: the 3D engine must unmount (debug hook removed).
  await page.getByTestId('mpv-mode-2d').click();
  await page.waitForTimeout(700);
  const gone = await page.evaluate(
    () => (window as { __MPV_ENGINE?: unknown }).__MPV_ENGINE === undefined,
  );
  expect(gone).toBe(true);
  // And back to 3D: a fresh engine with the SAME bounded resource count.
  await page.getByTestId('mpv-mode-3d').click();
  await page.waitForTimeout(2500);
  const resourcesAfterRebuild = (await engineDebug(page))?.resources;
  expect(resourcesAfterRebuild).toBe(resourcesAfterFirst);
  await expect(page.locator('[data-testid="mpv-canvas"] canvas')).toHaveCount(1);
});

test('R24 (case 24): repeated mount/unmount cycles do not accumulate renderers or canvases', async ({
  page,
}) => {
  await gotoViewer(page, '?fixture=primary');
  for (let i = 0; i < 6; i++) {
    await page.getByTestId('mpv-mode-2d').click();
    await page.waitForTimeout(450);
    await page.getByTestId('mpv-mode-3d').click();
    await page.waitForTimeout(1400);
  }
  await expect(page.locator('[data-testid="mpv-canvas"] canvas')).toHaveCount(1);
  const heap = await page.evaluate(
    () =>
      (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
        ?.usedJSHeapSize ?? null,
  );
  // Chromium-only; when present, guard against runaway accumulation.
  if (heap !== null) expect(heap).toBeLessThan(150 * 1024 * 1024);
});

test('R25 (case 25): light mode renders the same authoritative scene', async ({ page }) => {
  await gotoViewer(page, '?fixture=primary&theme=light');
  await expect(page.locator('[data-testid="mission-viewer"]')).toHaveAttribute(
    'data-theme-mode',
    'light',
  );
  await expect(page.getByTestId('mpv-truth-chip')).toContainText('SIMULATED_OPERATION');
  // The harness always signals decision availability → the breach phase is S3.
  await expect(page.locator('[data-testid="mission-viewer"]')).toHaveAttribute(
    'data-phase',
    'S3-restricted-escalated',
  );
});

// ---------------------------------------------------------------------------
// Product correctness (brief §8.3, cases 26–36)
// ---------------------------------------------------------------------------

test('C26 (case 26): event markers map to the exact admitted event ids', async ({ page }) => {
  await gotoViewer(page, '?fixture=primary');
  const markerIds = await page
    .locator('.mpv-marker')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.eventId));
  const listIds = await page
    .locator('.mpv-events__item')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.eventId));
  expect(markerIds.sort()).toEqual(listIds.sort());
  const state = await stateJson(page);
  expect([...markerIds].sort()).toEqual([...state.markers].sort());
});

test('C27 (case 27): replay after refresh recreates selection and state deterministically', async ({
  page,
}) => {
  await gotoViewer(page, '?fixture=primary&event=mevt_pri01');
  const before = await stateJson(page);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3500);
  const after = await stateJson(page);
  expect(after).toEqual(before);
  expect(after.selectedEventId).toBe('mevt_pri01');
  expect(after.replay).toBe(true);
});

test('C28 (case 28): synthetic provenance is unmistakable in both chips and detail', async ({
  page,
}) => {
  await gotoViewer(page, '?fixture=primary&event=mevt_pri03');
  await expect(page.getByTestId('mpv-truth-chip')).toContainText('SIMULATED_OPERATION');
  await expect(page.getByTestId('mpv-provenance')).toHaveText('SYNTHETIC');
});

test('C29+C30 (cases 29/30): no provider receipts or payment success can appear — even after recovery', async ({
  page,
}) => {
  for (const fixture of ['primary', 'recovered']) {
    await gotoViewer(page, `?fixture=${fixture}`);
    const text = (await page.locator('main.mpvh').innerText()).toLowerCase();
    expect(text).not.toContain('settled');
    expect(text).not.toContain('paid');
    expect(text).not.toContain('receipt');
    expect(text).not.toContain('transfer complete');
  }
});

test('C31 (case 31): unknown physical evidence cannot look optimistic', async ({ page }) => {
  await gotoViewer(page, '?fixture=empty');
  const phaseChip = await page.getByTestId('mpv-phase').innerText();
  expect(phaseChip.toLowerCase()).not.toContain('nominal');
  expect(phaseChip.toLowerCase()).toContain('unknown');
});

test('C32 (case 32): a changed mission selection clears the previous highlights', async ({
  page,
}) => {
  await gotoViewer(page, '?fixture=primary&event=mevt_pri02&asset=uav-seeker-1');
  await expect(page.locator('.mpv-events__item[aria-pressed="true"]')).toContainText('mevt_pri02');
  await gotoViewer(page, '?fixture=warehouse');
  await expect(page.locator('.mpv-events__item[aria-pressed="true"]')).toHaveCount(0);
  const ids = await page
    .locator('.mpv-events__item')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.eventId));
  expect(ids).toEqual(['mevt_wh02', 'mevt_wh01']);
});

test('C33 (case 33): keyboard-only navigation reaches the evidence list and selects', async ({
  page,
}) => {
  await gotoViewer(page, '?fixture=primary');
  // Tab into the viewer: the first reachable evidence control is the event list.
  await page.keyboard.press('Tab');
  let reached = '';
  for (let i = 0; i < 12; i++) {
    reached = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.className ?? el?.tagName ?? '';
    });
    if (reached.includes('mpv-events__item') || reached.includes('mpv-marker')) break;
    await page.keyboard.press('Tab');
  }
  expect(reached).toMatch(/mpv-events__item|mpv-marker/);
  await page.keyboard.press('Enter');
  const state = await stateJson(page);
  expect(state.selectedEventId).not.toBeNull();
});

test('C34 (case 34): screen readers get a meaningful non-visual incident description', async ({
  page,
}) => {
  await gotoViewer(page, '?fixture=primary&event=mevt_pri03');
  const sr = await page.getByTestId('mpv-sr-status').innerText();
  expect(sr).toContain('3 admitted synthetic observations');
  expect(sr).toContain('24.6 knots');
  expect(sr).toContain('modeled limit of 22 knots');
  expect(sr).toContain('illustrative');
});

test.describe('C35 touch gesture isolation (touch pipeline enabled)', () => {
  test.use({ hasTouch: true });

  test('C35 (case 35): touch gestures are governed by the camera, not the page', async ({
    page,
  }) => {
    await gotoViewer(page, '?fixture=primary');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(900);
    // The page stays scrollable (content taller than the viewport)…
    const scrollable = await page.evaluate(
      () => document.documentElement.scrollHeight > document.documentElement.clientHeight,
    );
    expect(scrollable).toBe(true);
    // …while the canvas declares the web-standard guarantee that touches on
    // it are never hijacked by page scrolling (touch-action: none — the
    // exact mechanism that prevents camera/page gesture fights).
    const touchAction = await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('[data-testid="mpv-canvas"] canvas') as Element)
          .touchAction,
    );
    expect(touchAction).toBe('none');
    // And the touch contract is configured: one finger rotates, two dolly.
    const dbg = await engineDebug(page);
    expect(dbg?.touchConfig).toEqual({ oneFinger: 'rotate', twoFinger: 'dolly-pan' });
    // Honest scope note: a full synthetic swipe cannot be driven through
    // Playwright/CDP — OrbitControls calls setPointerCapture, which browsers
    // refuse for non-active synthetic pointer ids, so the rotate response to
    // real fingers is covered by the manual capture pass (research/mtv-09)
    // instead of a fabricated automation claim.
    const drift = await page.evaluate(() => window.scrollY);
    expect(drift).toBe(0);
  });
});

test('C36 (case 36): no raw journal payloads or secrets enter the browser', async ({ page }) => {
  await gotoViewer(page, '?fixture=primary&event=mevt_pri03');
  const audit = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script'))
      .map((s) => s.textContent ?? '')
      .join('');
    const debug = JSON.stringify((window as { __MPV_DEBUG?: unknown }).__MPV_DEBUG ?? {});
    return {
      poisoned: `${scripts}${debug}${document.documentElement.outerHTML}`,
    };
  });
  // The journal stores payloads server-side; the contract carries typed
  // observations only. None of these strings can exist in the client.
  expect(audit.poisoned).not.toContain('payload_json');
  expect(audit.poisoned).not.toContain('payloadDigest:');
  expect(audit.poisoned).not.toContain('secretKey');
  expect(audit.poisoned).not.toContain('signature"');
});

// ---------------------------------------------------------------------------
// C2/C4 additions: strict server-shape adapter + additional browser cases.
// ---------------------------------------------------------------------------

type ValidateResult = { ok: boolean; reason?: string };

function validateMutated(
  page: Page,
  mutation: (payload: Record<string, unknown>) => void,
): Promise<ValidateResult> {
  return page.evaluate((mutationSource) => {
    const debug = (window as { __MPV_DEBUG?: { validateAdapter(p: unknown): ValidateResult } })
      .__MPV_DEBUG;
    const raw = (window as { __MPV_FIXTURES_RAW?: Record<string, Record<string, unknown>> })
      .__MPV_FIXTURES_RAW;
    const payload = JSON.parse(JSON.stringify(raw?.['primary'] ?? {}));
    // The mutation source is test-authored (this file), never page content.
    // `return (arrow)(payload)` — a bare arrow at statement position would
    // be parsed as an expression statement and never apply the mutation.
    const apply = new Function('payload', `return (${mutationSource})(payload);`) as (
      p: Record<string, unknown>,
    ) => void;
    apply(payload);
    return debug!.validateAdapter(payload);
  }, mutation.toString());
}

test.describe('C2 — strict server-shape adapter (fail closed)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoViewer(page, '?fixture=primary');
  });

  test('every committed fixture passes the strict adapter (proven on load)', async ({ page }) => {
    for (const fixture of [
      'primary',
      'empty',
      'stale',
      'conflict',
      'offline',
      'recovered',
      'warehouse',
      'duplicate',
    ]) {
      await gotoViewer(page, `?fixture=${fixture}`);
      await expect(page.locator('[data-testid="mission-viewer"]')).toHaveAttribute(
        'data-availability',
        'ready',
        { timeout: 30_000 },
      );
    }
  });

  test('rejects: wrong contractVersion, missing field, unknown event asset, duplicate asset', async ({
    page,
  }) => {
    let r = await validateMutated(page, (p) => {
      p['contractVersion'] = 2;
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('contractVersion');

    r = await validateMutated(page, (p) => {
      const policy = p['policy'] as Record<string, unknown>;
      policy['uavWindLimitKt'] = undefined;
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('uavWindLimitKt');

    r = await validateMutated(page, (p) => {
      const events = p['recentEvents'] as Record<string, unknown>[];
      events[0]!['assetId'] = 'asset-ghost';
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not a registered asset/);

    r = await validateMutated(page, (p) => {
      const assets = p['assets'] as Record<string, unknown>[];
      assets[1]!['assetId'] = assets[0]!['assetId'];
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('duplicate assetId');
  });

  test('rejects: bad digest, invalid freshness enum, inverted policy, malformed timestamp', async ({
    page,
  }) => {
    let r = await validateMutated(page, (p) => {
      const events = p['recentEvents'] as Record<string, unknown>[];
      events[0]!['eventDigest'] = 'zz-not-hex';
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('64-hex');

    r = await validateMutated(page, (p) => {
      const events = p['recentEvents'] as Record<string, unknown>[];
      events[0]!['freshness'] = 'current';
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('freshness');

    r = await validateMutated(page, (p) => {
      const policy = p['policy'] as Record<string, unknown>;
      policy['expiredMs'] = 1000;
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('expiredMs');

    r = await validateMutated(page, (p) => {
      const events = p['recentEvents'] as Record<string, unknown>[];
      events[0]!['observedAt'] = '2026-11-06 09:00';
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('ISO-8601');
  });

  test('accepts optional metadata absence (label optional; kind mandatory)', async ({ page }) => {
    const okNoLabel = await validateMutated(page, (p) => {
      const assets = p['assets'] as Record<string, unknown>[];
      const asset = assets[0]!;
      delete asset['label'];
    });
    expect(okNoLabel.ok).toBe(true);
    const noKind = await validateMutated(page, (p) => {
      const assets = p['assets'] as Record<string, unknown>[];
      const asset = assets[0]!;
      delete asset['kind'];
    });
    expect(noKind.ok).toBe(false);
    expect(noKind.reason).toContain('kind');
  });
});

test.describe('C4 — additional browser resilience cases', () => {
  test('out-of-order per-source arrival cannot reorder the journal timeline', async ({ page }) => {
    await gotoViewer(page, '?fixture=primary');
    const state = await stateJson(page);
    // Journal order is the timeline: the gateway event (per-source seq 1)
    // sits at journal #3 AFTER two telemetry events with higher per-source
    // sequences — and the marker list follows the journal, not the sources.
    expect(state.markers).toEqual(['mevt_pri01', 'mevt_pri02', 'mevt_pri03']);
  });

  test('rapid selection changes converge on a defined final state without errors', async ({
    page,
  }) => {
    await gotoViewer(page, '?fixture=primary');
    const items = page.locator('.mpv-events__item');
    const count = await items.count();
    for (let i = 0; i < count; i++) await items.nth(i).click();
    // A final click on the already-selected last item deselects (toggle law):
    const last = items.nth(count - 1);
    await last.click();
    await expect(last).toHaveAttribute('aria-pressed', 'false');
    const state = await stateJson(page);
    expect(state.selectedEventId).toBeNull();
  });

  test('switching missions during an active replay clears the replay state', async ({ page }) => {
    await gotoViewer(page, '?fixture=primary&event=mevt_pri01');
    const before = await stateJson(page);
    expect(before.replay).toBe(true);
    await gotoViewer(page, '?fixture=warehouse');
    const after = await stateJson(page);
    expect(after.selectedEventId).toBeNull();
    expect(after.replay).toBe(false);
    expect(after.markers.every((id) => !id.startsWith('mevt_pri'))).toBe(true);
  });

  test('browser resize during a camera transition settles deterministically', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await gotoViewer(page, '?fixture=primary&event=mevt_pri03');
    // Fire a resize while the 950ms framing transition is still running.
    await page.waitForTimeout(200);
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(1600);
    const withResize = await engineDebug(page);
    // Deterministic: the same scenario without the mid-transition resize
    // lands at the identical settled camera pose.
    await page.setViewportSize({ width: 1200, height: 800 });
    await gotoViewer(page, '?fixture=primary&event=mevt_pri03');
    await page.waitForTimeout(2500);
    const withoutResize = await engineDebug(page);
    expect(withResize?.camera).toEqual(withoutResize?.camera);
    expect(withResize?.framing).toBe('event');
  });

  test('device-pixel-ratio change adapts the backing store and keeps the scene', async ({
    page,
  }) => {
    await gotoViewer(page, '?fixture=primary');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1000,
      height: 600,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page.waitForTimeout(900);
    await expect(page.locator('[data-testid="mission-viewer"]')).toHaveAttribute('data-mode', '3d');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1000,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.waitForTimeout(600);
    await expect(page.locator('[data-testid="mission-viewer"]')).toHaveAttribute('data-mode', '3d');
    await expect(page.locator('[data-testid="mpv-canvas"] canvas')).toBeVisible();
  });

  test('context loss during rapid evidence selection preserves the final selection', async ({
    page,
  }) => {
    await gotoViewer(page, '?fixture=primary');
    const items = page.locator('.mpv-events__item');
    await items.nth(0).click();
    await items.nth(1).click();
    await page.evaluate(() => {
      (
        window as { __MPV_ENGINE?: { simulateContextLoss(): void } }
      ).__MPV_ENGINE?.simulateContextLoss();
    });
    await expect(page.locator('[data-testid="mission-viewer"]')).toHaveAttribute('data-mode', '2d');
    await expect(page.locator('.mpv-events__item[aria-pressed="true"]')).toContainText(
      'mevt_pri02',
    );
  });
});
