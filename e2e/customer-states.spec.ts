import { expect, test, type Page } from '@playwright/test';
import {
  apiAdmitEvidence,
  apiIssueCredential,
  apiProvisionMission,
  createMissionViaSheet,
  fillSpecForm,
  selectMission,
  signIn,
  UNSEEN,
} from './support/customer.js';

/**
 * R-final — the customer workflow's NON-HAPPY states, against the real
 * backend: empty, invalid, refused, expired, forbidden, failing and narrow.
 * Mission data is provisioned through the PRODUCTION API (unseen values); the
 * UI under test is the real application. Nothing here is a fixture route.
 */

test.setTimeout(120_000);

function uniq(base: string): string {
  const info = test.info();
  return `${base} ${Date.now().toString(36).slice(-5)}w${info.workerIndex}r${info.retry}`;
}

async function openDecisionRoom(page: Page, role: string, title: string): Promise<void> {
  await signIn(page, role);
  await selectMission(page, title);
  await page.getByRole('link', { name: 'Decision Room' }).click();
  await expect(page.getByTestId('decision-room')).toBeVisible();
}

/** The source field is a select when the API lists declared sources, else a
 *  text input (older builds) — the operator's action is the same. */
async function chooseSource(page: Page, sourceId: string): Promise<void> {
  const field = page.getByTestId('issue-source');
  const tag = await field.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'select') await field.selectOption(sourceId);
  else await field.fill(sourceId);
}

