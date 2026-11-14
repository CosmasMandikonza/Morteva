/**
 * Shared fixtures for the machine-ingress / source-key-custody adversarial
 * suites (CTO review PR #64, comment 6808560477).
 *
 * Everything key-like is DERIVED AT RUNTIME — no key material is ever a
 * literal in the repository (the secret scanner gate would rightly flag it).
 * The harness signs exactly like a real headless telemetry client: HMAC-SHA256
 * over the sorted-key JSON of the event, no cookie, no CSRF token.
 */
import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';

export const DEV_PASSWORD = ['dev', 'only', 'fixture'].join('-');

/** A deterministic 32-byte test KEK (hex), derived from a label. */
export function runtimeKek(label: string): string {
  return createHash('sha256').update(`moterva-test-kek:${label}`).digest('hex');
}

export interface Session {
  cookie: string;
  csrf: string;
}

export interface InjectLike {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests cast bodies per assertion
  json: () => any;
}

export function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, sortDeep(v)]),
    );
  }
  return value;
}

export function hmacHex(secret: string, payload: Record<string, unknown>): string {
  return createHmac('sha256', secret)
    .update(JSON.stringify(sortDeep(payload)), 'utf8')
    .digest('hex');
}

/** The signed possession proof for the credential-status route (see source-credentials.ts). */
export function statusProof(
  secret: string,
  fields: { missionId: string; sourceId: string; keyId: string; issuedAt: string },
): string {
  return hmacHex(secret, { contractVersion: 1, purpose: 'credential-status', ...fields });
}

/** An UNSEEN customer mission: no fixture id, threshold or supplier name. */
export function customerSpec(orgId: string, missionId: string, specId: string) {
  return {
    specVersion: 1 as const,
    specId,
    industry: 'general-operations' as const,
    identity: {
      orgId,
      missionId,
      title: 'Canopy survey — south ridge block D',
      objective:
        'Complete the georeferenced canopy survey of block D before the harvest window opens, using the registered survey drone or a configured alternative service.',
    },
    assets: [
      { assetId: 'sat-link-9', domainKind: 'ground' as const, label: 'Field uplink node' },
      { assetId: 'drone-cartographer', domainKind: 'aerial' as const, label: 'Survey drone' },
    ],
    sources: [
      {
        sourceId: 'ridge-telemetry',
        sourceType: 'asset_telemetry' as const,
        assetIds: ['drone-cartographer'],
        trustedForRecovery: false,
        provenance: 'FIELD' as const,
      },
      {
        sourceId: 'site-ops-gateway',
        sourceType: 'vessel_gateway' as const,
        assetIds: ['sat-link-9', 'drone-cartographer'],
        trustedForRecovery: true,
        provenance: 'FIELD' as const,
      },
    ],
    safetyPolicy: {
      version: 1,
      clearanceAuthority: 'deterministic-domain-policy' as const,
      uavWindLimitKt: 31,
      groundInterrupts: ['comms-offline' as const],
    },
    economics: {
      currency: 'USD',
      missionValueMinor: 4_200_000,
      failureCostMinor: 1_100_000,
      protectedReserveMinor: 60_000,
      deadlineOffsetMinutes: 300,
    },
    offers: {
      incumbent: {
        id: 'canopy-self-fly',
        kind: 'inspection-service' as const,
        beneficiary: 'orbit-metrics',
        purpose: 'canopy survey',
        currency: 'USD',
        baseCostMinor: 480_000,
        feeMinor: 0,
        leadTimeMinutes: 20,
        durationMinutes: 75,
        probabilityOfSuccess: 0.9,
        availability: 'confirmed' as const,
        requiresAssetId: 'drone-cartographer',
      },
      alternatives: [
        {
          id: 'canopy-contracted',
          kind: 'inspection-service' as const,
          beneficiary: 'solar-grid-works',
          purpose: 'canopy survey',
          currency: 'USD',
          baseCostMinor: 690_000,
          feeMinor: 25_000,
          leadTimeMinutes: 40,
          durationMinutes: 80,
          probabilityOfSuccess: 0.84,
          availability: 'confirmed' as const,
        },
      ],
    },
    financialMandateShape: {
      currency: 'USD',
      allowedBeneficiaries: ['orbit-metrics', 'solar-grid-works'],
      allowedPurposes: ['canopy survey'],
    },
    truthLabel: 'SIMULATED_OPERATION — POLICY-ONLY',
  };
}

export interface EventSpec {
  orgId: string;
  missionId: string;
  eventId: string;
  sequence: number;
  assetId?: string;
  sourceId?: string;
  keyId: string;
  observedAt: string;
  observations?: { kind: string; unit: string; value: string | number }[];
}

/** An unsigned wire event for the telemetry source `ridge-telemetry` (FIELD). */
export function machineEvent(spec: EventSpec): Record<string, unknown> {
  const sourceId = spec.sourceId ?? 'ridge-telemetry';
  return {
    contractVersion: 1,
    eventId: spec.eventId,
    sequence: spec.sequence,
    orgId: spec.orgId,
    missionId: spec.missionId,
    assetId: spec.assetId ?? 'drone-cartographer',
    observedAt: spec.observedAt,
    ingestedAt: spec.observedAt,
    source: {
      sourceId,
      sourceType: sourceId === 'ridge-telemetry' ? 'asset_telemetry' : 'vessel_gateway',
      keyId: spec.keyId,
      provenance: 'FIELD',
    },
    observations: spec.observations ?? [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
  };
}

/** Sign (with `secret`) and POST to the machine route — NO cookie, NO CSRF token. */
export async function machineSubmit(
  app: FastifyInstance,
  urlMissionId: string,
  secret: string,
  events: Record<string, unknown>[],
  extraHeaders: Record<string, string> = {},
): Promise<InjectLike> {
  const signed = events.map((event) => ({
    ...event,
    source: { ...(event.source as Record<string, unknown>), signature: hmacHex(secret, event) },
  }));
  return app.inject({
    method: 'POST',
    url: `/api/machine/missions/${urlMissionId}/events`,
    headers: extraHeaders,
    payload: { events: signed },
  }) as Promise<InjectLike>;
}

/** The first outcome code of a machine response, whether route-level or per-event. */
export function refusalCode(res: InjectLike): string {
  if (res.statusCode === 401 || res.statusCode === 403) return res.json().error.code as string;
  return res.json().outcomes[0].code as string;
}

export async function devLogin(app: FastifyInstance, username: string): Promise<Session> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: DEV_PASSWORD },
  });
  expect(r.statusCode).toBe(200);
  const setCookie = r.headers['set-cookie'] as unknown;
  const cookie = (Array.isArray(setCookie) ? (setCookie[0] as string) : String(setCookie)).split(
    ';',
  )[0]!;
  return { cookie, csrf: (r.json() as { csrfToken: string }).csrfToken };
}

export function asAdmin(app: () => FastifyInstance, session: () => Session) {
  return {
    post: (url: string, payload?: object) =>
      app().inject({
        method: 'POST',
        url,
        headers: { cookie: session().cookie, 'x-csrf-token': session().csrf },
        payload,
      }) as Promise<InjectLike>,
    get: (url: string) =>
      app().inject({
        method: 'GET',
        url,
        headers: { cookie: session().cookie },
      }) as Promise<InjectLike>,
  };
}
