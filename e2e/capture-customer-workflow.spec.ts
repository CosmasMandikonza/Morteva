import { expect, test, type Page } from '@playwright/test';
import {
  createMissionViaSheet,
  deliver,
  fillSpecForm,
  headlessClient,
  selectMission,
  signedEnvelope,
  signIn,
  signOut,
  UNSEEN,
} from './support/customer.js';

/**
 * Opt-in evidence capture of the CUSTOMER-OPERATED workflow from the real
 * application — run with:
 *   CAPTURE=1 npx playwright test e2e/capture-customer-workflow.spec.ts --workers=1
 * Writes docs/assets/production/mtv-13-customer-*.png. Never part of CI.
 *
 * SECRET HYGIENE: the credential dialog is captured with the secret MASKED
 * (it is never revealed on screen), and every capture of a page that held the
 * dialog is taken after it was dismissed. No image contains a signing secret.
 */
const shouldCapture = !!process.env.CAPTURE;
test.skip(!shouldCapture, 'screenshot capture is opt-in (CAPTURE=1)');
test.setTimeout(240_000);

const OUT = 'docs/assets/production/mtv-13-customer';

async function shot(page: Page, name: string, mask: boolean = false): Promise<void> {
  await page.waitForTimeout(350);
  await page.screenshot({
    path: `${OUT}-${name}.png`,
    mask: mask ? [page.getByTestId('credential-secret')] : [],
  });
}

async function theme(page: Page, value: 'dark' | 'light'): Promise<void> {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), value);
  await page.waitForTimeout(250);
}

