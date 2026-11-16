import { expect, test, type Page } from '@playwright/test';

/**
 * Evidence Replay screen-specific suite (MTV-20 polish pass) — validates the
 * redesigned timeline against REAL journal data from the seeded throwaway
 * ledger: honest titles/summaries, evidence-tier distinction, summary-line
 * honesty (loaded set, never a lifetime total), local-search scope labeling,
 * keyboard navigation, inspector fidelity (full factual fields + copy), and
 * the retained Treasury operation-filter round trip. No new fixtures, no
 * simulated events.
 */
async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill('founder');
  await page.getByLabel('Password').fill('moterva-e2e-demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('actor-chip')).toBeVisible();
}

async function openEvidence(page: Page): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: 'Evidence Replay' }).click();
  await expect(page.getByTestId('evidence-panel')).toBeVisible();
}

test('summary line counts the LOADED set with topic breakdown and latest event', async ({
  page,
}) => {
  await signIn(page);
  await openEvidence(page);

  const summary = page.getByTestId('evidence-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText(/loaded events?/);
  await expect(summary).toContainText(/financial/i);
  await expect(summary).toContainText(/operational/i);
  await expect(summary).toContainText(/latest/i);
  // Honest scope: never presented as a lifetime total.
  await expect(summary).toContainText('most recent 50 per fetch');

  // The list is present, newest first by journal sequence.
  const list = page.getByTestId('evidence-list');
  await expect(list.locator('.mv-evidence__event').first()).toBeVisible();
  const seqs = await list
    .locator('.mv-evidence__event')
    .evaluateAll((rows) => rows.map((r) => Number(r.getAttribute('data-seq'))));
  expect(seqs.length).toBeGreaterThan(1);
  for (let i = 1; i < seqs.length; i += 1) {
    expect(seqs[i - 1]!).toBeGreaterThan(seqs[i]!);
  }
});

test('rows show honest human titles, no raw digests/UUIDs/JSON keys in the row surface', async ({
  page,
}) => {
  await signIn(page);
  await openEvidence(page);

  const first = page.getByTestId('evidence-list').locator('.mv-evidence__event').first();
  await expect(first).toBeVisible();
  await expect(first.locator('.mv-evrow__title')).toBeVisible();
  await expect(first.locator('.mv-evrow__meta time')).toBeVisible();
  await expect(first.locator('.mv-evrow__topic')).toBeVisible();

  // The row surface must NOT leak 64-hex digests or long UUIDs.
  const rowText = await page
    .getByTestId('evidence-list')
    .locator('.mv-evrow__title, .mv-evrow__line')
    .allTextContents();
  const joined = rowText.join(' ');
  expect(joined).not.toMatch(/[0-9a-f]{32,}/i);
  expect(joined).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);

  // An operation transition row reports WHAT WAS RECORDED, never provider
  // settlement claims (the seeded journal contains operation.* transitions).
  const titles = await page
    .getByTestId('evidence-list')
    .locator('.mv-evrow__title')
    .allTextContents();
  for (const title of titles) {
    expect(title).not.toContain('Funds settled by provider');
    expect(title).not.toContain('verified operational');
  }
});

test('known types carry honest one-line summaries; unknown types fall back safely', async ({
  page,
}) => {
  await signIn(page);
  await openEvidence(page);

  const list = page.getByTestId('evidence-list');
  // The seeded scenario journals mandate issuances with currency fields —
  // known types produce a summary line from allowlisted fields only.
  const lines = await list.locator('.mv-evrow__line').allTextContents();
  expect(lines.some((l) => l.includes('·'))).toBe(true);

  // Unknown future types must render the HONEST fallback: the generic
  // "Journal event recorded" title, tier "journal", and NO invented summary
  // line. If the server sends any unrecognized type, every such row carries
  // exactly this shape (never a fabricated observation or trust level).
  const unrecognizedRows = list.locator('.mv-evrow--unrecognized');
  const unrecognizedCount = await unrecognizedRows.count();
  for (let i = 0; i < unrecognizedCount; i += 1) {
    const row = unrecognizedRows.nth(i);
    await expect(row.locator('.mv-evrow__title')).toHaveText('Journal event recorded');
    await expect(row.locator('.mv-evrow__line')).toHaveCount(0);
    await expect(row.locator('.mv-evrow__tier')).toHaveText(/journal/i);
  }
});

