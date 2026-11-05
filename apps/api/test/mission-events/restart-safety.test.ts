/**
 * CTO correction B — restart-safe sequencing (issue #9 review).
 *
 * Before the correction, a fresh service instance started with empty state
 * and could admit events for an existing stream without first rebuilding it
 * from the journal (first-ever sequence >1 was also accepted). Now:
 *   - ingest lazily hydrates the target (org, mission) scope from the journal
 *     on first use and NEVER trusts empty state for an existing stream;
 *   - a stream's first event must be sequence 1 (memory AND a
 *     journal-authoritative check);
 *   - sequence admission is re-enforced from the journal INSIDE the
 *     BEGIN IMMEDIATE write transaction, so concurrent service instances
 *     cannot both admit the same stream sequence;
 *   - a corrupted/inconsistent journal fails closed on ingest and replay —
 *     it is never silently treated as an empty baseline.
 */
import { describe, expect, it } from 'vitest';
import { MissionEventIngestService, SourceRegistry } from '../../src/mission-events/index.js';
import { at, envelope, makeWorld } from './helpers.js';

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

/** A brand-new service instance over the SAME ledger (a "restart"). */
function restart(world: ReturnType<typeof makeWorld>): MissionEventIngestService {
  const registry = new SourceRegistry();
  registry.registerAll([world.telemetrySource, world.gatewaySource]);
  return new MissionEventIngestService(world.ledger, world.clock, registry);
}

