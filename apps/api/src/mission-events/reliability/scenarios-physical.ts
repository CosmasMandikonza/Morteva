/**
 * Physical-evidence reliability scenarios (family P).
 *
 * Every case injects a concrete fault or operational change into the REAL
 * ingestion/journal stack and asserts the admission result, replay behavior
 * and planner-facing consequences. All sources/assets are SYNTHETIC
 * (SIMULATED_OPERATION); evidence-only cases must produce ZERO financial
 * side effects.
 */
import type { PlanChain, ScenarioCase } from './types.js';
import { HARNESS_T0 } from './harness.js';

const ONLINE = { kind: 'asset_comms', unit: 'state', value: 'online' } as const;
const OFFLINE = { kind: 'asset_comms', unit: 'state', value: 'offline' } as const;
const CLEAR_WIND = [
  { kind: 'wind_speed', unit: 'kt', value: '14.2' },
  { kind: 'weather_hold', unit: 'state', value: 'clear' },
  { kind: 'asset_comms', unit: 'state', value: 'online' },
] as const;
const GALE = [
  { kind: 'wind_speed', unit: 'kt', value: '24.6' },
  { kind: 'weather_hold', unit: 'state', value: 'active' },
] as const;

/** Minutes after the harness T0. */
function m(minute: number): string {
  return new Date(Date.parse(HARNESS_T0) + minute * 60_000).toISOString();
}

