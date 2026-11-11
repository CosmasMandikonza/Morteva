import { createHmac } from 'node:crypto';
import {
  expect,
  type APIRequestContext,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import { HEADLESS_SIGNING_CORE } from '../../apps/web/src/lib/ingestContract.js';

/**
 * Support for the CUSTOMER-OPERATED journeys (R-final). Nothing here uses a
 * demo fixture route:
 *
 *  - `UNSEEN` is a mission that appears in NO fixture (quarry blast-zone
 *    survey; asset ids, sources, thresholds, suppliers, beneficiaries and
 *    amounts are all new);
 *  - `signAndEnvelope` is the independent "field system": it signs with the
 *    EXACT reference signer the product prints in Mission Setup
 *    (HEADLESS_SIGNING_CORE, executed — not re-implemented) using only the
 *    one-time credential the UI issued;
 *  - `apiProvision` provisions a customer mission through the PRODUCTION API
 *    only, for the secondary state tests (the primary journey drives the UI).
 */

// Assembled so the secret scanner does not flag the demo credential.
export const PASSWORD = ['moterva', 'e2e', 'demo'].join('-');

export const UNSEEN = {
  specId: 'quarry-blast-survey-q3',
  title: 'Quarry bench 7 — post-blast volumetric survey',
  objective:
    'Survey bench 7 after the scheduled blast and deliver the volumetric report before the haul road reopens.',
  assets: [
    { assetId: 'survey-quad-q3', label: 'Survey quadcopter', domainKind: 'aerial' },
    { assetId: 'haul-gate-radio', label: 'Haul-road gate radio', domainKind: 'ground' },
  ],
  sources: [
    {
      sourceId: 'bench7-flight-link',
      sourceType: 'asset_telemetry',
      provenance: 'FIELD',
      assetIds: ['survey-quad-q3'],
      trustedForRecovery: false,
    },
    {
      sourceId: 'quarry-control-room',
      sourceType: 'mission_control',
      provenance: 'FIELD',
      assetIds: ['survey-quad-q3', 'haul-gate-radio'],
      trustedForRecovery: true,
    },
  ],
  windLimitKt: '27',
  currency: 'USD',
  missionValue: '386,000',
  failureCost: '91,000',
  protectedReserve: '5,500',
  deadlineMinutes: '420',
  incumbent: {
    id: 'inhouse-quad-flight',
    beneficiary: 'bench-ops-crew',
    purpose: 'volumetric survey',
    baseCost: '31000',
    fee: '0',
    lead: '15',
    duration: '95',
    probability: '91.5',
    requiresAssetId: 'survey-quad-q3',
  },
  alternative: {
    id: 'ridge-lidar-contract',
    beneficiary: 'ridgeline-lidar-kk',
    purpose: 'volumetric survey',
    baseCost: '74200',
    fee: '1850',
    lead: '55',
    duration: '120',
    probability: '86.25',
  },
  /** incumbent threshold-free baseline and a breach of the unseen 27 kt limit */
  baselineWind: '11.8',
  breachWind: '29.3',
  alternativeGross: 'USD 76,050.00',
} as const;

/** Wire spec for API provisioning (mirrors the form output for UNSEEN). */
export function unseenWireSpec(): Record<string, unknown> {
  return {
    specVersion: 1,
    specId: UNSEEN.specId,
    industry: 'general-operations',
    identity: { title: UNSEEN.title, objective: UNSEEN.objective },
    assets: UNSEEN.assets,
    sources: UNSEEN.sources,
    safetyPolicy: {
      version: 1,
      clearanceAuthority: 'deterministic-domain-policy',
      uavWindLimitKt: 27,
      groundInterrupts: ['comms-offline'],
    },
    economics: {
      currency: 'USD',
      missionValueMinor: 38_600_000,
      failureCostMinor: 9_100_000,
      protectedReserveMinor: 550_000,
      deadlineOffsetMinutes: 420,
    },
    offers: {
      incumbent: {
        id: UNSEEN.incumbent.id,
        kind: 'inspection-service',
        beneficiary: UNSEEN.incumbent.beneficiary,
        purpose: UNSEEN.incumbent.purpose,
        currency: 'USD',
        baseCostMinor: 3_100_000,
        feeMinor: 0,
        leadTimeMinutes: 15,
        durationMinutes: 95,
        probabilityOfSuccess: 0.915,
        availability: 'confirmed',
        requiresAssetId: UNSEEN.incumbent.requiresAssetId,
      },
      alternatives: [
        {
          id: UNSEEN.alternative.id,
          kind: 'inspection-service',
          beneficiary: UNSEEN.alternative.beneficiary,
          purpose: UNSEEN.alternative.purpose,
          currency: 'USD',
          baseCostMinor: 7_420_000,
          feeMinor: 185_000,
          leadTimeMinutes: 55,
          durationMinutes: 120,
          probabilityOfSuccess: 0.8625,
          availability: 'confirmed',
        },
      ],
    },
    financialMandateShape: {
      currency: 'USD',
      allowedBeneficiaries: [UNSEEN.incumbent.beneficiary, UNSEEN.alternative.beneficiary],
      allowedPurposes: [UNSEEN.incumbent.purpose],
    },
    truthLabel: 'CUSTOMER_CONFIGURED_OPERATION — POLICY-ONLY',
  };
}

/**
 * A SECOND unseen mission in a different domain: ground-only (a cold-store
 * tote runner), NO aerial asset and therefore NO wind rule — its safety
 * verdicts come from aisle/comms interrupts. Proves the workflow is
 * spec-driven, not tied to the aerial example.
 */
export const GROUND = {
  specId: 'coldstore-tote-run-7',
  title: 'Cold-store tote run, aisle 14 re-slotting',
  objective:
    'Re-slot aisle 14 totes before the 06:00 outbound wave using the primary tote runner or a hired floor crew.',
  assetId: 'tote-runner-4',
  sourceId: 'dock-wms-feed',
  keyId: 'key-ground-a',
  incumbentId: 'runner-reslot',
  alternativeId: 'floor-crew-reslot',
  alternativeBeneficiary: 'night-floor-collective',
  alternativeGross: 'USD 9,350.00',
} as const;

export function groundWireSpec(): Record<string, unknown> {
  return {
    specVersion: 1,
    specId: GROUND.specId,
    industry: 'general-operations',
    identity: { title: GROUND.title, objective: GROUND.objective },
    assets: [{ assetId: GROUND.assetId, label: 'Tote runner 4', domainKind: 'ground' }],
    sources: [
      {
        sourceId: GROUND.sourceId,
        sourceType: 'warehouse_wms',
        provenance: 'FIELD',
        assetIds: [GROUND.assetId],
        trustedForRecovery: false,
      },
    ],
    safetyPolicy: {
      version: 1,
      clearanceAuthority: 'deterministic-domain-policy',
      groundInterrupts: ['comms-offline', 'aisle-obstructed'],
    },
    economics: {
      currency: 'USD',
      missionValueMinor: 6_200_000,
      failureCostMinor: 1_400_000,
      protectedReserveMinor: 100_000,
      deadlineOffsetMinutes: 360,
    },
    offers: {
      incumbent: {
        id: GROUND.incumbentId,
        kind: 'inspection-service',
        beneficiary: 'cold-store-ops',
        purpose: 'aisle re-slotting',
        currency: 'USD',
        baseCostMinor: 410_000,
        feeMinor: 0,
        leadTimeMinutes: 10,
        durationMinutes: 120,
        probabilityOfSuccess: 0.93,
        availability: 'confirmed',
        requiresAssetId: GROUND.assetId,
      },
      alternatives: [
        {
          id: GROUND.alternativeId,
          kind: 'inspection-service',
          beneficiary: GROUND.alternativeBeneficiary,
          purpose: 'aisle re-slotting',
          currency: 'USD',
          baseCostMinor: 910_000,
          feeMinor: 25_000,
          leadTimeMinutes: 45,
          durationMinutes: 150,
          probabilityOfSuccess: 0.88,
          availability: 'confirmed',
        },
      ],
    },
    financialMandateShape: {
      currency: 'USD',
      allowedBeneficiaries: ['cold-store-ops', GROUND.alternativeBeneficiary],
      allowedPurposes: ['aisle re-slotting'],
    },
    truthLabel: 'CUSTOMER_CONFIGURED_OPERATION — POLICY-ONLY',
  };
}

// --------------------------------------------------------- field-system signer

/** The PRODUCT's printed reference signer, executed as documented. */
const signEvent = new Function('createHmac', `${HEADLESS_SIGNING_CORE}\nreturn signEvent;`)(
  createHmac,
) as (event: unknown, secret: string) => string;

export interface EnvelopeArgs {
  orgId: string;
  missionId: string;
  assetId: string;
  sourceId: string;
  sourceType: string;
  keyId: string;
  eventId: string;
  sequence: number;
  /** milliseconds before NOW at which the event was observed */
  agoMs: number;
  observations: { kind: string; unit: string; value: string | number }[];
}

export function signedEnvelope(args: EnvelopeArgs, secret: string): Record<string, unknown> {
  const observedAt = new Date(Date.now() - args.agoMs).toISOString();
  const ingestedAt = new Date(Date.now() - Math.max(0, args.agoMs - 1000)).toISOString();
  const event = {
    contractVersion: 1,
    eventId: args.eventId,
    sequence: args.sequence,
    orgId: args.orgId,
    missionId: args.missionId,
    assetId: args.assetId,
    observedAt,
    ingestedAt,
    source: {
      sourceId: args.sourceId,
      sourceType: args.sourceType,
      keyId: args.keyId,
      provenance: 'FIELD',
      signature: '',
    },
    observations: args.observations,
  };
  event.source.signature = signEvent(event, secret);
  return event;
}

export interface IngestOutcome {
  status: string;
  code?: string;
  eventId?: string | null;
}

export interface DeliverResult {
  http: number;
  outcomes: IngestOutcome[];
  /** top-level machine error code (401/403/410), when the whole request failed */
  errorCode?: string;
}

/**
 * The independent FIELD SYSTEM: a client with NO cookie jar and NO CSRF token,
 * holding only an issued source credential. It posts to Agent C's machine
 * ingress (`/api/machine/missions/:id/events`) — authentication IS the HMAC.
 */
export async function headlessClient(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string | undefined,
): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: baseURL ?? '' });
}

