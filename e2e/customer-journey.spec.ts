import { expect, test } from '@playwright/test';
import { INGEST_CONTRACT } from '../apps/web/src/lib/ingestContract.js';
import {
  createMissionViaSheet,
  deliver,
  fillSpecForm,
  FIXTURE_ROUTE,
  selectMission,
  signedEnvelope,
  signIn,
  signOut,
  UNSEEN,
} from './support/customer.js';

/**
 * R-final — THE CUSTOMER-OPERATED JOURNEY, through the real application and
 * the real production API (no demo route, no fixture, no mock):
 *
 *   founder authors an UNSEEN mission → registers it → onboards a source with
 *   a one-time credential → grants authority → an independent "field system"
 *   (no browser; the product's own printed signer) submits authenticated FIELD
 *   evidence → operator evaluates from the real journal (baseline = NO
 *   ACTION; threshold breach = different supplier at a different price) →
 *   immutable proposal → a DIFFERENT person approves exact terms → Evidence
 *   Replay + reload reconstruct the same records → no secret anywhere.
 *
 * A request spy proves the browser never touched a fixture route.
 */

test.setTimeout(240_000);
test.describe.configure({ mode: 'serial' });

test('customer journey: unseen mission → authenticated evidence → decision → governed approval → durable replay', async ({
  page,
  playwright,
  baseURL,
}) => {
  const suffix = Date.now().toString(36).slice(-5);
  const missionTitle = `${UNSEEN.title} ${suffix}`;

  // ---- request spy: the customer flow must never call a fixture route
  const fixtureCalls: string[] = [];
  const seenBodies: string[] = [];
  page.on('request', (r) => {
    if (FIXTURE_ROUTE.test(r.url())) fixtureCalls.push(`${r.method()} ${r.url()}`);
  });
  page.on('response', (res) => {
    if (res.url().includes('/api/') && !res.url().includes('/sources/')) {
      void res
        .text()
        .then((t) => seenBodies.push(t))
        .catch(() => undefined);
    }
  });

  // =================================================== 1. founder: author the mission
  await signIn(page, 'founder');
  await createMissionViaSheet(page, missionTitle);
  await page.getByRole('link', { name: 'Mission Setup' }).click();
  const setup = page.getByTestId('mission-setup');
  await expect(setup).toBeVisible();

  // Empty state is honest: no spec, no fallback to a built-in demo catalog.
  await expect(page.getByTestId('setup-unregistered')).toContainText(
    'No specification is registered',
  );
  await expect(page.getByTestId('setup-unregistered')).toContainText('harbor DEMO default');

  await fillSpecForm(page, { objective: `${UNSEEN.objective} (${suffix})` });
  await page.getByTestId('setup-review').click();

  // Exact review BEFORE registration — amounts exact, mandate shape derived.
  const review = page.getByTestId('setup-review-pane');
  await expect(review).toContainText('quarry-blast-survey-q3');
  await expect(review).toContainText('USD 386,000.00');
  await expect(review).toContainText(UNSEEN.alternativeGross); // 74,200 + 1,850
  await expect(review).toContainText('p=86.25%');
  await expect(review).toContainText('modeled wind limit 27 kt');
  await expect(review).toContainText('bench-ops-crew, ridgeline-lidar-kk');
  await page.getByTestId('setup-register').click();
  await expect(page.getByTestId('setup-registered-notice')).toContainText(
    'Specification registered',
  );
  await expect(page.getByTestId('setup-spec-summary')).toContainText('quarry-blast-survey-q3');

  // =================================================== 2. source credential (one time)
  const creds = page.getByTestId('source-credentials');
  await expect(creds).toBeVisible();
  await page.getByTestId('issue-source').selectOption('bench7-flight-link');
  await page.getByTestId('issue-keyid').fill('key-bench7-a');
  await page.getByTestId('issue-credential').click();

  const reveal = page.getByTestId('credential-reveal');
  await expect(reveal).toBeVisible();
  await expect(page.getByTestId('credential-warning')).toContainText('shown once');
  // Masked by default: the real secret is NOT in the DOM until Reveal.
  const masked = (await page.getByTestId('credential-secret').textContent()) ?? '';
  expect(masked).toMatch(/^•+$/);
  await page.getByTestId('credential-reveal-toggle').click();
  const secret = ((await page.getByTestId('credential-secret').textContent()) ?? '').trim();
  expect(secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  await page.getByTestId('credential-reveal-toggle').click();
  expect((await page.getByTestId('credential-secret').textContent()) ?? '').toMatch(/^•+$/);

  // Cannot be dismissed by accident: Escape and Close are inert until acknowledged.
  await page.keyboard.press('Escape');
  await expect(reveal).toBeVisible();
  await reveal.getByRole('button', { name: /Close/ }).click();
  await expect(reveal).toBeVisible();
  await expect(reveal).toContainText('Confirm that you stored the secret');
  await page.getByTestId('credential-ack').check();
  await page.getByTestId('credential-done').click();
  await expect(reveal).toHaveCount(0);

  // The secret is nowhere in the page, browser storage, or any response so far.
  await expect(page.locator('body')).not.toContainText(secret);
  const storage = await page.evaluate(() =>
    JSON.stringify({ l: { ...window.localStorage }, s: { ...window.sessionStorage } }),
  );
  expect(storage).not.toContain(secret);
  expect(seenBodies.join('\n')).not.toContain(secret);
  // Key inventory note carries the NON-secret key id only.
  await expect(page.getByTestId('source-row-bench7-flight-link')).toContainText('key-bench7-a');

  // Headless guide: honest about today's ingress, contains no secret, includes the signer.
  const guide = page.getByTestId('headless-guide');
  await expect(guide).toContainText('How a field system sends signed evidence');
  await expect(page.getByTestId('ingest-route')).toContainText('/events');
  await guide.getByText('Reference signer (Node.js)').click();
  await expect(page.getByTestId('ingest-snippet')).toContainText('createHmac');
  await expect(guide).not.toContainText(secret);

  // =================================================== 3. founder: grant authority
  await page.getByTestId('setup-grant-authority').click();
  const mandate = page.getByTestId('mandate-create-sheet');
  // Prefilled SUGGESTION from the spec (a human still reviews and submits).
  await expect(mandate.getByLabel(/Approved beneficiaries/)).toHaveValue(
    'bench-ops-crew, ridgeline-lidar-kk',
  );
  await expect(mandate.getByLabel(/Approved purposes/)).toHaveValue('volumetric survey');
  await mandate.getByLabel('Per-operation cap (USD)').fill('100000');
  await mandate.getByLabel(/Mission budget envelope/).fill('150000');
  await mandate.getByTestId('mandate-review-btn').click();
  await mandate.getByTestId('mandate-submit-btn').click();
  await expect(mandate).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('setup-mandate-notice')).toContainText('separate approver');
  await expect(page.getByTestId('setup-mandate-active')).toContainText('USD');

  // capture what the independent field system needs
  const csrf = await page.evaluate(() => window.localStorage.getItem('moterva-csrf') ?? '');
  const missionId = await page.evaluate(
    () => window.sessionStorage.getItem('moterva-selected-mission') ?? '',
  );
  const orgId = await page.evaluate(async () => {
    const r = await fetch('/api/auth/session', { credentials: 'same-origin' });
    return ((await r.json()) as { actor: { orgId: string } }).actor.orgId;
  });
  expect(missionId).toMatch(/^msn_/);
  const base = {
    orgId,
    missionId,
    assetId: 'survey-quad-q3',
    sourceId: 'bench7-flight-link',
    sourceType: 'asset_telemetry',
    keyId: 'key-bench7-a',
  };

  // =================================================== 4. the independent field system
  // A client that holds ONLY the credential (no browser, no cookie, no CSRF).
  const headless = await playwright.request.newContext({ baseURL: baseURL ?? '' });

  // BASELINE observation: an unseen healthy reading, well under the 27 kt limit.
  const baselineEnvelope = signedEnvelope(
    {
      ...base,
      eventId: `evt_base_${suffix}`,
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
  const machineIngress = INGEST_CONTRACT.authentication === 'source-credential';
  const bare = await deliver(headless, missionId, [baselineEnvelope], undefined);
  if (machineIngress) {
    // Credential-only ingress is available: the bare client is admitted.
    expect(bare.http).toBe(200);
    expect(bare.outcomes[0]?.status, JSON.stringify(bare)).toBe('accepted');
  } else {
    // INTERIM (CTO P0-1 on #64): a bare credential cannot post yet — and the
    // product says so instead of implying otherwise.
    expect([401, 403]).toContain(bare.http);
    await expect(page.getByTestId('ingest-auth-status')).toContainText('INTERIM');
  }
  const relay = machineIngress ? undefined : { csrf };
  const client = machineIngress ? headless : page.request;
  if (!machineIngress) {
    const relayed = await deliver(client, missionId, [baselineEnvelope], relay);
    expect(relayed.outcomes[0]?.status, JSON.stringify(relayed)).toBe('accepted');
  }

  // Forgery with a wrong key is refused with the typed code (never admitted).
  const forged = await deliver(
    client,
    missionId,
    [
      signedEnvelope(
        {
          ...base,
          eventId: `evt_forged_${suffix}`,
          sequence: 2,
          agoMs: 20_000,
          observations: [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
        },
        ['wrong', 'key', 'material', 'for', 'the', 'forgery', 'case', 'only', 'ok'].join('-'),
      ),
    ],
    relay,
  );
  expect(forged.outcomes[0]?.status).toBe('rejected');
  expect(forged.outcomes[0]?.code).toBe('SIGNATURE_INVALID');
  // Replaying the exact admitted event is an idempotent refusal, not a second record.
  const replayed = await deliver(client, missionId, [baselineEnvelope], relay);
  expect(replayed.outcomes[0]?.code).toBe('DUPLICATE_EVENT');

  await signOut(page);

  // =================================================== 5. operator: evaluate from the journal
  await signIn(page, 'operator');
  await selectMission(page, missionTitle);
  await page.getByRole('link', { name: 'Decision Room' }).click();
  const room = page.getByTestId('decision-room');
  await expect(room).toContainText('Field evidence → financial decision');

  // Customer mode: NO demo entry points, ever.
  await expect(page.getByTestId('demo-source')).toHaveCount(0);
  await expect(page.getByTestId('start-synthetic')).toHaveCount(0);
  await expect(page.getByTestId('customer-ops')).toBeVisible();

  // Truth boundary printed honestly.
  const truth = page.getByTestId('truth-boundary');
  await expect(truth).toContainText('FIELD EVIDENCE = AUTHENTICATED CLAIMS');
  await expect(truth).toContainText('AIRWALLEX: OFFLINE · UNVERIFIED');
  await expect(truth).toContainText('METAL: NO RECEIPT');
  await expect(page.getByTestId('truth-model')).toContainText('POLICY-ONLY');

  // Field observations show the authenticated evidence with honest provenance.
  const events = page.getByTestId('field-events');
  await expect(events).toContainText('FIELD · SOURCE-AUTHENTICATED CLAIM', { timeout: 15_000 });
  await expect(events).toContainText('wind_speed 11.8 kt');
  await expect(events).toContainText('bench7-flight-link');
  await expect(events).not.toContainText('SYNTHETIC');
  // viewer remains live
  await expect(
    page.locator('[data-testid="decision-room"] [data-testid="mission-viewer"]'),
  ).toHaveAttribute('data-availability', 'ready', { timeout: 30_000 });

  // Baseline evaluation → NO ACTION (a decision, not an error); nothing to propose.
  await expect(page.getByTestId('evaluate-journal')).toHaveText('Record baseline evaluation');
  await page.getByTestId('evaluate-journal').click();
  await expect(page.getByTestId('evaluation-recorded')).toContainText('baseline', {
    timeout: 15_000,
  });
  const live = page.getByTestId('live-evaluation');
  await expect(live).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('live-evaluation-outcome')).toHaveAttribute(
    'data-outcome',
    'no-action',
  );
  await expect(page.getByTestId('live-evaluation-outcome')).toContainText('NO ACTION');
  await expect(page.getByTestId('no-spend-explained')).toContainText('nothing to propose');
  await expect(page.getByTestId('propose-plan')).toBeDisabled();
  // waiting state is explained, not a dead button
  await expect(page.getByTestId('evaluate-disabled-reason')).toContainText('Waiting for a new');

  // =================================================== 6. unseen threshold breach arrives
  // The relay now runs under the OPERATOR session: use ITS csrf token.
  const operatorCsrf = await page.evaluate(() => window.localStorage.getItem('moterva-csrf') ?? '');
  const incidentRelay = machineIngress ? undefined : { csrf: operatorCsrf };
  const incident = await deliver(
    client,
    missionId,
    [
      signedEnvelope(
        {
          ...base,
          eventId: `evt_breach_${suffix}`,
          sequence: 2,
          agoMs: 10_000,
          observations: [
            { kind: 'wind_speed', unit: 'kt', value: UNSEEN.breachWind },
            { kind: 'weather_hold', unit: 'state', value: 'active' },
          ],
        },
        secret,
      ),
    ],
    incidentRelay,
  );
  expect(incident.outcomes[0]?.status, JSON.stringify(incident)).toBe('accepted');

  await page.getByTestId('refresh-journal').click();
  await expect(page.getByTestId('field-events')).toContainText('wind_speed 29.3 kt', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('evaluate-journal')).toHaveText('Evaluate the latest evidence');
  await page.getByTestId('evaluate-journal').click();
  await expect(page.getByTestId('evaluation-recorded')).toContainText('incident', {
    timeout: 15_000,
  });

  // The decision FOLLOWED the unseen inputs: a different supplier at a different price.
  const outcome = page.getByTestId('live-evaluation-outcome');
  await expect(outcome).toHaveAttribute('data-outcome', 'spend', { timeout: 15_000 });
  await expect(outcome).toContainText('AWAITING HUMAN APPROVAL');
  await expect(page.getByTestId('live-evaluation-selected')).toContainText(UNSEEN.alternativeGross);
  const selectedOption = page.getByTestId('cmp-option-hire-ridge-lidar-contract');
  await expect(selectedOption).toContainText('SELECTED');
  // The incumbent is REFUSED with its typed reason in plain words.
  const refused = page.getByTestId('cmp-option-continue-inhouse-quad-flight');
  await expect(refused).toHaveAttribute('data-feasible', 'false');
  await expect(refused).toContainText('ASSET_SAFETY_BLOCKED');
  await expect(refused).toContainText('blocked');
  // Per-asset operating status from the real journal (modeled wind rule).
  await expect(page.getByTestId('constraint-survey-quad-q3')).toContainText('BLOCKED');

  // Immutable proposal from the RECORDED evaluation (ID-only; no typed terms).
  await page.getByTestId('propose-plan').click();
  const plans = page.getByTestId('decision-plans');
  const row = plans.getByTestId('decision-plan-row').first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(plans.getByTestId('plan-terms')).toContainText(UNSEEN.alternativeGross);
  await expect(plans.getByTestId('plan-terms')).toContainText('ridgeline-lidar-kk');
  await expect(plans.getByTestId('plan-terms')).toContainText('volumetric survey');
  await expect(plans).toContainText('provider verified: no');
  const planTitle = await row.locator('span.mv-num').first().getAttribute('title');
  expect(planTitle).toMatch(/^plan_[0-9a-f]{24}$/);
  // The proposer cannot approve (distinct approver is a server rule).
  await expect(plans.getByTestId('open-approve')).toHaveCount(0);

  await signOut(page);

  // =================================================== 7. a DIFFERENT person approves exact terms
  await signIn(page, 'approver');
  await selectMission(page, missionTitle);
  await page.getByRole('link', { name: 'Decision Room' }).click();
  const approverPlans = page.getByTestId('decision-plans');
  await expect(approverPlans.getByTestId('decision-plan-row')).toBeVisible({ timeout: 15_000 });
  await expect(approverPlans.getByTestId('plan-terms')).toContainText(UNSEEN.alternativeGross);
  await approverPlans.getByTestId('open-approve').click();
  const approve = page.getByTestId('approve-plan-sheet');
  await approve.getByTestId('approve-review-btn').click();
  const approval = approve.getByTestId('approval-review');
  await expect(approval).toContainText(UNSEEN.alternativeGross);
  await expect(approval).toContainText('ridgeline-lidar-kk');
  await expect(approval).toContainText('volumetric survey');
  await approve.getByTestId('approve-submit-btn').click();
  await expect(approve).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('plan-approval-recorded')).toBeVisible({ timeout: 15_000 });
  // Provider state stays honest: nothing is settled, paid or verified.
  await expect(room).not.toContainText(/SETTLED|RECONCILED|\bPAID\b/);
  await expect(room).toContainText('AIRWALLEX: OFFLINE');

  // =================================================== 8. Evidence Replay, same identities
  await page.getByRole('link', { name: 'Evidence Replay' }).click();
  const evidence = page.getByTestId('evidence-panel');
  await expect(evidence).toBeVisible({ timeout: 15_000 });
  await expect(evidence).toContainText(missionTitle.slice(0, 20));
  await expect(page.locator('body')).not.toContainText(secret);

  // =================================================== 9. reload: durable records rebuild
  await page.reload();
  await page.getByRole('link', { name: 'Decision Room' }).click();
  await expect(page.getByTestId('decision-plans').getByTestId('plan-terms')).toContainText(
    UNSEEN.alternativeGross,
    { timeout: 15_000 },
  );
  await expect(page.getByTestId('plan-approval-recorded')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('field-events')).toContainText('wind_speed 29.3 kt');
  await expect(page.getByTestId('recorded-snapshots')).toContainText('incident');
  await expect(page.getByTestId('recorded-snapshots')).toContainText('baseline');
  await expect(page.getByTestId('demo-source')).toHaveCount(0);

  // =================================================== 10. nothing leaked, nothing fixture
  // The secret never appears in any read the app makes (spec, journal,
  // decisions, evidence, snapshots) — fetch them directly as the approver.
  const missionPaths = [
    `/api/missions/${missionId}/mission-spec`,
    `/api/missions/${missionId}/operations/decision`,
    `/api/missions/${missionId}/decision-snapshots`,
    `/api/missions/${missionId}/decision-plans`,
    `/api/missions/${missionId}/evidence?topic=operational&limit=200`,
    `/api/missions/${missionId}/evidence?topic=financial&limit=200`,
    `/api/missions/${missionId}/physical-view`,
  ];
  for (const path of missionPaths) {
    const r = await page.request.get(path);
    expect(await r.text(), path).not.toContain(secret);
  }
  expect(seenBodies.join('\n')).not.toContain(secret);
  expect(fixtureCalls, `fixture routes touched: ${fixtureCalls.join(', ')}`).toEqual([]);

  await headless.dispose();
});
