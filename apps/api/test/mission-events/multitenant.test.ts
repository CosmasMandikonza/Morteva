/**
 * CTO correction A — strict multitenant isolation (issue #9 review).
 *
 * Before the correction, in-memory validation state keyed assets by bare
 * assetId and event ids globally, so two organizations or two missions reusing
 * the same id strings could contaminate offline/monotonic/duplicate checks,
 * and rehydrating one mission replaced the whole service state. These tests
 * pin the corrected behavior: composite (org, mission, asset[, source]) state
 * identities built from collision-safe JSON tuple keys.
 */
import { describe, expect, it } from 'vitest';
import { fixtureSourceKey, sourceSignature } from '../../src/mission-events/index.js';
import type {
  EnvelopeWire,
  MissionEventIngestService,
  RegisteredSource,
  SourceRegistry,
} from '../../src/mission-events/index.js';
import { at, envelope, makeWorld, type TestWorld } from './helpers.js';

const ONLINE = { kind: 'asset_comms', unit: 'state', value: 'online' };
const OFFLINE = { kind: 'asset_comms', unit: 'state', value: 'offline' };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const match = /\[([A-Z_]+)\]/.exec(error instanceof Error ? error.message : String(error));
    if (match === null) throw error;
    return match[1]!;
  }
  throw new Error('expected rejection');
}

/** A wire envelope from a NON-default source/world, properly signed. */
function signedEnvelope(spec: {
  source: RegisteredSource;
  orgId: string;
  missionId: string;
  assetId: string;
  eventId?: string;
  sequence: number;
  observedAt: string;
  ingestedAt: string;
  observations?: EnvelopeWire['observations'];
}): EnvelopeWire {
  const unsigned = {
    contractVersion: 1,
    eventId: spec.eventId ?? `mevt_mt${Math.random().toString(16).slice(2, 10)}`,
    sequence: spec.sequence,
    orgId: spec.orgId,
    missionId: spec.missionId,
    assetId: spec.assetId,
    observedAt: spec.observedAt,
    ingestedAt: spec.ingestedAt,
    source: {
      sourceId: spec.source.sourceId,
      sourceType: spec.source.sourceType,
      keyId: spec.source.keyId,
      provenance: spec.source.provenance,
    },
    observations: spec.observations ?? [{ kind: 'battery_soc', unit: 'percent', value: 80 }],
  };
  return {
    ...unsigned,
    source: {
      ...unsigned.source,
      signature: sourceSignature(unsigned as never, spec.source.secretKey),
    },
  } as EnvelopeWire;
}

/** A second mission inside an existing world, with sources bound to it. */
function secondMission(
  world: TestWorld,
  registry: SourceRegistry,
): {
  missionId: string;
  telemetry: RegisteredSource;
  gateway: RegisteredSource;
  service: MissionEventIngestService;
} {
  const mission = world.ledger.organizations.createMission(world.orgId, 'second-mission');
  const telemetry: RegisteredSource = {
    orgId: world.orgId,
    missionId: mission.id,
    sourceId: world.telemetrySource.sourceId, // SAME source id string as mission 1
    sourceType: 'asset_telemetry',
    keyId: 'key-tel-m2-v1',
    secretKey: fixtureSourceKey('seed-m2', world.telemetrySource.sourceId),
    provenance: 'SYNTHETIC',
    assetIds: [world.telemetrySource.assetIds[0]!], // SAME asset id string as mission 1
    trustedForRecovery: false,
  };
  const gateway: RegisteredSource = {
    orgId: world.orgId,
    missionId: mission.id,
    sourceId: world.gatewaySource.sourceId,
    sourceType: 'vessel_gateway',
    keyId: 'key-gw-m2-v1',
    secretKey: fixtureSourceKey('seed-m2', world.gatewaySource.sourceId),
    provenance: 'SYNTHETIC',
    assetIds: [world.telemetrySource.assetIds[0]!],
    trustedForRecovery: true,
  };
  registry.register(telemetry);
  registry.register(gateway);
  return { missionId: mission.id, telemetry, gateway, service: world.service };
}

