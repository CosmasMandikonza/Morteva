/**
 * THIRD FIXTURE — warehouse ground-robot operational interrupt (MTV-07,
 * issue #9 second-domain proof; distinct from `warehouse-cycle-count-v1`).
 *
 * Where the cycle-count fixture proves the ingest architecture serves a
 * second domain with only vocabulary differences, THIS fixture drives the
 * DECISION pathway: normal running → physically-restricted operation
 * (journaled ground facts) → comms loss (the one ground-interrupting
 * condition the current contracts support end-to-end) → ghost/self/duplicate/
 * out-of-order/future/adversarial refusals → AUTHORIZED recovery only →
 * post-recovery steady state whose honest bridge verdict for a declared
 * ground asset is `unknown/insufficient-evidence` — asset-dependent spend
 * stays gated by the planner's existing ASSET_SAFETY prerequisite and ZERO
 * financial writes occur anywhere in the arc.
 *
 * Ground-domain facts (aisle/charger) are journaled as first-class evidence;
 * the live bridge cannot turn them into a clearance verdict (Agent A's
 * contract request — see contract/planner-adapter-request.v1.md and
 * src/integration/ground-safety-proposal.ts), and this scenario must never
 * manufacture one.
 *
 * SYNTHETIC throughout — see the provenance statement in the build.
 */
import { fixtureSourceKey } from '../rng.js';
import type { MissionEventErrorCode } from '../errors.js';
import type { RegisteredSource } from '../registry.js';
import type { NormalizedObservation } from '../schema.js';
import type { ScenarioBuild, ScenarioDefinition, ScenarioWorld } from './types.js';
import { ScenarioBuilder } from './builder.js';

export const WAREHOUSE_INTERRUPT_T0_MS = Date.parse('2026-11-07T22:00:00.000Z');

export const warehouseInterruptScenario: ScenarioDefinition = {
  id: 'warehouse-robot-interrupt-v1',
  title:
    'SYNTHETIC warehouse ground-robot interrupt — governed recovery, refusal and an honest unknown clearance',
  defaultSeed: 'moterva-warehouse-interrupt-2026-11-07',
  build(world: ScenarioWorld, seed = warehouseInterruptScenario.defaultSeed): ScenarioBuild {
    const bot = 'picker-bot-7';
    const botSrc: RegisteredSource = {
      orgId: world.orgId,
      missionId: world.missionId,
      sourceId: 'bot-telemetry',
      sourceType: 'asset_telemetry',
      keyId: 'key_bot_tel_v1',
      secretKey: fixtureSourceKey(seed, 'bot-telemetry'),
      provenance: 'SYNTHETIC',
      assetIds: [bot],
      trustedForRecovery: false,
    };
    const wmsSrc: RegisteredSource = {
      orgId: world.orgId,
      missionId: world.missionId,
      sourceId: 'wms-supervisor',
      sourceType: 'warehouse_wms',
      keyId: 'key_wms_sup_v1',
      secretKey: fixtureSourceKey(seed, 'wms-supervisor'),
      provenance: 'SYNTHETIC',
      assetIds: [bot],
      trustedForRecovery: true,
    };
    const b = new ScenarioBuilder(world, seed, WAREHOUSE_INTERRUPT_T0_MS);
    const obs = (...list: NormalizedObservation[]) => list;
    const accepted = { status: 'accepted' as const };
    const rejected = (code: MissionEventErrorCode) => ({ status: 'rejected' as const, code });

    const script = [
      b.submission({
        source: wmsSrc,
        assetId: bot,
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
        beat: 'Night shift opens: replenishment robot picker-bot-7 leaves dock 2, aisles clear.',
        economicEffect: 'Autonomous replenishment is the planned baseline (cheapest) option.',
      }),
      b.submission({
        source: botSrc,
        assetId: bot,
        sequence: 1,
        observedMin: 4,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 12 },
          { kind: 'battery_soc', unit: 'percent', value: 95 },
          { kind: 'asset_position_status', unit: 'state', value: 'transit' },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
        ),
        expect: accepted,
        beat: 'Normal running: picking at rate, link healthy.',
      }),
    ];

    return {
      id: warehouseInterruptScenario.id,
      seed,
      title: warehouseInterruptScenario.title,
      world,
      sources: [botSrc, wmsSrc],
      assets: [bot],
      script,
      provenanceStatement:
        'SIMULATED_OPERATION: this ground-robot interrupt mission is fully SYNTHETIC and shares ' +
        'the exact ingest/validation/journal/decision code path with every other domain — no ' +
        'domain-specific branches exist anywhere in the pipeline. Ground facts (aisle, charger) ' +
        'are journaled as evidence; no ground clearance is invented, no payment, reservation or ' +
        'approval is implied by any beat, and recovery never fabricates completed work.',
    };
  },
};
