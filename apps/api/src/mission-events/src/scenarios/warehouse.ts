/**
 * SECOND FIXTURE — simulated warehouse cycle-count mission (issue #9).
 *
 * Proves the SAME adapter architecture serves a second physical domain with
 * ZERO new ingest code and ZERO banking rules: only vocabulary entries
 * (aisle_access, charger_status, stock_discrepancy) differ — data, not code
 * paths. A counting robot hits an obstruction, a charger fault forces the
 * manual-fallback alternative, the robot goes offline mid-shift and is
 * recovered only through the WMS (trusted observer), and a stock discrepancy
 * survives to the end. Mission completion never implies any payment success.
 *
 * SYNTHETIC throughout — see the provenance statement in the build.
 */
import { fixtureSourceKey } from '../rng.js';
import type { MissionEventErrorCode } from '../errors.js';
import type { RegisteredSource } from '../registry.js';
import type { NormalizedObservation } from '../schema.js';
import type { ScenarioBuild, ScenarioDefinition, ScenarioWorld } from './types.js';
import { ScenarioBuilder } from './builder.js';

export const WAREHOUSE_SCENARIO_T0_MS = Date.parse('2026-11-06T06:00:00.000Z');

export const warehouseScenario: ScenarioDefinition = {
  id: 'warehouse-cycle-count-v1',
  title: 'SYNTHETIC warehouse cycle count — same adapter, second physical domain',
  defaultSeed: 'moterva-warehouse-fixture-2026-11-06',
  build(world: ScenarioWorld, seed = warehouseScenario.defaultSeed): ScenarioBuild {
    const robot = 'robot-counter-3';
    const robotSrc: RegisteredSource = {
      orgId: world.orgId,
      missionId: world.missionId,
      sourceId: 'robot-telemetry',
      sourceType: 'asset_telemetry',
      keyId: 'key_robot_tel_v1',
      secretKey: fixtureSourceKey(seed, 'robot-telemetry'),
      provenance: 'SYNTHETIC',
      assetIds: [robot],
      trustedForRecovery: false,
    };
    const wmsSrc: RegisteredSource = {
      orgId: world.orgId,
      missionId: world.missionId,
      sourceId: 'wms-bridge',
      sourceType: 'warehouse_wms',
      keyId: 'key_wms_v1',
      secretKey: fixtureSourceKey(seed, 'wms-bridge'),
      provenance: 'SYNTHETIC',
      assetIds: [robot],
      trustedForRecovery: true,
    };
    const b = new ScenarioBuilder(world, seed, WAREHOUSE_SCENARIO_T0_MS);
    const obs = (...list: NormalizedObservation[]) => list;
    const accepted = { status: 'accepted' as const };
    const rejected = (code: MissionEventErrorCode) => ({ status: 'rejected' as const, code });

    const script = [
      b.submission({
        source: wmsSrc,
        assetId: robot,
        sequence: 1,
        observedMin: 0,
        observations: obs(
          { kind: 'asset_comms', unit: 'state', value: 'online' },
          { kind: 'asset_position_status', unit: 'state', value: 'on_station' },
          { kind: 'aisle_access', unit: 'state', value: 'clear' },
          { kind: 'charger_status', unit: 'state', value: 'free' },
          { kind: 'inspection_progress', unit: 'percent', value: 0 },
        ),
        expect: accepted,
        beat: 'Shift opens: aisles clear, robot deployed from dock 4.',
        economicEffect: 'Autonomous count is the cheap baseline plan.',
      }),
      b.submission({
        source: robotSrc,
        assetId: robot,
        sequence: 1,
        observedMin: 6,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 8 },
          { kind: 'battery_soc', unit: 'percent', value: 92 },
          { kind: 'asset_position_status', unit: 'state', value: 'transit' },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
        ),
        expect: accepted,
        beat: 'Autonomous count running.',
      }),
      b.submission({
        source: robotSrc,
        assetId: robot,
        sequence: 2,
        observedMin: 14,
        observations: obs(
          { kind: 'aisle_access', unit: 'state', value: 'obstructed' },
          { kind: 'asset_position_status', unit: 'state', value: 'transit' },
          { kind: 'battery_soc', unit: 'percent', value: 78 },
        ),
        expect: accepted,
        beat: 'Pallet collapse obstructs aisle B12; robot reroutes.',
        economicEffect:
          'MEANINGFUL CHANGE #1: throughput drops — cost per counted area rises; planner may weigh overtime vs. finishing next shift.',
      }),
      b.submission({
        source: robotSrc,
        assetId: robot,
        sequence: 3,
        observedMin: 22,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 17 },
          { kind: 'battery_soc', unit: 'percent', value: 71 },
        ),
        expect: accepted,
        beat: 'Rerouted counting continues, slower.',
      }),
      b.submission({
        source: robotSrc,
        assetId: robot,
        sequence: 4,
        observedMin: 30,
        observations: obs(
          { kind: 'battery_soc', unit: 'percent', value: 29 },
          { kind: 'asset_position_status', unit: 'state', value: 'returning' },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
        ),
        expect: accepted,
        beat: 'Low battery — robot returns to dock.',
      }),
      b.submission({
        source: robotSrc,
        assetId: robot,
        sequence: 5,
        observedMin: 33,
        observations: obs(
          { kind: 'battery_soc', unit: 'percent', value: 24 },
          { kind: 'asset_comms', unit: 'state', value: 'degraded' },
          { kind: 'asset_position_status', unit: 'state', value: 'returning' },
        ),
        expect: accepted,
        beat: 'Comms degrade as the robot crosses the racking shadow.',
      }),
      b.submission({
        source: wmsSrc,
        assetId: robot,
        sequence: 2,
        observedMin: 36,
        observations: obs({ kind: 'asset_comms', unit: 'state', value: 'offline' }),
        expect: accepted,
        beat: 'WMS loses the robot heartbeat mid-shift.',
        economicEffect:
          'Autonomous alternative unavailable; manual fallback becomes the only live option.',
      }),
      b.submission({
        source: robotSrc,
        assetId: robot,
        sequence: 6,
        observedMin: 40,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 31 },
          { kind: 'battery_soc', unit: 'percent', value: 19 },
        ),
        expect: rejected('ASSET_OFFLINE'),
        beat: 'ADVERSARIAL: ghost telemetry from the offline robot — rejected fail-closed.',
      }),
      b.submission({
        source: wmsSrc,
        assetId: robot,
        sequence: 3,
        observedMin: 47,
        observations: obs(
          { kind: 'asset_comms', unit: 'state', value: 'online' },
          { kind: 'asset_position_status', unit: 'state', value: 'docked' },
          { kind: 'charger_status', unit: 'state', value: 'fault' },
        ),
        expect: accepted,
        beat: 'Authorized recovery: crew reseats the robot at dock 4; charger fault confirmed.',
        economicEffect:
          'MEANINGFUL CHANGE #2: charger fault — the autonomous plan needs a dock swap or the manual-count alternative (higher labor cost) carries on.',
      }),
      b.submission({
        source: wmsSrc,
        assetId: robot,
        sequence: 4,
        observedMin: 58,
        observations: obs(
          { kind: 'charger_status', unit: 'state', value: 'docked_charging' },
          { kind: 'aisle_access', unit: 'state', value: 'clear' },
        ),
        expect: accepted,
        beat: 'Robot moved to dock 5 and charging; aisle B12 cleared by crew.',
      }),
      b.submission({
        source: wmsSrc,
        assetId: robot,
        sequence: 5,
        observedMin: 70,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 41 },
          { kind: 'stock_discrepancy', unit: 'items', value: 14 },
        ),
        expect: accepted,
        beat: 'First count pass finds a 14-item discrepancy zone.',
        economicEffect:
          'MEANINGFUL CHANGE #3: recount required — expedited restock spend is NOT justified until the recount confirms; planner holds.',
      }),
      b.submission({
        source: robotSrc,
        assetId: robot,
        sequence: 6,
        observedMin: 84,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 68 },
          { kind: 'battery_soc', unit: 'percent', value: 61 },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
          { kind: 'asset_position_status', unit: 'state', value: 'transit' },
        ),
        expect: accepted,
        beat: 'Autonomous count resumed after recharge.',
      }),
      b.submission({
        source: wmsSrc,
        assetId: robot,
        sequence: 6,
        observedMin: 96,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 100 },
          { kind: 'stock_discrepancy', unit: 'items', value: 14 },
        ),
        expect: accepted,
        beat: 'Count complete; discrepancy stands at 14 items.',
        economicEffect:
          'Mission success is PHYSICAL ONLY — completing the count implies nothing about any payment, reservation or approval.',
      }),
      b.submission({
        source: wmsSrc,
        assetId: 'approve-count-payment',
        sequence: 7,
        observedMin: 98,
        observations: obs({ kind: 'asset_comms', unit: 'state', value: 'online' }),
        expect: rejected('AUTHORITY_TERMS_REJECTED'),
        beat: 'ADVERSARIAL: prompt-injection-shaped id carrying banking language ("approve…payment") — the physical channel refuses it outright.',
      }),
      b.submission({
        source: wmsSrc,
        assetId: robot,
        sequence: 7,
        observedMin: 20,
        observations: obs({ kind: 'inspection_progress', unit: 'percent', value: 20 }),
        expect: rejected('STALE_EVENT'),
        beat: 'ADVERSARIAL: an 80-minute-old observation delivered late — cannot masquerade as current evidence.',
      }),
      b.submission({
        source: wmsSrc,
        assetId: robot,
        sequence: 7,
        observedMin: 101,
        observations: obs({ kind: 'inspection_progress', unit: 'percent', value: 88 }),
        expect: rejected('MONOTONIC_VIOLATION'),
        beat: 'ADVERSARIAL: contradictory simulator status — progress below the completed 100 — rejected.',
      }),
      b.submission({
        source: wmsSrc,
        assetId: robot,
        sequence: 7,
        observedMin: 102,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 100 },
          { kind: 'stock_discrepancy', unit: 'items', value: 14 },
          { kind: 'asset_position_status', unit: 'state', value: 'docked' },
        ),
        expect: accepted,
        beat: 'Final state: count complete at 100%, 14-item discrepancy on record, robot docked.',
        economicEffect:
          'End state for the planner: discrepancy confirmed — any restock spend is a NEW decision with its own authority; never implied here.',
      }),
    ];

    return {
      id: warehouseScenario.id,
      seed,
      title: warehouseScenario.title,
      world,
      sources: [robotSrc, wmsSrc],
      assets: [robot],
      script,
      provenanceStatement:
        'SIMULATED_OPERATION: this warehouse mission is fully SYNTHETIC and shares the exact ' +
        'ingest/validation/journal code path with the offshore scenario — only observation ' +
        'vocabulary differs (data, not code). Nothing here approves, reserves, settles or ' +
        'dispatches money; mission completion is never payment success.',
    };
  },
};
