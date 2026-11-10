import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * MTV-09/12 — issue #14 INTEGRATED ACCEPTANCE (live path).
 *
 * The viewer is mounted in the REAL Decision Room and driven through the
 * REAL authenticated journey against the REAL server: founder creates +
 * grants the mandate → operator signs the synthetic baseline + incident →
 * the viewport fetches the authenticated physical-view read (Agent A's
 * GET /api/missions/:id/physical-view), strict-parses it (Agent C's
 * snapshotFromServerPayload), and mounts the LIVE lazy 3D scene from the
 * admitted journal. Every assertion below is against the running
 * application — no fixtures, no mocks, no fabricated states.
 *
 * The journaled demo events (evt_demo_baseline_N and evt_demo_incident_N)
 * carry the 24.6 kt wind incident against the modeled 22 kt limit: the scene
 * must show the RESTRICTED phase with the exact evidence identity, and
 * financial states must remain independent of the physical scene.
 */
const PASSWORD = ['moterva', 'e2e', 'demo'].join('-');
const CAPTURE_DIR = join(import.meta.dirname, '..', 'research', 'mtv-09', 'captures', 'integrated');

test.setTimeout(180_000);

// The demo-auth server seeds ONE shared ledger: concurrent journeys reorder
// the synthetic timeline and trip login rate limiting (documented D-3 class).
// Serial execution is the established pattern for real-server journey specs.
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, username: 'founder' | 'operator'): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('actor-chip')).toContainText(
    username === 'founder' ? 'E2E Founder' : 'E2E Operator',
  );
}

async function createAndGrant(page: Page, title: string): Promise<void> {
  await page.getByTestId('new-mission-btn').click();
  const sheet = page.getByTestId('mission-create-sheet');
  await sheet.getByLabel('Mission name').fill(title);
  await sheet.getByTestId('create-mission-submit').click();
  await expect(page.getByTestId('missions-panel')).toContainText(title, { timeout: 10_000 });
  await page.getByTestId('grant-first-mandate').click();
  const mandate = page.getByTestId('mandate-create-sheet');
  await mandate.getByLabel('Per-operation cap (USD)').fill('25000');
  await mandate.getByLabel(/Approved beneficiaries/).fill('harbor-diagnostics, harbor-marine');
  await mandate.getByLabel(/Approved purposes/).fill('harbor inspection');
  await mandate.getByTestId('mandate-review-btn').click();
  await mandate.getByTestId('mandate-submit-btn').click();
  await expect(mandate).toHaveCount(0);
}

async function selectMission(page: Page, title: string): Promise<void> {
  await page
    .getByTestId('missions-panel')
    .getByRole('button', { name: new RegExp(title) })
    .first()
    .click();
}

async function runStage(page: Page, stage: 'baseline' | 'incident'): Promise<void> {
  const button =
    stage === 'baseline'
      ? page.getByTestId('start-synthetic')
      : page.getByTestId('introduce-incident');
  await expect(button).toBeEnabled({ timeout: 15_000 });
  await button.click();
  await expect(
    page.getByTestId(stage === 'baseline' ? 'snapshot-baseline' : 'snapshot-incident'),
  ).toBeVisible({ timeout: 15_000 });
}

