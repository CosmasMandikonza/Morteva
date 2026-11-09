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
      b.submission({
        source: botSrc,
        assetId: bot,
        sequence: 2,
        observedMin: 10,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 24 },
          { kind: 'battery_soc', unit: 'percent', value: 84 },
        ),
        expect: accepted,
        beat: 'Normal running continues.',
      }),
      b.submission({
        source: botSrc,
        assetId: bot,
        sequence: 3,
        observedMin: 16,
        observations: obs(
          { kind: 'aisle_access', unit: 'state', value: 'obstructed' },
          { kind: 'asset_position_status', unit: 'state', value: 'transit' },
          { kind: 'battery_soc', unit: 'percent', value: 77 },
        ),
        expect: accepted,
        beat: 'INTERRUPTION (physical): spilled coolant obstructs aisle C3; robot halts transit.',
        economicEffect:
          'MEANINGFUL CHANGE #1: the ground fact is journaled; the current contracts cannot clear ' +
          'or price a ground obstruction — the honest bridge verdict for this asset stays unknown ' +
          '(Agent A contract request), and no spend is implied.',
      }),
      b.submission({
        source: botSrc,
        assetId: bot,
        sequence: 4,
        observedMin: 20,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 27 },
          { kind: 'battery_soc', unit: 'percent', value: 68 },
          { kind: 'asset_comms', unit: 'state', value: 'degraded' },
        ),
        expect: accepted,
        beat: 'Link degrades while the robot shelters behind racking.',
      }),
      b.submission({
        source: wmsSrc,
        assetId: bot,
        sequence: 2,
        observedMin: 24,
        observations: obs({ kind: 'asset_comms', unit: 'state', value: 'offline' }),
        expect: accepted,
        beat: 'INTERRUPTION (comms): WMS loses the heartbeat — the one ground-interrupting ' +
          'condition the current contracts support end-to-end.',
        economicEffect:
          'MEANINGFUL CHANGE #2: bridge verdict for this ground asset becomes blocked/' +
          'comms-offline — the planner must refuse any candidate that requires the robot.',
      }),
      b.submission({
        source: botSrc,
        assetId: bot,
        sequence: 5,
        observedMin: 28,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 30 },
          { kind: 'battery_soc', unit: 'percent', value: 62 },
        ),
        expect: rejected('ASSET_OFFLINE'),
        beat: 'ADVERSARIAL: ghost telemetry from the offline robot — refused fail-closed.',
      }),
      b.submission({
        source: botSrc,
        assetId: bot,
        sequence: 6,
        observedMin: 30,
        observations: obs({ kind: 'asset_comms', unit: 'state', value: 'online' }),
        expect: rejected('ASSET_OFFLINE'),
        beat:
          'ADVERSARIAL: SELF-RECOVERY — the offline robot claims its own comms are back. ' +
          'bot-telemetry is not trustedForRecovery; an offline asset cannot speak itself healthy.',
      }),
      b.submission({
        source: botSrc,
        assetId: bot,
        sequence: 5,
        observedMin: 28,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 30 },
          { kind: 'battery_soc', unit: 'percent', value: 62 },
        ),
        expect: rejected('DUPLICATE_EVENT'),
        beat:
          'ADVERSARIAL: exact link-layer replay of beat 7 (same eventId) — idempotent refusal; ' +
          'a duplicated telemetry event can never double-count, let alone duplicate a proposal.',
      }),
      b.submission({
        source: wmsSrc,
        assetId: bot,
        sequence: 4,
        observedMin: 32,
        observations: obs({ kind: 'asset_comms', unit: 'state', value: 'online' }),
        expect: rejected('SEQUENCE_GAP'),
        beat: 'ADVERSARIAL: WMS jumps to sequence 4 while 3 is missing — lost updates fail closed.',
      }),
      b.submission({
        source: wmsSrc,
        assetId: bot,
        sequence: 3,
        observedMin: 34,
        observations: obs(
          { kind: 'asset_comms', unit: 'state', value: 'online' },
          { kind: 'asset_position_status', unit: 'state', value: 'docked' },
        ),
        expect: accepted,
        beat:
          'AUTHORIZED RECOVERY: the WMS (trustedForRecovery supervisor) confirms the crew ' +
          'reseated the radio — the ONLY path that may reopen an offline asset.',
        economicEffect:
          'MEANINGFUL CHANGE #3: comms restored. Recovery is a physical fact only — it does NOT ' +
          'verify any payment, release any commitment or fabricate completed work.',
      }),
      b.submission({
        source: wmsSrc,
        assetId: bot,
        sequence: 4,
        observedMin: 36,
        observations: obs({ kind: 'asset_comms', unit: 'state', value: 'online' }),
        expect: accepted,
        beat: 'The previously lost update now arrives in order — the stream repairs itself.',
      }),
      b.submission({
        source: wmsSrc,
        assetId: 'release-recovery-payment',
        sequence: 5,
        observedMin: 38,
        observations: obs({ kind: 'asset_comms', unit: 'state', value: 'online' }),
        expect: rejected('AUTHORITY_TERMS_REJECTED'),
        beat:
          'ADVERSARIAL: banking vocabulary riding in an event id — the physical channel refuses ' +
          'it outright (unauthorized physical input can never change financial authority).',
      }),
      b.submission({
        source: wmsSrc,
        assetId: bot,
        sequence: 5,
        observedMin: 51,
        observations: obs({ kind: 'asset_comms', unit: 'state', value: 'online' }),
        expect: rejected('FUTURE_EVENT'),
        beat:
          'ADVERSARIAL: gateway clock 10 minutes fast — a future-dated observation beyond the ' +
          '2-minute skew tolerance is refused (skewed clock cannot forge current evidence).',
      }),
      b.submission({
        source: wmsSrc,
        assetId: bot,
        sequence: 5,
        observedMin: 49,
        observations: obs(
          { kind: 'asset_comms', unit: 'state', value: 'online' },
          { kind: 'inspection_progress', unit: 'percent', value: 31 },
        ),
        expect: accepted,
        beat:
          'Bounded skew: the same source within the 2-minute tolerance is admitted ' +
          '(observed 49 min, clock anchored at its ingest time).',
      }),
      b.submission({
        source: botSrc,
        assetId: bot,
        sequence: 7,
        observedMin: 21,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 28 },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
        ),
        expect: rejected('STALE_EVENT'),
        beat:
          'ADVERSARIAL: an old pre-offline observation delivered AFTER the recovery — late ' +
          'telemetry cannot masquerade as current evidence or rewrite the recovered state.',
      }),
      b.submission({
        source: wmsSrc,
        assetId: bot,
        sequence: 6,
        observedMin: 53,
        observations: obs(
          { kind: 'aisle_access', unit: 'state', value: 'clear' },
          { kind: 'charger_status', unit: 'state', value: 'free' },
        ),
        expect: accepted,
        beat: 'Crew clears aisle C3 and frees the dock — recovery work confirmed by the supervisor.',
      }),
      b.submission({
        source: botSrc,
        assetId: bot,
        sequence: 8,
        observedMin: 54,
        observations: obs(
          { kind: 'inspection_progress', unit: 'percent', value: 33 },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
          { kind: 'battery_soc', unit: 'percent', value: 64 },
        ),
        expect: accepted,
        beat: 'Robot resumes; both sources now report — newest authoritative reading wins.',
      }),
      b.submission({
        source: wmsSrc,
        assetId: bot,
        sequence: 7,
        observedMin: 55,
        observations: obs(
          { kind: 'asset_comms', unit: 'state', value: 'online' },
          { kind: 'asset_position_status', unit: 'state', value: 'transit' },
          { kind: 'aisle_access', unit: 'state', value: 'clear' },
          { kind: 'charger_status', unit: 'state', value: 'docked_charging' },
          { kind: 'inspection_progress', unit: 'percent', value: 45 },
          { kind: 'battery_soc', unit: 'percent', value: 71 },
        ),
        expect: accepted,
        beat: 'POST-RECOVERY STEADY STATE: all ground facts healthy, 45% complete.',
        economicEffect:
          'End state for the planner: comms online + healthy ground facts journaled — but the ' +
          'bridge CANNOT emit ground clearance (no supported rule; Agent A contract request), so ' +
          'the verdict stays unknown/insufficient-evidence. Any robot-gated spend remains refused ' +
          'by the existing ASSET_SAFETY gate; a human decides, and nothing is paid here.',
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