export async function deliver(
  client: APIRequestContext,
  missionId: string,
  envelopes: Record<string, unknown>[],
): Promise<DeliverResult> {
  const response = await client.post(
    `/api/machine/missions/${encodeURIComponent(missionId)}/events`,
    { data: { events: envelopes } },
  );
  const body = (await response.json().catch(() => ({}))) as {
    outcomes?: IngestOutcome[];
    error?: { code?: string };
  };
  return {
    http: response.status(),
    outcomes: body.outcomes ?? [],
    errorCode: body.error?.code,
  };
}

// ------------------------------------------------------------------ UI helpers

export async function signIn(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('actor-chip')).toBeVisible();
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByTestId('actor-chip')).toHaveCount(0);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function selectMission(page: Page, title: string): Promise<void> {
  await page
    .getByTestId('missions-panel')
    .getByRole('button', { name: new RegExp(escapeRegExp(title)) })
    .first()
    .click();
}

export async function createMissionViaSheet(page: Page, title: string): Promise<void> {
  await page.getByTestId('new-mission-btn').click();
  const sheet = page.getByTestId('mission-create-sheet');
  await sheet.getByLabel('Mission name').fill(title);
  await sheet.getByTestId('create-mission-submit').click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('missions-panel')).toContainText(title, { timeout: 10_000 });
}

