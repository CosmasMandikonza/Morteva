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

    // An authenticated workspace has no global demo banner. Financial
    // sample provenance remains visible at the figures where it matters.
    await expect(page.getByTestId('provenance-chip')).toHaveCount(0);
    await expect(page.getByTestId('provenance-banner')).toHaveCount(0);

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
    // Expired authority moved into a compact disclosure (founder UX gate):
    // open it, then the lapsed mandate is still inspectable and NEVER spendable.
    const expired = page.getByTestId('lapsed-mandates');
    await expired.locator('summary').click();
    const lapsed = page.getByTestId('lapsed-mandate');
    await expect(lapsed).toContainText('Lapsed — not spendable');
    await expect(lapsed).toContainText('can no longer authorize new spending');
    await expect(lapsed.locator('.mv-chip--info')).toHaveCount(0);
    await expect(page.locator('.mv-chip--info', { hasText: 'Mandate active' })).toHaveCount(2);

    // Superseded history remains, on demand under its own disclosure.
    const history = page.getByTestId('history-mandates');
    await history.locator('summary').click();
    await expect(mandates.locator('.mv-chip--neutral', { hasText: 'Superseded' })).toBeVisible();

    // Provenance (position panel replaced the old capabilities panel): the
    // balance source + freshness is explicit, provider state stays accurate.
    const position = page.getByTestId('position-panel');
    await expect(position).toContainText('illustrative ledger data');
    await expect(position).toContainText('internal record, not provider-verified');
    await expect(position.getByText('No simulated or fixture data')).toHaveCount(0);

    // Financial position comes from the real #35 API: USD treasury with
    // engine-computed spendable and honest commitment pressure.
    await expect(position).toContainText('USD');
    await expect(position).toContainText('fresh snapshot');
    await expect(position).toContainText('Spendable');
    await expect(position).toContainText('Pending / unknown');

    // Operations list from the real #35 API: deterministic lifecycle states.
    const ops = page.getByTestId('operations-panel');
    await expect(ops).toContainText('Unknown');
    await expect(ops).toContainText('Needs decision');
    await expect(ops).toContainText('Reconciled internally');
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

  test('mobile keeps the workspace header clean and the data provenance precise', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);

    await expect(page.getByTestId('provenance-chip')).toHaveCount(0);
    await expect(page.getByTestId('provenance-banner')).toHaveCount(0);
    const scrollWidth = await page.evaluate<number>('document.documentElement.scrollWidth');
    expect(scrollWidth).toBeLessThanOrEqual(391);

    // No engineering status card anymore: provider truth lives in the
    // business surface (position provenance) and no developer-only text leaks.
    await expect(page.getByTestId('system-status')).toHaveCount(0);
    await expect(page.getByTestId('position-panel')).toContainText(
      'internal record, not provider-verified',
    );
    await expect(page.getByTestId('position-panel')).toContainText('illustrative ledger data');
    await expect(page.getByText(/hackathon|npm run dev|STATE.md/)).toHaveCount(0);
  });

  test('shell header: one desktop row, unmistakable active tab, honest phone stack, surviving mission context', async ({
    page,
  }) => {
    // ---- Desktop 1440×900: brand | centered navigation | identity — ONE row.
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);

    interface RowBox {
      top: number;
      bottom: number;
      left: number;
      right: number;
      height: number;
    }
    const boxes = await page.evaluate<Record<string, RowBox | null>>(() => {
      const rect = (selector: string) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          left: Math.round(r.left),
          right: Math.round(r.right),
          height: Math.round(r.height),
        };
      };
      return {
        brand: rect('.mv-topbar__brand'),
        nav: rect('.mv-nav'),
        ops: rect('.mv-topbar__ops'),
        topbar: rect('.mv-topbar'),
        h1: rect('.mv-pagehead__title'),
      };
    });
    // All three regions share ONE band (no wrapped second full-width row);
    // the brand's baseline-aligned mark shifts its box a couple of px.
    expect(boxes.brand).not.toBeNull();
    expect(boxes.nav).not.toBeNull();
    expect(boxes.ops).not.toBeNull();
    expect(
      Math.abs(boxes.brand!.top - boxes.nav!.top),
      'brand on the header row',
    ).toBeLessThanOrEqual(4);
    expect(
      Math.abs(boxes.nav!.top - boxes.ops!.top),
      'navigation on the header row',
    ).toBeLessThanOrEqual(4);
    // The header stays compact (one 56-64px band — the old two-row header
    // with the utility pill row measured ~100px+).
    expect(boxes.topbar!.height, 'compact single-row header').toBeLessThan(80);
    // Navigation sits BETWEEN brand and ops (centered region, never wrapped).
    expect(boxes.nav!.left).toBeGreaterThan(boxes.brand!.right);
    expect(boxes.nav!.right).toBeLessThan(boxes.ops!.left);

    // The active destination is unmistakable: aria-current lives on exactly
    // one nav link, and a real semantic h1 names the section — compact, no
    // giant display stack (the old h1 measured ~40px tall).
    const current = page.locator('.mv-nav a[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText('Mission Treasury');
    const h1 = page.getByRole('heading', { level: 1, name: 'Mission Treasury' });
    await expect(h1).toBeVisible();
    expect(boxes.h1!.height, 'compact page heading').toBeLessThan(40);
    await expect(page.locator('.mv-crumb')).toHaveCount(0);

    // ---- Navigation works from the header and the selected mission
    // survives the round trip (session-scoped context, unchanged semantics).
    await page.getByRole('button', { name: /Subsea mooring survey/ }).click();
    await expect(page.getByTestId('mission-hero')).toContainText('Subsea mooring survey');
    await page.getByRole('link', { name: 'Decision Room' }).click();
    await expect(current).toHaveText('Decision Room');
    await page.getByRole('link', { name: 'Mission Treasury' }).click();
    await expect(current).toHaveText('Mission Treasury');
    await expect(page.getByTestId('mission-hero')).toContainText('Subsea mooring survey');

    // ---- 320×844: intentional phone stack — brand, identity, navigation
    // strip; nothing clipped, no sideways BODY scroll, content reachable.
    await page.setViewportSize({ width: 320, height: 844 });
    await page.evaluate('window.scrollTo(0, 0)');
    await page.waitForTimeout(300);
    const scrollWidth = await page.evaluate<number>('document.documentElement.scrollWidth');
    expect(scrollWidth).toBeLessThanOrEqual(320);
    const phone = await page.evaluate<Record<string, RowBox | null>>(() => {
      const rect = (selector: string) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          left: Math.round(r.left),
          right: Math.round(r.right),
          height: Math.round(r.height),
        };
      };
      return {
        brand: rect('.mv-topbar__brand'),
        ops: rect('.mv-topbar__ops'),
        nav: rect('.mv-nav'),
        main: rect('.mv-main'),
        topbar: rect('.mv-topbar'),
      };
    });
    // The brand owns its own row: identity and theme follow BELOW it, and
    // the navigation strip follows them (vertical stack, nothing clipped).
    expect(phone.ops!.top).toBeGreaterThanOrEqual(phone.brand!.bottom);
    // The navigation strip follows, and the content starts below the header.
    expect(phone.nav!.top).toBeGreaterThanOrEqual(phone.ops!.bottom);
    expect(phone.main!.top).toBeGreaterThanOrEqual(phone.nav!.bottom);
    // All five destinations remain labeled and reachable in the strip.
    for (const label of [
      'Mission Treasury',
      'Mission Setup',
      'Decision Room',
      'Authority & Execution',
      'Evidence Replay',
    ]) {
      const link = page.getByRole('link', { name: label });
      await expect(link).toBeAttached();
    }
    // The strip scrolls INSIDE the header: its own overflow may exceed the
    // viewport, but the page never gains a horizontal scrollbar.
    await expect(page.getByTestId('actor-chip')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    // ---- 1024×900: the intentional two-band header (identity row + tab
    // strip), still without body overflow.
    await page.setViewportSize({ width: 1024, height: 900 });
    const tabletWidth = await page.evaluate<number>('document.documentElement.scrollWidth');
    expect(tabletWidth).toBeLessThanOrEqual(1024);
    const tabletNav = await page.locator('.mv-nav ul').evaluate((el) => ({
      overflowX: getComputedStyle(el).overflowX,
    }));
    expect(['auto', 'scroll', 'hidden']).toContain(tabletNav.overflowX);
  });
});
