/**
 * FLAGSHIP SCENARIO — simulated offshore hull inspection (issue #9).
 *
 * A UAV inspects a moored vessel's hull from the air while a support vessel
 * stands by. Changing conditions alter the ECONOMICS mid-mission: the launch
 * window closes (aerial alternative blocked), the UAV goes offline offshore,
 * recovery happens only through the support vessel's gateway, and the mission
 * finishes on the more expensive vessel-based alternative with a major defect
 * found. Adversarial beats are scripted INTO the trace: ghost telemetry from
 * the offline asset, an exact replay, an unregistered "magic recovery" source,
 * a lost-update sequence gap and a contradictory progress report.
 *
 * EVERYTHING HERE IS SYNTHETIC. No real vehicle, water, weather or payment
 * exists. The economic annotations describe what a PLANNER (issue #8, Agent A)
 * should re-weigh — they carry no financial authority and never journal.
 */
import { fixtureSourceKey } from '../rng.js';
import type { MissionEventErrorCode } from '../errors.js';
import type { RegisteredSource } from '../registry.js';
import type { NormalizedObservation } from '../schema.js';
import type { ScenarioBuild, ScenarioDefinition, ScenarioWorld } from './types.js';
import { ScenarioBuilder } from './builder.js';

export const OFFSHORE_SCENARIO_T0_MS = Date.parse('2026-11-06T09:00:00.000Z');