test('LIVE: physical incident renders the restricted 3D scene inside the real Decision Room', async ({
  page,
}, testInfo) => {
  mkdirSync(CAPTURE_DIR, { recursive: true });
  const title = `Live viewer acceptance ${testInfo.parallelIndex}${Date.now() % 10000}`;

  await signIn(page, 'founder');
  await createAndGrant(page, title);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, 'operator');
  await selectMission(page, title);
  await page.getByRole('link', { name: 'Decision Room' }).click();

  // ---- S0: live viewer before any evidence — honest initial state --------
  const viewer = page.locator('[data-testid="decision-room"] [data-testid="mission-viewer"]');
  await page.waitForTimeout(3000);
  if ((await page.getByTestId('mpv-unavailable-reason').count()) > 0) {
    throw new Error(
      'UNAVAILABLE REASON: ' + (await page.getByTestId('mpv-unavailable-reason').innerText()),
    );
  }
  await expect(viewer).toHaveAttribute('data-availability', 'ready', { timeout: 30_000 });
  await expect(viewer).toHaveAttribute('data-phase', 'S0-initial');
  await expect(page.getByTestId('mpv-phase')).toContainText('unknown by design');
  // S0 never implies clearance.
  await expect(page.getByTestId('mpv-wind')).toContainText('no fresh wind reading');
  await page.screenshot({ path: join(CAPTURE_DIR, 'live-s0-initial.png') });

  // ---- S1: baseline admitted — nominal within modeled limits -------------
  await runStage(page, 'baseline');
  await expect(viewer).toHaveAttribute('data-phase', 'S1-nominal', { timeout: 30_000 });
  // The viewport refetches on stage change (remount key) — the live journal
  // event id appears in the viewer's own evidence list.
  await expect(viewer.locator('.mpv-events')).toContainText(/evt_demo_baseline/i, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('mpv-wind')).toContainText(/\d+(\.\d+)? kt/);
  await page.screenshot({ path: join(CAPTURE_DIR, 'live-s1-baseline.png') });

  // ---- S2/S3: the 24.6 kt incident — RESTRICTED, evidence-linked ---------
  await runStage(page, 'incident');
  await expect(viewer).toHaveAttribute('data-phase', /S2-restricted|S3-restricted-escalated/, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('mpv-truth-chip')).toContainText('SIMULATED_OPERATION');
  // Observed wind from the LIVE journal vs the modeled limit from the payload.
  await expect(page.getByTestId('mpv-wind')).toContainText('24.6 kt');
  await expect(page.getByTestId('mpv-wind')).toContainText('exceeded');
  // Inferred constraint: blocked by the modeled wind rule.
  await expect(page.getByTestId('mpv-constraint')).toContainText('blocked');
  // Selection seeded from the journey's incident event id — the exact
  // journal identity is visible in both the scene and the decision trace.
  const incidentId = (await page.getByTestId('physical-incident').innerText()).match(
    /evt_demo_incident_[a-z0-9]+/i,
  )?.[0];
  expect(incidentId).toBeTruthy();
  await expect(viewer.locator('.mpv-events')).toContainText(new RegExp(incidentId!, 'i'), {
    timeout: 15_000,
  });
  // The restricted state shows the financial decision link (host-provided),
  // never a payment result.
  await expect(page.getByTestId('mpv-decision-link')).toBeVisible();
  await page.screenshot({ path: join(CAPTURE_DIR, 'live-s3-incident-restricted.png') });

  // ---- Historical replay: selecting the baseline returns S4 --------------
  await page
    .locator('[data-testid="decision-room"] .mpv-events__item')
    .filter({ hasText: /evt_demo_baseline/i })
    .click();
  await expect(viewer).toHaveAttribute('data-phase', 'S4-historical', { timeout: 15_000 });
  await expect(page.getByTestId('mpv-replay-chip')).toContainText('Historical replay');
  await page.screenshot({ path: join(CAPTURE_DIR, 'live-s4-historical-replay.png') });
  // Back to live: deselect returns to the current restricted state.
  await page
    .locator('[data-testid="decision-room"] .mpv-events__item')
    .filter({ hasText: /evt_demo_baseline/i })
    .click();
  await expect(viewer).toHaveAttribute('data-phase', /S2-restricted|S3-restricted-escalated/);

  // ---- 2D fallback parity from the LIVE snapshot --------------------------
  await page.getByTestId('mpv-mode-2d').click();
  await expect(viewer).toHaveAttribute('data-mode', '2d');
  await expect(page.getByTestId('mpv-2d')).toBeVisible();
  await expect(page.getByTestId('mpv-constraint')).toContainText('blocked');
  await page.screenshot({ path: join(CAPTURE_DIR, 'live-2d-fallback.png') });
  await page.getByTestId('mpv-mode-3d').click();
  await expect(viewer).toHaveAttribute('data-mode', '3d', { timeout: 15_000 });
});