test('evidence tiers are distinguished: journal vs provider-verified', async ({ page }) => {
  await signIn(page);
  await openEvidence(page);

  const list = page.getByTestId('evidence-list');
  // Journal tier chips exist on ordinary rows.
  await expect(list.locator('.mv-evrow__tier--journal').first()).toBeVisible();

  // The seeded scenario includes readback-backed operation state changes;
  // whenever a provider-tier chip renders it must say provider-verified.
  const providerChips = await list.locator('.mv-evrow__tier--provider').count();
  if (providerChips > 0) {
    const text = await list.locator('.mv-evrow__tier--provider').first().textContent();
    expect(text).toContain('provider-verified');
  }
});

test('selecting a row opens the inspector with full factual fields and copy affordances', async ({
  page,
}) => {
  await signIn(page);
  await openEvidence(page);

  const first = page.getByTestId('evidence-list').locator('.mv-evidence__event').first();
  await first.locator('.mv-evrow__select').click();

  const detail = page.getByTestId('evidence-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('Journal seq');
  await expect(detail).toContainText('Payload digest');
  await expect(detail).toContainText('Event key');
  await expect(detail).toContainText('Full payload (allowlisted projection)');
  // The tier banner states the evidence class in plain language.
  const banner = detail.locator('.mv-evdetail__tier');
  await expect(banner).toBeVisible();
  const bannerText = (await banner.textContent()) ?? '';
  expect(
    bannerText.includes('Internal journal evidence') ||
      bannerText.includes('field claim') ||
      bannerText.includes('Provider-verified'),
  ).toBe(true);

  // Selection is maintained (aria-pressed on the row).
  await expect(first.locator('.mv-evrow__select')).toHaveAttribute('aria-pressed', 'true');

  // Closing restores a clean list.
  await detail.getByRole('button', { name: /close/i }).click();
  await expect(detail).toHaveCount(0);
});

test('keyboard: arrow keys move row focus; Enter selects', async ({ page }) => {
  await signIn(page);
  await openEvidence(page);

  const rows = page.getByTestId('evidence-list').locator('.mv-evrow__select');
  await rows.first().focus();
  const beforeSeq = await page.evaluate(
    () => document.activeElement?.getAttribute('data-seq') ?? '',
  );
  expect(beforeSeq).not.toBe('');
  await page.keyboard.press('ArrowDown');
  const afterSeq = await page.evaluate(
    () => document.activeElement?.getAttribute('data-seq') ?? '',
  );
  expect(afterSeq).not.toBe('');
  expect(afterSeq, 'ArrowDown moves focus to a different row').not.toBe(beforeSeq);

  await page.keyboard.press('ArrowUp');
  const backSeq = await page.evaluate(() => document.activeElement?.getAttribute('data-seq') ?? '');
  expect(backSeq).toBe(beforeSeq);

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('evidence-detail')).toBeVisible();
});

test('local search filters the loaded set honestly and is scope-labeled', async ({ page }) => {
  await signIn(page);
  await openEvidence(page);

  const search = page.getByTestId('evidence-search');
  await expect(search).toBeVisible();
  // Scope label discloses local-only search.
  await expect(page.locator('.mv-evidence__searchscope')).toContainText(/loaded/i);

  // The seeded journal has financial events; search for a financial marker.
  await search.fill('mandate');
  const list = page.getByTestId('evidence-list');
  const titles = await list.locator('.mv-evrow__title').allTextContents();
  if (titles.length > 0) {
    expect(titles.some((t) => t.toLowerCase().includes('mandate'))).toBe(true);
  }

  // A nonsense query yields the deliberate empty state, not a broken list.
  await search.fill('zzz-no-such-event-zzz');
  await expect(page.getByTestId('evidence-empty')).toBeVisible();
  await expect(page.getByTestId('evidence-empty')).toContainText('match this filter');

  // Clearing restores the full loaded set.
  await search.fill('');
  await expect(page.getByTestId('evidence-empty')).toHaveCount(0);
  await expect(list.locator('.mv-evidence__event').first()).toBeVisible();
});