/** Fill the customer spec form (UNSEEN values) through real inputs. */
export async function fillSpecForm(
  page: Page,
  overrides: Partial<{ specId: string; objective: string; title: string }> = {},
): Promise<void> {
  const U = UNSEEN;
  await page.getByLabel('Spec id').fill(overrides.specId ?? U.specId);
  await page.getByLabel('Mission title').fill(overrides.title ?? U.title);
  await page.getByLabel('Objective').fill(overrides.objective ?? U.objective);

  // assets
  await page.getByLabel('Asset 1 id').fill(U.assets[0].assetId);
  await page.getByLabel('Asset 1 label').fill(U.assets[0].label);
  await page.getByLabel('Asset 1 domain').selectOption('aerial');
  await page.getByRole('button', { name: 'Add asset' }).click();
  await page.getByLabel('Asset 2 id').fill(U.assets[1].assetId);
  await page.getByLabel('Asset 2 label').fill(U.assets[1].label);
  await page.getByLabel('Asset 2 domain').selectOption('ground');

  // sources
  await page.getByLabel('Source 1 id').fill(U.sources[0].sourceId);
  await page.getByLabel('Source 1 type').selectOption('asset_telemetry');
  const s0 = page.getByTestId('spec-source-0');
  await s0.getByLabel('survey-quad-q3').check();
  await page.getByRole('button', { name: 'Add source' }).click();
  await page.getByLabel('Source 2 id').fill(U.sources[1].sourceId);
  await page.getByLabel('Source 2 type').selectOption('mission_control');
  const s1 = page.getByTestId('spec-source-1');
  await s1.getByLabel('survey-quad-q3').check();
  await s1.getByLabel('haul-gate-radio').check();
  await s1.getByLabel('Trusted to confirm recovery after an offline period').check();

  // safety + economics
  await page.getByLabel('Modeled wind limit (kt) — aerial assets').fill(U.windLimitKt);
  await page.getByLabel('Currency').selectOption(U.currency);
  await page.getByLabel(/^Mission value/).fill(U.missionValue);
  await page.getByLabel(/^Cost of failure/).fill(U.failureCost);
  await page.getByLabel(/^Protected reserve/).fill(U.protectedReserve);
  await page.getByLabel('Deadline (minutes after evaluation)').fill(U.deadlineMinutes);

  // suppliers
  const inc = page.getByTestId('spec-offers.incumbent');
  await inc.getByLabel('Offer id').fill(U.incumbent.id);
  await inc.getByLabel('Beneficiary (who is paid)').fill(U.incumbent.beneficiary);
  await inc.getByLabel('Purpose').fill(U.incumbent.purpose);
  await inc.getByLabel(/^Base cost/).fill(U.incumbent.baseCost);
  await inc.getByLabel(/^Fee/).fill(U.incumbent.fee);
  await inc.getByLabel('Lead time (minutes)').fill(U.incumbent.lead);
  await inc.getByLabel('Duration (minutes)').fill(U.incumbent.duration);
  await inc.getByLabel('Success probability (%)').fill(U.incumbent.probability);
  await inc.getByLabel(/^Requires this asset cleared/).selectOption(U.incumbent.requiresAssetId);

  await page.getByRole('button', { name: 'Add alternative supplier' }).click();
  const alt = page.getByTestId('spec-offers.alternatives.0');
  await alt.getByLabel('Offer id').fill(U.alternative.id);
  await alt.getByLabel('Beneficiary (who is paid)').fill(U.alternative.beneficiary);
  await alt.getByLabel('Purpose').fill(U.alternative.purpose);
  await alt.getByLabel(/^Base cost/).fill(U.alternative.baseCost);
  await alt.getByLabel(/^Fee/).fill(U.alternative.fee);
  await alt.getByLabel('Lead time (minutes)').fill(U.alternative.lead);
  await alt.getByLabel('Duration (minutes)').fill(U.alternative.duration);
  await alt.getByLabel('Success probability (%)').fill(U.alternative.probability);
}

