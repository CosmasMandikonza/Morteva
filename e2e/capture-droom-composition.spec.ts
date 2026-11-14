import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  apiIssueCredential,
  apiLogin,
  apiProvisionMission,
  deliver,
  groundWireSpec,
  GROUND,
  headlessClient,
  PASSWORD,
  selectMission,
  signedEnvelope,
  UNSEEN,
} from './support/customer.js';

/**
 * Opt-in BEFORE/AFTER evidence capture for the Decision Room viewer
 * composition correction (CTO visual gate on PR #65). Run with:
 *   CAPTURE_DROOM=1 CAPTURE_ROUND=before npx playwright test e2e/capture-droom-composition.spec.ts --workers=1
 * Writes research/mtv-20-droom/<round>/droom-*.png. Never part of CI.
 *
 * The SAME states, names and viewports are captured before and after the
 * composition change, so the two rounds are directly comparable. Only
 * testids that exist in BOTH versions are used.
 */
const shouldCapture = !!process.env.CAPTURE_DROOM;
test.skip(!shouldCapture, 'screenshot capture is opt-in (CAPTURE_DROOM=1)');
test.setTimeout(300_000);

const ROUND = process.env.CAPTURE_ROUND ?? 'run';
const OUT = join('research', 'mtv-20-droom', ROUND);

const DESKTOP = [
  [1440, 900],
  [1920, 1080],
] as const;
const NARROW = [
  [320, 800],
  [390, 844],
  [640, 450],
  [768, 1000],
  [1024, 768],
  [1280, 800],
] as const;

