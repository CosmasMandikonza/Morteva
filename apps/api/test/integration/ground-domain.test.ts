import { describe, expect, it } from 'vitest';
import { reviewEvidence } from '@moterva/planner';
import { physicalTimelineToPlannerSafety } from '../../src/integration/physical-to-planner.js';
import type { AcceptedEventView, MissionTimelineView } from '../../src/mission-events/src/view.js';

/**
 * Ground-domain bridge semantics (MTV-07, issue #9; audit gap G1).
 *
 * A warehouse ground robot must never inherit aerial wind policy: a UAV
 * wind limit is not a ground constraint, and missing aerial readings must
 * not be mistaken for ground safety. Until Agent A's ground-clearance
 * contract lands, a declared ground asset is `blocked/comms-offline` when
 * comms are offline and otherwise `unknown/insufficient-evidence` — never
 * `clear`. Aerial and UNDECLARED assets keep the historical state machine
 * byte-for-byte (harbor behavior and the 45-case matrix are unchanged).
 */

const AS_OF = new Date('2026-11-06T09:20:00.000Z');

function event(
  journalSeq: number,
  eventId: string,
  observations: AcceptedEventView['observations'],
  overrides: Partial<AcceptedEventView> = {},
): AcceptedEventView {
  return {
    journalSeq,
    eventId,
    sequence: 1,
    assetId: 'robot-counter-3',
    sourceId: 'robot-telemetry',
    sourceType: 'asset_telemetry',
    provenance: 'SYNTHETIC',
    observedAt: '2026-11-06T09:19:00.000Z',
    ingestedAt: '2026-11-06T09:19:02.000Z',
    recordedAt: '2026-11-06T09:19:03.000Z',
    eventDigest: 'sha256-accepted-journal-' + eventId,
    observations,
    freshness: 'fresh',
    planningValid: true,
    ...overrides,
  };
}

function timeline(events: AcceptedEventView[], missionId = 'mission-warehouse'): MissionTimelineView {
  return {
    orgId: 'org-demo',
    missionId,
    asOf: AS_OF.toISOString(),
    policy: { maxAgeMs: 15 * 60_000, expiredMs: 30 * 60_000 },
    events,
    assets: {},
    streams: {},
  };
}

const GROUND_POLICY = {
  orgId: 'org-demo',
  missionId: 'mission-warehouse',
  asOf: AS_OF,
  uavWindLimitKt: 22,
  assetKinds: { 'robot-counter-3': 'ground' },
} as const;

