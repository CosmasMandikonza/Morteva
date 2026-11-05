/**
 * Replay tests (issue #9): the append-only journal is the only durable state.
 * A fresh service instance over the same ledger must reconstruct the identical
 * timeline (restart determinism); freshness must age with the clock; journal
 * tampering must fail closed; replay must stay tenant-scoped.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@moterva/domain';
import {
  JOURNAL_EVENT_TYPE,
  MissionEventIngestService,
  MissionEventError,
  SourceRegistry,
} from '../../src/mission-events/index.js';
import { at, envelope, makeWorld } from './helpers.js';

describe('mission-event journal replay', () => {
  it('reconstructs the identical timeline after a restart (deterministic replay)', () => {
    const world = makeWorld();
    for (const sequence of [1, 2, 3]) {
      world.service.ingest(
        world.orgId,
        envelope(world, {
          sequence,
          observedAt: at(sequence),
          ingestedAt: at(sequence),
          observations: [
            { kind: 'battery_soc', unit: 'percent', value: 90 - sequence * 10 },
            { kind: 'asset_comms', unit: 'state', value: 'online' },
          ],
        }),
      );
    }
    world.clock.advance(5 * 60_000);
    const before = world.service.replay(world.orgId, world.missionId);

    // "Restart": brand-new service + registry over the same ledger file.
    const registry = new SourceRegistry();
    registry.registerAll([world.telemetrySource, world.gatewaySource]);
    const restarted = new MissionEventIngestService(world.ledger, world.clock, registry);
    const after = restarted.replay(world.orgId, world.missionId);

    expect(after.events.map((e) => e.eventId)).toEqual(before.events.map((e) => e.eventId));
    expect(after.events.map((e) => e.eventDigest)).toEqual(before.events.map((e) => e.eventDigest));
    expect(after.assets).toEqual(before.assets);
    expect(after.events.map((e) => e.freshness)).toEqual(before.events.map((e) => e.freshness));
    expect(after.events).toHaveLength(3);
    world.ledger.close();
  });

  it('rehydrate restores the validation state so old sequences still reject after restart', () => {
    const world = makeWorld();
    for (const sequence of [1, 2]) {
      world.service.ingest(
        world.orgId,
        envelope(world, { sequence, observedAt: at(sequence), ingestedAt: at(sequence) }),
      );
    }
    const registry = new SourceRegistry();
    registry.registerAll([world.telemetrySource, world.gatewaySource]);
    const restarted = new MissionEventIngestService(world.ledger, world.clock, registry);
    restarted.rehydrate(world.orgId, world.missionId);
    // Without rehydration this regression would be accepted (empty state).
    const regression = envelope(world, { sequence: 2, observedAt: at(3), ingestedAt: at(3) });
    expect(() => restarted.ingest(world.orgId, regression)).toThrowError(/SEQUENCE_REGRESSION/);
    world.ledger.close();
  });

  it('freshness ages with the clock and expires stop being planning-valid', () => {
    const world = makeWorld();
    world.service.ingest(
      world.orgId,
      envelope(world, { sequence: 1, observedAt: at(1), ingestedAt: at(1) }),
    );
    const fresh = world.service.replay(world.orgId, world.missionId);
    expect(fresh.events[0]!.freshness).toBe('fresh');
    expect(fresh.events[0]!.planningValid).toBe(true);

    world.clock.advance(16 * 60_000); // > maxAge (15m) but < expired (30m)
    const stale = world.service.replay(world.orgId, world.missionId);
    expect(stale.events[0]!.freshness).toBe('stale');
    expect(stale.events[0]!.planningValid).toBe(true); // stale is a flag, still journaled truth

    world.clock.advance(20 * 60_000); // > 30m total
    const expired = world.service.replay(world.orgId, world.missionId);
    expect(expired.events[0]!.freshness).toBe('expired');
    expect(expired.events[0]!.planningValid).toBe(false);
    world.ledger.close();
  });

  it('fails closed on a tampered journal payload (digest mismatch)', () => {
    const world = makeWorld();
    world.service.ingest(
      world.orgId,
      envelope(world, { sequence: 1, observedAt: at(1), ingestedAt: at(1) }),
    );
    // The journal's own triggers block UPDATE/DELETE (first line of defense).
    // Digest verification is the SECOND line: simulate an attacker with raw
    // DB write access by dropping the trigger before tampering.
    world.ledger.db.prepare('DROP TRIGGER evidence_events_no_update').run();
    world.ledger.db.prepare(`UPDATE evidence_events SET payload_json = ? WHERE type = ?`).run(
      JSON.stringify({
        event: {},
        eventDigest: '0'.repeat(64),
        ingest: { receivedAt: at(1), validatorVersion: 1 },
      }),
      JOURNAL_EVENT_TYPE,
    );
    expect(() => world.service.replay(world.orgId, world.missionId)).toThrowError(
      /JOURNAL_TAMPERED/,
    );
    world.ledger.close();
  });

  it('fails closed when the stored event digest does not match the stored event', () => {
    const world = makeWorld();
    world.service.ingest(
      world.orgId,
      envelope(world, { sequence: 1, observedAt: at(1), ingestedAt: at(1) }),
    );
    const row = world.ledger.db
      .prepare('SELECT seq, payload_json, payload_digest FROM evidence_events WHERE type = ?')
      .get(JOURNAL_EVENT_TYPE) as { seq: number; payload_json: string; payload_digest: string };
    world.ledger.db.prepare('DROP TRIGGER evidence_events_no_update').run();
    const payload = JSON.parse(row.payload_json) as { eventDigest: string };
    payload.eventDigest = '1'.repeat(64); // forge the inner digest…
    // …and recompute the outer digest so only the INNER check can catch it.
    const forgedDigest = createHash('sha256').update(canonicalJson(payload)).digest('hex');
    world.ledger.db
      .prepare('UPDATE evidence_events SET payload_json = ?, payload_digest = ? WHERE seq = ?')
      .run(JSON.stringify(payload), forgedDigest, row.seq);
    expect(() => world.service.replay(world.orgId, world.missionId)).toThrowError(
      MissionEventError,
    );
    world.ledger.close();
  });

  it('replay is tenant-scoped: a foreign mission id is MISSION_NOT_IN_ORG', () => {
    const world = makeWorld();
    expect(() => world.service.replay(world.orgId, world.foreignMissionId)).toThrowError(
      /MISSION_NOT_IN_ORG/,
    );
    expect(() => world.service.replay(world.foreignOrgId, world.missionId)).toThrowError(
      /MISSION_NOT_IN_ORG/,
    );
    world.ledger.close();
  });

  it('replay exposes latest per-kind readings with evidence references', () => {
    const world = makeWorld();
    world.service.ingest(
      world.orgId,
      envelope(world, {
        sequence: 1,
        observedAt: at(1),
        ingestedAt: at(1),
        observations: [
          { kind: 'asset_comms', unit: 'state', value: 'online' },
          { kind: 'wind_speed', unit: 'kt', value: '12.0' },
        ],
      }),
    );
    world.service.ingest(
      world.orgId,
      envelope(world, {
        sequence: 2,
        observedAt: at(2),
        ingestedAt: at(2),
        observations: [{ kind: 'wind_speed', unit: 'kt', value: '19.4' }],
      }),
    );
    const view = world.service.replay(world.orgId, world.missionId);
    const asset = view.assets['asset-uav-1']!;
    expect(asset.latest['wind_speed']!.value).toBe('19.4');
    expect(asset.latest['asset_comms']!.value).toBe('online'); // carried from event 1
    expect(asset.latest['wind_speed']!.eventId).toBeTruthy();
    expect(asset.comms).toBe('online');
    world.ledger.close();
  });

  it('deterministic journal payloads: the same envelope+clock always digests the same', () => {
    const world = makeWorld();
    const fixed = {
      eventId: 'mevt_fixed1',
      sequence: 1,
      observedAt: at(1),
      ingestedAt: at(1),
    };
    const readPayload = (): string =>
      (
        world.ledger.db.prepare('SELECT payload_json FROM evidence_events ORDER BY seq').get() as {
          payload_json: string;
        }
      ).payload_json;
    world.service.ingest(world.orgId, envelope(world, fixed));
    const first = readPayload();
    // Remove the row (as an admin with raw DB access would) and re-ingest the
    // SAME envelope under the SAME clock with a fresh service: the payload
    // must be identical — journal content is a pure function of (event, clock).
    world.ledger.db.prepare('DROP TRIGGER evidence_events_no_update').run();
    world.ledger.db.prepare('DROP TRIGGER evidence_events_no_delete').run();
    world.ledger.db.prepare('DELETE FROM evidence_events').run();
    const registry = new SourceRegistry();
    registry.registerAll([world.telemetrySource, world.gatewaySource]);
    const fresh = new MissionEventIngestService(world.ledger, world.clock, registry);
    fresh.ingest(world.orgId, envelope(world, fixed));
    expect(readPayload()).toBe(first);
    world.ledger.close();
  });
});