function uniq(base: string): string {
  return `${base} ${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `droom-${name}.png`) });
}

async function theme(page: Page, value: 'dark' | 'light'): Promise<void> {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), value);
  await page.waitForTimeout(300);
}

async function openDecisionRoom(
  page: Page,
  role: 'founder' | 'operator',
  title: string,
): Promise<void> {
  // The states chain inside one page: drop any live session first, or the
  // login form never renders for the next role. The session restores
  // ASYNC after goto — wait for whichever lands first (chip = signed in,
  // username field = signed out) instead of racing a count() probe.
  await page.goto('/');
  const chip = page.getByTestId('actor-chip');
  const user = page.getByLabel('Username');
  await chip.or(user).first().waitFor({ state: 'visible', timeout: 20_000 });
  if (await chip.isVisible()) {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(chip).toHaveCount(0);
  }
  await user.fill(role);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(chip).toContainText(role === 'founder' ? 'E2E Founder' : 'E2E Operator');
  await selectMission(page, title);
  await page.getByRole('link', { name: 'Decision Room' }).click();
  await expect(page.getByTestId('decision-room')).toBeVisible();
}

test('capture the Decision Room composition matrix (before/after comparable)', async ({
  page,
  request,
  playwright,
  baseURL,
}) => {
  mkdirSync(OUT, { recursive: true });
  const stem = Date.now().toString(36).slice(-5);

  // ---------------------------------------------------------------- (a) unconfigured
  const aTitle = uniq('Unconfigured capture');
  const founder = await apiLogin(request, 'founder');
  const created = await request.post('/api/missions', {
    headers: { 'x-csrf-token': founder.csrf },
    data: { title: aTitle },
  });
  expect(created.status()).toBe(200);
  for (const [w, h] of DESKTOP) {
    await page.setViewportSize({ width: w, height: h });
    await openDecisionRoom(page, 'founder', aTitle);
    await expect(page.getByTestId('unconfigured-notice')).toBeVisible();
    await shot(page, `a-unconfigured-${String(w)}x${String(h)}-dark`);
    if (w === 1440) {
      await theme(page, 'light');
      await shot(page, 'a-unconfigured-1440x900-light');
      await theme(page, 'dark');
    }
  }

  // ---------------------------------------------------------------- (b) zero events
  const bTitle = `${UNSEEN.title} zero ${stem}`;
  await apiProvisionMission(request, bTitle, { mandate: false });
  for (const [w, h] of DESKTOP) {
    await page.setViewportSize({ width: w, height: h });
    await openDecisionRoom(page, 'operator', bTitle);
    await expect(page.getByTestId('customer-ops')).toBeVisible({ timeout: 15_000 });
    await shot(page, `b-zero-events-${String(w)}x${String(h)}-dark`);
    if (w === 1440) {
      await theme(page, 'light');
      await shot(page, 'b-zero-events-1440x900-light');
      await theme(page, 'dark');
    }
  }

  // ------------------------------------------------ (c) FIELD baseline + incident
  const cTitle = `${UNSEEN.title} incident ${stem}`;
  const { missionId, session } = await apiProvisionMission(request, cTitle, { mandate: true });
  const secret = await apiIssueCredential(
    request,
    session,
    missionId,
    UNSEEN.sources[0].sourceId,
    `key-cap-${stem}`,
  );
  const headless = await headlessClient(playwright, baseURL);
  const base = {
    orgId: session.orgId,
    missionId,
    assetId: UNSEEN.assets[0].assetId,
    sourceId: UNSEEN.sources[0].sourceId,
    sourceType: UNSEEN.sources[0].sourceType,
    keyId: `key-cap-${stem}`,
  };
  await deliver(headless, missionId, [
    signedEnvelope(
      {
        ...base,
        eventId: `evt_cap_base_${stem}`,
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
  await openDecisionRoom(page, 'operator', cTitle);
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
        eventId: `evt_cap_inc_${stem}`,
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
  // The scene reflects the incident evidence before the shutter falls.
  await expect(page.locator('.mpv-stage').first()).toBeVisible();
  await shot(page, 'c-incident-1440x900-dark');
  // Page-top vs scrolled vs in-page anchor (sticky-navigation repro states).
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'c-incident-1440x900-dark-pagetop');
  await page
    .getByTestId('evaluate-journal')
    .evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, 'c-incident-1440x900-dark-scrolled');
  await page.goto(`${baseURL as string}/#decisions`);
  await expect(page.getByTestId('decision-room')).toBeVisible();
  await shot(page, 'c-incident-1440x900-dark-anchor');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await shot(page, 'c-incident-1920x1080-dark');
  await page.setViewportSize({ width: 1440, height: 900 });
  await theme(page, 'light');
  await shot(page, 'c-incident-1440x900-light');
  await theme(page, 'dark');

  // Narrow set on the populated state.
  for (const [w, h] of NARROW) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(500);
    await shot(page, `c-incident-${String(w)}x${String(h)}-dark`);
  }

  // ---------------------------------------------------------------- (e) 2D view
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('mpv-mode-2d').click();
  await page.waitForTimeout(600);
  await shot(page, 'e-2d-1440x900-dark');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(600);
  await shot(page, 'e-2d-1920x1080-dark');
  await page.getByTestId('mpv-mode-3d').click();

  // ---------------------------------------------------------------- (d) ground-only
  const dTitle = uniq('Cold-store capture');
  const ground = await apiProvisionMission(request, dTitle, {
    mandate: true,
    spec: groundWireSpec(),
  });
  const gSecret = await apiIssueCredential(
    request,
    ground.session,
    ground.missionId,
    GROUND.sourceId,
    GROUND.keyId,
  );
  const gBase = {
    orgId: ground.session.orgId,
    missionId: ground.missionId,
    assetId: GROUND.assetId,
    sourceId: GROUND.sourceId,
    sourceType: 'warehouse_wms',
    keyId: GROUND.keyId,
  };
  await deliver(headless, ground.missionId, [
    signedEnvelope(
      {
        ...gBase,
        eventId: `evt_gd_base_${stem}`,
        sequence: 1,
        agoMs: 60_000,
        observations: [
          { kind: 'asset_comms', unit: 'state', value: 'online' },
          { kind: 'aisle_access', unit: 'state', value: 'clear' },
          { kind: 'charger_status', unit: 'state', value: 'free' },
        ],
      },
      gSecret,
    ),
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDecisionRoom(page, 'operator', dTitle);
  await expect(page.getByTestId('field-events')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('evaluate-journal').click();
  await expect(page.getByTestId('live-evaluation-outcome')).toHaveAttribute(
    'data-outcome',
    'no-action',
    { timeout: 20_000 },
  );
  await deliver(headless, ground.missionId, [
    signedEnvelope(
      {
        ...gBase,
        eventId: `evt_gd_inc_${stem}`,
        sequence: 2,
        agoMs: 20_000,
        observations: [{ kind: 'aisle_access', unit: 'state', value: 'obstructed' }],
      },
      gSecret,
    ),
  ]);
  await page.getByTestId('refresh-journal').click();
  await page.getByTestId('evaluate-journal').click();
  await expect(page.getByTestId('live-evaluation-outcome')).toHaveAttribute(
    'data-outcome',
    'spend',
    { timeout: 20_000 },
  );
  await shot(page, 'd-ground-1440x900-dark');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await shot(page, 'd-ground-1920x1080-dark');
  await page.setViewportSize({ width: 1440, height: 900 });
  await theme(page, 'light');
  await shot(page, 'd-ground-1440x900-light');
  await theme(page, 'dark');
  await page.setViewportSize({ width: 320, height: 800 });
  await shot(page, 'd-ground-320x800-dark');

  // ------------------------------------------------------- (f) reduced motion
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDecisionRoom(page, 'operator', cTitle);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByTestId('live-evaluation-outcome')).toBeVisible({ timeout: 15_000 });
  await shot(page, 'f-reduced-motion-1440x900-dark');

  await headless.dispose();
});
