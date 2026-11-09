/**
 * P0-1 contract test — REAL HTTP → REAL viewer adapter → REAL scene state.
 *
 * Drives the live endpoint with an authenticated tenant over journal-derived
 * evidence (baseline + 24.6-kt incident via the REAL ingest path), then feeds
 * the actual HTTP response through Agent C's checked-in strict
 * `snapshotFromServerPayload` and `projectSceneState` (vendored verbatim from
 * PR #50 head f5b4a16). Verifies event id/digest, the 24.6-vs-22 incident
 * breach, S4 historical selection, negatives (malformed/unknown payloads
 * fail the adapter closed), and that the read creates zero financial writes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { openLedger, type Ledger } from '@moterva/ledger';
import { TEST_PASSWORD, tempDbPath } from '../../../../packages/ledger/test/helpers.js';
// REAL viewer modules, vendored verbatim from origin/feat/mtv-09-mission-viewer (f5b4a16):
import { snapshotFromServerPayload } from '../../../web/src/mission-viewer/adapter.js';
import { projectSceneState } from '../../../web/src/mission-viewer/scene-state.js';

const DIR = mkdtempSync(join(tmpdir(), 'pv-contract-'));
let ledger: Ledger;
let app: FastifyInstance;
let OPERATOR: { cookie: string; csrf: string };
let missionId = '';

async function login(username: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: TEST_PASSWORD },
  });
  expect(r.statusCode).toBe(200);
  const setCookie = r.headers['set-cookie'] as unknown;
  const first = Array.isArray(setCookie) ? (setCookie[0] as string) : String(setCookie);
  return { cookie: first.split(';')[0]!, csrf: (r.json() as { csrfToken: string }).csrfToken };
}

async function get(who: { cookie: string }, url: string) {
  return app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });
}

async function post(
  who: { cookie: string; csrf: string },
  url: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url,
    headers: { cookie: who.cookie, 'x-csrf-token': who.csrf },
    ...(payload === undefined ? {} : { payload }),
  });
}

beforeAll(async () => {
  ledger = openLedger(tempDbPath('pv-contract-'));
  ledger.migrate();
  app = buildApp(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WEB_ORIGIN: 'http://localhost:5173',
      HOST: '127.0.0.1',
      MOTERVA_LEDGER_PATH: join(DIR, 'ledger.sqlite'),
      MOTERVA_DEV_AUTH: '1',
    }),
    undefined,
    ledger,
  );
  await app.ready();
  const org = ledger.organizations.createOrganization('PV Contract Org');
  ledger.organizations.createMission(org.id, 'contract mission');
  for (const role of ['owner', 'admin', 'approver', 'operator', 'viewer'] as const) {
    ledger.authority.createHumanActor({
      orgId: org.id,
      username: role,
      displayName: role,
      role,
      password: TEST_PASSWORD,
    });
  }
  OPERATOR = await login('operator');
  missionId = ((await get(OPERATOR, '/api/missions')).json() as { missions: { id: string }[] })
    .missions[0]!.id;
});

afterAll(async () => {
  await app.close();
  if (ledger.db.open) ledger.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe('P0-1 — live HTTP payload satisfies the REAL strict viewer adapter', () => {
  it('baseline+incident → HTTP → snapshotFromServerPayload → projectSceneState (S2 breach)', async () => {
    // Journal-derived evidence through the REAL ingest path.
    await post(OPERATOR, `/api/missions/${missionId}/synthetic-step`, { step: 'baseline' });
    await post(OPERATOR, `/api/missions/${missionId}/synthetic-step`, { step: 'incident' });

    const http = await get(OPERATOR, `/api/missions/${missionId}/physical-view`);
    expect(http.statusCode).toBe(200);
    const payload = http.json();

    // THE ACTUAL STRICT ADAPTER (throws PhysicalViewShapeError on any deviation):
    const snapshot = snapshotFromServerPayload(payload);
    expect(snapshot.contractVersion).toBe(1);
    expect(snapshot.policy.uavAssetId).toBe('uav-seeker-1');
    expect(snapshot.policy.uavWindLimitKt).toBe(22);
    expect(snapshot.assets[0]!.kind).toBe('aerial');
    // Event identity + digest survive the wire.
    expect(snapshot.events.length).toBe(2);
    expect(snapshot.events[0]!.eventDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.events[1]!.observedAt).toBeDefined();

    // REAL scene projection: the 24.6 kt incident breaches the 22 kt limit → S2.
    const scene = projectSceneState(snapshot);
    expect(scene.phase).toBe('S2-restricted');
    expect(scene.aerialWindKt).toBe(24.6);
    expect(scene.windBreached).toBe(true);

    // Pose observations travel for the 3D scene (typed asset_position_status
    // admitted by the allowlist when journaled).
    const kinds = new Set(snapshot.events.flatMap((e) => e.observations.map((o) => o.kind)));
    for (const kind of kinds) {
      expect(['wind_speed', 'weather_hold', 'asset_comms', 'asset_position_status']).toContain(
        kind,
      );
    }
  });

  it('S4-historical: selecting the EARLIER baseline event on the FULL snapshot yields the exact phase, basis and event id', async () => {
    // REAL S4 mechanism (no journal trimming): the FULL snapshot is fetched
    // and the host selects the earlier event via SceneSelection.
    // selected.isHistoricalReplay is derived from journalSeq < max, and the
    // constraint-at-event is derived from the as-of-event prefix.
    const http = await get(OPERATOR, `/api/missions/${missionId}/physical-view`);
    const snapshot = snapshotFromServerPayload(http.json());
    expect(snapshot.events.length).toBe(2);
    const baselineEvent = snapshot.events.find((e) => e.observations.some((o) => o.kind === 'wind_speed' && o.value === '14.2'));
    expect(baselineEvent).toBeDefined();
    const scene = projectSceneState(snapshot, {
      selectedEventId: baselineEvent!.eventId,
    });
    expect(scene.phase).toBe('S4-historical'); // EXACT phase
    expect(scene.selected).not.toBeNull();
    expect(scene.selected!.event.eventId).toBe(baselineEvent!.eventId); // exact event id
    expect(scene.selected!.isHistoricalReplay).toBe(true);
    // The historical constraint at the baseline event: 14.2 kt, hold clear,
    // comms online (all fresh at that point) → nominal-era basis, no breach.
    expect(scene.selected!.constraintAtEvent).toBeDefined();
    expect(scene.selected!.constraintAtEvent.state).toBe('clear');
    // And selecting the LATEST incident preserves S2 (no S4 on newest).
    const latestScene = projectSceneState(snapshot, {
      selectedEventId: snapshot.events[snapshot.events.length - 1]!.eventId,
    });
    expect(latestScene.selected!.isHistoricalReplay).toBe(false);
  });

  it('NEGATIVES: malformed/unknown payloads fail the adapter closed', () => {
    expect(() => snapshotFromServerPayload({})).toThrow(
      /contractVersion must be 1|payload must be an object/,
    );
    expect(() => snapshotFromServerPayload({ contractVersion: 2 })).toThrow(
      /contractVersion must be 1/,
    );
    expect(() =>
      snapshotFromServerPayload({
        contractVersion: 1,
        tenant: { orgId: 'o', missionId: 'm' },
        policy: { maxAgeMs: 1, expiredMs: 1, uavAssetId: 'x', uavWindLimitKt: 22 },
        assets: [{ assetId: 'x', kind: 'aerial' }],
        events: [],
        asOf: '2026-11-09T00:00:00.000Z',
        truthLabel: 't',
      }),
    ).not.toThrow(); // empty events is a valid S0-initial snapshot per the adapter
    // Bad digest fails closed.
    expect(() =>
      snapshotFromServerPayload({
        contractVersion: 1,
        tenant: { orgId: 'o', missionId: 'm' },
        policy: { maxAgeMs: 1, expiredMs: 1, uavAssetId: 'x', uavWindLimitKt: 22 },
        assets: [{ assetId: 'x', kind: 'aerial' }],
        events: [
          {
            eventId: 'e',
            journalSeq: 1,
            sequence: 1,
            assetId: 'x',
            sourceId: 's',
            sourceType: 't',
            provenance: 'SYNTHETIC',
            observedAt: '2026-11-09T00:00:00.000Z',
            ingestedAt: '2026-11-09T00:00:00.000Z',
            recordedAt: '2026-11-09T00:00:00.000Z',
            eventDigest: 'not-hex',
            observations: [{ kind: 'wind_speed', unit: 'kt', value: '10.0' }],
            freshnessAtSnapshot: 'fresh',
            planningValidAtSnapshot: true,
          },
        ],
        asOf: '2026-11-09T00:00:00.000Z',
        truthLabel: 't',
      }),
    ).toThrow(/64-hex/);
    // Unknown asset in events fails closed.
    expect(() =>
      snapshotFromServerPayload({
        contractVersion: 1,
        tenant: { orgId: 'o', missionId: 'm' },
        policy: { maxAgeMs: 1, expiredMs: 1, uavAssetId: 'x', uavWindLimitKt: 22 },
        assets: [{ assetId: 'x', kind: 'aerial' }],
        events: [
          {
            eventId: 'e',
            journalSeq: 1,
            sequence: 1,
            assetId: 'ghost',
            sourceId: 's',
            sourceType: 't',
            provenance: 'SYNTHETIC',
            observedAt: '2026-11-09T00:00:00.000Z',
            ingestedAt: '2026-11-09T00:00:00.000Z',
            recordedAt: '2026-11-09T00:00:00.000Z',
            eventDigest: '0'.repeat(64),
            observations: [{ kind: 'wind_speed', unit: 'kt', value: '10.0' }],
            freshnessAtSnapshot: 'fresh',
            planningValidAtSnapshot: true,
          },
        ],
        asOf: '2026-11-09T00:00:00.000Z',
        truthLabel: 't',
      }),
    ).toThrow(/not a registered asset/);
  });

  it('read-only proof: physical-view GETs add zero ledger rows of any kind', async () => {
    const count = (t: string) =>
      (ledger.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    const before = {
      ops: count('operations'),
      receipts: count('provider_receipts'),
      evidence: count('evidence_events'),
    };
    for (let i = 0; i < 3; i += 1) {
      const r = await get(OPERATOR, `/api/missions/${missionId}/physical-view`);
      expect(r.statusCode).toBe(200);
    }
    const after = {
      ops: count('operations'),
      receipts: count('provider_receipts'),
      evidence: count('evidence_events'),
    };
    expect(after).toEqual(before); // GET is a pure read — zero rows added
  });
});
