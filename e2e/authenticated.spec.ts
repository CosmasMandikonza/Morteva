import { expect, test, type Page } from '@playwright/test';

/**
 * Authenticated operator journey against the REAL API + seeded throwaway
 * ledger (e2e/scripts/demo-auth-server.mjs): login → missions → effective
 * authority (expiry excluded) → provenance → negative auth flows.
 *
 * Seed facts used by assertions:
 * - Mission A "Harbor turbine inspection": USD mandate 150,000.00 envelope
 *   with 60,000.00 committed; EUR 37,000.00 uncommitted; GBP mandate issued
 *   with a 200ms fuse (valid at issue, lapsed by clock when rendered);
 *   one superseded USD v1.
 * - Mission B "Subsea mooring survey": USD 60,000.00 envelope,
 *   12,000.00 committed.
 */
async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill('founder');
  await page.getByLabel('Password').fill('moterva-e2e-demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('actor-chip')).toBeVisible();
}

test.describe('authenticated treasury journey', () => {
  test('login renders real ledger data with effective authority and provenance', async ({
    page,
  }) => {
    await signIn(page);
    await expect(page.getByTestId('actor-chip')).toContainText('E2E Founder');

    // Provenance is explicit, compact and accurate for a seeded demo.
    await expect(page.getByTestId('provenance-chip')).toContainText(
      'DEMO_AUTH · seeded internal ledger — not Airwallex funds',
    );

    // Real missions from the ledger.
    const missions = page.getByTestId('missions-panel');
    await expect(missions).toContainText('Harbor turbine inspection');
    await expect(missions).toContainText('Subsea mooring survey');

    // EFFECTIVE authority excludes the clock-lapsed GBP mandate: the hero
    // counts USD + EUR only — USD 76,500.00 and EUR 37,000.00 remaining.
    const hero = page.getByTestId('mission-hero');
    await expect(hero).toContainText('USD 76,500.00');
    await expect(hero).toContainText('EUR 37,000.00');
    await expect(hero).not.toContainText('GBP');
    await expect(hero).toContainText('effective authority');

    // Real envelope math on the effective card.
    const mandates = page.getByTestId('mandates-panel');
    await expect(mandates).toContainText('of 150,000.00 envelope');
    await expect(mandates).toContainText('49% committed');

    // The lapsed mandate stays inspectable but is NEVER spendable: its own
    // section, a not-spendable chip (no "Mandate active" claim), historical
    // framing, and the recorded status shown for audit.
    const lapsed = page.getByTestId('lapsed-mandate');
    await expect(lapsed).toContainText('Lapsed — not spendable');
    await expect(lapsed).toContainText('historical envelope 20,000.00');
    await expect(lapsed).toContainText('recorded status: active');
    await expect(lapsed.locator('.mv-chip--info')).toHaveCount(0);
    await expect(page.locator('.mv-chip--info', { hasText: 'Mandate active' })).toHaveCount(2);

    // Superseded history remains.
    await expect(mandates.locator('.mv-chip--neutral', { hasText: 'Superseded' })).toBeVisible();

    // Provenance (position panel replaced the old capabilities panel): the
    // balance source + freshness is explicit, provider state stays accurate.
    const position = page.getByTestId('position-panel');
    await expect(position).toContainText('seeded demo data');
    await expect(position).toContainText('internal record, not provider-verified');
    await expect(position.getByText('No simulated or fixture data')).toHaveCount(0);

    // Financial position comes from the real #35 API: USD treasury with
    // engine-computed spendable and honest commitment pressure.
    await expect(position).toContainText('USD');
    await expect(position).toContainText('fresh snapshot');
    await expect(position).toContainText('Spendable now');
    await expect(position).toContainText('unknown/held');

    // Operations list from the real #35 API: deterministic lifecycle states.
    const ops = page.getByTestId('operations-panel');
    await expect(ops).toContainText('Unknown');
    await expect(ops).toContainText('Needs decision');
    await expect(ops).toContainText('Reconciled');
    await expect(ops.locator('[data-attention="human"]')).toHaveCount(1);

    // Inspector auto-selects the needs-human operation with exact terms.
    const inspector = page.getByTestId('operation-inspector');
    await expect(inspector).toContainText('blade crack dye test');
    await expect(inspector).toContainText('Required action');
    await expect(inspector).toContainText('exposure stays held');

    // Mission selection actually drives the content.
    await page.getByRole('button', { name: /Subsea mooring survey/ }).click();
    await expect(page.getByTestId('mission-hero')).toContainText('Subsea mooring survey');
    await expect(page.getByTestId('mandates-panel')).toContainText('USD 48,000.00');

    // The fixture-free honesty contract still holds.
    await expect(page.getByText('USD 184,250')).toHaveCount(0);
  });

  test('session survives reload and sign out works with the persisted CSRF token', async ({
    page,
  }) => {
    await signIn(page);

    // Reload: cookie session + stored CSRF token must keep Sign out functional.
    await page.reload();
    await expect(page.getByTestId('actor-chip')).toContainText('E2E Founder');
    await expect(page.getByTestId('missions-panel')).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByTestId('signin-panel')).toBeVisible();
    await expect(page.getByTestId('actor-chip')).toHaveCount(0);
  });

  test('server-rejected logout keeps the authenticated state and shows the failure', async ({
    page,
  }) => {
    await signIn(page);

    await page.route('**/api/auth/logout', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
    );
    await page.getByRole('button', { name: 'Sign out' }).click();

    // No fake signed-out state: session UI stays, failure is announced.
    await expect(page.getByTestId('actor-chip')).toContainText('E2E Founder');
    const logoutAlert = page.locator('.mv-actor__error');
    await expect(logoutAlert).toContainText('Sign out failed');
    await expect(logoutAlert).toContainText('session remains active');
    await expect(page.getByTestId('signin-panel')).toHaveCount(0);

    // After the server recovers, sign out succeeds with the same token.
    await page.unroute('**/api/auth/logout');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByTestId('signin-panel')).toBeVisible();
    await expect(page.getByTestId('actor-chip')).toHaveCount(0);
  });

  test('session expiration (401 on a financial read) hides financial content', async ({ page }) => {
    await signIn(page);
    await expect(page.getByTestId('missions-panel')).toContainText('Harbor turbine inspection');

    // The server rejects the next authenticated read: content must not remain.
    await page.route('**/api/missions', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'expired' } }),
      }),
    );
    await page.reload();

    await expect(page.getByTestId('signin-panel')).toBeVisible();
    await expect(page.getByTestId('actor-chip')).toHaveCount(0);
    await expect(page.getByTestId('missions-panel')).toHaveCount(0);
    await expect(page.getByText('Harbor turbine inspection')).toHaveCount(0);
  });

  test('recovers from an API error via retry', async ({ page }) => {
    let failing = true;
    await page.route('**/api/missions', async (route) => {
      if (failing) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }),
        });
      } else {
        const response = await route.fetch();
        await route.fulfill({ response });
      }
    });

    await signIn(page);
    const alert = page.getByRole('alert').filter({ hasText: 'Could not load' });
    await expect(alert).toBeVisible();
    // No missions leaked into view while the read fails.
    await expect(page.getByText('Harbor turbine inspection')).toHaveCount(0);

    failing = false;
    await alert.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByTestId('missions-panel')).toContainText('Harbor turbine inspection');
    await expect(page.getByRole('alert').filter({ hasText: 'Could not load' })).toHaveCount(0);
  });

  test('wrong password shows the server error, never a session', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Username').fill('founder');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.mv-signin__error')).toContainText('invalid credentials');
    await expect(page.getByTestId('signin-panel')).toBeVisible();
    await expect(page.getByTestId('actor-chip')).toHaveCount(0);
  });

  test('mobile presents provenance as a banner and keeps the top bar clear', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);

    // Exactly one provenance instance: banner visible, cramped chip hidden.
    const banner = page.getByTestId('provenance-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('DEMO_AUTH · seeded internal ledger — not Airwallex funds');
    await expect(page.getByTestId('provenance-chip')).toBeHidden();

    // The banner must not crowd the controls: it lives below the top bar and
    // never exceeds the viewport width.
    const box = await banner.boundingBox();
    expect(box?.x).toBeDefined();
    if (box) {
      expect(box.x + box.width).toBeLessThanOrEqual(391);
    }
    const scrollWidth = await page.evaluate<number>('document.documentElement.scrollWidth');
    expect(scrollWidth).toBeLessThanOrEqual(391);

    // Provider truth stays visible as badges; prose sits behind a keyboard
    // operable disclosure that opens on click.
    const status = page.getByTestId('system-status');
    await expect(status.locator('.mv-badge--offline, .mv-badge--sandbox')).toHaveCount(2);
    const disclosure = status.locator('.mv-provider__details').first();
    await expect(disclosure.locator('summary')).toBeVisible();
    await disclosure.locator('summary').click();
    await expect(disclosure.locator('p')).toBeVisible();
  });

  test('at 320px the breadcrumb and provenance banner are vertically visible, not overlapped', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await signIn(page);
    await page.evaluate('window.scrollTo(0, 0)');
    await page.waitForTimeout(300);

    interface Geometry {
      viewportH: number;
      scrollY: number;
      topbar: { top: number; bottom: number } | null;
      crumb: { top: number; bottom: number } | null;
      banner: { top: number; bottom: number } | null;
    }
    const geometry = await page.evaluate<Geometry>(
      '(() => { const rect = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; }; return { viewportH: window.innerHeight, scrollY: Math.round(window.scrollY), topbar: rect(".mv-topbar"), crumb: rect(".mv-crumb"), banner: rect(".mv-provenance-banner") }; })()',
    );

    // Anchored at the top of the page, not mid-scroll.
    expect(geometry.scrollY).toBe(0);
    // The breadcrumb sits fully below the sticky top bar.
    expect(geometry.crumb).not.toBeNull();
    expect(geometry.crumb!.top).toBeGreaterThanOrEqual(geometry.topbar!.bottom);
    // The entire banner is inside the viewport and below the top bar —
    // vertical visibility, not just width.
    expect(geometry.banner).not.toBeNull();
    expect(geometry.banner!.top).toBeGreaterThanOrEqual(geometry.topbar!.bottom);
    expect(geometry.banner!.bottom).toBeLessThanOrEqual(geometry.viewportH);
  });
});
