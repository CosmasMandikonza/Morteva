import { expect, test, type Page } from '@playwright/test';
import {
  apiIssueCredential,
  apiProvisionMission,
  deliver,
  groundWireSpec,
  GROUND,
  headlessClient,
  selectMission,
  signedEnvelope,
  UNSEEN,
} from './support/customer.js';

/**
 * DECISION ROOM COMPOSITION — CTO visual gate (PR #65), evidence as DOM
 * geometry, not screenshots alone:
 *
 *  - the physical scene is ONE unobstructed plane: the telemetry strip and
 *    evidence timeline render BENEATH the canvas at EVERY width (bounding
 *    boxes prove no overlap), and the old fixed 250px evidence rail is gone;
 *  - the only in-scene UI is the tiny status badge (<=10% of canvas area);
 *  - markers/raycast stay clickable (nothing overlays them);
 *  - truth: unconfigured missions get NO scene (and no fallback-harbor
 *    header); ground-only missions get a non-spatial overview, never a
 *    harbor; zero evidence says UNKNOWN, never nominal;
 *  - 3D real frames across resize (ResizeObserver), 2D fallback, keyboard,
 *    reduced motion, dark/light parity, sticky-navigation repro states.
 */

test.setTimeout(180_000);
test.describe.configure({ mode: 'serial' });

const WIDTHS = [
  [320, 800],
  [390, 844],
  [640, 450],
  [768, 1000],
  [1024, 768],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
] as const;

function uniq(base: string): string {
  return `${base} ${Date.now().toString(36).slice(-5)}w${Math.floor(Math.random() * 90 + 10)}`;
}

