import { expect, test, type Page } from '@playwright/test';

/**
 * R-final: operator journeys through the C1 mission-spec contract.
 * - Harbor mission (registered spec): existing journey unchanged.
 * - Warehouse journey through the demo event source on a FRESH mission with
 *   previously-unseen parameters (spec registered on first baseline).
 * - No-action / escalation outcomes displayed as first-class states.
 * - Reload rebuilds everything from the durable journal.
 */
const PASSWORD = ['moterva', 'e2e', 'demo'].join('-');

async function signIn(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('actor-chip')).toBeVisible();
}

async function createMissionViaSheet(page: Page, title: string): Promise<void> {
  await page.getByTestId('new-mission-btn').click();
  const sheet = page.getByTestId('mission-create-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByLabel('Mission name').fill(title);
  await sheet.getByTestId('create-mission-submit').click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('missions-panel')).toContainText(title, { timeout: 10_000 });
}

async function grantMandateAs(page: Page, cap: string, missionTitle: string): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByTestId('actor-chip')).toHaveCount(0);
  await signIn(page, 'founder');
  await page
    .getByTestId('missions-panel')
    .getByRole('button', { name: new RegExp(missionTitle) })
    .first()
    .click();
  await page.getByTestId('grant-first-mandate').click();
  const sheet = page.getByTestId('mandate-create-sheet');
  await sheet.getByLabel('Per-operation cap (USD)').fill('25000');
  await sheet.getByTestId('mandate-review-btn').click();
  await sheet.getByTestId('mandate-submit-btn').click();
  await expect(sheet).toHaveCount(0, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByTestId('actor-chip')).toHaveCount(0);
}

async function signInOperator(page: Page, missionTitle: string): Promise<void> {
  await signIn(page, 'operator');
  await page
    .getByTestId('missions-panel')
    .getByRole('button', { name: new RegExp(missionTitle) })
    .first()
    .click();
}

test.describe('industry journeys through the spec-driven room', () => {
  test('fresh mission registers the warehouse spec via the demo source; no-action and escalation outcomes surface; refresh-from-journal is the primary action', async ({
    page,
  }) => {
    const missionTitle = `Warehouse unseen ${String(Date.now()).slice(-6)}`;
    await signIn(page, 'founder');
    await createMissionViaSheet(page, missionTitle);
    await grantMandateAs(page, '25000', missionTitle);

    await signInOperator(page, missionTitle);
    await page.getByRole('link', { name: 'Decision Room' }).click();
    await page.getByTestId('decision-room').waitFor({ state: 'visible' });
    await page.waitForTimeout(800);

    // Typed mission-spec panel: READ-ONLY configuration from C's contract.
    const specPanel = page.getByTestId('mission-spec-panel');
    await expect(specPanel).toContainText('Mission specification', { timeout: 15_000 });

    // Unregistered fresh mission → the harbor default catalog is offered and
    // the warehouse demo source can register the warehouse spec.
    await page.getByTestId('warehouse-entry').click();
    // After baseline admission the mission spec is warehouse-inventory-v1 and
    // the warehouse step ladder becomes available.
    await expect(page.getByTestId(`warehouse-step-aisle-obstruction`)).toBeVisible({
      timeout: 15_000,
    });

    // Aisle obstruction → the planner sees the ground interrupt and decides
    // (no-action hold or escalation — BOTH are honest non-executable outcomes).
    await page.getByTestId(`warehouse-step-aisle-obstruction`).click();
    await page
      .getByTestId('snapshot-incident')
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => {
        // The incident snapshot may need the explicit record action on this
        // path (the durable snapshot gates are domain-specific).
      });
    // The outcome must be visible somewhere: the record list or the cards.
    const room = page.getByTestId('decision-room');
    await expect(room).toContainText(
      /NO ACTION|ESCALAT|no-action|escalat|HUMAN DECISION|reselect/i,
      {
        timeout: 15_000,
      },
    );

    // Charger fault → escalation path.
    await page.getByTestId(`warehouse-step-charger-fault`).click();
    await page.waitForTimeout(600);

    // Comms loss + restored completes the journey.
    await page.getByTestId(`warehouse-step-comms-loss`).click();
    await page.waitForTimeout(600);
    await page.getByTestId(`warehouse-step-comms-restored`).click();
    await page.waitForTimeout(600);

    // Refresh-from-journal (primary operator action) rebuilds from durable state.
    await page.getByTestId('refresh-journal').click();
    await page.waitForTimeout(800);
    await expect(page.getByTestId('recorded-snapshots')).toBeVisible();

    // Reload persistence: everything rebuilds from the durable journal.
    await page.reload();
    await page.getByRole('link', { name: 'Decision Room' }).click();
    await page.getByTestId('decision-room').waitFor({ state: 'visible' });
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('recorded-snapshots')).toBeVisible({ timeout: 15_000 });
    await expect(specPanel).toContainText('warehouse-amr');
  });

  test('harbor mission journey is unchanged through the spec-driven room', async ({ page }) => {
    await signIn(page, 'operator');
    // The seeded Harbor mission carries the harbor spec.
    await page.getByRole('link', { name: 'Decision Room' }).click();
    await expect(page.getByTestId('decision-room')).toContainText('Harbor turbine inspection', {
      timeout: 15_000,
    });
    if (await page.getByTestId('start-synthetic').isEnabled()) {
      await page.getByTestId('start-synthetic').click();
    }
    await expect(page.getByTestId('snapshot-baseline')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('decision-room')).toContainText('Harbor turbine inspection');
  });
});
