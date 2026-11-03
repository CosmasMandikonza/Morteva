import { expect, test, type Page } from '@playwright/test';

/**
 * MTV-08 design-lab interaction tests (issue #10 visual validation).
 *
 * These run against a build that includes the design lab entry
 * (VITE_DESIGN_LAB=1 → /design-lab.html). With a default production build
 * (lab excluded) every test self-skips, so `npm run test:e2e` stays green
 * either way.
 */

async function labAvailable(page: Page): Promise<boolean> {
  // Vite preview's SPA fallback answers 200 with index.html for missing
  // paths, so verify the actual lab document rather than the status code.
  const res = await page.request.get('/design-lab.html');
  return res.ok() && (await res.text()).includes('Design Lab (MTV-08, synthetic)');
}

test.beforeEach(async ({ page }) => {
  const ok = await labAvailable(page);
  test.skip(!ok, 'design lab not present in this build (VITE_DESIGN_LAB=1 required)');
});

const CANDIDATES = ['a', 'b'] as const;

for (const c of CANDIDATES) {
  test(`candidate ${c}: shell renders with synthetic banner and nav`, async ({ page }) => {
    await page.goto(`/design-lab.html?c=${c}`);
    await expect(page.locator('.lab__banner')).toContainText('SYNTHETIC DATA');
    await expect(page.getByRole('navigation', { name: 'Screens' })).toBeVisible();
    await expect(page.locator(`[data-lab="${c}"]`)).toBeVisible();
  });

  test(`candidate ${c}: money is explicit-currency and tabular`, async ({ page }) => {
    await page.goto(`/design-lab.html?c=${c}`);
    const body = page.locator(`[data-lab="${c}"]`);
    await expect(body).toContainText('USD 184,250.00', { ignoreCase: false });
    await expect(body).toContainText('USD 99,250.00');
  });

  test(`candidate ${c}: every displayed monetary amount stays finite and internally consistent`, async ({
    page,
  }) => {
    await page.goto(`/design-lab.html?c=${c}`);
    const body = page.locator(`[data-lab="${c}"]`);
    await expect(body).not.toContainText(/\\bNaN\\b|\\bInfinity\\b|undefined/);
    await expect(body).toContainText('USD 99,250.00');
    if (c === 'b') {
      // This targeted assertion catches a stale screenshot committed in the
      // original PR, where the decomposition legend displayed "NaN" even
      // though the hero amount was correct.
      const fundLegend = page.locator('.b-fundmap__legend');
      await expect(fundLegend).toContainText('99,250.00');
      await expect(fundLegend).not.toContainText('NaN');
      await expect(fundLegend).toContainText('28,600.00');
      await expect(fundLegend).toContainText('6,400.00');
      await expect(fundLegend).toContainText('50,000.00');
    }
  });

  test(`candidate ${c}: synthetic snapshot recovery is functional without pretending a provider call`, async ({
    page,
  }) => {
    await page.goto(`/design-lab.html?c=${c}`);
    await expect(page.getByRole('button', { name: 'Refresh snapshot' })).toHaveCount(0);
    await page.getByRole('button', { name: /State laboratory|state lab/ }).click();
    await page.getByRole('radio', { name: /Provider offline/ }).click();
    const body = page.locator(`[data-lab="${c}"]`);
    await expect(body).toContainText('synthetic fixtures');
    await page.getByRole('button', { name: 'Restore synthetic snapshot' }).click();
    await expect(body).not.toContainText('provider-offline state');
    await expect(body).toContainText('USD 99,250.00');
    // Empty state never offers a dead onboarding control.
    await page.getByRole('radio', { name: /^Empty/ }).click();
    await expect(page.getByRole('button', { name: 'Configure first mission' })).toHaveCount(0);
    await expect(body).toContainText('unavailable in this');
  });

  test(`candidate ${c}: navigates all four screens`, async ({ page }) => {
    await page.goto(`/design-lab.html?c=${c}`);
    const nav = page.getByRole('navigation', { name: 'Screens' });
    for (const name of [
      'Decision Room',
      'Authority & Execution',
      'Evidence Replay',
      'Mission Treasury',
    ]) {
      await nav.getByRole('link', { name: new RegExp(name) }).click();
      await expect(page.getByRole('region')).toBeVisible();
    }
  });

  test(`candidate ${c}: submitted never reads as settled, settle requires verification`, async ({
    page,
  }) => {
    await page.goto(`/design-lab.html?c=${c}&screen=authority`);
    const statebox = page.getByTestId('authority-state');

    await expect(statebox).toHaveAttribute('data-state', 'PROPOSED');
    const advance = page.getByRole('button', { name: /Reserve USD 2,150/ });
    await advance.click();
    await expect(statebox).toHaveAttribute('data-state', 'RESERVED');
    await page.getByRole('button', { name: /Approve exact terms/ }).click();
    await expect(statebox).toHaveAttribute('data-state', 'APPROVED');
    await page.getByRole('button', { name: /Submit to Airwallex/ }).click();
    await expect(statebox).toHaveAttribute('data-state', 'SUBMITTING');
    await page.getByRole('button', { name: /Dispatching/ }).click();
    await expect(statebox).toHaveAttribute('data-state', 'SUBMITTED');

    // SUBMITTED must render with the transit tone (never the verified tone).
    const chip = page.locator('.chip', { hasText: 'SUBMITTED' }).first();
    await expect(chip).toHaveClass(/chip--transit/);
    await expect(statebox).toContainText('NOT settled', { ignoreCase: true });

    await page.getByRole('button', { name: /Verify by read-back/ }).click();
    await expect(statebox).toHaveAttribute('data-state', 'SETTLED');
    const settledChip = page.locator('.chip', { hasText: 'SETTLED' }).first();
    await expect(settledChip).toHaveClass(/chip--verified/);
    await expect(statebox).toContainText('verified by read-back');
  });

  test(`candidate ${c}: unknown status retains commitment and offers original-ID resolution`, async ({
    page,
  }) => {
    await page.goto(`/design-lab.html?c=${c}&screen=authority`);
    await page.getByRole('button', { name: /Simulate lost response|lost response/ }).click();
    const statebox = page.getByTestId('authority-state');
    await expect(statebox).toHaveAttribute('data-state', 'STATUS_UNKNOWN');
    await expect(statebox).toContainText('Commitment retained');
    await expect(statebox).toContainText('never resubmit blind', { ignoreCase: true });
    await page
      .getByRole('button', { name: /Resolve by original ID|resolve by original ID/ })
      .click();
    await expect(statebox).toHaveAttribute('data-state', 'SETTLED');
    await expect(statebox).toContainText('resolved by original request id');
  });

  test(`candidate ${c}: state laboratory demonstrates offline and 3D-unavailable honesty`, async ({
    page,
  }) => {
    await page.goto(`/design-lab.html?c=${c}`);
    await page.getByRole('button', { name: /State laboratory|state lab/ }).click();
    await page.getByRole('radio', { name: /Provider offline/ }).click();
    await expect(page.locator('[data-lab]').first()).toContainText('OFFLINE', {
      ignoreCase: false,
    });
    await expect(page.locator('[data-lab]').first()).toContainText('last verified snapshot');

    await page.getByRole('radio', { name: /3D unavailable/ }).click();
    await page.getByRole('link', { name: /Decision Room/ }).click();
    await expect(page.getByTestId('viewport-fallback')).toBeVisible();
    await expect(page.getByTestId('viewport-fallback')).toContainText('2D');
  });

  test(`candidate ${c}: reduced-motion toggle silences animation`, async ({ page }) => {
    await page.goto(`/design-lab.html?c=${c}`);
    await page
      .getByRole('button', { name: /Reduced motion|motion/ })
      .first()
      .click();
    await expect(page.locator('.lab').first()).toHaveClass(/is-reduced/);
  });
}