describe('CTO correction A — strict multitenant isolation', () => {
  it('two organizations reusing identical mission/asset/source id STRINGS never leak state', () => {
    const world = makeWorld();
    const asset = world.telemetrySource.assetIds[0]!;
    // Org B reuses the SAME asset id string and the same sourceId string.
    const sourceB: RegisteredSource = {
      orgId: world.foreignOrgId,
      missionId: world.foreignMissionId,
      sourceId: world.telemetrySource.sourceId,
      sourceType: 'asset_telemetry',
      keyId: 'key-tel-orgB-v1',
      secretKey: fixtureSourceKey('seed-orgB', world.telemetrySource.sourceId),
      provenance: 'SYNTHETIC',
      assetIds: [asset],
      trustedForRecovery: false,
    };
    world.registry.register(sourceB);

    // Org A: seq 1 accepted.
    expect(
      world.service.ingest(
        world.orgId,
        envelope(world, { sequence: 1, observedAt: at(1), ingestedAt: at(1), assetId: asset }),
      ).status,
    ).toBe('accepted');
    // Org B's FIRST event with the SAME asset+source strings is seq 1 — and
    // must be accepted (no cross-org sequence contamination).
    const envB = signedEnvelope({
      source: sourceB,
      orgId: world.foreignOrgId,
      missionId: world.foreignMissionId,
      assetId: asset,
      sequence: 1,
      observedAt: at(2),
      ingestedAt: at(2),
    });
    expect(world.service.ingest(world.foreignOrgId, envB).status).toBe('accepted');
    // Org A's stream still expects 2; a seq-2 event for org A is accepted.
    expect(
      world.service.ingest(
        world.orgId,
        envelope(world, { sequence: 2, observedAt: at(3), ingestedAt: at(3), assetId: asset }),
      ).status,
    ).toBe('accepted');
    world.ledger.close();
  });

  it('the same eventId is valid independently in two organizations (journal keys are org-scoped)', () => {
    const world = makeWorld();
    const asset = world.telemetrySource.assetIds[0]!;
    const shared = 'mevt_shared_id_1';
    expect(
      world.service.ingest(
        world.orgId,
        envelope(world, {
          eventId: shared,
          sequence: 1,
          observedAt: at(1),
          ingestedAt: at(1),
          assetId: asset,
        }),
      ).status,
    ).toBe('accepted');
    const sourceB: RegisteredSource = {
      orgId: world.foreignOrgId,
      missionId: world.foreignMissionId,
      sourceId: world.telemetrySource.sourceId,
      sourceType: 'asset_telemetry',
      keyId: 'key-tel-orgB2-v1',
      secretKey: fixtureSourceKey('seed-orgB2', world.telemetrySource.sourceId),
      provenance: 'SYNTHETIC',
      assetIds: [asset],
      trustedForRecovery: false,
    };
    world.registry.register(sourceB);
    const envB = signedEnvelope({
      source: sourceB,
      orgId: world.foreignOrgId,
      missionId: world.foreignMissionId,
      assetId: asset,
      eventId: shared,
      sequence: 1,
      observedAt: at(2),
      ingestedAt: at(2),
    });
    // Same eventId, different org: accepted (per-org duplicate scoping).
    expect(world.service.ingest(world.foreignOrgId, envB).status).toBe('accepted');
    // And a same-org replay of the original still rejects.
    expect(
      codeOf(() =>
        world.service.ingest(
          world.orgId,
          envelope(world, {
            eventId: shared,
            sequence: 2,
            observedAt: at(3),
            ingestedAt: at(3),
            assetId: asset,
          }),
        ),
      ),
    ).toBe('DUPLICATE_EVENT');
    world.ledger.close();
  });

  it('mission A declaring the asset OFFLINE cannot suppress the same asset id in mission B', () => {
    const world = makeWorld();
    // Mission A (the world's default mission): telemetry seq1 online…
    world.service.ingest(
      world.orgId,
      envelope(world, {
        sequence: 1,
        observedAt: at(1),
        ingestedAt: at(1),
        observations: [ONLINE],
      }),
    );
    // …then the trusted gateway declares it offline IN MISSION A.
    world.service.ingest(
      world.orgId,
      envelope(world, {
        source: world.gatewaySource,
        sequence: 1,
        observedAt: at(2),
        ingestedAt: at(2),
        observations: [OFFLINE],
      }),
    );
    // Mission A telemetry is now blocked…
    expect(
      codeOf(() =>
        world.service.ingest(
          world.orgId,
          envelope(world, { sequence: 2, observedAt: at(3), ingestedAt: at(3) }),
        ),
      ),
    ).toBe('ASSET_OFFLINE');
    // …but mission B, reusing the SAME asset id, still accepts telemetry.
    const m2 = secondMission(world, world.registry);
    expect(
      m2.service.ingest(
        world.orgId,
        envelope(world, {
          source: m2.telemetry,
          missionId: m2.missionId,
          sequence: 1,
          observedAt: at(4),
          ingestedAt: at(4),
          observations: [ONLINE],
        }),
      ).status,
    ).toBe('accepted');
    // Monotonic state is also mission-scoped: mission B progress starts fresh.
    expect(
      m2.service.ingest(
        world.orgId,
        envelope(world, {
          source: m2.telemetry,
          missionId: m2.missionId,
          sequence: 2,
          observedAt: at(5),
          ingestedAt: at(5),
          observations: [{ kind: 'inspection_progress', unit: 'percent', value: 5 }],
        }),
      ).status,
    ).toBe('accepted');
    world.ledger.close();
  });

  it('rehydrating mission A does not erase mission B in-memory stream state', () => {
    const world = makeWorld();
    const m2 = secondMission(world, world.registry);
    // Both missions ingest streams.
    world.service.ingest(
      world.orgId,
      envelope(world, { sequence: 1, observedAt: at(1), ingestedAt: at(1) }),
    );
    world.service.ingest(
      world.orgId,
      envelope(world, {
        source: m2.telemetry,
        missionId: m2.missionId,
        sequence: 1,
        observedAt: at(2),
        ingestedAt: at(2),
      }),
    );
    world.service.ingest(
      world.orgId,
      envelope(world, {
        source: m2.telemetry,
        missionId: m2.missionId,
        sequence: 2,
        observedAt: at(3),
        ingestedAt: at(3),
      }),
    );
    // Explicit rehydrate of mission A (previously: replaced the ENTIRE state).
    world.service.rehydrate(world.orgId, world.missionId);
    // Mission B's stream state survived: a regression still rejects.
    expect(
      codeOf(() =>
        world.service.ingest(
          world.orgId,
          envelope(world, {
            source: m2.telemetry,
            missionId: m2.missionId,
            sequence: 2,
            observedAt: at(4),
            ingestedAt: at(4),
          }),
        ),
      ),
    ).toBe('SEQUENCE_REGRESSION');
    // And mission B continues at its true next sequence.
    expect(
      world.service.ingest(
        world.orgId,
        envelope(world, {
          source: m2.telemetry,
          missionId: m2.missionId,
          sequence: 3,
          observedAt: at(5),
          ingestedAt: at(5),
        }),
      ).status,
    ).toBe('accepted');
    world.ledger.close();
  });

  it('a foreign organization or unauthorized source cannot modify another mission state', () => {
    const world = makeWorld();
    const m2 = secondMission(world, world.registry);
    world.service.ingest(
      world.orgId,
      envelope(world, {
        sequence: 1,
        observedAt: at(1),
        ingestedAt: at(1),
        observations: [ONLINE],
      }),
    );
    // Mission 1's key submitting into mission 2's stream: source/mission
    // binding refuses (the key is registered for mission 1 only).
    expect(
      codeOf(() =>
        world.service.ingest(
          world.orgId,
          envelope(world, {
            missionId: m2.missionId,
            sequence: 1,
            observedAt: at(2),
            ingestedAt: at(2),
          }),
        ),
      ),
    ).toBe('CROSS_ORG_EVENT');
    // Foreign-org caller with our mission: refused.
    expect(
      codeOf(() =>
        world.service.ingest(
          world.foreignOrgId,
          envelope(world, { sequence: 2, observedAt: at(2), ingestedAt: at(2) }),
        ),
      ),
    ).toBe('CROSS_ORG_EVENT');
    // Neither attempt changed mission 1 state: seq 2 still accepted next.
    expect(
      world.service.ingest(
        world.orgId,
        envelope(world, { sequence: 2, observedAt: at(3), ingestedAt: at(3) }),
      ).status,
    ).toBe('accepted');
    // Mission 2's stream is still untouched (its first event must be seq 1).
    expect(
      codeOf(() =>
        world.service.ingest(
          world.orgId,
          envelope(world, {
            source: m2.telemetry,
            missionId: m2.missionId,
            sequence: 2,
            observedAt: at(4),
            ingestedAt: at(4),
          }),
        ),
      ),
    ).toBe('SEQUENCE_GAP');
    world.ledger.close();
  });

  it('a FAILED journal append never advances in-memory validation state', () => {
    const world = makeWorld();
    const blocked = 'mevt_blocked_append';
    // Occupy the journal event key with an unrelated row (different type) so
    // the append inside ingest fails with a uniqueness violation AFTER the
    // in-memory checks pass.
    world.ledger.evidence.append({
      orgId: world.orgId,
      missionId: world.missionId,
      topic: 'operational',
      type: 'test.seed',
      eventKey: `mevt:${blocked}`,
      payload: { seeded: true },
    });
    expect(
      codeOf(() =>
        world.service.ingest(
          world.orgId,
          envelope(world, {
            eventId: blocked,
            sequence: 1,
            observedAt: at(1),
            ingestedAt: at(1),
          }),
        ),
      ),
    ).toBe('DUPLICATE_EVENT');
    // The failed admission left no stream state behind: sequence 1 is still
    // the expected next event for a DIFFERENT event id.
    expect(
      world.service.ingest(
        world.orgId,
        envelope(world, { sequence: 1, observedAt: at(2), ingestedAt: at(2) }),
      ).status,
    ).toBe('accepted');
    world.ledger.close();
  });
});