describe('CTO correction B — restart-safe sequencing', () => {
  it('a stream begins at sequence 1; the first-ever sequence ≥ 2 is rejected', () => {
    const world = makeWorld();
    expect(
      world.service.ingest(
        world.orgId,
        envelope(world, { sequence: 1, observedAt: at(1), ingestedAt: at(1) }),
      ).status,
    ).toBe('accepted');
    // A NEW stream (gateway source) must also start at 1.
    expect(
      codeOf(() =>
        world.service.ingest(
          world.orgId,
          envelope(world, {
            source: world.gatewaySource,
            sequence: 2,
            observedAt: at(2),
            ingestedAt: at(2),
          }),
        ),
      ),
    ).toBe('SEQUENCE_GAP');
    expect(
      world.service.ingest(
        world.orgId,
        envelope(world, {
          source: world.gatewaySource,
          sequence: 1,
          observedAt: at(3),
          ingestedAt: at(3),
        }),
      ).status,
    ).toBe('accepted');
    world.ledger.close();
  });

  it('a fresh instance rejects a previously accepted eventId (no empty-state trust)', () => {
    const world = makeWorld();
    const original = envelope(world, { sequence: 1, observedAt: at(1), ingestedAt: at(1) });
    expect(world.service.ingest(world.orgId, original).status).toBe('accepted');
    const fresh = restart(world);
    expect(codeOf(() => fresh.ingest(world.orgId, original))).toBe('DUPLICATE_EVENT');
    world.ledger.close();
  });

  it('a fresh instance rejects a DIFFERENT eventId reusing a consumed sequence (regression)', () => {
    const world = makeWorld();
    world.service.ingest(
      world.orgId,
      envelope(world, { sequence: 1, observedAt: at(1), ingestedAt: at(1) }),
    );
    world.service.ingest(
      world.orgId,
      envelope(world, { sequence: 2, observedAt: at(2), ingestedAt: at(2) }),
    );
    const fresh = restart(world);
    expect(
      codeOf(() =>
        fresh.ingest(
          world.orgId,
          envelope(world, { sequence: 2, observedAt: at(3), ingestedAt: at(3) }),
        ),
      ),
    ).toBe('SEQUENCE_REGRESSION');
    expect(
      codeOf(() =>
        fresh.ingest(
          world.orgId,
          envelope(world, { sequence: 1, observedAt: at(4), ingestedAt: at(4) }),
        ),
      ),
    ).toBe('SEQUENCE_REGRESSION');
    world.ledger.close();
  });

  it('a fresh instance rejects sequence gaps and accepts the true next sequence', () => {
    const world = makeWorld();
    world.service.ingest(
      world.orgId,
      envelope(world, { sequence: 1, observedAt: at(1), ingestedAt: at(1) }),
    );
    const fresh = restart(world);
    expect(
      codeOf(() =>
        fresh.ingest(
          world.orgId,
          envelope(world, { sequence: 4, observedAt: at(2), ingestedAt: at(2) }),
        ),
      ),
    ).toBe('SEQUENCE_GAP');
    expect(
      fresh.ingest(
        world.orgId,
        envelope(world, { sequence: 2, observedAt: at(3), ingestedAt: at(3) }),
      ).status,
    ).toBe('accepted');
    world.ledger.close();
  });

  it('interleaved events from independent sources keep independent sequences', () => {
    const world = makeWorld();
    // Telemetry and gateway streams for the SAME asset interleave; each
    // counts its own contiguous sequence.
    for (const seq of [1, 2, 3]) {
      expect(
        world.service.ingest(
          world.orgId,
          envelope(world, { sequence: seq, observedAt: at(seq), ingestedAt: at(seq) }),
        ).status,
      ).toBe('accepted');
      expect(
        world.service.ingest(
          world.orgId,
          envelope(world, {
            source: world.gatewaySource,
            sequence: seq,
            observedAt: at(seq + 0.5),
            ingestedAt: at(seq + 0.5),
          }),
        ).status,
      ).toBe('accepted');
    }
    const fresh = restart(world);
    // A fresh instance keeps both streams distinct: telemetry 4 ok, then
    // telemetry 5 (skipping the not-yet-written 4... wait, 4 was just
    // accepted) — telemetry 5 skipping nothing is next; test the gap instead.
    expect(
      fresh.ingest(
        world.orgId,
        envelope(world, { sequence: 4, observedAt: at(10), ingestedAt: at(10) }),
      ).status,
    ).toBe('accepted');
    expect(
      codeOf(() =>
        fresh.ingest(
          world.orgId,
          envelope(world, { sequence: 6, observedAt: at(11), ingestedAt: at(11) }),
        ),
      ),
    ).toBe('SEQUENCE_GAP');
    world.ledger.close();
  });

  it('a corrupted journal fails closed on ingest — never silently reset to empty state', () => {
    const world = makeWorld();
    world.service.ingest(
      world.orgId,
      envelope(world, { sequence: 1, observedAt: at(1), ingestedAt: at(1) }),
    );
    world.ledger.db.prepare('DROP TRIGGER evidence_events_no_update').run();
    world.ledger.db
      .prepare(
        `UPDATE evidence_events SET payload_json = '{not-json' WHERE type = 'mission.event.ingested'`,
      )
      .run();
    const fresh = restart(world);
    // The new instance would happily admit into empty state; instead the
    // hydration path detects the corrupt journal and refuses everything.
    expect(
      codeOf(() =>
        fresh.ingest(
          world.orgId,
          envelope(world, { sequence: 2, observedAt: at(2), ingestedAt: at(2) }),
        ),
      ),
    ).toBe('JOURNAL_TAMPERED');
    expect(() => fresh.replay(world.orgId, world.missionId)).toThrowError(/JOURNAL_TAMPERED/);
    world.ledger.close();
  });

  it('CONCURRENT instances cannot both admit the same stream sequence (journal-authoritative transaction)', () => {
    const world = makeWorld();
    const writer = restart(world);
    // The racer hydrates BEFORE the writer's next admission — the exact
    // stale-memory window two live instances can hit.
    writer.ingest(
      world.orgId,
      envelope(world, { sequence: 1, observedAt: at(1), ingestedAt: at(1) }),
    );
    const racer = restart(world);
    racer.rehydrate(world.orgId, world.missionId); // memory now ends at seq 1
    writer.ingest(
      world.orgId,
      envelope(world, { sequence: 2, observedAt: at(2), ingestedAt: at(2) }),
    );
    // Racer's STALE memory passes a second sequence 2 for a different event
    // id… but the journal-authoritative check inside the BEGIN IMMEDIATE
    // transaction sees the committed 2 and fails closed.
    expect(
      codeOf(() =>
        racer.ingest(
          world.orgId,
          envelope(world, { sequence: 2, observedAt: at(3), ingestedAt: at(3) }),
        ),
      ),
    ).toBe('SEQUENCE_REGRESSION');
    // The racer cannot skip ahead either — its stale memory (last=1) already
    // rejects 4 as a gap before the journal check is even needed.
    expect(
      codeOf(() =>
        racer.ingest(
          world.orgId,
          envelope(world, { sequence: 4, observedAt: at(4), ingestedAt: at(4) }),
        ),
      ),
    ).toBe('SEQUENCE_GAP');
    // After refreshing its memory the racer continues at the true next seq.
    racer.rehydrate(world.orgId, world.missionId);
    expect(
      racer.ingest(
        world.orgId,
        envelope(world, { sequence: 3, observedAt: at(5), ingestedAt: at(5) }),
      ).status,
    ).toBe('accepted');
    world.ledger.close();
  });

  it('a raw writer duplicating a sequence is detected at replay (documented residual, fail-closed)', () => {
    const world = makeWorld();
    for (const sequence of [1, 2]) {
      world.service.ingest(
        world.orgId,
        envelope(world, { sequence, observedAt: at(sequence), ingestedAt: at(sequence) }),
      );
    }
    // A raw DB writer re-inserts the last payload as a "sequence 2 again"
    // row with a different event key — the one thing the journal's
    // per-eventId uniqueness cannot prevent. Replay must refuse (duplicate
    // sequence in one stream = inconsistent journal). Note: the payload
    // digest is wrong too; EITHER check fails closed — the continuity check
    // is the one that would catch a fully-forged valid-digest row.
    world.ledger.db.prepare('DROP TRIGGER evidence_events_no_update').run();
    world.ledger.db.prepare('DROP TRIGGER evidence_events_no_delete').run();
    const rows = world.ledger.db
      .prepare(
        `SELECT payload_json FROM evidence_events WHERE type = 'mission.event.ingested' ORDER BY seq`,
      )
      .all() as { payload_json: string }[];
    const lastPayload = rows[rows.length - 1]!.payload_json;
    world.ledger.db
      .prepare(
        `INSERT INTO evidence_events (id, org_id, mission_id, topic, type, event_key, payload_digest, payload_json, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'evt_rawdup',
        world.orgId,
        world.missionId,
        'operational',
        'mission.event.ingested',
        'mevt:mevt_raw_duplicate',
        '0'.repeat(64),
        lastPayload,
        world.clock.iso(),
      );
    expect(() => world.service.replay(world.orgId, world.missionId)).toThrowError(
      /JOURNAL_TAMPERED/,
    );
    world.ledger.close();
  });
});