test('candidate A: plan comparison drives the approval handoff', async ({ page }) => {
  await page.goto('/design-lab.html?c=a&screen=decision');
  const plans = page.getByRole('radiogroup', { name: 'Candidate plans' });
  await expect(plans.getByText('Hold · second inspection pass tomorrow')).toBeVisible();
  // The no-payment plan is a first-class option.
  await expect(plans.getByRole('radio', { name: /USD 0/ })).toBeVisible();
  // Selecting P2 (needs approval) hands off to Authority with exact terms.
  await plans.getByRole('radio', { name: /Retainer repair crew/ }).click();
  await expect(page.getByRole('region')).toContainText('Immutable terms');
  await expect(page.getByRole('region')).toContainText('USD 2,150.00');
  // Blocked-by-policy plan is visible with its reason (not hidden).
  await page.goto('/design-lab.html?c=a&screen=decision');
  await expect(page.getByText('exceeds USD 7,750.00 envelope')).toBeVisible();
});

test('candidate B: selected plan summary shows policy reason and honest CTA', async ({ page }) => {
  await page.goto('/design-lab.html?c=b&screen=decision');
  // Selecting P2 hands off to Authority (by design); return to see the summary.
  await page.getByRole('radio', { name: /Retainer repair crew/ }).click();
  await expect(page.getByRole('region')).toContainText('Approve exact terms');
  await expect(page.getByRole('region')).toContainText('USD 2,150.00');
  await page.goto('/design-lab.html?c=b&screen=decision');
  await expect(page.locator('.b-planfocus')).toContainText(
    'per-action limit — human approval required',
  );
  await expect(page.getByRole('button', { name: /Review approval · USD 2,150.00/ })).toBeVisible();
});

test('viewport pins are keyboard-operable and reframe the scene', async ({ page }) => {
  await page.goto('/design-lab.html?c=a&screen=decision');
  const pin = page.getByRole('button', { name: /Select evidence EV-2214/ });
  await pin.focus();
  await pin.press('Enter');
  await expect(page.locator('[data-testid="lab-viewport"]')).toBeVisible();
  await expect(page.locator('.hud-v--on')).toHaveCount(1);
});

test('no horizontal scrolling of financial content at 320px', async ({ page }) => {
  for (const c of CANDIDATES) {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`/design-lab.html?c=${c}`);
    // String-form evaluate keeps the e2e tsconfig DOM-free.
    const scrollWidth = await page.evaluate<number>('document.documentElement.scrollWidth');
    expect(scrollWidth).toBeLessThanOrEqual(321);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/design-lab.html?c=${c}&screen=decision`);
    const w = await page.evaluate<number>('document.documentElement.scrollWidth');
    expect(w).toBeLessThanOrEqual(391);
  }
});

test('founder console compare mode frames both candidates', async ({ page }) => {
  await page.goto('/design-lab.html');
  await expect(page.getByRole('heading', { name: /A · Harbour Watch/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /B · Night Sortie/ })).toBeVisible();
  const frames = page.locator('.shell__frame iframe');
  await expect(frames).toHaveCount(2);
  // Width tool constrains the preview frames.
  await page.getByRole('button', { name: '390' }).click();
  await expect(page.locator('.shell__frame').first()).toHaveCSS('width', '390px');
});
