import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { openLedger, type Ledger } from '@moterva/ledger';
import type { FastifyInstance } from 'fastify';
import { snapshotFromServerPayload } from '../../../web/src/mission-viewer/adapter.js';
import type { PhysicalViewSnapshot } from '../../../web/src/mission-viewer/contract.js';
import { projectSceneState } from '../../../web/src/mission-viewer/scene-state.js';
import { constraintFor as acceptedConstraintFor } from '../../src/integration/physical-view.js';

/**
 * CTO final-review corrections — regression suite for the three defects.
 *
 * P0-A: S0 must come from a REAL server payload (HTTP 200, strict-adapter
 *   valid, real tenant/policy/catalog asset, zero events) — the client
 *   fabricates nothing; 404/401/malformed never render a ready scene.
 * P0-B: the viewer verdict MUST equal the accepted backend constraintFor on
 *   the same journal state — ground/surface online comms is UNKNOWN (never
 *   clear), aerial precedence wind-limit → hold → offline → degraded → clear.
 * P1-C: decisionAvailable derives from verified decision evidence only
 *   (S2 without it, S3 with it).
 */
const TEST_PASSWORD = ['dev', 'only', 'fixture'].join('-');
const DIR = mkdtempSync(join(tmpdir(), 'mv14-cto-final-'));
let ledger: Ledger;
let app: FastifyInstance;
let orgId = '';
let missionId = '';
let cookie = '';

async function login(username: string): Promise<void> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: TEST_PASSWORD },
  });
  expect(r.statusCode).toBe(200);
  const setCookie = r.headers['set-cookie'] as unknown;
  cookie = (Array.isArray(setCookie) ? (setCookie[0] as string) : String(setCookie)).split(';')[0]!;
}

async function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { cookie } });
}

beforeAll(async () => {
  ledger = openLedger(join(DIR, 'ledger.sqlite'));
  ledger.migrate();
  app = buildApp(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WEB_ORIGIN: 'http://localhost:5173',
      HOST: '127.0.0.1',
      MOTERVA_DEV_AUTH: '1',
    }),
    undefined,
    ledger,
  );
  await app.ready();
  orgId = ledger.organizations.createOrganization('CTO Final Org').id;
  ledger.organizations.createMission(orgId, 'CTO final mission');
  for (const role of ['owner', 'approver', 'operator', 'viewer'] as const) {
    ledger.authority.createHumanActor({
      orgId,
      username: role,
      displayName: `CTO ${role}`,
      role,
      password: TEST_PASSWORD,
    });
  }
  await login('operator');
  missionId = ((await get('/api/missions')).json() as { missions: { id: string }[] }).missions[0]!
    .id;
});