test('LIVE: reload recreates the same evidence state from server truth', async ({ page }) => {
  const title = `Live reload determinism ${Date.now() % 10000}`;
  await signIn(page, 'founder');
  await createAndGrant(page, title);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, 'operator');
  await selectMission(page, title);
  await page.getByRole('link', { name: 'Decision Room' }).click();
  await runStage(page, 'baseline');
  await runStage(page, 'incident');
  const viewer = page.locator('[data-testid="decision-room"] [data-testid="mission-viewer"]');
  await expect(viewer).toHaveAttribute('data-availability', 'ready', { timeout: 30_000 });
  const phaseBefore = await viewer.getAttribute('data-phase');
  const eventsBefore = await viewer.locator('.mpv-events__item').count();
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await expect(viewer).toHaveAttribute('data-availability', 'ready', { timeout: 30_000 });
  await expect(viewer).toHaveAttribute('data-phase', phaseBefore ?? '');
  await expect(viewer.locator('.mpv-events__item')).toHaveCount(eventsBefore);
});

test('LIVE: no financial writes from the viewport mount or selection', async ({ page }) => {
  const mutating: string[] = [];
  const title = `Live no-write ${Date.now() % 10000}`;
  await signIn(page, 'founder');
  await createAndGrant(page, title);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, 'operator');
  await selectMission(page, title);
  await page.getByRole('link', { name: 'Decision Room' }).click();
  page.on('request', (req) => {
    const url = req.url();
    const method = req.method();
    if (
      method !== 'GET' &&
      (url.includes('/api/operations') ||
        url.includes('/api/approvals') ||
        url.includes('/api/plans'))
    ) {
      mutating.push(`${method} ${url}`);
    }
  });
  await runStage(page, 'baseline');
  const viewer = page.locator('[data-testid="decision-room"] [data-testid="mission-viewer"]');
  await expect(viewer).toHaveAttribute('data-availability', 'ready', { timeout: 30_000 });
  // Interact with the viewer: select evidence, switch modes, orbit.
  await viewer.locator('.mpv-events__item').first().click();
  await page.getByTestId('mpv-mode-2d').click();
  await page.waitForTimeout(400);
  await page.getByTestId('mpv-mode-3d').click();
  await page.waitForTimeout(1500);
  // The journey's own journaling is expected; the VIEWER must have added none.
  expect(mutating).toEqual([]);
});

test('LIVE: scene quality at production widths and reduced motion', async ({ page }, testInfo) => {
  mkdirSync(CAPTURE_DIR, { recursive: true });
  const title = `Live visual pass ${testInfo.parallelIndex}${Date.now() % 10000}`;
  await signIn(page, 'founder');
  await createAndGrant(page, title);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, 'operator');
  await selectMission(page, title);
  await page.getByRole('link', { name: 'Decision Room' }).click();
  await runStage(page, 'baseline');
  await runStage(page, 'incident');
  const viewer = page.locator('[data-testid="decision-room"] [data-testid="mission-viewer"]');
  await expect(viewer).toHaveAttribute('data-availability', 'ready', { timeout: 30_000 });
  // 1920×1080: the flagship width.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(CAPTURE_DIR, 'live-1920x1080.png') });
  // Reduced motion still renders the evidence state.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(800);
  await expect(viewer).toHaveAttribute('data-availability', 'ready');
  // 320px: no horizontal overflow of the decision room.
  await page.setViewportSize({ width: 320, height: 844 });
  await page.waitForTimeout(1200);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
  await page.screenshot({ path: join(CAPTURE_DIR, 'live-320-no-overflow.png') });
});
