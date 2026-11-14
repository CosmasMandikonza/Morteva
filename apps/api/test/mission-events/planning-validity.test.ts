/**
 * CTO correction C — stale evidence must never authorize planning (issue #9
 * review). Before the correction, `planningValid` was `freshness !==
 * 'expired'`, so STALE evidence influenced consequential planning. Now only
 * FRESH evidence is planning-valid; stale/expired rows stay visible as
 * digest-verifiable journal history. These tests pin the exact thresholds
 * (one millisecond either side), clock skew, unparseable timestamps, and
 * later-clock replay — plus the explicit journal-validity vs
 * planning-eligibility distinction.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_FRESHNESS_POLICY, freshnessOf } from '../../src/mission-events/index.js';
import { at, envelope, makeWorld } from './helpers.js';

const POLICY = DEFAULT_FRESHNESS_POLICY; // maxAgeMs 900000, expiredMs 1800000
const OBSERVED = '2026-11-06T12:00:00.000Z';
const NOW = Date.parse(OBSERVED);

describe('CTO correction C — only fresh evidence is planning-valid', () => {
  describe('freshnessOf boundary precision', () => {
    it('fresh up to exactly maxAgeMs − 1ms', () => {
      expect(freshnessOf(OBSERVED, NOW + POLICY.maxAgeMs - 1, POLICY)).toBe('fresh');
    });

    it('stale AT the threshold (age == maxAgeMs) — one millisecond matters', () => {
      expect(freshnessOf(OBSERVED, NOW + POLICY.maxAgeMs, POLICY)).toBe('stale');
      expect(freshnessOf(OBSERVED, NOW + POLICY.maxAgeMs + 1, POLICY)).toBe('stale');
    });

    it('expired at expiredMs and beyond', () => {
      expect(freshnessOf(OBSERVED, NOW + POLICY.expiredMs, POLICY)).toBe('expired');
      expect(freshnessOf(OBSERVED, NOW + POLICY.expiredMs + 1, POLICY)).toBe('expired');
      // The stale window is the half-open interval [maxAgeMs, expiredMs).
      expect(freshnessOf(OBSERVED, NOW + POLICY.expiredMs - 1, POLICY)).toBe('stale');
    });

    it('bounded future clock skew stays fresh (arrival tolerance is enforced at ingest)', () => {
      // observedAt slightly AHEAD of the read clock (within the 2-minute
      // ingest tolerance): negative age is fresh, never below-zero weirdness.
      expect(freshnessOf(OBSERVED, NOW - 120_000, POLICY)).toBe('fresh');
      expect(freshnessOf(OBSERVED, NOW - 1, POLICY)).toBe('fresh');
    });

    it('an unparseable timestamp is never planning-eligible (expired, fail closed)', () => {
      expect(freshnessOf('not-a-timestamp', NOW, POLICY)).toBe('expired');
      expect(freshnessOf('', NOW, POLICY)).toBe('expired');
    });
  });

  describe('replay view planning eligibility', () => {
    it('planningValid is true ONLY for fresh events — exact boundary, one millisecond either side', () => {
      const world = makeWorld();
      world.service.ingest(
        world.orgId,
        envelope(world, { sequence: 1, observedAt: at(1), ingestedAt: at(1) }),
      );
      // The clock now sits exactly at observedAt; age 0. Walk to the boundary.
      world.clock.advance(POLICY.maxAgeMs - 1); // age = maxAge − 1ms
      let view = world.service.replay(world.orgId, world.missionId);
      expect(view.events[0]!.freshness).toBe('fresh');
      expect(view.events[0]!.planningValid).toBe(true);
      // Cross the boundary by exactly 1 ms: stale → NOT planning-valid.
      world.clock.advance(1);
      view = world.service.replay(world.orgId, world.missionId);
      expect(view.events[0]!.freshness).toBe('stale');
      expect(view.events[0]!.planningValid).toBe(false);
      world.ledger.close();
    });

    it('stale/expired evidence remains visible as JOURNAL history with digests — never deleted or rewritten', () => {
      const world = makeWorld();
      for (const sequence of [1, 2]) {
        world.service.ingest(
          world.orgId,
          envelope(world, { sequence, observedAt: at(sequence), ingestedAt: at(sequence) }),
        );
      }
      world.clock.advance(POLICY.expiredMs + 60_000); // both events now expired
      const view = world.service.replay(world.orgId, world.missionId);
      expect(view.events).toHaveLength(2); // history preserved
      expect(view.events.every((e) => e.freshness === 'expired')).toBe(true);
      expect(view.events.every((e) => e.planningValid === false)).toBe(true);
      expect(view.events.every((e) => e.eventDigest.match(/^[0-9a-f]{64}$/) !== null)).toBe(true);
      world.ledger.close();
    });

    it('a mixed timeline splits cleanly: only the fresh tail is planning-eligible', () => {
      const world = makeWorld();
      // Event 1 is old; event 2 is recent.
      world.service.ingest(
        world.orgId,
        envelope(world, { sequence: 1, observedAt: at(1), ingestedAt: at(1) }),
      );
      world.clock.advance(31 * 60_000); // event 1 is now older than expiredMs
      world.service.ingest(
        world.orgId,
        envelope(world, { sequence: 2, observedAt: at(32), ingestedAt: at(32) }),
      );
      const view = world.service.replay(world.orgId, world.missionId);
      expect(view.events[0]!.freshness).toBe('expired'); // 31 min old
      expect(view.events[0]!.planningValid).toBe(false);
      expect(view.events[1]!.freshness).toBe('fresh'); // just observed
      expect(view.events[1]!.planningValid).toBe(true);
      world.ledger.close();
    });

    it('replay at a later simulated clock flips eligibility without touching the journal', () => {
      const world = makeWorld();
      world.service.ingest(
        world.orgId,
        envelope(world, { sequence: 1, observedAt: at(1), ingestedAt: at(1) }),
      );
      const before = world.service.replay(world.orgId, world.missionId);
      expect(before.events[0]!.planningValid).toBe(true);
      const journalCount = (
        world.ledger.db
          .prepare(`SELECT COUNT(*) AS c FROM evidence_events WHERE topic = 'operational'`)
          .get() as { c: number }
      ).c;
      // Simulate "read the same mission an hour later".
      world.clock.advance(60 * 60_000);
      const after = world.service.replay(world.orgId, world.missionId);
      expect(after.events[0]!.planningValid).toBe(false);
      expect(after.events[0]!.freshness).toBe('expired');
      // The journal itself is unchanged — eligibility is read-time only.
      const journalCountAfter = (
        world.ledger.db
          .prepare(`SELECT COUNT(*) AS c FROM evidence_events WHERE topic = 'operational'`)
          .get() as { c: number }
      ).c;
      expect(journalCountAfter).toBe(journalCount);
      world.ledger.close();
    });

    it('per-asset latest readings expose freshness so consumers can require fresh evidence per kind', () => {
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
      world.clock.advance(POLICY.maxAgeMs + 5_000);
      const view = world.service.replay(world.orgId, world.missionId);
      const asset = view.assets['asset-uav-1']!;
      expect(asset.latest['wind_speed']!.freshness).toBe('stale');
      expect(view.events[0]!.planningValid).toBe(false);
      world.ledger.close();
    });
  });
});
