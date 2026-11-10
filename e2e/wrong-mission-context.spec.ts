import { expect, test, type Page } from '@playwright/test';

/**
 * R-final B1 regression: mission creation must refresh the App-level mission
 * context. Failing-before behavior: after creating a mission, the Decision
 * Room silently rendered/executed against the FIRST mission (context list
 * was stale), so the entire financial journey landed on the wrong mission.
 */

const PASSWORD = ['moterva', 'e2e', 'demo'].join('-');
const SUFFIX = () => String(Date.now()).slice(-6);

async function signIn(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('actor-chip')).toBeVisible();
}

test('created mission becomes the decision context (wrong-mission regression)', async ({
  page,
}) => {
  const title = `Context fix mission ${SUFFIX()}`;
  await signIn(page, 'founder');
  await page.getByTestId('new-mission-btn').click();
  const sheet = page.getByTestId('mission-create-sheet');
  await sheet.getByLabel('Mission name').fill(title);
  await sheet.getByTestId('create-mission-submit').click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('missions-panel')).toContainText(title, { timeout: 10_000 });

  // Navigate DIRECTLY to the Decision Room after creation — the room must
  // render the NEW mission, never the first/previous mission.
  await page.getByRole('link', { name: 'Decision Room' }).click();
  await page.getByTestId('decision-room').waitFor({ state: 'visible' });
  await page.waitForTimeout(600);
  const roomText = await page.getByTestId('decision-room').innerText();
  expect(roomText, 'decision room renders the created mission').toContain(title);
  expect(roomText, 'decision room does NOT render the old first mission').not.toContain(
    'Harbor turbine inspection',
  );

  // The durable writes must target the created mission too: record baseline.
  if (await page.getByTestId('start-synthetic').isEnabled()) {
    await page.getByTestId('start-synthetic').click();
  }
  await expect(page.getByTestId(`snapshot-baseline`)).toBeVisible({ timeout: 15_000 });

  // Server truth: the snapshot belongs to the created mission.
  const snap = await page.evaluate(async (t) => {
    const ms = (await fetch('/api/missions', { credentials: 'same-origin' }).then((r) =>
      r.json(),
    )) as { missions: { id: string; title: string }[] };
    const created = ms.missions.find((m) => m.title === t);
    if (created === undefined) throw new Error('created mission missing');
    const ev = await fetch(`/api/missions/${created.id}/decision-snapshots`, {
      credentials: 'same-origin',
    }).then((r) => r.json());
    return (ev as { snapshots: unknown[] }).snapshots.length;
  }, title);
  expect(snap, 'durable snapshot recorded on the CREATED mission').toBeGreaterThanOrEqual(1);
});

test('mission switch during load never executes on another mission (fail-closed context)', async ({
  page,
}) => {
  const title = `Fail-closed context ${SUFFIX()}`;
  await signIn(page, 'founder');
  await page.getByTestId('new-mission-btn').click();
  const sheet = page.getByTestId('mission-create-sheet');
  await sheet.getByLabel('Mission name').fill(title);
  await sheet.getByTestId('create-mission-submit').click();
  await expect(sheet).toHaveCount(0);

  // Immediately open the Decision Room — while the context list settles, the
  // room must NOT render any other mission's name.
  await page.getByRole('link', { name: 'Decision Room' }).click();
  await page.getByTestId('decision-room').waitFor({ state: 'visible' });
  await expect(page.getByTestId('decision-room')).toContainText(title, { timeout: 15_000 });
  const roomText = await page.getByTestId('decision-room').innerText();
  expect(roomText).not.toContain('Harbor turbine inspection');
});