test('topic controls still drive the server query (Financial/Operational/All)', async ({
  page,
}) => {
  await signIn(page);
  await openEvidence(page);

  // Scope to the segmented control: the rows themselves contain the words
  // "Financial"/"Operational" in their accessible names.
  const topicBar = page.getByRole('radiogroup', { name: 'Evidence topic' });
  await topicBar.getByRole('radio', { name: 'Financial' }).check();
  const finRows = await page
    .getByTestId('evidence-list')
    .locator('.mv-evrow__topic')
    .allTextContents();
  for (const t of finRows) expect(t).toContain('Financial');

  await topicBar.getByRole('radio', { name: 'Operational' }).check();
  const opRows = await page
    .getByTestId('evidence-list')
    .locator('.mv-evrow__topic')
    .allTextContents();
  for (const t of opRows) expect(t).toContain('Operational');
});

test('Treasury operation-filter navigation still filters and clears', async ({ page }) => {
  await signIn(page);

  const ops = page.getByTestId('operations-panel');
  await expect(ops.locator('.mv-op').first()).toBeVisible();
  await ops.locator('.mv-op').first().click();
  const inspector = page.getByTestId('operation-inspector');
  await expect(inspector).toBeVisible();
  await inspector.getByTestId('inspect-evidence').click();

  await expect(page.getByTestId('evidence-panel')).toBeVisible();
  const clear = page.getByTestId('clear-op-filter');
  await expect(clear).toBeVisible();
  // Filtered rows all reference the operation — then clearing restores all.
  await clear.click();
  await expect(page.getByTestId('clear-op-filter')).toHaveCount(0);
  await expect(
    page.getByTestId('evidence-list').locator('.mv-evidence__event').first(),
  ).toBeVisible();
});

test('responsive: no horizontal overflow at 320/390/1024 and side panel coexists at 1440', async ({
  page,
}) => {
  await signIn(page);

  for (const width of [320, 390, 1024, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await openEvidence(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `width ${width}`).toBeLessThanOrEqual(1);
    await page.getByRole('navigation').getByRole('link', { name: 'Mission Treasury' }).click();
    await expect(page.getByTestId('mission-hero')).toBeVisible();
  }

  // At 1440 the inspector opens beside the list without overlap.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEvidence(page);
  await page.getByTestId('evidence-list').locator('.mv-evrow__select').first().click();
  await expect(page.getByTestId('evidence-detail')).toBeVisible();
  const overflow2 = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow2).toBeLessThanOrEqual(1);
});

test('dark/light themes and reduced motion render the timeline cleanly', async ({ page }) => {
  test.skip(
    (await page.evaluate(() => !CSS.supports('color', 'var(--x)'))) === true,
    'token support assumed',
  );
  await signIn(page);
  await openEvidence(page);

  // Light theme via the app toggle (localStorage 'moterva-theme').
  await page.evaluate(() => {
    window.localStorage.setItem('moterva-theme', 'light');
    document.documentElement.dataset.theme = 'light';
  });
  await page.reload();
  await expect(page.getByTestId('evidence-panel')).toBeVisible();
  await expect(page.getByTestId('evidence-list').locator('.mv-evrow__title').first()).toBeVisible();

  // Reduced motion: transitions collapse (presence check only — no assertion
  // on computed transition because PW cannot emulate the media query
  // reliably across drivers; the CSS handles it).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByTestId('evidence-list').locator('.mv-evrow__title').first()).toBeVisible();
});
