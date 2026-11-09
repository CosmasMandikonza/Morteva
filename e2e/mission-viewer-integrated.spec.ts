import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * MTV-09/12 integrated Decision Room proof (brief §C5) — the viewer is
 * MOUNTED in the real application (DecisionRoom) and this spec drives the
 * REAL authenticated journey (founder creates + grants the mandate →
 * operator signs the synthetic baseline and incident) against the real
 * server, then asserts:
 *   - the mounted viewer renders its HONEST unavailable state (the
 *     physical-view read endpoint is not deployed on this build — the
 *     fixture never substitutes for live data in the product shell),
 *   - the exact journal event identity stays visible on the incident panel,
 *   - the financial decision cards are unaffected by the viewer mount,
 *   - reload rebuilds the same honest mounted state from server truth.
 * Screenshots land in research/mtv-09/captures/integrated/.
 */
const PASSWORD = ['moterva', 'e2e', 'demo'].join('-');
const CAPTURE_DIR = join(import.meta.dirname, '..', 'research', 'mtv-09', 'captures', 'integrated');

test.setTimeout(180_000);

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

test('mounted viewer: honest unavailable state inside the real Decision Room', async ({
  page,
}, testInfo) => {
  mkdirSync(CAPTURE_DIR, { recursive: true });
  const title = `Viewer mount mission ${testInfo.parallelIndex}${Date.now() % 10000}`;

  // Authority: founder creates the mission and grants the spending mandate.
  await signIn(page, 'founder');
  await createAndGrant(page, title);

  // Operator: runs the signed synthetic journey in the Decision Room.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, 'operator');
  await selectMission(page, title);
  await page.getByRole('link', { name: 'Decision Room' }).click();

  // Baseline: the mounted viewer is present with the honest unavailable card.
  await runStage(page, 'baseline');
  const viewer = page.locator('[data-testid="decision-room"] [data-testid="mission-viewer"]');
  await expect(viewer).toHaveAttribute('data-availability', 'unavailable');
  await expect(page.getByTestId('mpv-unavailable')).toContainText(
    'Physical evidence read-out unavailable',
  );
  await expect(page.getByTestId('mpv-unavailable-reason')).toContainText('not deployed yet');
  // The honest law, stated to the user in the product:
  await expect(page.getByTestId('mpv-unavailable')).toContainText('no demo data is substituted');
  // No scene is rendered for an unavailable snapshot — no canvas, no 2D SVG.
  await expect(page.locator('[data-testid="mpv-canvas"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="mpv-2d"]')).toHaveCount(0);
  await page.screenshot({ path: join(CAPTURE_DIR, 'integrated-baseline-unavailable.png') });

  // Incident: the exact journal identity appears on the incident panel while
  // the scene remains honestly withheld.
  await runStage(page, 'incident');
  const incident = page.getByTestId('physical-incident');
  await expect(incident).toContainText('24.6 kt');
  const incidentText = await incident.innerText();
  expect(incidentText).toMatch(/EVT_[A-Za-z0-9_]+|mevt_[0-9a-f]+/); // exact journal event id present

  // Financial decision cards are unaffected by the mount.
  await expect(page.getByTestId('decision-room')).toContainText('After · updated constraints');
  await expect(page.getByTestId('decision-room')).toContainText('POLICY-ONLY');
  await page.screenshot({ path: join(CAPTURE_DIR, 'integrated-incident-unavailable.png') });

  // Reload: the durable journey rebuilds from server truth and the mount
  // renders the same honest state (deterministic across reloads).
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('physical-incident')).toContainText('24.6 kt', { timeout: 15_000 });
  await expect(
    page.locator('[data-testid="decision-room"] [data-testid="mission-viewer"]'),
  ).toHaveAttribute('data-availability', 'unavailable');
  await page.screenshot({ path: join(CAPTURE_DIR, 'integrated-reload-unavailable.png') });
});

test('mounted viewer: unavailable card renders in both theme modes', async ({ page }) => {
  const title = `Viewer mount theme parity ${Date.now() % 10000}`;
  await signIn(page, 'founder');
  await createAndGrant(page, title);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, 'operator');
  await selectMission(page, title);
  await page.getByRole('link', { name: 'Decision Room' }).click();
  await runStage(page, 'baseline');
  const viewer = page.locator('[data-testid="decision-room"] [data-testid="mission-viewer"]');
  await expect(viewer).toHaveAttribute('data-availability', 'unavailable');
  await page.screenshot({ path: join(CAPTURE_DIR, 'integrated-unavailable-dark.png') });
  await page.getByRole('button', { name: 'Light mode' }).click();
  await expect(viewer).toBeVisible();
  await page.screenshot({ path: join(CAPTURE_DIR, 'integrated-unavailable-light.png') });
});
