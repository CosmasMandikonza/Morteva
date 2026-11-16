import { expect, test, type Page } from '@playwright/test';
import { apiProvisionMission, signIn } from './support/customer.js';

function uniq(base: string): string {
  return `${base} ${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Mission Setup clarity redesign (dedicated screen test).
 *
 * The registered view must read as a configuration workspace: mission name as
 * the primary title, one status badge, a readiness strip with REAL states, a
 * 65/35 brief + financial-boundaries composition, technical detail and the
 * developer guide behind collapsed disclosures, and the same honest
 * unregistered / restricted-role behavior as before.
 */
const PASSWORD = ['moterva', 'e2e', 'demo'].join('-');

test.describe('mission setup clarity (registered)', () => {
  test.beforeEach(async ({ page, request }) => {
    await apiProvisionMission(request, uniq('Clarity mission'), { mandate: true });
    await signIn(page, 'founder');
    await page
      .getByTestId('missions-panel')
      .getByRole('button', { name: /Clarity mission/ })
      .first()
      .click();
    await page.getByRole('link', { name: 'Mission Setup' }).click();
    await expect(page.getByTestId('mission-setup')).toBeVisible();
    await expect(page.getByTestId('ms-readiness')).toBeVisible({ timeout: 10_000 });
  });

  test('header: mission name is the primary title; one status badge; subtle proposes-only chip', async ({
    page,
  }) => {
    const title = page.locator('.ms-title');
    await expect(title).toBeVisible();
    await expect(title).toContainText('Clarity mission');
    await expect(page.locator('.ms-head__badges .mv-badge--info')).toContainText(
      'Specification registered',
    );
    await expect(page.locator('.ms-policychip')).toContainText('Proposes only');
    // the supporting line states what the mission is configured to accomplish
    await expect(page.getByTestId('ms-objective')).toContainText('volumetric report');
    // no competing POLICY-ONLY badge in the header anymore
    await expect(page.locator('.ms-head__badges .mv-badge--neutral')).toHaveCount(0);
  });

  test('readiness strip shows real states, never fake completion', async ({ page }) => {
    const strip = page.getByTestId('ms-readiness');
    await expect(strip).toContainText('Specification');
    await expect(strip).toContainText('Sources');
    await expect(strip).toContainText('Authority');
    await expect(strip).toContainText('Field evidence');
    await expect(strip).toContainText('Decision');
    // authority is granted in this fixture → done with remaining amount note
    await expect(strip.locator('.is-done', { hasText: 'Authority' })).toBeVisible();
    // no observations yet → evidence is active, not done
    await expect(strip.locator('.is-active', { hasText: 'Field evidence' })).toBeVisible();
  });

  test('65/35 composition: mission brief left, financial boundaries right', async ({ page }) => {
    await expect(page.getByTestId('setup-spec-summary')).toContainText('Mission brief');
    await expect(page.getByTestId('setup-authority')).toContainText('Financial boundaries');
    const cols = await page.evaluate(() => {
      const brief = document.querySelector('.ms-brief')?.getBoundingClientRect();
      const fin = document.querySelector('.ms-financial')?.getBoundingClientRect();
      if (brief === undefined || fin === undefined) return null;
      return {
        briefW: Math.round(brief.width),
        finW: Math.round(fin.width),
        sideBySide: fin.top < brief.bottom - 5,
      };
    });
    expect(cols).not.toBeNull();
    // roughly 65/35 and actually side by side at desktop
    expect(cols!.sideBySide).toBe(true);
    expect(cols!.briefW / (cols!.briefW + cols!.finW)).toBeGreaterThan(0.58);
    expect(cols!.briefW / (cols!.briefW + cols!.finW)).toBeLessThan(0.72);
  });

  test('brief rows are human-readable: asset names first, ids secondary; policy not measurement', async ({
    page,
  }) => {
    const brief = page.getByTestId('setup-spec-summary');
    await expect(brief.locator('.ms-assets__name').first()).toContainText('Survey quadcopter');
    await expect(brief.locator('.ms-assets__meta').first()).toContainText('survey-quad-q3');
    await expect(brief).toContainText('operating rule this mission declares, not a measurement');
    await expect(brief).toContainText('Incumbent');
    await expect(brief).toContainText('Alternative');
  });

  test('financial boundaries are planning parameters, never account balances', async ({ page }) => {
    const fin = page.getByTestId('setup-authority');
    await expect(fin).toContainText('not account balances');
    await expect(fin).toContainText('Mission value at stake');
    await expect(fin).toContainText('Protected reserve — never spendable');
    await expect(fin.getByTestId('setup-mandate-active')).toContainText('remaining');
    await expect(fin.getByTestId('setup-grant-authority')).toBeVisible();
    await expect(fin.getByTestId('setup-open-decisions')).toBeVisible();
  });

  test('technical details live in a collapsed disclosure with id, digest and raw JSON', async ({
    page,
  }) => {
    const details = page.getByTestId('ms-techdetails');
    await expect(details).toBeVisible();
    await expect(details).not.toHaveAttribute('open', '');
    await details.locator('> summary').click();
    await expect(details).toContainText('quarry-blast-survey-q3');
    await expect(details).toContainText('Raw specification JSON');
    await details.getByText('Raw specification JSON').click();
    await expect(details.locator('.ms-json')).toContainText('"specId"');
  });

  test('developer integration is collapsed by default and opens with the full guide', async ({
    page,
  }) => {
    const dev = page.getByTestId('developer-integration');
    await expect(dev).toBeVisible();
    await expect(dev).not.toHaveAttribute('open', '');
    await dev.locator('> summary').click();
    const guide = page.getByTestId('headless-guide');
    await expect(dev).toContainText('How a field system sends signed evidence');
    await expect(page.getByTestId('ingest-route')).toContainText('/events');
    await expect(guide).toContainText('credential-authenticated claim');
  });

  test('create-new-version remains visible for operators only', async ({ page }) => {
    await expect(page.getByTestId('setup-new-version')).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await signIn(page, 'viewer');
    await page
      .getByTestId('missions-panel')
      .getByRole('button', { name: /Clarity mission/ })
      .first()
      .click();
    await page.getByRole('link', { name: 'Mission Setup' }).click();
    await expect(page.getByTestId('setup-role-note')).toBeVisible();
    await expect(page.getByTestId('setup-new-version')).toHaveCount(0);
  });
});

test.describe('mission setup clarity (states)', () => {
  test('unregistered mission: honest note, no fake readiness, form reachable', async ({
    page,
    request,
  }) => {
    // A GENUINELY unregistered mission: create via the API but register NO
    // specification (apiProvisionMission always registers one).
    const title = uniq('Unregistered clarity');
    const login = await request.post('/api/auth/login', {
      data: { username: 'founder', password: PASSWORD },
    });
    const { csrfToken } = await login.json();
    const created = await request.post('/api/missions', {
      headers: { 'x-csrf-token': csrfToken },
      data: { title },
    });
    expect(created.status()).toBe(200);
    await signIn(page, 'founder');
    await page
      .getByTestId('missions-panel')
      .getByRole('button', { name: new RegExp(title.slice(0, 20)) })
      .first()
      .click();
    await page.getByRole('link', { name: 'Mission Setup' }).click();
    await expect(page.getByTestId('mission-setup')).toBeVisible();
    await expect(page.getByTestId('setup-unregistered')).toContainText(
      'No specification is registered',
    );
    await expect(page.locator('.ms-head__badges .mv-badge--neutral')).toContainText(
      'No specification yet',
    );
    // readiness never claims completion
    await expect(page.getByTestId('ms-readiness').locator('.is-done')).toHaveCount(0);
    await expect(page.getByTestId('setup-author')).toBeVisible();
    await expect(page.getByTestId('setup-review')).toBeVisible();
  });

  test('spec read failure: honest error state, not silent emptiness', async ({ page, request }) => {
    await apiProvisionMission(request, uniq('Error clarity'), { mandate: false });
    await page.route('**/api/missions/*/mission-spec', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }),
      }),
    );
    await signIn(page, 'founder');
    await page
      .getByTestId('missions-panel')
      .getByRole('button', { name: /Error clarity/ })
      .first()
      .click();
    await page.getByRole('link', { name: 'Mission Setup' }).click();
    await expect(page.getByTestId('setup-spec-error')).toContainText('could not be read');
    // the workspace header still renders; no fabricated spec content appears
    await expect(page.getByTestId('ms-techdetails')).toHaveCount(0);
  });

  test('no horizontal overflow at 1440/1024/390/320 and 200% zoom equivalent', async ({
    page,
    request,
  }) => {
    await apiProvisionMission(request, uniq('Responsive clarity'), { mandate: true });
    await signIn(page, 'founder');
    await page
      .getByTestId('missions-panel')
      .getByRole('button', { name: /Responsive clarity/ })
      .first()
      .click();
    await page.getByRole('link', { name: 'Mission Setup' }).click();
    await expect(page.getByTestId('ms-readiness')).toBeVisible({ timeout: 10_000 });
    for (const [w, h] of [
      [1440, 900],
      [1024, 900],
      [640, 450],
      [390, 844],
      [320, 844],
    ] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(350);
      const sw = await page.evaluate<number>('document.documentElement.scrollWidth');
      expect(sw, `scrollWidth at ${String(w)}`).toBeLessThanOrEqual(w);
      await expect(page.getByTestId('setup-spec-summary')).toBeVisible();
    }
  });

  test('light/dark themes and reduced motion render the complete workspace', async ({
    page,
    browser,
    request,
  }) => {
    await apiProvisionMission(request, uniq('Theme clarity'), { mandate: true });
    await signIn(page, 'founder');
    await page
      .getByTestId('missions-panel')
      .getByRole('button', { name: /Theme clarity/ })
      .first()
      .click();
    await page.getByRole('link', { name: 'Mission Setup' }).click();
    await expect(page.getByTestId('ms-readiness')).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.waitForTimeout(250);
    await expect(page.locator('.ms-title')).toBeVisible();
    await expect(page.getByTestId('ms-objective')).toBeVisible();
    await expect(page.getByTestId('setup-authority')).toBeVisible();

    // keyboard: the developer-integration summary is reachable and operable
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    for (let i = 0; i < 30; i += 1) await page.keyboard.press('Tab');
    const dev = page.getByTestId('developer-integration');
    await dev.locator('> summary').focus();
    await page.keyboard.press('Enter');
    await expect(dev).toHaveAttribute('open', '');

    const rm = await browser.newPage({ reducedMotion: 'reduce' });
    await rm.goto('/app');
    await rm.getByLabel('Username').fill('founder');
    await rm.getByLabel('Password').fill(PASSWORD);
    await rm.getByRole('button', { name: 'Sign in' }).click();
    await rm.getByTestId('actor-chip').waitFor();
    await rm
      .getByTestId('missions-panel')
      .getByRole('button', { name: /Theme clarity/ })
      .first()
      .click();
    await rm.getByRole('link', { name: 'Mission Setup' }).click();
    await expect(rm.getByTestId('ms-readiness')).toBeVisible({ timeout: 10_000 });
    await expect(rm.getByTestId('ms-objective')).toBeVisible();
    await rm.close();
  });
});

test.describe('source onboarding stays fully functional', () => {
  test('issuance, one-time reveal and revocation controls remain present and operable', async ({
    page,
    request,
  }) => {
    await apiProvisionMission(request, uniq('Sources clarity'), { mandate: false });
    await signIn(page, 'founder');
    await page
      .getByTestId('missions-panel')
      .getByRole('button', { name: /Sources clarity/ })
      .first()
      .click();
    await page.getByRole('link', { name: 'Mission Setup' }).click();
    await expect(page.getByTestId('source-credentials')).toBeVisible({ timeout: 10_000 });

    await chooseSource(page, 'bench7-flight-link');
    await page.getByTestId('issue-keyid').fill('key-clarity-a');
    await page.getByTestId('issue-credential').click();
    await expect(page.getByTestId('credential-reveal')).toBeVisible();
    // masked until reveal; acknowledge; dismiss
    await expect(page.getByTestId('credential-secret')).toHaveText(/^•+$/);
    await page.getByTestId('credential-reveal-toggle').click();
    const secret = ((await page.getByTestId('credential-secret').textContent()) ?? '').trim();
    expect(secret.length).toBeGreaterThan(30);
    await page.getByTestId('credential-reveal-toggle').click();
    await page.getByTestId('credential-ack').check();
    await page.getByTestId('credential-done').click();
    await expect(page.getByTestId('credential-reveal')).toHaveCount(0);
    // the secret never persists in the page or storage
    await expect(page.locator('body')).not.toContainText(secret);

    // revocation controls present (owner)
    await expect(page.getByTestId('revoke-keyid')).toBeVisible();
    await expect(page.getByTestId('revoke-start')).toBeVisible();
  });
});

/** The source picker is a select when the API lists declared sources. */
async function chooseSource(page: Page, sourceId: string): Promise<void> {
  const field = page.getByTestId('issue-source');
  const tag = await field.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'select') await field.selectOption(sourceId);
  else await field.fill(sourceId);
}