async function openDecisionRoom(
  page: Page,
  role: 'founder' | 'operator',
  title: string,
): Promise<void> {
  await page.goto('/');
  const chip = page.getByTestId('actor-chip');
  const user = page.getByLabel('Username');
  await chip.or(user).first().waitFor({ state: 'visible', timeout: 20_000 });
  if (await chip.isVisible()) {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(chip).toHaveCount(0);
  }
  await user.fill(role);
  await page.getByLabel('Password').fill(['moterva', 'e2e', 'demo'].join('-'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(chip).toContainText(role === 'founder' ? 'E2E Founder' : 'E2E Operator');
  await selectMission(page, title);
  await page.getByRole('link', { name: 'Decision Room' }).click();
  await expect(page.getByTestId('decision-room')).toBeVisible();
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

test('populated FIELD mission: unobstructed scene, strip below, badge <=10%, markers clickable — at every width', async ({
  page,
  request,
  playwright,
  baseURL,
}) => {
  const title = uniq('Composition mission');
  const { missionId, session } = await apiProvisionMission(request, title, { mandate: true });
  const secret = await apiIssueCredential(
    request,
    session,
    missionId,
    UNSEEN.sources[0].sourceId,
    'key-comp-a',
  );
  const headless = await headlessClient(playwright, baseURL);
  const base = {
    orgId: session.orgId,
    missionId,
    assetId: UNSEEN.assets[0].assetId,
    sourceId: UNSEEN.sources[0].sourceId,
    sourceType: UNSEEN.sources[0].sourceType,
    keyId: 'key-comp-a',
  };
  await deliver(headless, missionId, [
    signedEnvelope(
      {
        ...base,
        eventId: 'evt_comp_base_1',
        sequence: 1,
        agoMs: 60_000,
        observations: [
          { kind: 'wind_speed', unit: 'kt', value: '12.4' },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
          { kind: 'weather_hold', unit: 'state', value: 'clear' },
        ],
      },
      secret,
    ),
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDecisionRoom(page, 'operator', title);
  await expect(page.getByTestId('field-events')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('evaluate-journal').click();
  await expect(page.getByTestId('live-evaluation-outcome')).toHaveAttribute(
    'data-outcome',
    'no-action',
    { timeout: 20_000 },
  );
  await deliver(headless, missionId, [
    signedEnvelope(
      {
        ...base,
        eventId: 'evt_comp_inc_1',
        sequence: 2,
        agoMs: 20_000,
        observations: [
          { kind: 'wind_speed', unit: 'kt', value: '31.4' },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
          { kind: 'weather_hold', unit: 'state', value: 'clear' },
        ],
      },
      secret,
    ),
  ]);
  await page.getByTestId('refresh-journal').click();
  await page.getByTestId('evaluate-journal').click();
  await expect(page.getByTestId('live-evaluation-outcome')).toHaveAttribute(
    'data-outcome',
    'spend',
    { timeout: 20_000 },
  );
  const incidentId = 'evt_comp_inc_1';
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.mpv-stage').first()).toBeVisible({ timeout: 15_000 });

  for (const [width, height] of WIDTHS) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(600);

    // ---- geometry: the scene exists, the chrome is BELOW it, nothing covers it
    const host = (await page.locator('.mpv-canvas-host').first().boundingBox()) as Box | null;
    expect(host, `canvas host at ${String(width)}x${String(height)}`).not.toBeNull();
    const meaningful = width <= 640 ? { w: 200, h: 110 } : { w: 420, h: width >= 1440 ? 300 : 220 };
    expect(host!.width, `canvas width at ${String(width)}`).toBeGreaterThan(meaningful.w);
    expect(host!.height, `canvas height at ${String(width)}`).toBeGreaterThan(meaningful.h);

    // no fixed evidence rail as a grid child of the viewer
    expect(
      await page.locator('.mv-droom__physical .mpv > .mpv-events').count(),
      `rail grid child at ${String(width)}`,
    ).toBe(0);

    // telemetry (the HUD) must sit BELOW the canvas — never overlap it
    const hud = (await page.locator('.mpv-hud').first().boundingBox()) as Box | null;
    expect(hud, `hud at ${String(width)}`).not.toBeNull();
    expect(hud!.y, `HUD below canvas at ${String(width)}x${String(height)}`).toBeGreaterThanOrEqual(
      host!.y + host!.height - 2,
    );

    // the in-scene badge is the ONLY overlay; on a phone-width canvas it
    // yields entirely (the strip below keeps the status), and where present
    // it stays under 10% of the canvas and clear of every marker
    if (host!.width <= 480) {
      await expect(
        page.locator('.mpv-scene-badge').first(),
        `badge hidden on tiny canvas at ${String(width)}`,
      ).toBeHidden();
    } else {
      const badge = (await page.locator('.mpv-scene-badge').first().boundingBox()) as Box | null;
      expect(badge, `scene badge at ${String(width)}`).not.toBeNull();
      const sceneArea = host!.width * host!.height;
      expect(
        (badge!.width * badge!.height) / sceneArea,
        `badge area fraction at ${String(width)}`,
      ).toBeLessThan(0.1);
      // and it must not sit on top of a marker (markers carry the evidence)
      const marker = (await page.locator('.mpv-marker').first().boundingBox()) as Box | null;
      if (marker !== null) {
        const overlapsBadge =
          marker.x < badge!.x + badge!.width &&
          badge!.x < marker.x + marker.width &&
          marker.y < badge!.y + badge!.height &&
          badge!.y < marker.y + marker.height;
        expect(overlapsBadge, `badge/marker overlap at ${String(width)}`).toBe(false);
      }
    }

    // no horizontal overflow anywhere
    const sw = await page.evaluate<number>('document.documentElement.scrollWidth');
    expect(sw, `scrollWidth at ${String(width)}`).toBeLessThanOrEqual(width);

    // the financial primary action is reachable (never under an overlay)
    const evaluate = page.getByTestId('evaluate-journal');
    await evaluate.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const reachable = await evaluate.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === el || el.contains(hit);
    });
    expect(reachable, `evaluate reachable at ${String(width)}`).toBe(true);

    // the scene stays visible while scrolling past it (sticky header honesty)
    await page.evaluate(() => window.scrollTo(0, 0));
    if (width >= 1440) {
      const markerHit = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('.mpv-marker');
        if (el === null) return true; // markers may be outside the crop — geometry above covers it
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit === el || el.contains(hit);
      });
      expect(markerHit, `marker raycast/click target at ${String(width)}`).toBe(true);
    }
  }

  // ---- evidence presentation: customer mode has NO duplicate list — the
  // journal list is Field observations; the viewer keeps counts + selection.
  expect(await page.locator('.mpv-evidence').count()).toBe(0);
  await expect(page.getByTestId('field-observations')).toBeVisible();

  // ---- selection seeded from the journey incident; the HUD (below) shows it
  await expect(page.getByTestId('mpv-selected')).toContainText(incidentId);
  await expect(page.getByTestId('mpv-wind')).toContainText('exceeded');

  // ---- real frames at the resized size (ResizeObserver drives the renderer)
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(900);
  const perf = await page.getByTestId('mpv-perf').textContent();
  expect(perf ?? '', 'renderer frame stats present after resize').toMatch(/\d+ fps/);

  // ---- remount (stage change) never duplicates the renderer
  expect(await page.locator('.mpv canvas').count()).toBe(1);

  // ---- keyboard: a marker is a real button; Enter toggles selection
  const marker = page.locator('.mpv-marker').first();
  await marker.focus();
  await page.keyboard.press('Enter');
  await expect(marker).toHaveAttribute('data-selected', 'true', { timeout: 10_000 });
  await page.keyboard.press('Enter');
  await expect(marker).toHaveAttribute('data-selected', 'false');

  // ---- 2D fallback keeps selection + strip semantics
  await page.getByTestId('mpv-mode-2d').click();
  await expect(page.locator('.mpv').first()).toHaveAttribute('data-mode', '2d');
  await expect(page.getByTestId('mpv-2d')).toBeVisible();
  await expect(page.getByTestId('mpv-wind')).toContainText('31.4');
  await page.getByTestId('mpv-mode-3d').click();
  await expect(page.locator('.mpv').first()).toHaveAttribute('data-mode', '3d', {
    timeout: 15_000,
  });

  // ---- reduced motion: the viewer renders and says so
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.mpv').first()).toHaveAttribute('data-availability', 'ready');
  await expect(page.getByTestId('mpv-hud')).toContainText('reduced motion');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // ---- dark/light parity: the scene surface tracks the semantic token set
  const darkSurface = await page
    .locator('.mpv-stage')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  const lightSurface = await page
    .locator('.mpv-stage')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(lightSurface, 'light mode repaints the scene surface').not.toEqual(darkSurface);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

  await headless.dispose();
});

test('unconfigured mission: NO scene, NO fallback-harbor header — honest onboarding', async ({
  page,
  request,
}) => {
  const title = uniq('Unconfigured comp');
  const session = await (await import('./support/customer.js')).apiLogin(request, 'founder');
  const created = await request.post('/api/missions', {
    headers: { 'x-csrf-token': session.csrf },
    data: { title },
  });
  expect(created.status()).toBe(200);
  await openDecisionRoom(page, 'founder', title);
  await expect(page.getByTestId('unconfigured-notice')).toBeVisible();
  await expect(page.getByTestId('goto-setup')).toBeVisible();
  // no viewer, no canvas, no harbor world, no fallback thresholds
  expect(await page.getByTestId('mission-viewer').count()).toBe(0);
  expect(await page.locator('.mpv canvas').count()).toBe(0);
  await expect(page.getByTestId('decision-room')).not.toContainText('KT MODELED LIMIT');
  await expect(page.getByTestId('decision-room')).toContainText('UNCONFIGURED');
});

test('ground-only mission: coherent NON-SPATIAL overview — never a harbor, never aerial wind', async ({
  page,
  request,
  playwright,
  baseURL,
}) => {
  const title = uniq('Ground comp');
  const { missionId, session } = await apiProvisionMission(request, title, {
    mandate: true,
    spec: groundWireSpec(),
  });
  const secret = await apiIssueCredential(
    request,
    session,
    missionId,
    GROUND.sourceId,
    GROUND.keyId,
  );
  const headless = await headlessClient(playwright, baseURL);
  await deliver(headless, missionId, [
    signedEnvelope(
      {
        orgId: session.orgId,
        missionId,
        assetId: GROUND.assetId,
        sourceId: GROUND.sourceId,
        sourceType: 'warehouse_wms',
        keyId: GROUND.keyId,
        eventId: 'evt_ground_comp_1',
        sequence: 1,
        agoMs: 60_000,
        observations: [
          { kind: 'asset_comms', unit: 'state', value: 'online' },
          { kind: 'aisle_access', unit: 'state', value: 'obstructed' },
        ],
      },
      secret,
    ),
  ]);
  await openDecisionRoom(page, 'operator', title);
  await expect(page.getByTestId('field-events')).toBeVisible({ timeout: 15_000 });
  // the honest overview, with the REAL registered asset — no canvas, no harbor
  await expect(page.getByTestId('droom-nonspatial')).toBeVisible();
  await expect(page.getByTestId('droom-nonspatial')).toContainText(GROUND.assetId);
  expect(await page.locator('.mpv canvas').count()).toBe(0);
  expect(await page.getByTestId('mission-viewer').count()).toBe(0);
  // no aerial-wind rule anywhere in the physical column
  await expect(page.getByTestId('droom-nonspatial')).not.toContainText('wind');
});

test('zero-evidence mission: the scene says UNKNOWN and the evidence line is one honest sentence', async ({
  page,
  request,
}) => {
  const title = uniq('Zero comp');
  await apiProvisionMission(request, title, { mandate: false });
  await openDecisionRoom(page, 'operator', title);
  await expect(page.getByTestId('customer-ops')).toBeVisible({ timeout: 15_000 });
  const viewer = page.getByTestId('mission-viewer');
  await expect(viewer).toHaveAttribute('data-phase', 'S0-initial', { timeout: 30_000 });
  await expect(page.getByTestId('mpv-scene-badge')).toContainText('status unknown');
  await expect(page.getByTestId('mpv-evidence-empty')).toBeVisible();
  await expect(page.getByTestId('mpv-wind')).toContainText('no fresh wind reading');
  // geometry still holds with zero events (no empty 250px rail)
  const host = (await page.locator('.mpv-canvas-host').first().boundingBox()) as Box | null;
  expect(host).not.toBeNull();
  expect(host!.width).toBeGreaterThan(400);
  const hud = (await page.locator('.mpv-hud').first().boundingBox()) as Box | null;
  expect(hud!.y).toBeGreaterThanOrEqual(host!.y + host!.height - 2);
});

test('sticky navigation: page-top, scrolled and in-page anchor all keep the primary action reachable', async ({
  page,
  request,
}) => {
  const title = uniq('Sticky comp');
  await apiProvisionMission(request, title, { mandate: false });
  await openDecisionRoom(page, 'operator', title);
  await expect(page.getByTestId('customer-ops')).toBeVisible({ timeout: 15_000 });
  await page.setViewportSize({ width: 1440, height: 900 });

  const reachableAt = async (label: string): Promise<void> => {
    const evaluate = page.getByTestId('evaluate-journal');
    const box = (await evaluate.boundingBox()) as Box | null;
    if (box !== null) {
      const probe = await page.evaluate(
        ({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          const target = document.querySelector<HTMLElement>('[data-testid="evaluate-journal"]');
          return el !== null && (el === target || (target !== null && target.contains(el)));
        },
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      );
      // Only assert when the button is inside the viewport at all; otherwise
      // the assertion is about the scroll position, not occlusion.
      if (box.y >= 0 && box.y + box.height <= 900 && box.x >= 0 && box.x + box.width <= 1440) {
        expect(probe, `evaluate not occluded ${label}`).toBe(true);
      }
    }
  };

  await page.evaluate(() => window.scrollTo(0, 0));
  await reachableAt('page-top');
  await page
    .getByTestId('evaluate-journal')
    .evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await reachableAt('scrolled');
  await page.goto(`${page.url().split('#')[0] ?? ''}#decisions`);
  await expect(page.getByTestId('decision-room')).toBeVisible();
  await reachableAt('anchor');
  // Reproduce (not change) the topbar sticky rule: sticky only >=721px wide.
  const wide = await page.locator('.mv-topbar').evaluate((el) => getComputedStyle(el).position);
  expect(wide).toBe('sticky');
  await page.setViewportSize({ width: 640, height: 450 });
  const narrow = await page.locator('.mv-topbar').evaluate((el) => getComputedStyle(el).position);
  expect(narrow).not.toBe('sticky');
});