describe('ground-domain bridge semantics (declared ground asset)', () => {
  it('never applies the aerial wind threshold: 30 kt wind does NOT block a ground robot', () => {
    const output = physicalTimelineToPlannerSafety(
      timeline([
        event(1, 'g1', [
          { kind: 'wind_speed', unit: 'kt', value: '30.0' }, // above the UAV limit
          { kind: 'asset_comms', unit: 'state', value: 'online' },
        ]),
      ]),
      GROUND_POLICY,
    );
    expect(output.evidence).toHaveLength(1);
    expect(output.evidence[0]?.constraint).toMatchObject({
      kind: 'asset-safety',
      state: 'unknown',
      reason: 'insufficient-evidence',
    });
    // The wind figure did not participate: no aerial attribution on the constraint.
    expect(output.evidence[0]?.constraint.observedWindKt).toBeUndefined();
    expect(output.evidence[0]?.constraint.maxWindKt).toBeUndefined();
  });

  it('never lets calm aerial readings CLEAR a ground robot (no inherited clearance)', () => {
    const output = physicalTimelineToPlannerSafety(
      timeline([
        event(1, 'g1', [
          { kind: 'wind_speed', unit: 'kt', value: '5.0' },
          { kind: 'weather_hold', unit: 'state', value: 'clear' },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
        ]),
      ]),
      GROUND_POLICY,
    );
    // The same readings on an UNDECLARED asset would be clear/nominal.
    expect(output.evidence[0]?.constraint).toMatchObject({
      state: 'unknown',
      reason: 'insufficient-evidence',
    });
  });

  it('blocks a ground robot on comms loss (domain-neutral condition) without wind attribution', () => {
    const output = physicalTimelineToPlannerSafety(
      timeline([event(1, 'g1', [{ kind: 'asset_comms', unit: 'state', value: 'offline' }])]),
      GROUND_POLICY,
    );
    expect(output.evidence[0]?.constraint).toMatchObject({
      state: 'blocked',
      reason: 'comms-offline',
    });
    expect(output.evidence[0]?.constraint.observedWindKt).toBeUndefined();
  });

  it('keeps journaled wind/hold integrity checks for ground assets (malformed journaled values still fail closed)', () => {
    expect(() =>
      physicalTimelineToPlannerSafety(
        timeline([event(1, 'g1', [{ kind: 'wind_speed', unit: 'kt', value: 'not-a-wind' }])]),
        GROUND_POLICY,
      ),
    ).toThrow('INVALID_JOURNALED_WIND_OBSERVATION');
    expect(() =>
      physicalTimelineToPlannerSafety(
        timeline([event(1, 'g1', [{ kind: 'weather_hold', unit: 'state', value: 'maybe' }])]),
        GROUND_POLICY,
      ),
    ).toThrow('INVALID_JOURNALED_HOLD');
  });

  it('feeds the planner: ground unknown gates asset-dependent spend via the existing ASSET_SAFETY gate', () => {
    const output = physicalTimelineToPlannerSafety(
      timeline([event(1, 'g1', [{ kind: 'asset_comms', unit: 'state', value: 'online' }])]),
      GROUND_POLICY,
    );
    const review = reviewEvidence([...output.evidence], AS_OF, {
      orgId: GROUND_POLICY.orgId,
      missionId: GROUND_POLICY.missionId,
    });
    expect(review.rejected).toHaveLength(0);
    expect(review.accepted).toHaveLength(1);
    expect(review.accepted[0]?.input.constraint).toMatchObject({ state: 'unknown' });
    // The planner's evaluate gate (existing contract, no changes) refuses
    // any candidate that requires this asset while its clearance != clear.
  });

  it('an UNDECLARED asset keeps historical semantics (calm aerial readings still clear it)', () => {
    const output = physicalTimelineToPlannerSafety(
      timeline([
        event(1, 'g1', [
          { kind: 'wind_speed', unit: 'kt', value: '10.0' },
          { kind: 'weather_hold', unit: 'state', value: 'clear' },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
        ]),
      ]),
      { ...GROUND_POLICY, assetKinds: { 'some-other-asset': 'ground' } },
    );
    expect(output.evidence[0]?.constraint).toMatchObject({ state: 'clear', reason: 'nominal' });
  });

  it('rejects an invalid assetKinds value at the policy boundary', () => {
    expect(() =>
      physicalTimelineToPlannerSafety(timeline([]), {
        ...GROUND_POLICY,
        assetKinds: { 'robot-counter-3': 'submarine' as never },
      }),
    ).toThrow('INVALID_PHYSICAL_BRIDGE_SCOPE_OR_POLICY');
  });

  it('outcomes track observations, not asset id strings (no-hardcoding proof at the bridge)', () => {
    // The SAME observation stream under three different asset id strings
    // (including the harbor UAV's id) produces identical ground verdicts.
    const verdicts: Array<string> = [];
    for (const assetId of ['robot-counter-3', 'uav-seeker-1', 'any-asset-id-xz']) {
      const output = physicalTimelineToPlannerSafety(
        timeline([
          { ...event(1, 'g1', [{ kind: 'asset_comms', unit: 'state', value: 'offline' }]), assetId },
        ]),
        { ...GROUND_POLICY, assetKinds: { [assetId]: 'ground' } },
      );
      expect(output.evidence[0]?.asset.id).toBe(assetId);
      verdicts.push(
        `${output.evidence[0]?.constraint.state}/${output.evidence[0]?.constraint.reason}`,
      );
    }
    expect(new Set(verdicts).size).toBe(1);
    expect(verdicts[0]).toBe('blocked/comms-offline');
  });
});
