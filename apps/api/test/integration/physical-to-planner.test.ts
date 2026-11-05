import { describe, expect, it } from 'vitest';
import { reviewEvidence } from '@moterva/planner';
import { physicalTimelineToPlannerSafety } from '../../src/integration/physical-to-planner.js';
import type { AcceptedEventView, MissionTimelineView } from '../../src/mission-events/src/view.js';

const AS_OF = new Date('2026-11-06T09:20:00.000Z');
const POLICY = {
  orgId: 'org-demo',
  missionId: 'mission-demo',
  asOf: AS_OF,
  uavWindLimitKt: 22,
} as const;

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
    assetId: 'uav-seeker-1',
    sourceId: 'mission-control',
    sourceType: 'mission_control',
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

function timeline(events: AcceptedEventView[]): MissionTimelineView {
  return {
    orgId: POLICY.orgId,
    missionId: POLICY.missionId,
    asOf: AS_OF.toISOString(),
    policy: { maxAgeMs: 15 * 60_000, expiredMs: 30 * 60_000 },
    events,
    assets: {},
    streams: {},
  };
}

describe('admitted synthetic mission event → planner safety constraint', () => {
  const baseline = event(21, 'physical-clear', [
    { kind: 'wind_speed', unit: 'kt', value: '14.2' },
    { kind: 'weather_hold', unit: 'state', value: 'clear' },
    { kind: 'asset_comms', unit: 'state', value: 'online' },
  ]);
  const incident = event(22, 'physical-wind', [
    { kind: 'wind_speed', unit: 'kt', value: '24.6' },
    { kind: 'weather_hold', unit: 'state', value: 'active' },
  ], { sourceId: 'vessel-gateway', sourceType: 'vessel_gateway' });

  it('converts measured wind into a policy safety block, NEVER a forecast', () => {
    const output = physicalTimelineToPlannerSafety(timeline([baseline, incident]), POLICY);
    expect(output.evidence).toHaveLength(2);
    expect(output.evidence[0]?.constraint).toMatchObject({ kind: 'asset-safety', state: 'clear' });
    expect(output.evidence[1]?.constraint).toMatchObject({
      kind: 'asset-safety', state: 'blocked', reason: 'wind-limit',
      observedWindKt: 24.6, maxWindKt: 22,
    });
    expect(output.evidence.some((e) => e.constraint.kind === 'weather-window')).toBe(false);
    expect(output.evidence[1]?.source).toMatchObject({
      physicalSourceId: 'vessel-gateway',
      physicalSequence: 1,
      provenance: 'SYNTHETIC',
    });
  });

  it('retains separate source sequences without false planner regression', () => {
    const inputs = physicalTimelineToPlannerSafety(timeline([baseline, incident]), POLICY).evidence;
    const review = reviewEvidence([...inputs], AS_OF, {
      orgId: POLICY.orgId, missionId: POLICY.missionId,
    });
    expect(review.accepted).toHaveLength(2);
    expect(review.rejected).toHaveLength(0);
    expect(review.accepted.map((x) => x.input.event.sequence)).toEqual([21, 22]);
    expect(review.accepted.map((x) => x.input.event.id)).toEqual(['physical-clear', 'physical-wind']);
  });

  it('withholds stale physical evidence without erasing journal history', () => {
    const stale = event(22, 'physical-old', [
      { kind: 'wind_speed', unit: 'kt', value: '24.6' },
    ], {
      observedAt: '2026-11-06T08:59:00.000Z',
      ingestedAt: '2026-11-06T08:59:02.000Z',
      freshness: 'stale',
      planningValid: false,
    });
    const output = physicalTimelineToPlannerSafety(timeline([baseline, stale]), POLICY);
    expect(output.evidence).toHaveLength(1);
    expect(output.withheldEventIds).toContain('physical-old');
    expect(output.evidence[0]?.constraint).toMatchObject({ state: 'clear' });
  });

  it('fails closed on a foreign tenant, invalid limit or mismatched simulation clock', () => {
    const view = timeline([baseline]);
    expect(() => physicalTimelineToPlannerSafety(view, { ...POLICY, orgId: 'foreign' })).toThrow();
    expect(() => physicalTimelineToPlannerSafety(view, { ...POLICY, uavWindLimitKt: Number.NaN })).toThrow();
    expect(() => physicalTimelineToPlannerSafety(view, {
      ...POLICY, asOf: new Date('2026-11-06T09:21:00.000Z'),
    })).toThrow();
  });
});