afterAll(async () => {
  await app.close();
  ledger.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe('P0-A — S0 is server-authoritative; the client fabricates nothing', () => {
  it('empty mission → HTTP 200 with a strict-valid S0 snapshot (real tenant, policy, catalog asset, zero events)', async () => {
    const r = await get(`/api/missions/${missionId}/physical-view`);
    expect(r.statusCode).toBe(200);
    const snapshot = snapshotFromServerPayload(r.json());
    expect(snapshot.events).toEqual([]);
    expect(snapshot.assets).toHaveLength(1);
    expect(snapshot.assets[0]!.kind).toBe('aerial');
    expect(snapshot.tenant.orgId).not.toBe('');
    expect(snapshot.tenant.missionId).toBe(missionId);
    expect(snapshot.policy.uavAssetId).toBe('uav-seeker-1');
    expect(snapshot.policy.uavWindLimitKt).toBe(22);
    const scene = projectSceneState(snapshot);
    expect(scene.phase).toBe('S0-initial');
    expect(scene.constraints[0]).toMatchObject({
      state: 'unknown',
      reason: 'insufficient-evidence',
    });
  });

  it('nonexistent (foreign) mission → 404, never a ready scene', async () => {
    const r = await get('/api/missions/msn_does_not_exist/physical-view');
    expect(r.statusCode).toBe(404);
    expect(() => snapshotFromServerPayload(r.json())).toThrow();
  });

  it('unauthenticated → 401, never a ready scene', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/missions/${missionId}/physical-view`,
    });
    expect(r.statusCode).toBe(401);
  });

  it('malformed payload → strict adapter rejects (never a half-trusted snapshot)', () => {
    expect(() => snapshotFromServerPayload({ contractVersion: 2 })).toThrow(/contractVersion/);
    expect(() => snapshotFromServerPayload({ contractVersion: 1, tenant: {} })).toThrow();
  });
});

describe('P0-B — matched verdicts: viewer == accepted backend on identical journal state', () => {
  it('ground/surface ONLINE comms alone → UNKNOWN in both engines (comms is never route clearance)', () => {
    const now = new Date().toISOString();
    const snapshot: PhysicalViewSnapshot = {
      contractVersion: 1 as const,
      tenant: { orgId: 'org_x', missionId: 'msn_x' },
      asOf: now,
      truthLabel: 'SIMULATED_OPERATION',
      policy: {
        maxAgeMs: 15 * 60_000,
        expiredMs: 30 * 60_000,
        uavAssetId: 'uav-seeker-1',
        uavWindLimitKt: 22,
      },
      assets: [{ assetId: 'robot-counter-3', kind: 'ground' as const }],
      events: [
        {
          eventId: 'mevt_ground_online',
          journalSeq: 1,
          sequence: 1,
          assetId: 'robot-counter-3',
          sourceId: 'wms',
          sourceType: 'warehouse_wms',
          provenance: 'SYNTHETIC',
          observedAt: now,
          ingestedAt: now,
          recordedAt: now,
          eventDigest: 'a'.repeat(64),
          observations: [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
          freshnessAtSnapshot: 'fresh',
          planningValidAtSnapshot: true,
        },
      ],
    };
    const viewer = projectSceneState(snapshot).constraints[0]!;
    const backend = acceptedConstraintFor({
      assetId: 'robot-counter-3',
      domain: 'ground',
      latest: {
        asset_comms: {
          kind: 'asset_comms',
          unit: 'state',
          value: 'online',
          eventId: 'mevt_ground_online',
          observedAt: now,
          freshness: 'fresh',
        },
      },
      windLimitKt: 22,
    });
    // Matched-verdict law: state AND reason equal the accepted engine.
    expect(viewer.state).toBe(backend.state);
    expect(viewer.reason).toBe(backend.reason);
    // And the completed-contract behavior, explicitly: online comms with no
    // fresh aisle/charger readings is NOT clearance (a recovered robot with
    // only comms restored stays unknown — route state is unproven).
    expect(viewer.state).toBe('unknown');
  });

  it('ground FULL healthy triple → CLEAR/nominal in both engines (completed ground contract)', () => {
    const now = new Date().toISOString();
    const snapshot: PhysicalViewSnapshot = {
      contractVersion: 1 as const,
      tenant: { orgId: 'org_x', missionId: 'msn_x' },
      asOf: now,
      truthLabel: 'SIMULATED_OPERATION',
      policy: {
        maxAgeMs: 15 * 60_000,
        expiredMs: 30 * 60_000,
        uavAssetId: 'uav-seeker-1',
        uavWindLimitKt: 22,
      },
      assets: [{ assetId: 'robot-counter-3', kind: 'ground' as const }],
      events: [
        {
          eventId: 'mevt_ground_ok',
          journalSeq: 1,
          sequence: 1,
          assetId: 'robot-counter-3',
          sourceId: 'wms',
          sourceType: 'warehouse_wms',
          provenance: 'SYNTHETIC',
          observedAt: now,
          ingestedAt: now,
          recordedAt: now,
          eventDigest: '1'.repeat(64),
          observations: [
            { kind: 'aisle_access', unit: 'state', value: 'clear' },
            { kind: 'charger_status', unit: 'state', value: 'free' },
            { kind: 'asset_comms', unit: 'state', value: 'online' },
          ],
          freshnessAtSnapshot: 'fresh',
          planningValidAtSnapshot: true,
        },
      ],
    };
    const viewer = projectSceneState(snapshot).constraints[0]!;
    const backend = acceptedConstraintFor({
      assetId: 'robot-counter-3',
      domain: 'ground',
      latest: {
        aisle_access: { kind: 'aisle_access', unit: 'state', value: 'clear', eventId: 'mevt_ground_ok', observedAt: now, freshness: 'fresh' },
        charger_status: { kind: 'charger_status', unit: 'state', value: 'free', eventId: 'mevt_ground_ok', observedAt: now, freshness: 'fresh' },
        asset_comms: { kind: 'asset_comms', unit: 'state', value: 'online', eventId: 'mevt_ground_ok', observedAt: now, freshness: 'fresh' },
      },
      windLimitKt: 22,
    });
    expect(viewer.state).toBe('clear');
    expect(viewer.reason).toBe('nominal');
    expect(`${backend.state}/${backend.reason}`).toBe('clear/nominal');
  });

  it('ground aisle-obstructed → BLOCKED in both engines (completed ground precedence)', () => {
    const now = new Date().toISOString();
    const snapshot: PhysicalViewSnapshot = {
      contractVersion: 1 as const,
      tenant: { orgId: 'org_x', missionId: 'msn_x' },
      asOf: now,
      truthLabel: 'SIMULATED_OPERATION',
      policy: {
        maxAgeMs: 15 * 60_000,
        expiredMs: 30 * 60_000,
        uavAssetId: 'uav-seeker-1',
        uavWindLimitKt: 22,
      },
      assets: [{ assetId: 'robot-counter-3', kind: 'ground' as const }],
      events: [
        {
          eventId: 'mevt_ground_aisle',
          journalSeq: 1,
          sequence: 1,
          assetId: 'robot-counter-3',
          sourceId: 'wms',
          sourceType: 'warehouse_wms',
          provenance: 'SYNTHETIC',
          observedAt: now,
          ingestedAt: now,
          recordedAt: now,
          eventDigest: '2'.repeat(64),
          observations: [
            { kind: 'aisle_access', unit: 'state', value: 'obstructed' },
            { kind: 'asset_comms', unit: 'state', value: 'online' },
          ],
          freshnessAtSnapshot: 'fresh',
          planningValidAtSnapshot: true,
        },
      ],
    };
    const viewer = projectSceneState(snapshot).constraints[0]!;
    const backend = acceptedConstraintFor({
      assetId: 'robot-counter-3',
      domain: 'ground',
      latest: {
        aisle_access: { kind: 'aisle_access', unit: 'state', value: 'obstructed', eventId: 'mevt_ground_aisle', observedAt: now, freshness: 'fresh' },
        asset_comms: { kind: 'asset_comms', unit: 'state', value: 'online', eventId: 'mevt_ground_aisle', observedAt: now, freshness: 'fresh' },
      },
      windLimitKt: 22,
    });
    // Restored comms must NOT imply route clearance while the aisle reading
    // says obstructed (C2 law) — and both engines agree on the verdict.
    expect(viewer.state).toBe('blocked');
    expect(viewer.reason).toBe('aisle-obstructed');
    expect(`${backend.state}/${backend.reason}`).toBe('blocked/aisle-obstructed');
  });

  it('ground OFFLINE → blocked in both engines', () => {
    const now = new Date().toISOString();
    const snapshot: PhysicalViewSnapshot = {
      contractVersion: 1 as const,
      tenant: { orgId: 'org_x', missionId: 'msn_x' },
      asOf: now,
      truthLabel: 'SIMULATED_OPERATION',
      policy: {
        maxAgeMs: 15 * 60_000,
        expiredMs: 30 * 60_000,
        uavAssetId: 'uav-seeker-1',
        uavWindLimitKt: 22,
      },
      assets: [{ assetId: 'robot-counter-3', kind: 'ground' as const }],
      events: [
        {
          eventId: 'mevt_ground_off',
          journalSeq: 1,
          sequence: 1,
          assetId: 'robot-counter-3',
          sourceId: 'wms',
          sourceType: 'warehouse_wms',
          provenance: 'SYNTHETIC',
          observedAt: now,
          ingestedAt: now,
          recordedAt: now,
          eventDigest: 'b'.repeat(64),
          observations: [{ kind: 'asset_comms', unit: 'state', value: 'offline' }],
          freshnessAtSnapshot: 'fresh',
          planningValidAtSnapshot: true,
        },
      ],
    };
    expect(projectSceneState(snapshot).constraints[0]).toMatchObject({
      state: 'blocked',
      reason: 'comms-offline',
    });
  });

  it('aerial compound precedence matches the accepted engine: wind → hold → offline → degraded → clear', () => {
    const now = new Date().toISOString();
    const snap = (
      observations: { kind: string; unit: string; value: string | number }[],
    ): PhysicalViewSnapshot => ({
      contractVersion: 1 as const,
      tenant: { orgId: 'org_x', missionId: 'msn_x' },
      asOf: now,
      truthLabel: 'SIMULATED_OPERATION',
      policy: {
        maxAgeMs: 15 * 60_000,
        expiredMs: 30 * 60_000,
        uavAssetId: 'uav-seeker-1',
        uavWindLimitKt: 22,
      },
      assets: [{ assetId: 'uav-seeker-1', kind: 'aerial' as const }],
      events: [
        {
          eventId: 'mevt_air',
          journalSeq: 1,
          sequence: 1,
          assetId: 'uav-seeker-1',
          sourceId: 'ops',
          sourceType: 'mission_control',
          provenance: 'SYNTHETIC',
          observedAt: now,
          ingestedAt: now,
          recordedAt: now,
          eventDigest: 'c'.repeat(64),
          observations,
          freshnessAtSnapshot: 'fresh',
          planningValidAtSnapshot: true,
        },
      ],
    });
    // wind-limit beats concurrent hold + offline (accepted precedence).
    expect(
      projectSceneState(
        snap([
          { kind: 'wind_speed', unit: 'kt', value: '24.6' },
          { kind: 'weather_hold', unit: 'state', value: 'active' },
          { kind: 'asset_comms', unit: 'state', value: 'offline' },
        ]),
      ).constraints[0],
    ).toMatchObject({ state: 'blocked', reason: 'wind-limit' });
    // hold beats offline.
    expect(
      projectSceneState(
        snap([
          { kind: 'weather_hold', unit: 'state', value: 'active' },
          { kind: 'asset_comms', unit: 'state', value: 'offline' },
        ]),
      ).constraints[0],
    ).toMatchObject({ state: 'blocked', reason: 'weather-hold' });
    // degraded comms never clear.
    expect(
      projectSceneState(
        snap([
          { kind: 'wind_speed', unit: 'kt', value: '10.0' },
          { kind: 'weather_hold', unit: 'state', value: 'clear' },
          { kind: 'asset_comms', unit: 'state', value: 'degraded' },
        ]),
      ).constraints[0],
    ).toMatchObject({ state: 'unknown', reason: 'insufficient-evidence' });
    // full fresh triple → clear.
    expect(
      projectSceneState(
        snap([
          { kind: 'wind_speed', unit: 'kt', value: '10.0' },
          { kind: 'weather_hold', unit: 'state', value: 'clear' },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
        ]),
      ).constraints[0],
    ).toMatchObject({ state: 'clear', reason: 'nominal' });
  });

  it('historical replay (as-of-event prefix) uses the same matched rules', () => {
    const now = new Date().toISOString();
    const snapshot: PhysicalViewSnapshot = {
      contractVersion: 1 as const,
      tenant: { orgId: 'org_x', missionId: 'msn_x' },
      asOf: now,
      truthLabel: 'SIMULATED_OPERATION',
      policy: {
        maxAgeMs: 15 * 60_000,
        expiredMs: 30 * 60_000,
        uavAssetId: 'uav-seeker-1',
        uavWindLimitKt: 22,
      },
      assets: [{ assetId: 'uav-seeker-1', kind: 'aerial' as const }],
      events: [
        {
          eventId: 'mevt_base',
          journalSeq: 1,
          sequence: 1,
          assetId: 'uav-seeker-1',
          sourceId: 'ops',
          sourceType: 'mission_control',
          provenance: 'SYNTHETIC',
          observedAt: now,
          ingestedAt: now,
          recordedAt: now,
          eventDigest: 'd'.repeat(64),
          observations: [{ kind: 'wind_speed', unit: 'kt', value: '14.2' }],
          freshnessAtSnapshot: 'fresh',
          planningValidAtSnapshot: true,
        },
        {
          eventId: 'mevt_inc',
          journalSeq: 2,
          sequence: 2,
          assetId: 'uav-seeker-1',
          sourceId: 'ops',
          sourceType: 'mission_control',
          provenance: 'SYNTHETIC',
          observedAt: now,
          ingestedAt: now,
          recordedAt: now,
          eventDigest: 'e'.repeat(64),
          observations: [{ kind: 'wind_speed', unit: 'kt', value: '24.6' }],
          freshnessAtSnapshot: 'fresh',
          planningValidAtSnapshot: true,
        },
      ],
    };
    const scene = projectSceneState(snapshot, { selectedEventId: 'mevt_base' });
    expect(scene.phase).toBe('S4-historical');
    // Constraint at the EARLIER event: 14.2 kt within limit → unknown
    // (no hold/comms readings yet — never clear without the full triple).
    expect(scene.selected?.constraintAtEvent).toMatchObject({ state: 'unknown' });
  });
});

describe('P1-C — decisionAvailable derives from verified decision evidence only', () => {
  it('a wind-blocked snapshot projects S2 without a verified decision, S3 with one', () => {
    const now = new Date().toISOString();
    const snapshot: PhysicalViewSnapshot = {
      contractVersion: 1 as const,
      tenant: { orgId: 'org_x', missionId: 'msn_x' },
      asOf: now,
      truthLabel: 'SIMULATED_OPERATION',
      policy: {
        maxAgeMs: 15 * 60_000,
        expiredMs: 30 * 60_000,
        uavAssetId: 'uav-seeker-1',
        uavWindLimitKt: 22,
      },
      assets: [{ assetId: 'uav-seeker-1', kind: 'aerial' as const }],
      events: [
        {
          eventId: 'mevt_wind',
          journalSeq: 1,
          sequence: 1,
          assetId: 'uav-seeker-1',
          sourceId: 'ops',
          sourceType: 'mission_control',
          provenance: 'SYNTHETIC',
          observedAt: now,
          ingestedAt: now,
          recordedAt: now,
          eventDigest: 'f'.repeat(64),
          observations: [{ kind: 'wind_speed', unit: 'kt', value: '24.6' }],
          freshnessAtSnapshot: 'fresh',
          planningValidAtSnapshot: true,
        },
      ],
    };
    // No verified decision: S2 (physical restriction alone).
    expect(projectSceneState(snapshot).phase).toBe('S2-restricted');
    // Verified decision present: S3.
    expect(projectSceneState(snapshot, { decisionAvailable: true }).phase).toBe(
      'S3-restricted-escalated',
    );
  });
});
