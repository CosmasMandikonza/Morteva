/**
 * Ingest pipeline tests (issue #9): journal round-trip through the EXISTING
 * append-only evidence boundary, and every adversarial ordering/time/state
 * fault from the issue: duplicates, replays, out-of-order, lost updates,
 * clock skew, stale/future readings, offline-asset ghost telemetry, magic
 * recovery attempts, contradictory observations — plus the financial
 * isolation law (no physical event can produce financial journal rows or
 * operations).
 */
import { describe, expect, it } from 'vitest';
import {
  eventDigest,
  JOURNAL_EVENT_TYPE,
  MissionEventError,
} from '../../src/mission-events/index.js';
import { at, envelope, makeWorld } from './helpers.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof MissionEventError) return error.code;
    throw error;
  }
  throw new Error('expected rejection');
}

const ONLINE = { kind: 'asset_comms', unit: 'state', value: 'online' };
const OFFLINE = { kind: 'asset_comms', unit: 'state', value: 'offline' };

describe('mission-event ingest through the evidence journal', () => {
  it('appends accepted events as operational evidence with digest + provenance', () => {
    const world = makeWorld();
    const result = world.service.ingest(world.orgId, envelope(world, {}));
    expect(result.status).toBe('accepted');
    const rows = world.ledger.evidence.list(world.orgId, {
      missionId: world.missionId,
      topic: 'operational',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe(JOURNAL_EVENT_TYPE);
    expect(rows[0]!.eventKey).toBe(`mevt:${rows[0]!.eventKey.slice(5)}`); // namespaced key
    expect(rows[0]!.topic).toBe('operational');
    expect(result.eventDigest).toMatch(/^[0-9a-f]{64}$/);
    world.ledger.close();
  });

  it('rejects an EXACT duplicate eventId (idempotent, no second journal row)', () => {
    const world = makeWorld();
    const first = envelope(world, { observedAt: at(1), ingestedAt: at(1) });
    expect(world.service.ingest(world.orgId, first).status).toBe('accepted');
    expect(codeOf(() => world.service.ingest(world.orgId, first))).toBe('DUPLICATE_EVENT');
    expect(world.ledger.evidence.list(world.orgId, { topic: 'operational' })).toHaveLength(1);
    world.ledger.close();
  });

  it('rejects sequence REGRESSION (same or lower sequence, new eventId)', () => {
    const world = makeWorld();
    for (const sequence of [1, 2]) {
      world.service.ingest(
        world.orgId,
        envelope(world, { sequence, observedAt: at(sequence), ingestedAt: at(sequence) }),
      );
    }
    const regression = envelope(world, { sequence: 1, observedAt: at(3), ingestedAt: at(3) });
    expect(codeOf(() => world.service.ingest(world.orgId, regression))).toBe('SEQUENCE_REGRESSION');
    const sameSequence = envelope(world, { sequence: 2, observedAt: at(4), ingestedAt: at(4) });
    expect(codeOf(() => world.service.ingest(world.orgId, sameSequence))).toBe(
      'SEQUENCE_REGRESSION',
    );
    world.ledger.close();
  });

  it('rejects a sequence GAP as a lost update and stays fail-closed until repaired', () => {
    const world = makeWorld();
    world.service.ingest(
      world.orgId,
      envelope(world, { sequence: 1, observedAt: at(1), ingestedAt: at(1) }),
    );
    const gap = envelope(world, { sequence: 3, observedAt: at(2), ingestedAt: at(2) });
    const code = codeOf(() => world.service.ingest(world.orgId, gap));
    expect(code).toBe('SEQUENCE_GAP');
    // The missing event can still be delivered (repair path), then seq 3 works.
    world.service.ingest(
      world.orgId,
      envelope(world, { sequence: 2, observedAt: at(3), ingestedAt: at(3) }),
    );
    expect(
      world.service.ingest(
        world.orgId,
        envelope(world, { sequence: 3, observedAt: at(4), ingestedAt: at(4) }),
      ).status,
    ).toBe('accepted');
    world.ledger.close();
  });

  it('rejects ingestedAt BEFORE observedAt (impossible emission order)', () => {
    const world = makeWorld();
    const impossible = envelope(world, { observedAt: at(10), ingestedAt: at(5) });
    expect(codeOf(() => world.service.ingest(world.orgId, impossible))).toBe('TIMESTAMP_ORDER');
    world.ledger.close();
  });

  it('rejects FUTURE-dated readings beyond the clock tolerance', () => {
    const world = makeWorld();
    // Build the envelope first (the helper advances the clock to its anchor),
    // then wind the clock back: the event is now far ahead of "now".
    const future = envelope(world, {
      observedAt: at(60),
      ingestedAt: at(60),
    });
    world.clock.advance(-60 * 60_000);
    expect(codeOf(() => world.service.ingest(world.orgId, future))).toBe('FUTURE_EVENT');
    world.ledger.close();
  });

  it('rejects STALE observations at arrival (delayed telemetry is not current evidence)', () => {
    const world = makeWorld();
    world.clock.advance(20 * 60_000); // now = T0+20m
    const stale = envelope(world, { observedAt: at(0), ingestedAt: at(20) });
    expect(codeOf(() => world.service.ingest(world.orgId, stale))).toBe('STALE_EVENT');
    // Borderline within the 15-minute arrival limit still accepts.
    const freshEnough = envelope(world, {
      sequence: 1,
      observedAt: at(6),
      ingestedAt: at(20),
    });
    expect(world.service.ingest(world.orgId, freshEnough).status).toBe('accepted');
    world.ledger.close();
  });

  it('rejects telemetry from an OFFLINE asset (ghost telemetry) fail-closed', () => {
    const world = makeWorld();
    world.service.ingest(
      world.orgId,
      envelope(world, {
        sequence: 1,
        observedAt: at(1),
        ingestedAt: at(1),
        observations: [ONLINE],
      }),
    );
    // The trusted gateway declares the asset offline.
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
    const ghost = envelope(world, {
      sequence: 2,
      observedAt: at(3),
      ingestedAt: at(3),
      observations: [{ kind: 'inspection_progress', unit: 'percent', value: 50 }],
    });
    expect(codeOf(() => world.service.ingest(world.orgId, ghost))).toBe('ASSET_OFFLINE');
    world.ledger.close();
  });

  it('an offline asset recovers ONLY via a trustedForRecovery source carrying comms=online', () => {
    const world = makeWorld();
    world.service.ingest(
      world.orgId,
      envelope(world, {
        sequence: 1,
        observedAt: at(1),
        ingestedAt: at(1),
        observations: [ONLINE],
      }),
    );
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
    // 1) telemetry cannot self-recover
    expect(
      codeOf(() =>
        world.service.ingest(
          world.orgId,
          envelope(world, {
            sequence: 2,
            observedAt: at(3),
            ingestedAt: at(3),
            observations: [ONLINE],
          }),
        ),
      ),
    ).toBe('ASSET_OFFLINE');
    // 2) a recovery source WITHOUT the comms observation cannot unblock the asset
    expect(
      codeOf(() =>
        world.service.ingest(
          world.orgId,
          envelope(world, {
            source: world.gatewaySource,
            sequence: 2,
            observedAt: at(4),
            ingestedAt: at(4),
            observations: [{ kind: 'inspection_progress', unit: 'percent', value: 10 }],
          }),
        ),
      ),
    ).toBe('ASSET_OFFLINE');
    // 3) the authorized recovery event works
    expect(
      world.service.ingest(
        world.orgId,
        envelope(world, {
          source: world.gatewaySource,
          sequence: 2,
          observedAt: at(5),
          ingestedAt: at(5),
          observations: [ONLINE],
        }),
      ).status,
    ).toBe('accepted');
    // 4) telemetry resumes afterwards at the next sequence
    expect(
      world.service.ingest(
        world.orgId,
        envelope(world, { sequence: 2, observedAt: at(6), ingestedAt: at(6) }),
      ).status,
    ).toBe('accepted');
    world.ledger.close();
  });

  it('rejects CONFLICTING observations of the same kind in one event', () => {
    const world = makeWorld();
    const contradictory = envelope(world, {
      observedAt: at(1),
      ingestedAt: at(1),
      observations: [
        { kind: 'wind_speed', unit: 'kt', value: '12.0' },
        { kind: 'wind_speed', unit: 'kt', value: '25.0' },
      ],
    });
    expect(codeOf(() => world.service.ingest(world.orgId, contradictory))).toBe(
      'CONFLICTING_OBSERVATIONS',
    );
    world.ledger.close();
  });

  it('rejects MONOTONIC violations (inspection progress never decreases)', () => {
    const world = makeWorld();
    world.service.ingest(
      world.orgId,
      envelope(world, {
        sequence: 1,
        observedAt: at(1),
        ingestedAt: at(1),
        observations: [{ kind: 'inspection_progress', unit: 'percent', value: 40 }],
      }),
    );
    const decrease = envelope(world, {
      sequence: 2,
      observedAt: at(2),
      ingestedAt: at(2),
      observations: [{ kind: 'inspection_progress', unit: 'percent', value: 39 }],
    });
    expect(codeOf(() => world.service.ingest(world.orgId, decrease))).toBe('MONOTONIC_VIOLATION');
    // Equal progress is allowed (non-decreasing).
    expect(
      world.service.ingest(
        world.orgId,
        envelope(world, {
          sequence: 2,
          observedAt: at(3),
          ingestedAt: at(3),
          observations: [{ kind: 'inspection_progress', unit: 'percent', value: 40 }],
        }),
      ).status,
    ).toBe('accepted');
    world.ledger.close();
  });

  it('FINANCIAL ISOLATION: a full accepted+rejected stream produces zero financial authority', () => {
    const world = makeWorld();
    // A burst of valid operational events plus adversarial junk.
    const outcomes = world.service.ingestAll(world.orgId, [
      envelope(world, {
        sequence: 1,
        observedAt: at(1),
        ingestedAt: at(1),
        observations: [ONLINE],
      }),
      envelope(world, { sequence: 2, observedAt: at(2), ingestedAt: at(2) }),
      envelope(world, { sequence: 3, observedAt: at(3), ingestedAt: at(3), assetId: 'settle-now' }),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['accepted', 'accepted', 'rejected']);
    // No financial-topic evidence, no operations, no reservations — anywhere.
    const financial = world.ledger.db
      .prepare(`SELECT COUNT(*) AS c FROM evidence_events WHERE topic = 'financial'`)
      .get() as { c: number };
    const operations = world.ledger.db.prepare('SELECT COUNT(*) AS c FROM operations').get() as {
      c: number;
    };
    const commitments = world.ledger.db.prepare('SELECT COUNT(*) AS c FROM commitments').get() as {
      c: number;
    };
    expect(financial.c).toBe(0);
    expect(operations.c).toBe(0);
    expect(commitments.c).toBe(0);
    world.ledger.close();
  });

  it('ingestAll captures rejection codes without stopping the batch', () => {
    const world = makeWorld();
    const first = envelope(world, { observedAt: at(1), ingestedAt: at(1) });
    const outcomes = world.service.ingestAll(world.orgId, [
      first,
      first, // duplicate
      envelope(world, { sequence: 5, observedAt: at(2), ingestedAt: at(2) }), // gap
    ]);
    expect(outcomes[0]!.status).toBe('accepted');
    expect(outcomes[1]).toMatchObject({ status: 'rejected', code: 'DUPLICATE_EVENT' });
    expect(outcomes[2]).toMatchObject({ status: 'rejected', code: 'SEQUENCE_GAP' });
    world.ledger.close();
  });

  it('the journaled payload digest equals the recomputable event digest', () => {
    const world = makeWorld();
    const source = envelope(world, { observedAt: at(1), ingestedAt: at(1) });
    const accepted = world.service.ingest(world.orgId, source);
    const row = world.ledger.db
      .prepare('SELECT payload_json FROM evidence_events WHERE event_key = ?')
      .get(`mevt:${source.eventId}`) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { eventDigest: string };
    expect(payload.eventDigest).toBe(accepted.eventDigest);
    expect(payload.eventDigest).toBe(
      eventDigest({
        contractVersion: source.contractVersion,
        eventId: source.eventId,
        sequence: source.sequence,
        orgId: source.orgId,
        missionId: source.missionId,
        assetId: source.assetId,
        observedAt: source.observedAt,
        ingestedAt: source.ingestedAt,
        source: {
          sourceId: source.source.sourceId,
          sourceType: source.source.sourceType,
          keyId: source.source.keyId,
          provenance: source.source.provenance,
        },
        observations: source.observations,
      }),
    );
    world.ledger.close();
  });
});