// ------------------------------------------------------- API provisioning

export interface ApiSession {
  csrf: string;
  orgId: string;
}

export async function apiLogin(request: APIRequestContext, username: string): Promise<ApiSession> {
  const login = await request.post('/api/auth/login', {
    data: { username, password: PASSWORD },
  });
  expect(login.status(), 'api login').toBe(200);
  const body = (await login.json()) as { csrfToken: string };
  const session = await request.get('/api/auth/session');
  const sessionBody = (await session.json()) as { actor: { orgId: string } };
  return { csrf: body.csrfToken, orgId: sessionBody.actor.orgId };
}

/** Demo/fixture route fragments that the CUSTOMER flow must never call. */
export const FIXTURE_ROUTE =
  /synthetic-step|warehouse-step|warehouse-decision|warehouse-interpret|refresh-authority|reviewer-|physical-decision/;

/** Issue a source credential through the production API (for state tests). */
export async function apiIssueCredential(
  request: APIRequestContext,
  session: ApiSession,
  missionId: string,
  sourceId: string,
  keyId: string,
  trustedForRecovery = false,
): Promise<string> {
  const r = await request.post(
    `/api/missions/${missionId}/sources/${encodeURIComponent(sourceId)}/secret`,
    { headers: { 'x-csrf-token': session.csrf }, data: { keyId, trustedForRecovery } },
  );
  expect(r.status(), `issue credential: ${await r.text()}`).toBe(200);
  return ((await r.json()) as { secret: string }).secret;
}