export const physicalScenarios: readonly ScenarioCase[] = [
  {
    id: 'PE-01',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-01-duplicate',
    summary: 'The same signed event is submitted twice (link-layer replay).',
    fault: 'exact duplicate submission',
    run(h) {
      const service = h.freshService();
      const first = h.env({
        sequence: 1,
        observedAt: m(1),
        ingestedAt: m(1),
        observations: CLEAR_WIND,
      });
      h.check('first submission', 'accepted', h.submit(service, first).status);
      h.check('replay submission', 'rejected/DUPLICATE_EVENT', codeOf(h.submit(service, first)));
      h.check('journal rows', '1', h.sideEffects().operationalEvidence);
      return { sideEffects: h.sideEffects(), explanation: 'idempotent replay suppression' };
    },
  },
  {
    id: 'PE-02',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-02-regression',
    summary: 'A new event id reuses an already-consumed stream sequence.',
    fault: 'sequence regression',
    run(h) {
      const service = h.freshService();
      h.submit(service, h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1) }));
      h.submit(service, h.env({ sequence: 2, observedAt: m(2), ingestedAt: m(2) }));
      h.check(
        'sequence reuse',
        'rejected/SEQUENCE_REGRESSION',
        codeOf(h.submit(service, h.env({ sequence: 2, observedAt: m(3), ingestedAt: m(3) }))),
      );
      return { sideEffects: h.sideEffects(), explanation: 'regression refused' };
    },
  },
  {
    id: 'PE-03',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-03-gap',
    summary: 'A lost update (sequence 3 after 1) then repair by delivering sequence 2.',
    fault: 'sequence gap (lost update), then repair',
    run(h) {
      const service = h.freshService();
      h.submit(service, h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1) }));
      h.check(
        'gap detected',
        'rejected/SEQUENCE_GAP',
        codeOf(h.submit(service, h.env({ sequence: 3, observedAt: m(2), ingestedAt: m(2) }))),
      );
      h.check(
        'repair accepted',
        'accepted',
        h.submit(service, h.env({ sequence: 2, observedAt: m(3), ingestedAt: m(3) })).status,
      );
      h.check(
        'then 3 accepted',
        'accepted',
        h.submit(service, h.env({ sequence: 3, observedAt: m(4), ingestedAt: m(4) })).status,
      );
      return {
        sideEffects: h.sideEffects(),
        explanation: 'fail-closed until the lost event arrives',
      };
    },
  },
  {
    id: 'PE-04',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-04-first-seq',
    summary: 'A brand-new stream opens at sequence 7 instead of 1.',
    fault: 'first-ever sequence > 1',
    run(h) {
      const service = h.freshService();
      h.check(
        'new stream must start at 1',
        'rejected/SEQUENCE_GAP',
        codeOf(h.submit(service, h.env({ sequence: 7, observedAt: m(1), ingestedAt: m(1) }))),
      );
      h.check(
        'seq 1 then accepted',
        'accepted',
        h.submit(service, h.env({ sequence: 1, observedAt: m(2), ingestedAt: m(2) })).status,
      );
      return { sideEffects: h.sideEffects(), explanation: 'no silent mid-stream start' };
    },
  },
  {
    id: 'PE-05',
    family: 'physical-evidence',
    domain: 'cross-domain',
    seed: 'PE-05-org-collision',
    summary: 'Two organizations reuse identical mission, asset and source id strings.',
    fault: 'cross-org id collision',
    run(h) {
      const service = h.freshService();
      h.check(
        'org A seq1',
        'accepted',
        h.submit(service, h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1) })).status,
      );
      const mirror = h.submit(
        service,
        h.env({
          source: h.world.mirrorOrg.source,
          orgId: h.world.mirrorOrg.orgId,
          missionId: h.world.mirrorOrg.missionId,
          sequence: 1,
          observedAt: m(2),
          ingestedAt: m(2),
        }),
      );
      h.check('org B same ids seq1 accepted', 'accepted', mirror.status);
      h.check(
        'org A still expects seq2',
        'accepted',
        h.submit(service, h.env({ sequence: 2, observedAt: m(3), ingestedAt: m(3) })).status,
      );
      return { sideEffects: h.sideEffects(), explanation: 'composite org-scoped keys; no leak' };
    },
  },
  {
    id: 'PE-06',
    family: 'physical-evidence',
    domain: 'cross-domain',
    seed: 'PE-06-mission-collision',
    summary: 'Same org, two missions reusing one asset id; mission A declares it offline.',
    fault: 'cross-mission offline bleed attempt',
    run(h) {
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: [ONLINE] }),
      );
      h.submit(
        service,
        h.env({
          source: h.world.gatewaySource,
          sequence: 1,
          observedAt: m(2),
          ingestedAt: m(2),
          observations: [OFFLINE],
        }),
      );
      h.check(
        'mission A telemetry blocked',
        'rejected/ASSET_OFFLINE',
        codeOf(h.submit(service, h.env({ sequence: 2, observedAt: m(3), ingestedAt: m(3) }))),
      );
      const b = h.submit(
        service,
        h.env({
          source: h.world.secondMission.source,
          missionId: h.world.secondMission.missionId,
          sequence: 1,
          observedAt: m(4),
          ingestedAt: m(4),
          observations: [ONLINE],
        }),
      );
      h.check('mission B same asset online accepted', 'accepted', b.status);
      return { sideEffects: h.sideEffects(), explanation: 'offline state is mission-scoped' };
    },
  },
  {
    id: 'PE-07',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-07-conflicting-state',
    summary:
      'Two authorized sources report conflicting comms state in sequence; the newest authoritative reading wins deterministically.',
    fault: 'conflicting asset state across sources',
    run(h) {
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: [ONLINE] }),
      );
      h.submit(
        service,
        h.env({
          source: h.world.gatewaySource,
          sequence: 1,
          observedAt: m(2),
          ingestedAt: m(2),
          observations: [OFFLINE],
        }),
      );
      const view = service.replay(h.world.orgId, h.world.missionId);
      h.check('latest comms reading', 'offline', view.assets['asset-uav-1']?.comms);
      h.check(
        'deterministic source of truth',
        'src-gateway',
        view.assets['asset-uav-1']?.latest['asset_comms']?.eventId === undefined
          ? 'none'
          : latestCommsSource(view.events),
      );
      return {
        sideEffects: h.sideEffects(),
        explanation: 'journal order decides; no silent side-picking',
      };
    },
  },
  {
    id: 'PE-08',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-08-offline-race',
    summary:
      'ACCEPTED cross-source race regression: telemetry validated before the gateway offline commit arrives after it.',
    fault: 'stale-memory offline race',
    run(h) {
      const telemetry = h.freshService();
      telemetry.ingest(
        h.world.orgId,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: [ONLINE] }),
      );
      const gateway = h.freshService();
      gateway.ingest(
        h.world.orgId,
        h.env({
          source: h.world.gatewaySource,
          sequence: 1,
          observedAt: m(2),
          ingestedAt: m(2),
          observations: [OFFLINE],
        }),
      );
      h.check(
        'telemetry after offline commit',
        'rejected/ASSET_OFFLINE',
        codeOf(
          h.submit(
            telemetry,
            h.env({
              sequence: 2,
              observedAt: m(3),
              ingestedAt: m(3),
              observations: [{ kind: 'inspection_progress', unit: 'percent', value: 20 }],
            }),
          ),
        ),
      );
      h.check(
        'still rejected on retry',
        'rejected/ASSET_OFFLINE',
        codeOf(h.submit(telemetry, h.env({ sequence: 2, observedAt: m(4), ingestedAt: m(4) }))),
      );
      return {
        sideEffects: h.sideEffects(),
        explanation: 'accepted cross-source admission-boundary fix preserved',
      };
    },
  },
  {
    id: 'PE-09',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-09-monotonic-race',
    summary:
      'ACCEPTED cross-source race regression: progress decrease vs a concurrently committed higher reading.',
    fault: 'cross-source monotonic regression race',
    run(h) {
      const telemetry = h.freshService();
      telemetry.ingest(
        h.world.orgId,
        h.env({
          sequence: 1,
          observedAt: m(1),
          ingestedAt: m(1),
          observations: [{ kind: 'inspection_progress', unit: 'percent', value: 53 }],
        }),
      );
      const gateway = h.freshService();
      gateway.ingest(
        h.world.orgId,
        h.env({
          source: h.world.gatewaySource,
          sequence: 1,
          observedAt: m(2),
          ingestedAt: m(2),
          observations: [{ kind: 'inspection_progress', unit: 'percent', value: 66 }],
        }),
      );
      h.check(
        'decrease vs journaled 66',
        'rejected/MONOTONIC_VIOLATION',
        codeOf(
          h.submit(
            telemetry,
            h.env({
              sequence: 2,
              observedAt: m(3),
              ingestedAt: m(3),
              observations: [{ kind: 'inspection_progress', unit: 'percent', value: 55 }],
            }),
          ),
        ),
      );
      h.check(
        'equal accepted',
        'accepted',
        h.submit(
          telemetry,
          h.env({
            sequence: 2,
            observedAt: m(4),
            ingestedAt: m(4),
            observations: [{ kind: 'inspection_progress', unit: 'percent', value: 66 }],
          }),
        ).status,
      );
      return {
        sideEffects: h.sideEffects(),
        explanation: 'accepted cross-source monotonic fix preserved',
      };
    },
  },
  {
    id: 'PE-10',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-10-unauthorized-recovery',
    summary:
      'Recovery attempts without trusted authority: self-recovery and a gateway event without the comms observation.',
    fault: 'unauthorized recovery attempts',
    run(h) {
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: [ONLINE] }),
      );
      h.submit(
        service,
        h.env({
          source: h.world.gatewaySource,
          sequence: 1,
          observedAt: m(2),
          ingestedAt: m(2),
          observations: [OFFLINE],
        }),
      );
      h.check(
        'self-recovery refused',
        'rejected/ASSET_OFFLINE',
        codeOf(
          h.submit(
            service,
            h.env({ sequence: 2, observedAt: m(3), ingestedAt: m(3), observations: [ONLINE] }),
          ),
        ),
      );
      h.check(
        'recovery without comms obs refused',
        'rejected/ASSET_OFFLINE',
        codeOf(
          h.submit(
            service,
            h.env({
              source: h.world.gatewaySource,
              sequence: 2,
              observedAt: m(4),
              ingestedAt: m(4),
              observations: [{ kind: 'inspection_progress', unit: 'percent', value: 30 }],
            }),
          ),
        ),
      );
      const rogue = h.submit(
        service,
        h.env({
          source: { ...h.world.gatewaySource, sourceId: 'rogue-recovery', keyId: 'key-rogue-v1' },
          sequence: 3,
          observedAt: m(5),
          ingestedAt: m(5),
          observations: [ONLINE],
        }),
      );
      h.check(
        'unregistered recovery source refused',
        'rejected/UNAUTHENTICATED_SOURCE',
        codeOf(rogue),
      );
      return { sideEffects: h.sideEffects(), explanation: 'no magic recovery' };
    },
  },
  {
    id: 'PE-11',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-11-trusted-recovery',
    summary:
      'Trusted recovery with proper provenance reopens the asset; the planner sees clear again after fresh readings.',
    fault: 'authorized recovery after offline',
    run(h) {
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: CLEAR_WIND }),
      );
      h.submit(
        service,
        h.env({
          source: h.world.gatewaySource,
          sequence: 1,
          observedAt: m(2),
          ingestedAt: m(2),
          observations: [OFFLINE],
        }),
      );
      h.check(
        'authorized recovery accepted',
        'accepted',
        h.submit(
          service,
          h.env({
            source: h.world.gatewaySource,
            sequence: 2,
            observedAt: m(30),
            ingestedAt: m(30),
            observations: [ONLINE],
          }),
        ).status,
      );
      const chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbentAssetId: 'asset-uav-1',
      });
      const states = chain.bridge.evidence.map((e) => (e.constraint as { state: string }).state);
      h.check('bridge sees recovery evidence', true, chain.bridge.evidence.length >= 1);
      h.check(
        'latest bridge state after recovery',
        true,
        states.includes('unknown') || states.includes('clear'),
      );
      return {
        sideEffects: h.sideEffects(),
        planner: plannerObservation(
          chain,
          'recovery visible; wind reading aged out so clearance is unknown — fail-closed, not fabricated',
        ),
        explanation:
          'recovery is physical only; planner still refuses without fresh full clearance',
      };
    },
  },
  {
    id: 'PE-12',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-12-delayed-telemetry',
    summary: 'Telemetry observed 20 minutes ago arrives late.',
    fault: 'delayed delivery',
    run(h) {
      const service = h.freshService();
      h.clock.advanceMs(20 * 60_000);
      h.check(
        'stale at arrival refused',
        'rejected/STALE_EVENT',
        codeOf(h.submit(service, h.env({ sequence: 1, observedAt: m(0), ingestedAt: m(20) }))),
      );
      h.check(
        'fresh accepted',
        'accepted',
        h.submit(service, h.env({ sequence: 1, observedAt: m(6), ingestedAt: m(20) })).status,
      );
      return {
        sideEffects: h.sideEffects(),
        explanation: 'delayed evidence cannot masquerade as current',
      };
    },
  },
  {
    id: 'PE-13',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-13-mixed-history',
    summary:
      'Mixed historical timestamps: old journaled events age to expired while a fresh event stays planning-valid.',
    fault: 'ageing timeline',
    run(h) {
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: GALE }),
      );
      h.clock.advanceMs(31 * 60_000);
      h.submit(
        service,
        h.env({
          sequence: 2,
          observedAt: m(32),
          ingestedAt: m(32),
          observations: [{ kind: 'wind_speed', unit: 'kt', value: '10.0' }],
        }),
      );
      const view = service.replay(h.world.orgId, h.world.missionId);
      h.check('old event expired', 'expired', view.events[0]?.freshness);
      h.check('old not planning-valid', false, view.events[0]?.planningValid);
      h.check('fresh event planning-valid', true, view.events[1]?.planningValid);
      h.check('history preserved', 2, view.events.length);
      return {
        sideEffects: h.sideEffects(),
        explanation: 'journal truth vs planning eligibility separated',
      };
    },
  },
  {
    id: 'PE-14',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-14-freshness-boundary',
    summary:
      'Exactly-on-boundary freshness: age == maxAgeMs is stale and withheld from planning; maxAge-1ms is fresh.',
    fault: 'freshness threshold boundary',
    run(h) {
      const service = h.freshService();
      const fresh = h.env({
        sequence: 1,
        observedAt: m(1),
        ingestedAt: m(1),
        observations: CLEAR_WIND,
      });
      h.submit(service, fresh);
      h.clock.advanceMs(15 * 60_000 - 1);
      let chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbentAssetId: 'asset-uav-1',
      });
      h.check('1ms before boundary: evidence used', 1, chain.bridge.evidence.length);
      h.clock.advanceMs(1);
      chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbentAssetId: 'asset-uav-1',
      });
      h.check('on boundary: evidence withheld', 0, chain.bridge.evidence.length);
      h.check('on boundary: withheld id recorded', 1, chain.bridge.withheldEventIds.length);
      return {
        sideEffects: h.sideEffects(),
        planner: plannerObservation(
          chain,
          'exactly at maxAgeMs the event is withheld — stale never authorizes planning',
        ),
        explanation: 'one-millisecond precision at the freshness boundary',
      };
    },
  },
  {
    id: 'PE-15',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-15-future-skew',
    summary: 'Future-dated readings: within the 2-minute tolerance accepted, beyond it refused.',
    fault: 'clock skew',
    run(h) {
      const service = h.freshService();
      // Build the envelope first (its anchor moves the clock), then roll the
      // clock BACK so the observation is genuinely ahead of "now".
      const withinTolerance = h.env({ sequence: 1, observedAt: m(1.5), ingestedAt: m(1.5) });
      h.clock.setTo(m(0.5)); // observation is 60s ahead — inside the 120s tolerance
      h.check('60s ahead accepted', 'accepted', h.submit(service, withinTolerance).status);
      const beyondTolerance = h.env({ sequence: 2, observedAt: m(15), ingestedAt: m(15) });
      h.clock.setTo(m(5)); // observation is 10 minutes ahead
      h.check(
        '10 minutes ahead refused',
        'rejected/FUTURE_EVENT',
        codeOf(h.submit(service, beyondTolerance)),
      );
      return { sideEffects: h.sideEffects(), explanation: 'bounded skew tolerance' };
    },
  },
  {
    id: 'PE-16',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-16-malformed-time',
    summary: 'Malformed timestamps are rejected at the envelope boundary.',
    fault: 'malformed timestamps',
    run(h) {
      const service = h.freshService();
      const bad = h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1) });
      (bad as { observedAt: string }).observedAt = 'not-a-timestamp';
      h.check(
        'garbage observedAt refused',
        'rejected/INVALID_ENVELOPE',
        codeOf(h.submit(service, bad)),
      );
      return { sideEffects: h.sideEffects(), explanation: 'schema-strict timestamps' };
    },
  },
  {
    id: 'PE-17',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-17-journal-corruption',
    summary:
      'A stored journal payload is corrupted; replay and fresh-instance ingestion fail closed.',
    fault: 'stored digest corruption',
    run(h) {
      const service = h.freshService();
      h.submit(service, h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1) }));
      h.world.ledger.db.prepare('DROP TRIGGER evidence_events_no_update').run();
      h.world.ledger.db
        .prepare(
          `UPDATE evidence_events SET payload_json = '{broken' WHERE type = 'mission.event.ingested'`,
        )
        .run();
      let replayFailed = false;
      try {
        service.replay(h.world.orgId, h.world.missionId);
      } catch {
        replayFailed = true;
      }
      h.check('replay fails closed', true, replayFailed);
      const fresh = h.freshService();
      h.check(
        'fresh ingestion fails closed',
        'rejected/JOURNAL_TAMPERED',
        codeOf(h.submit(fresh, h.env({ sequence: 2, observedAt: m(2), ingestedAt: m(2) }))),
      );
      return {
        sideEffects: h.sideEffects(),
        explanation: 'corruption never silently resets state',
      };
    },
  },
  {
    id: 'PE-18',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-18-bad-signature',
    summary: 'A tampered payload with a stale HMAC signature is refused; no journal row appears.',
    fault: 'invalid signature',
    run(h) {
      const service = h.freshService();
      const before = h.sideEffects().operationalEvidence;
      h.check(
        'forged signature refused',
        'rejected/SIGNATURE_INVALID',
        codeOf(
          h.submit(
            service,
            h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), signature: 'f'.repeat(64) }),
          ),
        ),
      );
      h.check('no journal row', before, h.sideEffects().operationalEvidence);
      return {
        sideEffects: h.sideEffects(),
        explanation: 'HMAC covers the exact canonical payload',
      };
    },
  },
  {
    id: 'PE-19',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-19-empty-contradictory',
    summary:
      'Missing observations (empty array) and contradictory readings in one event are refused.',
    fault: 'missing/contradictory observations',
    run(h) {
      const service = h.freshService();
      const empty = h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: [] });
      h.check(
        'empty observations refused',
        'rejected/INVALID_ENVELOPE',
        codeOf(h.submit(service, empty)),
      );
      const contradictory = h.env({
        sequence: 1,
        observedAt: m(2),
        ingestedAt: m(2),
        observations: [
          { kind: 'wind_speed', unit: 'kt', value: '12.0' },
          { kind: 'wind_speed', unit: 'kt', value: '25.0' },
        ],
      });
      h.check(
        'duplicate kind refused',
        'rejected/CONFLICTING_OBSERVATIONS',
        codeOf(h.submit(service, contradictory)),
      );
      return {
        sideEffects: h.sideEffects(),
        explanation: 'at least one typed observation; one value per kind',
      };
    },
  },
  {
    id: 'PE-20',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-20-instance-race',
    summary:
      'Two live instances: a stale-memory instance tries to admit an already-committed sequence.',
    fault: 'multi-instance same-sequence race',
    run(h) {
      const writer = h.freshService();
      writer.ingest(h.world.orgId, h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1) }));
      const racer = h.freshService();
      racer.rehydrate(h.world.orgId, h.world.missionId);
      writer.ingest(h.world.orgId, h.env({ sequence: 2, observedAt: m(2), ingestedAt: m(2) }));
      h.check(
        'racer stale-memory seq2 refused',
        'rejected/SEQUENCE_REGRESSION',
        codeOf(h.submit(racer, h.env({ sequence: 2, observedAt: m(3), ingestedAt: m(3) }))),
      );
      racer.rehydrate(h.world.orgId, h.world.missionId);
      h.check(
        'after rehydrate next seq accepted',
        'accepted',
        h.submit(racer, h.env({ sequence: 3, observedAt: m(4), ingestedAt: m(4) })).status,
      );
      return {
        sideEffects: h.sideEffects(),
        explanation: 'journal-authoritative admission inside the write transaction',
      };
    },
  },
  {
    id: 'PE-21',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-21-restart-replay',
    summary:
      'Process restart: a fresh instance rebuilds identical timeline and rejects a previously accepted event id.',
    fault: 'process restart',
    run(h) {
      const first = h.freshService();
      const event = h.env({
        sequence: 1,
        observedAt: m(1),
        ingestedAt: m(1),
        observations: CLEAR_WIND,
      });
      first.ingest(h.world.orgId, event);
      const restarted = h.freshService();
      const view = restarted.replay(h.world.orgId, h.world.missionId);
      h.check('timeline rebuilt', 1, view.events.length);
      h.check(
        'event id known after restart',
        'rejected/DUPLICATE_EVENT',
        codeOf(h.submit(restarted, event)),
      );
      h.check(
        'progress continues',
        'accepted',
        h.submit(restarted, h.env({ sequence: 2, observedAt: m(2), ingestedAt: m(2) })).status,
      );
      return { sideEffects: h.sideEffects(), explanation: 'journal is the only durable state' };
    },
  },
  {
    id: 'PE-22',
    family: 'physical-evidence',
    domain: 'warehouse',
    seed: 'PE-22-schema-violations',
    summary:
      'Units and values outside the documented schema: wrong unit, integer wind, 1-dp wave, battery 140%.',
    fault: 'invalid units/values',
    run(h) {
      const service = h.freshService();
      h.check(
        'wind unit kts refused',
        'rejected/INVALID_UNIT',
        codeOf(
          h.submit(
            service,
            h.env({
              sequence: 1,
              observedAt: m(1),
              ingestedAt: m(1),
              observations: [{ kind: 'wind_speed', unit: 'kts', value: '18.5' }],
            }),
          ),
        ),
      );
      h.check(
        'integer wind refused',
        'rejected/INVALID_VALUE',
        codeOf(
          h.submit(
            service,
            h.env({
              sequence: 1,
              observedAt: m(2),
              ingestedAt: m(2),
              observations: [{ kind: 'wind_speed', unit: 'kt', value: 18 }],
            }),
          ),
        ),
      );
      h.check(
        'wave 1-dp refused',
        'rejected/INVALID_VALUE',
        codeOf(
          h.submit(
            service,
            h.env({
              sequence: 1,
              observedAt: m(3),
              ingestedAt: m(3),
              observations: [{ kind: 'wave_height', unit: 'm', value: '1.2' }],
            }),
          ),
        ),
      );
      h.check(
        'battery 140 refused',
        'rejected/INVALID_VALUE',
        codeOf(
          h.submit(
            service,
            h.env({
              sequence: 1,
              observedAt: m(4),
              ingestedAt: m(4),
              observations: [{ kind: 'battery_soc', unit: 'percent', value: 140 }],
            }),
          ),
        ),
      );
      return {
        sideEffects: h.sideEffects(),
        explanation: 'closed vocabulary enforced in both domains',
      };
    },
  },
  {
    id: 'PE-23',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-23-raw-writer',
    summary:
      'A raw writer bypassing ingestion inserts a duplicate stream sequence; replay fails closed.',
    fault: 'raw journal write bypassing ingestion',
    run(h) {
      const service = h.freshService();
      for (const sequence of [1, 2]) {
        h.submit(service, h.env({ sequence, observedAt: m(sequence), ingestedAt: m(sequence) }));
      }
      const rows = h.world.ledger.db
        .prepare(
          `SELECT payload_json FROM evidence_events WHERE type = 'mission.event.ingested' ORDER BY seq`,
        )
        .all() as { payload_json: string }[];
      const last = rows[rows.length - 1]!;
      h.world.ledger.db.prepare('DROP TRIGGER evidence_events_no_update').run();
      h.world.ledger.db.prepare('DROP TRIGGER evidence_events_no_delete').run();
      h.world.ledger.db
        .prepare(
          `INSERT INTO evidence_events (id, org_id, mission_id, topic, type, event_key, payload_digest, payload_json, recorded_at)
           VALUES ('evt_rawdup', ?, ?, 'operational', 'mission.event.ingested', 'mevt:mevt_rawdup', ?, ?, ?)`,
        )
        .run(
          h.world.orgId,
          h.world.missionId,
          '0'.repeat(64),
          last.payload_json,
          h.clock.now().toISOString(),
        );
      let replayFailed = false;
      try {
        service.replay(h.world.orgId, h.world.missionId);
      } catch {
        replayFailed = true;
      }
      h.check('raw duplicate detected at replay', true, replayFailed);
      return {
        sideEffects: h.sideEffects(),
        explanation: 'documented residual: detected fail-closed, not prevented',
      };
    },
  },
  {
    id: 'PE-24',
    family: 'physical-evidence',
    domain: 'warehouse',
    seed: 'PE-24-warehouse-not-uav',
    summary:
      'Warehouse robot events flow through the SAME ingest path WITHOUT being forced into UAV wind-safety rules.',
    fault: 'domain generality probe (no fault injected)',
    run(h) {
      const service = h.freshService();
      h.check(
        'warehouse vocabulary accepted',
        'accepted',
        h.submit(
          service,
          h.env({
            sequence: 1,
            observedAt: m(1),
            ingestedAt: m(1),
            observations: [
              { kind: 'aisle_access', unit: 'state', value: 'obstructed' },
              { kind: 'charger_status', unit: 'state', value: 'fault' },
              { kind: 'asset_comms', unit: 'state', value: 'online' },
              { kind: 'stock_discrepancy', unit: 'items', value: 14 },
            ],
          }),
        ).status,
      );
      // The current bridge (Agent A's) maps only wind/hold/comms: a warehouse
      // comms-only reading yields 'unknown' clearance for the robot — honest
      // conservative behavior, NOT a fabricated wind rule. Aisle/charger facts
      // are preserved in the journal for a domain-aware adapter (documented
      // request to Agent A; see contract/planner-adapter-request.v1.md).
      const chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbentAssetId: 'asset-uav-1',
      });
      const hasWindConstraint = chain.bridge.evidence.some(
        (e) =>
          e.constraint.kind === 'asset-safety' &&
          (e.constraint as { observedWindKt?: number }).observedWindKt !== undefined,
      );
      h.check('no wind rule invented for warehouse asset', false, hasWindConstraint);
      h.check(
        'journal preserves warehouse facts',
        true,
        service
          .replay(h.world.orgId, h.world.missionId)
          .events[0]?.observations.some((o) => o.kind === 'aisle_access'),
      );
      return {
        sideEffects: h.sideEffects(),
        planner: plannerObservation(
          chain,
          'warehouse facts journaled; bridge conservative (unknown clearance), domain adapter requested from Agent A',
        ),
        explanation: 'same architecture, no cross-domain rule forcing',
      };
    },
  },
  {
    id: 'PE-25',
    family: 'physical-evidence',
    domain: 'cross-domain',
    seed: 'PE-25-both-domains',
    summary:
      'Offshore and warehouse missions coexist in one ledger with no state bleed; both replay correctly.',
    fault: 'multi-domain coexistence (no fault injected)',
    run(h) {
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: CLEAR_WIND }),
      );
      const warehouseOrg = h.world.mirrorOrg;
      h.check(
        'warehouse mission event accepted',
        'accepted',
        h.submit(
          service,
          h.env({
            source: warehouseOrg.source,
            orgId: warehouseOrg.orgId,
            missionId: warehouseOrg.missionId,
            sequence: 1,
            observedAt: m(2),
            ingestedAt: m(2),
            observations: [{ kind: 'stock_discrepancy', unit: 'items', value: 3 }],
          }),
        ).status,
      );
      const offshoreView = service.replay(h.world.orgId, h.world.missionId);
      const warehouseView = service.replay(warehouseOrg.orgId, warehouseOrg.missionId);
      h.check('offshore mission isolated', 1, offshoreView.events.length);
      h.check('warehouse mission isolated', 1, warehouseView.events.length);
      const crossTenant: string = (() => {
        try {
          service.replay(h.world.orgId, warehouseOrg.missionId);
          return 'no-error';
        } catch (error) {
          return (/\[([A-Z_]+)\]/.exec(String(error)) ?? [])[1] ?? 'uncoded';
        }
      })();
      h.check(
        'cross-tenant replay refused',
        'rejected/MISSION_NOT_IN_ORG',
        `rejected/${crossTenant}`,
      );
      return {
        sideEffects: h.sideEffects(),
        explanation: 'one architecture, two domains, zero bleed',
      };
    },
  },
  {
    id: 'PE-26',
    family: 'physical-evidence',
    domain: 'offshore',
    seed: 'PE-26-clock-rollover',
    summary:
      'Clock rollover: a previously fresh observation crosses the planning boundary, while NEW telemetry keeps arriving and stays eligible.',
    fault: 'read clock advances past a fresh observation',
    run(h) {
      const service = h.freshService();
      h.submit(
        service,
        h.env({ sequence: 1, observedAt: m(1), ingestedAt: m(1), observations: CLEAR_WIND }),
      );
      let chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbentAssetId: 'asset-uav-1',
      });
      h.check('before rollover: eligible', true, chain.bridge.evidence.length === 1);
      // Rollover: the read clock passes the observation's planning boundary.
      h.clock.advanceMs(15 * 60_000 + 1);
      chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbentAssetId: 'asset-uav-1',
      });
      h.check('after rollover: withheld', 0, chain.bridge.evidence.length);
      h.check('after rollover: listed as withheld', 1, chain.bridge.withheldEventIds.length);
      // Ingestion continues normally after the rollover; the new event is
      // eligible (the boundary is per-observation, not a service-wide lockout).
      h.check(
        'post-rollover ingestion accepted',
        'accepted',
        h.submit(
          service,
          h.env({ sequence: 2, observedAt: m(17), ingestedAt: m(17), observations: GALE }),
        ).status,
      );
      chain = h.plan({
        service,
        orgId: h.world.orgId,
        missionId: h.world.missionId,
        uavWindLimitKt: 22,
        incumbentAssetId: 'asset-uav-1',
      });
      h.check('new observation eligible', 1, chain.bridge.evidence.length);
      h.check(
        'new observation is the gale',
        'blocked',
        (chain.bridge.evidence[0]?.constraint as { state?: string }).state,
      );
      h.check(
        'old event still listed as history',
        2,
        service.replay(h.world.orgId, h.world.missionId).events.length,
      );
      return {
        sideEffects: h.sideEffects(),
        planner: plannerObservation(
          chain,
          'rollover flips eligibility per-observation; fresh telemetry keeps constraining the plan',
        ),
        explanation:
          'freshness boundary is evaluated per event at read time — no stale carry-over, no lockout',
      };
    },
  },
];

function codeOf(result: { status: string; code?: string }): string {
  return result.status === 'accepted' ? 'accepted' : `rejected/${result.code ?? 'UNKNOWN'}`;
}

function latestCommsSource(
  events: readonly {
    sourceId: string;
    observations: readonly { kind: string; value: unknown }[];
  }[],
): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.observations.some((o) => o.kind === 'asset_comms')) return event.sourceId;
  }
  return 'none';
}

function plannerObservation(chain: PlanChain, note: string) {
  return {
    outcome: chain.decision.outcome,
    selectedId: chain.decision.selected?.candidate.id ?? null,
    rejectionCodes: chain.decision.trace.scores.flatMap((s) =>
      s.rejection ? [s.rejection.code] : [],
    ),
    bridgeEvidence: chain.bridge.evidence.length,
    bridgeWithheld: chain.bridge.withheldEventIds.length,
    constraintStates: chain.bridge.evidence.map(
      (e) => (e.constraint as { state?: string }).state ?? e.constraint.kind,
    ),
    note,
  };
}