test('capture the customer-operated workflow (dark + light, 1440 → 320, 200% zoom)', async ({
  page,
  playwright,
  baseURL,
}) => {
  const suffix = Date.now().toString(36).slice(-5);
  const title = `${UNSEEN.title} ${suffix}`;
  await page.setViewportSize({ width: 1440, height: 900 });

  // ---------------------------------------------------------- setup (founder)
  await signIn(page, 'founder');
  await createMissionViaSheet(page, title);
  await page.getByRole('link', { name: 'Mission Setup' }).click();
  await expect(page.getByTestId('setup-unregistered')).toBeVisible();
  await shot(page, 'setup-empty-1440x900');
  await fillSpecForm(page);
  await page.getByTestId('setup-review').click();
  await expect(page.getByTestId('setup-review-pane')).toBeVisible();
  await page.getByTestId('setup-review-pane').scrollIntoViewIfNeeded();
  await shot(page, 'setup-exact-review-1440x900');
  await page.getByTestId('setup-register').click();
  await expect(page.getByTestId('setup-registered-notice')).toBeVisible();
  await shot(page, 'setup-registered-1440x900');

  // credential dialog: secret MASKED, never revealed on screen
  await page.getByTestId('issue-source').selectOption('bench7-flight-link');
  await page.getByTestId('issue-keyid').fill('key-bench7-a');
  await page.getByTestId('issue-credential').click();
  await expect(page.getByTestId('credential-reveal')).toBeVisible();
  await expect(page.getByTestId('credential-secret')).toHaveText(/^•+$/);
  await shot(page, 'credential-one-time-masked-1440x900', true);
  await page.getByTestId('credential-reveal-toggle').click();
  const secret = ((await page.getByTestId('credential-secret').textContent()) ?? '').trim();
  await page.getByTestId('credential-reveal-toggle').click(); // hide again
  await page.getByTestId('credential-ack').check();
  await page.getByTestId('credential-done').click();
  await expect(page.getByTestId('credential-reveal')).toHaveCount(0);
  await page.getByTestId('headless-guide').scrollIntoViewIfNeeded();
  await page.getByTestId('headless-guide').getByText('Example envelope').click();
  await shot(page, 'setup-sources-and-headless-guide-1440x900');

  await page.getByTestId('setup-grant-authority').click();
  const mandate = page.getByTestId('mandate-create-sheet');
  await mandate.getByLabel('Per-operation cap (USD)').fill('100000');
  await mandate.getByLabel(/Mission budget envelope/).fill('150000');
  await shot(page, 'mandate-prefilled-from-spec-1440x900');
  await mandate.getByTestId('mandate-review-btn').click();
  await mandate.getByTestId('mandate-submit-btn').click();
  await expect(mandate).toHaveCount(0, { timeout: 10_000 });
  await shot(page, 'setup-authority-granted-1440x900');

  // ----------------------------------- independent field system (no browser)
  const missionId = await page.evaluate(
    () => window.sessionStorage.getItem('moterva-selected-mission') ?? '',
  );
  const orgId = await page.evaluate(async () => {
    const r = await fetch('/api/auth/session', { credentials: 'same-origin' });
    return ((await r.json()) as { actor: { orgId: string } }).actor.orgId;
  });
  const base = {
    orgId,
    missionId,
    assetId: 'survey-quad-q3',
    sourceId: 'bench7-flight-link',
    sourceType: 'asset_telemetry',
    keyId: 'key-bench7-a',
  };
  const headless = await headlessClient(playwright, baseURL);
  const baseline = signedEnvelope(
    {
      ...base,
      eventId: `evt_cap_base_${suffix}`,
      sequence: 1,
      agoMs: 30_000,
      observations: [
        { kind: 'wind_speed', unit: 'kt', value: UNSEEN.baselineWind },
        { kind: 'weather_hold', unit: 'state', value: 'clear' },
        { kind: 'asset_comms', unit: 'state', value: 'online' },
      ],
    },
    secret,
  );
  await deliver(headless, missionId, [baseline]); // credential-only: no cookie, no CSRF
  await signOut(page);

  // -------------------------------------------------- operator: baseline
  await signIn(page, 'operator');
  await selectMission(page, title);
  await page.getByRole('link', { name: 'Decision Room' }).click();
  await expect(page.getByTestId('field-events')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="mission-viewer"]')).toHaveAttribute(
    'data-availability',
    'ready',
    { timeout: 30_000 },
  );
  await shot(page, 'decision-field-evidence-before-1440x900');
  await page.getByTestId('evaluate-journal').click();
  await expect(page.getByTestId('live-evaluation-outcome')).toHaveAttribute(
    'data-outcome',
    'no-action',
    { timeout: 15_000 },
  );
  await page.getByTestId('live-evaluation').scrollIntoViewIfNeeded();
  await shot(page, 'decision-baseline-no-action-1440x900');

  // -------------------------------------------------- unseen threshold breach
  await deliver(headless, missionId, [
    signedEnvelope(
      {
        ...base,
        eventId: `evt_cap_breach_${suffix}`,
        sequence: 2,
        agoMs: 10_000,
        observations: [
          { kind: 'wind_speed', unit: 'kt', value: UNSEEN.breachWind },
          { kind: 'weather_hold', unit: 'state', value: 'active' },
        ],
      },
      secret,
    ),
  ]);
  await page.getByTestId('refresh-journal').click();
  await expect(page.getByTestId('evaluate-journal')).toHaveText('Evaluate the latest evidence');
  await page.getByTestId('evaluate-journal').click();
  await expect(page.getByTestId('live-evaluation-outcome')).toHaveAttribute(
    'data-outcome',
    'spend',
    { timeout: 15_000 },
  );
  await page.getByTestId('propose-plan').click();
  await expect(page.getByTestId('decision-plan-row').first()).toBeVisible({ timeout: 15_000 });

  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'decision-incident-s2-live-scene-1440x900');
  await page.getByTestId('live-evaluation').scrollIntoViewIfNeeded();
  await shot(page, 'decision-alternatives-refusals-1440x900');
  await page.getByTestId('decision-plans').scrollIntoViewIfNeeded();
  await shot(page, 'decision-immutable-proposal-1440x900');
  await theme(page, 'light');
  await page.getByTestId('live-evaluation').scrollIntoViewIfNeeded();
  await shot(page, 'decision-alternatives-refusals-light-1440x900');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'decision-incident-light-1440x900');
  await theme(page, 'dark');

  // --------------------------------------------------- responsive ladder
  for (const [w, h, name] of [
    [1024, 768, '1024'],
    [640, 450, '640-zoom200'],
    [390, 844, '390'],
    [320, 800, '320'],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, `decision-top-${name}`);
    await page.locator('.mpv-stage').first().scrollIntoViewIfNeeded();
    await shot(page, `decision-scene-and-hud-${name}`);
    await page.getByTestId('live-evaluation').scrollIntoViewIfNeeded();
    await shot(page, `decision-alternatives-${name}`);
    await page.getByRole('link', { name: 'Mission Setup' }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, `setup-${name}`);
    await page.getByRole('link', { name: 'Decision Room' }).click();
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // ------------------------------------------- approver + evidence replay
  await signOut(page);
  await signIn(page, 'approver');
  await selectMission(page, title);
  await page.getByRole('link', { name: 'Decision Room' }).click();
  await page.getByTestId('open-approve').click();
  const approve = page.getByTestId('approve-plan-sheet');
  await approve.getByTestId('approve-review-btn').click();
  await shot(page, 'approval-exact-terms-1440x900');
  await approve.getByTestId('approve-submit-btn').click();
  await expect(page.getByTestId('plan-approval-recorded')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('decision-plans').scrollIntoViewIfNeeded();
  await shot(page, 'approval-recorded-provider-offline-1440x900');
  await page.getByRole('link', { name: 'Evidence Replay' }).click();
  await expect(page.getByTestId('evidence-panel')).toBeVisible({ timeout: 15_000 });
  await shot(page, 'evidence-replay-1440x900');
  await page.getByRole('link', { name: 'Authority & Execution' }).click();
  await page.waitForTimeout(1200);
  await shot(page, 'authority-provider-offline-1440x900');
  await headless.dispose();
});