async function noHorizontalOverflow(page: Page, width: number, label: string): Promise<void> {
  const sw = await page.evaluate<number>('document.documentElement.scrollWidth');
  if (sw <= width) return;
  // Name the real offenders so a failure is a diagnosis, not just a number.
  const offenders = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((el) => el.getBoundingClientRect().right > vw + 1)
      .slice(0, 6)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}[${el.getAttribute('data-testid') ?? ''}]`,
      );
  });
  expect(
    sw,
    `${label}: document scrollWidth at ${String(width)}; offenders: ${offenders.join(' | ')}`,
  ).toBeLessThanOrEqual(width);
}

test.describe('configuration: empty and invalid inputs', () => {
  test('an empty form and malformed values are refused on the client WITHOUT any server write', async ({
    page,
  }) => {
    const writes: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /mission-spec|\/secret/.test(r.url())) writes.push(r.url());
    });
    await signIn(page, 'founder');
    await createMissionViaSheet(page, uniq('Empty form mission'));
    await page.getByRole('link', { name: 'Mission Setup' }).click();

    // Honest empty state: nothing prefilled, no fallback.
    await expect(page.getByTestId('setup-unregistered')).toBeVisible();
    await expect(page.getByLabel('Spec id')).toHaveValue('');
    await expect(page.getByLabel(/^Mission value/)).toHaveValue('');

    await page.getByTestId('setup-review').click();
    const issues = page.getByTestId('setup-issues');
    await expect(issues).toBeVisible();
    await expect(issues).toContainText('SPEC_ID_INVALID');
    await expect(issues).toContainText('SPEC_ASSET_ID_INVALID');
    await expect(issues).toContainText('SPEC_SOURCE_ID_INVALID');
    await expect(issues).toContainText('SPEC_ECONOMICS_INVALID');
    await expect(issues).toContainText('SPEC_OFFER_ID_INVALID');
    // field-level errors are attached to the inputs (accessible)
    await expect(page.getByLabel('Spec id')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('setup-review-pane')).toHaveCount(0);

    // Ids the ingest layer would refuse are refused at CONFIGURATION time.
    await page.getByLabel('Asset 1 id').fill('quad-transfer-1');
    await page.getByLabel('Currency').selectOption('JPY');
    await page.getByLabel(/^Mission value/).fill('1000.5'); // JPY has no minor unit
    await page.getByTestId('setup-review').click();
    await expect(page.getByTestId('setup-issues')).toContainText('CLIENT_AUTHORITY_TERM');
    await expect(page.getByTestId('setup-issues')).toContainText('not an exact amount in JPY');

    expect(writes, 'no server write for an invalid draft').toEqual([]);
  });

  test('re-registering a spec id with DIFFERENT content is refused by the server and explained', async ({
    page,
    request,
  }) => {
    const title = uniq('Collision mission');
    await apiProvisionMission(request, title, { mandate: false });
    await signIn(page, 'founder');
    await selectMission(page, title);
    await page.getByRole('link', { name: 'Mission Setup' }).click();
    await expect(page.getByTestId('setup-spec-summary')).toContainText(UNSEEN.specId);
    await page.getByTestId('setup-new-version').click();
    // same spec id, different objective → the server refuses (immutable history)
    await fillSpecForm(page, {
      objective: 'A completely different objective for the same spec id.',
    });
    await page.getByTestId('setup-review').click();
    await page.getByTestId('setup-register').click();
    const error = page.getByTestId('setup-register-error');
    await expect(error).toContainText('DIFFERENT content', { timeout: 15_000 });
    await expect(error).toContainText('new spec id');
    // the registered spec is unchanged
    await expect(page.getByTestId('setup-spec-summary')).toContainText('Survey bench 7 after');
  });
});

test.describe('authentication and authorization', () => {
  test('signed out: no configuration form and no data is shown', async ({ page }) => {
    await page.goto('/#setup');
    await expect(page.getByTestId('mission-setup')).toContainText('Sign in');
    await expect(page.getByTestId('spec-form')).toHaveCount(0);
    await page.goto('/#decisions');
    await expect(page.getByTestId('decision-room')).toContainText('Sign in');
    await expect(page.getByTestId('field-events')).toHaveCount(0);
  });

  test('a viewer can read the configuration but every write control is disabled', async ({
    page,
    request,
  }) => {
    const title = uniq('Viewer read-only mission');
    await apiProvisionMission(request, title, { mandate: true });
    await signIn(page, 'viewer');
    await selectMission(page, title);
    await page.getByRole('link', { name: 'Mission Setup' }).click();
    await expect(page.getByTestId('setup-role-note')).toContainText('cannot register');
    await expect(page.getByTestId('setup-spec-summary')).toContainText(UNSEEN.specId);
    await expect(page.getByTestId('setup-new-version')).toHaveCount(0);
    await expect(page.getByTestId('issue-credential')).toBeDisabled();
    await expect(page.getByText('cannot issue credentials')).toBeVisible();

    await page.getByRole('link', { name: 'Decision Room' }).click();
    await expect(page.getByTestId('evaluate-journal')).toBeDisabled();
    await expect(page.getByTestId('customer-ops')).toContainText('cannot record them');
  });

  test('a session lost mid-flow signs the person out and never reveals a credential', async ({
    page,
    request,
    context,
  }) => {
    const title = uniq('Expired session mission');
    await apiProvisionMission(request, title, { mandate: false });
    await signIn(page, 'founder');
    await selectMission(page, title);
    await page.getByRole('link', { name: 'Mission Setup' }).click();
    await chooseSource(page, 'bench7-flight-link');
    await page.getByTestId('issue-keyid').fill('key-expired-a');
    await context.clearCookies(); // the session expires before the click
    await page.getByTestId('issue-credential').click();
    await expect(page.getByTestId('actor-chip')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId('credential-reveal')).toHaveCount(0);
    await expect(page.getByTestId('credential-secret')).toHaveCount(0);
    await expect(page.getByTestId('spec-form')).toHaveCount(0);
  });
});

test.describe('decision states from the real journal', () => {
  test('empty journal: nothing to evaluate, said plainly, no fabricated evidence', async ({
    page,
    request,
  }) => {
    const title = uniq('Empty journal mission');
    await apiProvisionMission(request, title, { mandate: true });
    await openDecisionRoom(page, 'operator', title);
    await expect(page.getByTestId('field-empty')).toContainText(
      'No authenticated observations yet',
    );
    await expect(page.getByTestId('field-empty')).toContainText('never invents');
    await expect(page.getByTestId('evaluate-journal')).toBeDisabled();
    await expect(page.getByTestId('evaluate-disabled-reason')).toContainText(
      'No authenticated observation has been admitted',
    );
    await expect(page.getByTestId('demo-source')).toHaveCount(0);
  });

  test('with NO mandate the engine DECLINES — a first-class outcome with typed reasons', async ({
    page,
    request,
  }) => {
    const title = uniq('No authority mission');
    const { missionId, session } = await apiProvisionMission(request, title, { mandate: false });
    const secret = await apiIssueCredential(
      request,
      session,
      missionId,
      'bench7-flight-link',
      'key-state-a',
    );
    await apiAdmitEvidence(
      request,
      session,
      missionId,
      secret,
      uniq('d').replace(/\W/g, ''),
      false,
    );
    await openDecisionRoom(page, 'operator', title);
    await page.getByTestId('evaluate-journal').click();
    await expect(page.getByTestId('evaluation-recorded')).toBeVisible({ timeout: 15_000 });
    const outcome = page.getByTestId('live-evaluation-outcome');
    await expect(outcome).toHaveAttribute('data-outcome', 'decline');
    await expect(outcome).toContainText('DECLINED');
    // every option carries its refusal in plain words + the typed code
    const incumbent = page.getByTestId('cmp-option-continue-inhouse-quad-flight');
    await expect(incumbent).toContainText('MANDATE_EXPIRED');
    await expect(incumbent).toContainText('No active, unexpired mandate');
    // nothing is proposable
    await expect(page.getByTestId('propose-plan')).toBeDisabled();
    await expect(page.getByTestId('no-spend-explained')).toHaveAttribute('data-outcome', 'decline');
  });

  test('several observations before a baseline: the closed baseline window is explained, not a dead button', async ({
    page,
    request,
  }) => {
    const title = uniq('Closed baseline mission');
    const { missionId, session } = await apiProvisionMission(request, title, { mandate: true });
    const secret = await apiIssueCredential(
      request,
      session,
      missionId,
      'bench7-flight-link',
      'key-state-a',
    );
    await apiAdmitEvidence(request, session, missionId, secret, uniq('c').replace(/\W/g, ''), true);
    await openDecisionRoom(page, 'operator', title);
    await expect(page.getByTestId('field-events').locator('li')).toHaveCount(2, {
      timeout: 15_000,
    });
    await expect(page.getByTestId('evaluate-journal')).toBeDisabled();
    await expect(page.getByTestId('evaluate-disabled-reason')).toContainText(
      'baseline window is closed',
    );
    // the live, read-only evaluation of the same journal is still shown honestly
    await expect(page.getByTestId('live-evaluation')).toBeVisible({ timeout: 15_000 });
  });

  test('server failures are explained; no alternatives are fabricated in their place', async ({
    page,
    request,
  }) => {
    const title = uniq('Failing reads mission');
    await apiProvisionMission(request, title, { mandate: true });
    await page.route('**/operations/decision', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }),
      }),
    );
    await page.route('**/physical-view', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'UAV_POLICY_UNRESOLVABLE' } }),
      }),
    );
    await openDecisionRoom(page, 'operator', title);
    await expect(page.getByTestId('ops-error')).toContainText('The journal read failed');
    await expect(page.getByTestId('ops-error')).toContainText('INTERNAL');
    await expect(page.getByTestId('live-evaluation')).toHaveCount(0);
    await expect(page.getByTestId('evaluate-journal')).toBeDisabled();
    await expect(page.getByTestId('field-unavailable')).toBeVisible();
    // still honest about everything else
    await expect(page.getByTestId('truth-boundary')).toContainText('AIRWALLEX: OFFLINE');
  });
});

test.describe('credential custody hygiene', () => {
  test('the browser stops holding a revealed secret after its hard time limit', async ({
    page,
    request,
  }) => {
    const title = uniq('Secret TTL mission');
    await apiProvisionMission(request, title, { mandate: false });
    await page.clock.install();
    await signIn(page, 'founder');
    await selectMission(page, title);
    await page.getByRole('link', { name: 'Mission Setup' }).click();
    await chooseSource(page, 'bench7-flight-link');
    await page.getByTestId('issue-keyid').fill('key-ttl-a');
    await page.getByTestId('issue-credential').click();
    await expect(page.getByTestId('credential-reveal')).toBeVisible();
    await page.getByTestId('credential-reveal-toggle').click();
    const secret = ((await page.getByTestId('credential-secret').textContent()) ?? '').trim();
    expect(secret.length).toBeGreaterThan(30);
    await page.clock.fastForward('06:00'); // past the 5-minute ceiling
    await expect(page.getByTestId('credential-reveal')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(secret);
    // a second issuance for the same key id is refused (rotation = new key id)
    await chooseSource(page, 'bench7-flight-link');
    await page.getByTestId('issue-keyid').fill('key-ttl-a');
    await page.getByTestId('issue-credential').click();
    await expect(page.getByTestId('issue-error')).toContainText('NEW key id');
  });
});

test.describe('responsive: 320 / 390 / 640 (200% zoom of a 1280 window) / 1024', () => {
  test('setup and decision surfaces stay usable — nothing clipped, HUD never covers the scene', async ({
    page,
    request,
  }) => {
    const title = uniq('Responsive mission');
    const { missionId, session } = await apiProvisionMission(request, title, { mandate: true });
    const secret = await apiIssueCredential(
      request,
      session,
      missionId,
      'bench7-flight-link',
      'key-state-a',
    );
    await apiAdmitEvidence(
      request,
      session,
      missionId,
      secret,
      uniq('r').replace(/\W/g, ''),
      false,
    );
    await signIn(page, 'operator');
    await selectMission(page, title);

    for (const [width, height] of [
      [320, 800],
      [390, 844],
      [640, 450],
      [1024, 768],
    ] as const) {
      await page.setViewportSize({ width, height });

      // ---- Mission Setup: the specification summary and the form are reachable
      await page.getByRole('link', { name: 'Mission Setup' }).click();
      await expect(page.getByTestId('setup-spec-summary')).toBeVisible();
      await noHorizontalOverflow(page, width, 'setup');
      const guide = page.getByTestId('headless-guide');
      await guide.scrollIntoViewIfNeeded();
      await expect(guide).toBeVisible();
      await noHorizontalOverflow(page, width, 'setup guide');

      // ---- Decision Room
      await page.getByRole('link', { name: 'Decision Room' }).click();
      await expect(page.getByTestId('customer-ops')).toBeVisible();
      await expect(page.getByTestId('field-events')).toBeVisible({ timeout: 15_000 });
      await noHorizontalOverflow(page, width, 'decision room');

      // the primary action is reachable and not covered by another element
      const evaluate = page.getByTestId('evaluate-journal');
      await evaluate.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await expect(evaluate).toBeVisible();
      const reachable = await evaluate.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit === el || el.contains(hit);
      });
      expect(reachable, `evaluate button not obscured at ${String(width)}`).toBe(true);

      // the scene itself is rendered (not hidden) and its content is not clipped
      const stage = page.locator('.mpv-stage').first();
      await stage.scrollIntoViewIfNeeded();
      await expect(page.locator('.mpv canvas').first()).toBeVisible();
      const box = await page.locator('.mpv-canvas-host').first().boundingBox();
      expect(box?.width ?? 0, `scene width at ${String(width)}`).toBeGreaterThan(200);
      expect(box?.height ?? 0, `scene height at ${String(width)}`).toBeGreaterThan(120);
      const clipped = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('.mpv, .mpv *'))
          .filter(
            (el) =>
              // screen-reader-only live regions are 1px by design — not clipping
              el.closest('.mpv-visually-hidden, .mv-visually-hidden') === null &&
              el.scrollWidth > el.clientWidth + 1 &&
              getComputedStyle(el).overflowX === 'hidden',
          )
          .map(
            (el) =>
              `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)} scroll=${String(el.scrollWidth)} client=${String(el.clientWidth)}`,
          ),
      );
      expect(
        clipped,
        `elements hiding horizontal overflow at ${String(width)}: ${clipped.join(' | ')}`,
      ).toEqual([]);

      if (width <= 640) {
        // narrow: the HUD sits BELOW the scene instead of covering it
        const hud = await page.locator('.mpv-hud').first().boundingBox();
        const host = await page.locator('.mpv-canvas-host').first().boundingBox();
        if (hud !== null && host !== null) {
          expect(hud.y, `HUD below scene at ${String(width)}`).toBeGreaterThanOrEqual(
            host.y + host.height - 1,
          );
        }
        // the sticky header never covers a quarter of a small viewport
        const sticky = await page
          .locator('.mv-topbar')
          .evaluate((el) => getComputedStyle(el).position);
        expect(sticky).not.toBe('sticky');
      }
    }
  });
});
