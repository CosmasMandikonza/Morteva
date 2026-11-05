import { expect, test } from '@playwright/test';

/**
 * P0 judge journey: same authenticated local session and existing seed ledger.
 * Real signed synthetic events → journal replay → planner → displayed result.
 * Explicitly NOT a provider settlement / live-model / payment-approval test.
 */
test('one synthetic physical incident changes a real ledger-bound financial decision', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Username').fill('founder');
  await page.getByLabel('Password').fill('moterva-e2e-demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('actor-chip')).toBeVisible();

  await page.getByRole('link', { name: 'Decision Room' }).click();
  await expect(page.getByTestId('decision-room')).toContainText('Harbor turbine inspection');
  await expect(page.getByTestId('start-synthetic')).toBeEnabled();
  await page.getByTestId('start-synthetic').click();
  await expect(page.getByTestId('decision-room')).toContainText('Before · initial plan');
  await expect(page.getByTestId('introduce-incident')).toBeEnabled();

  await page.getByTestId('introduce-incident').click();
  await expect(page.getByTestId('physical-incident')).toContainText('24.6 kt');
  await expect(page.getByTestId('physical-incident')).toContainText('SYNTHETIC');
  await expect(page.getByTestId('decision-room')).toContainText('ASSET_SAFETY_BLOCKED');
  await expect(page.getByTestId('decision-room')).toContainText('Hire vessel-inspection');
  await expect(page.getByTestId('decision-provenance')).toContainText('No money sent');

  const mission = await page.evaluate(async () => {
    const ms = (await fetch('/api/missions', { credentials: 'same-origin' }).then((r) =>
      r.json(),
    )) as {
      missions: { id: string; title: string }[];
    };
    const selected = ms.missions.find((m) => m.title === 'Harbor turbine inspection');
    if (!selected) throw new Error('seeded mission missing');
    return selected.id;
  });
  const response = await page.request.get(
    '/api/missions/' + encodeURIComponent(mission) + '/physical-decision',
  );
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.stage).toBe('incident');
  expect(result.before.selected.candidateId).not.toBe(result.after.selected.candidateId);
  expect(result.after.evidenceIds).toContain(result.incident.eventId);
  expect(result.after.providerVerified).toBe(false);
  expect(result.after.authorization).toContain('PROPOSED_ONLY');

  await page.reload();
  await page.getByRole('link', { name: 'Decision Room' }).click();
  await expect(page.getByTestId('physical-incident')).toContainText(result.incident.eventId);
});