export const offshoreScenario: ScenarioDefinition = {
  id: 'offshore-hull-inspection-v1',
  title: 'SYNTHETIC offshore hull inspection — changing sea state alters the economic choice',
  defaultSeed: 'moterva-offshore-flagship-2026-11-06',
  build(world: ScenarioWorld, seed = offshoreScenario.defaultSeed): ScenarioBuild {
    const uav = 'uav-seeker-1';
    const vessel = 'vessel-prospect';
    const uavSrc: RegisteredSource = {
      orgId: world.orgId,
      missionId: world.missionId,
      sourceId: 'uav-telemetry',
      sourceType: 'asset_telemetry',
      keyId: 'key_uav_tel_v1',
      secretKey: fixtureSourceKey(seed, 'uav-telemetry'),
      provenance: 'SYNTHETIC',
      assetIds: [uav],
      trustedForRecovery: false,
    };
    const vesselSrc: RegisteredSource = {
      orgId: world.orgId,
      missionId: world.missionId,
      sourceId: 'vessel-gateway',
      sourceType: 'vessel_gateway',
      keyId: 'key_vessel_gw_v1',
      secretKey: fixtureSourceKey(seed, 'vessel-gateway'),
      provenance: 'SYNTHETIC',
      assetIds: [uav, vessel],
      trustedForRecovery: true,
    };
    const opsSrc: RegisteredSource = {
      orgId: world.orgId,
      missionId: world.missionId,
      sourceId: 'ops-console',
      sourceType: 'mission_control',
      keyId: 'key_ops_console_v1',
      secretKey: fixtureSourceKey(seed, 'ops-console'),
      provenance: 'SYNTHETIC',
      assetIds: [uav, vessel],
      trustedForRecovery: false,
    };
    const sources = [uavSrc, vesselSrc, opsSrc];
    const b = new ScenarioBuilder(world, seed, OFFSHORE_SCENARIO_T0_MS);
    const obs = (...list: NormalizedObservation[]) => list;
    const accepted = { status: 'accepted' as const };
    const rejected = (code: MissionEventErrorCode) => ({ status: 'rejected' as const, code });

    const script = [
      b.submission({
        source: opsSrc,
        assetId: uav,
        sequence: 1,
        observedMin: 0,
        observations: obs(
          { kind: 'wind_speed', unit: 'kt', value: '14.2' },
          { kind: 'wave_height', unit: 'm', value: '0.80' },
          { kind: 'visibility', unit: 'category', value: 'good' },
          { kind: 'weather_hold', unit: 'state', value: 'clear' },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
          { kind: 'asset_position_status', unit: 'state', value: 'on_station' },
          { kind: 'battery_soc', unit: 'percent', value: 96 },
          { kind: 'inspection_progress', unit: 'percent', value: 0 },
        ),
        expect: accepted,
        beat: 'Mission opens: calm seas, UAV on station — aerial inspection window is open.',
        economicEffect:
          'Aerial alternative is deployable and cheapest; planner can keep the low-cost plan.',
      }),
      b.submission({
        source: uavSrc,
        assetId: uav,
        sequence: 1,
        observedMin: 8,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 12 },
          { kind: 'battery_soc', unit: 'percent', value: 84 },
          { kind: 'wind_speed', unit: 'kt', value: '14.9' },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
          { kind: 'asset_position_status', unit: 'state', value: 'on_station' },
        ),
        expect: accepted,
        beat: 'Aerial inspection progressing.',
      }),
      b.submission({
        source: opsSrc,
        assetId: uav,
        sequence: 2,
        observedMin: 18,
        observations: obs(
          { kind: 'wind_speed', unit: 'kt', value: '24.6' },
          { kind: 'wave_height', unit: 'm', value: '1.48' },
          { kind: 'weather_hold', unit: 'state', value: 'active' },
        ),
        expect: accepted,
        beat: 'Sea state changes: wind 24.6 kt exceeds the 22 kt UAV limit; weather hold active.',
        economicEffect:
          'MEANINGFUL CHANGE #1: aerial alternative is blocked; planner must weigh the costlier vessel-based close inspection against waiting out the hold.',
      }),
      b.submission({
        source: uavSrc,
        assetId: uav,
        sequence: 2,
        observedMin: 20,
        observations: obs(
          { kind: 'battery_soc', unit: 'percent', value: 58 },
          { kind: 'asset_position_status', unit: 'state', value: 'returning' },
          { kind: 'asset_comms', unit: 'state', value: 'degraded' },
        ),
        expect: accepted,
        beat: 'UAV returns to base against headwind, comms degraded.',
      }),
      b.submission({
        source: uavSrc,
        assetId: uav,
        sequence: 3,
        observedMin: 29,
        emitDelaySec: 3,
        observations: obs(
          { kind: 'battery_soc', unit: 'percent', value: 33 },
          { kind: 'asset_position_status', unit: 'state', value: 'returning' },
          { kind: 'asset_comms', unit: 'state', value: 'degraded' },
        ),
        expect: accepted,
        beat: 'UAV still inbound, battery falling.',
      }),
      b.submission({
        source: vesselSrc,
        assetId: uav,
        sequence: 1,
        observedMin: 34,
        observations: obs(
          { kind: 'asset_comms', unit: 'state', value: 'offline' },
          { kind: 'asset_position_status', unit: 'state', value: 'off_station' },
        ),
        expect: accepted,
        beat: 'Support vessel gateway loses the UAV data link offshore; last position off station.',
        economicEffect:
          'Aerial alternative is now unavailable AND uncertain (asset state unknown offshore); planner must not commit further aerial-dependent spend.',
      }),
      b.submission({
        source: uavSrc,
        assetId: uav,
        sequence: 4,
        observedMin: 40,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 47 },
          { kind: 'battery_soc', unit: 'percent', value: 22 },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
        ),
        expect: rejected('ASSET_OFFLINE'),
        beat: 'ADVERSARIAL: ghost telemetry from the offline UAV claiming progress and comms — rejected fail-closed.',
        economicEffect:
          'No false progress evidence can enter the timeline while the asset is offline.',
      }),
      b.submission({
        source: uavSrc,
        assetId: uav,
        sequence: 3,
        observedMin: 29,
        emitDelaySec: 3,
        observations: obs(
          { kind: 'battery_soc', unit: 'percent', value: 33 },
          { kind: 'asset_position_status', unit: 'state', value: 'returning' },
          { kind: 'asset_comms', unit: 'state', value: 'degraded' },
        ),
        expect: rejected('DUPLICATE_EVENT'),
        beat: 'ADVERSARIAL: exact re-transmission of the already-accepted sequence-3 event (same eventId) — idempotent rejection.',
        economicEffect: 'Duplicate suppression: a replayed event cannot double-count evidence.',
      }),
      b.submission({
        source: { ...vesselSrc, sourceId: 'rogue-recovery', keyId: 'key_rogue_v1' },
        assetId: uav,
        sequence: 1,
        observedMin: 44,
        observations: obs({ kind: 'asset_comms', unit: 'state', value: 'online' }),
        expect: rejected('UNAUTHENTICATED_SOURCE'),
        beat: 'ADVERSARIAL: an UNREGISTERED source tries to declare the asset back online — no magic recovery.',
      }),
      b.submission({
        source: vesselSrc,
        assetId: uav,
        sequence: 2,
        observedMin: 52,
        observations: obs(
          { kind: 'asset_comms', unit: 'state', value: 'online' },
          { kind: 'asset_position_status', unit: 'state', value: 'docked' },
          { kind: 'battery_soc', unit: 'percent', value: 12 },
        ),
        expect: accepted,
        beat: 'Authorized recovery: vessel gateway reports the UAV recovered on deck, link restored.',
        economicEffect:
          'Asset is physically accounted for (docked, 12% battery) — but recovery is PHYSICAL ONLY; nothing financial happened or was implied.',
      }),
      b.submission({
        source: vesselSrc,
        assetId: vessel,
        sequence: 1,
        observedMin: 64,
        observations: obs(
          { kind: 'asset_comms', unit: 'state', value: 'online' },
          { kind: 'asset_position_status', unit: 'state', value: 'on_station' },
          { kind: 'inspection_progress', unit: 'percent', value: 53 },
          { kind: 'wind_speed', unit: 'kt', value: '26.1' },
          { kind: 'weather_hold', unit: 'state', value: 'active' },
        ),
        expect: accepted,
        beat: 'Vessel-based close inspection underway under hold.',
        economicEffect:
          'MEANINGFUL CHANGE #2: the costlier vessel alternative is the only live path; planner has effectively switched plans.',
      }),
      b.submission({
        source: vesselSrc,
        assetId: vessel,
        sequence: 2,
        observedMin: 78,
        observations: obs({ kind: 'defect_severity', unit: 'category', value: 'major' }),
        expect: accepted,
        beat: 'Vessel inspection finds MAJOR hull corrosion (section 7).',
        economicEffect:
          'MEANINGFUL CHANGE #3: a follow-up diagnostic/repair spend decision becomes relevant for the planner — evidence-linked, never auto-executed.',
      }),
      b.submission({
        source: opsSrc,
        assetId: vessel,
        sequence: 1,
        observedMin: 92,
        observations: obs(
          { kind: 'visibility', unit: 'category', value: 'poor' },
          { kind: 'weather_hold', unit: 'state', value: 'active' },
          { kind: 'inspection_progress', unit: 'percent', value: 62 },
        ),
        expect: accepted,
        beat: 'Visibility drops; hold persists; mission extends.',
      }),
      b.submission({
        source: vesselSrc,
        assetId: vessel,
        sequence: 4,
        observedMin: 97,
        observations: obs({ kind: 'inspection_progress', unit: 'percent', value: 64 }),
        expect: rejected('SEQUENCE_GAP'),
        beat: 'ADVERSARIAL: submission skips vessel sequence 3 (lost update) — gap detected, fail closed.',
      }),
      b.submission({
        source: vesselSrc,
        assetId: vessel,
        sequence: 3,
        observedMin: 98,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 66 },
          { kind: 'weather_hold', unit: 'state', value: 'active' },
        ),
        expect: accepted,
        beat: 'The lost sequence is delivered; stream repaired.',
      }),
      b.submission({
        source: opsSrc,
        assetId: vessel,
        sequence: 2,
        observedMin: 105,
        observations: obs({ kind: 'inspection_progress', unit: 'percent', value: 55 }),
        expect: rejected('MONOTONIC_VIOLATION'),
        beat: 'ADVERSARIAL: contradictory status — progress reported BELOW the accepted 66 — rejected.',
      }),
      b.submission({
        source: opsSrc,
        assetId: vessel,
        sequence: 2,
        observedMin: 106,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 68 },
          { kind: 'visibility', unit: 'category', value: 'poor' },
          { kind: 'weather_hold', unit: 'state', value: 'active' },
        ),
        expect: accepted,
        beat: 'Final state: mission continues under weather hold; UAV recovered and docked; one major defect on record.',
        economicEffect:
          'End state for the planner: aerial blocked, vessel path mid-progress, defect open — any further spend is a NEW decision requiring its own authority.',
      }),
    ];

    return {
      id: offshoreScenario.id,
      seed,
      title: offshoreScenario.title,
      world,
      sources,
      assets: [uav, vessel],
      script,
      provenanceStatement:
        'SIMULATED_OPERATION: every observation, source and asset in this trace is SYNTHETIC. ' +
        'An HMAC-authenticated synthetic source is NOT a verified physical measurement, and nothing ' +
        'in this trace approves, reserves, settles or dispatches money.',
    };
  },
};