/** Admit baseline + (optionally) a breach through the production ingest path. */
export async function apiAdmitEvidence(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string | undefined,
  session: ApiSession,
  missionId: string,
  secret: string,
  suffix: string,
  withBreach: boolean,
  keyId = 'key-state-a',
): Promise<void> {
  const base = {
    orgId: session.orgId,
    missionId,
    assetId: 'survey-quad-q3',
    sourceId: 'bench7-flight-link',
    sourceType: 'asset_telemetry',
    keyId,
  };
  const envs = [
    signedEnvelope(
      {
        ...base,
        eventId: `evt_s_base_${suffix}`,
        sequence: 1,
        agoMs: 60_000,
        observations: [
          { kind: 'wind_speed', unit: 'kt', value: UNSEEN.baselineWind },
          { kind: 'weather_hold', unit: 'state', value: 'clear' },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
        ],
      },
      secret,
    ),
  ];
  if (withBreach) {
    envs.push(
      signedEnvelope(
        {
          ...base,
          eventId: `evt_s_breach_${suffix}`,
          sequence: 2,
          agoMs: 20_000,
          observations: [
            { kind: 'wind_speed', unit: 'kt', value: UNSEEN.breachWind },
            { kind: 'weather_hold', unit: 'state', value: 'active' },
          ],
        },
        secret,
      ),
    );
  }
  const headless = await headlessClient(playwright, baseURL);
  try {
    for (const env of envs) {
      const res = await deliver(headless, missionId, [env]);
      expect(res.outcomes[0]?.status, JSON.stringify(res)).toBe('accepted');
    }
  } finally {
    await headless.dispose();
  }
}

/** Mission + spec (+ mandate optional) through the production API only. */
export async function apiProvisionMission(
  request: APIRequestContext,
  title: string,
  options: { mandate: boolean; spec?: Record<string, unknown> },
): Promise<{ missionId: string; session: ApiSession }> {
  const wire = options.spec ?? unseenWireSpec();
  const shape = wire.financialMandateShape as {
    allowedBeneficiaries: string[];
    allowedPurposes: string[];
  };
  const session = await apiLogin(request, 'founder');
  const headers = { 'x-csrf-token': session.csrf };
  const mission = await request.post('/api/missions', { headers, data: { title } });
  expect(mission.status(), 'create mission').toBe(200);
  const missionId = ((await mission.json()) as { id: string }).id;
  const spec = await request.post(`/api/missions/${missionId}/mission-spec`, {
    headers,
    data: { spec: wire },
  });
  expect(spec.status(), `register spec: ${await spec.text()}`).toBe(200);
  if (options.mandate) {
    const mandate = await request.post('/api/mandates', {
      headers,
      data: {
        missionId,
        currency: 'USD',
        maxAmountMinor: 10_000_000,
        totalBudgetMinor: 15_000_000,
        permittedOperationKinds: ['airwallex_transfer'],
        allowedBeneficiaries: shape.allowedBeneficiaries,
        allowedPurposes: shape.allowedPurposes,
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
    });
    expect(mandate.status(), `grant mandate: ${await mandate.text()}`).toBe(200);
  }
  return { missionId, session };
}
