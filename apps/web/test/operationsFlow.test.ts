import { describe, expect, it } from 'vitest';
import { eventsFromPayload, newestEvent } from '../src/lib/fieldEvents';
import { describeEvaluateError, nextEvaluation } from '../src/lib/operationsFlow';

describe('nextEvaluation — mirrors the server stage law without clicking into a refusal', () => {
  it('nothing admitted → nothing to evaluate', () => {
    expect(nextEvaluation({ eventCount: 0, hasBaseline: false, hasIncident: false })).toEqual({
      stage: null,
      reason: 'NO_OBSERVATIONS',
    });
    expect(nextEvaluation({ eventCount: null, hasBaseline: false, hasIncident: false })).toEqual({
      stage: null,
      reason: 'UNKNOWN',
    });
  });

  it('exactly one observation and no baseline → record the baseline', () => {
    expect(nextEvaluation({ eventCount: 1, hasBaseline: false, hasIncident: false })).toEqual({
      stage: 'baseline',
      again: false,
    });
  });

  it('several observations before a baseline → the window is closed (said plainly)', () => {
    expect(nextEvaluation({ eventCount: 3, hasBaseline: false, hasIncident: false })).toEqual({
      stage: null,
      reason: 'BASELINE_WINDOW_CLOSED',
    });
  });

  it('baseline recorded: wait for a new event, then evaluate incident (repeatable)', () => {
    expect(nextEvaluation({ eventCount: 1, hasBaseline: true, hasIncident: false })).toEqual({
      stage: null,
      reason: 'WAITING_FOR_NEW_OBSERVATION',
    });
    expect(nextEvaluation({ eventCount: 2, hasBaseline: true, hasIncident: false })).toEqual({
      stage: 'incident',
      again: false,
    });
    expect(nextEvaluation({ eventCount: 5, hasBaseline: true, hasIncident: true })).toEqual({
      stage: 'incident',
      again: true,
    });
  });

  it('typed server errors become operator words, never a blank failure', () => {
    expect(describeEvaluateError('BASELINE_SNAPSHOT_BEFORE_INCIDENT_REQUIRED', 409)).toMatch(
      /baseline evaluation first/,
    );
    expect(describeEvaluateError('NO_PHYSICAL_EVENT_ADMITTED', 409)).toMatch(/nothing to evaluate/);
    expect(describeEvaluateError('HTTP_403', 403)).toMatch(/operator or above/);
    expect(describeEvaluateError('SOMETHING_NEW', 418)).toContain('SOMETHING_NEW');
  });
});

describe('field journal parsing is defensive', () => {
  it('drops malformed entries instead of inventing values', () => {
    const { events, constraints } = eventsFromPayload({
      events: [
        null,
        { eventId: '' },
        'x',
        {
          eventId: 'evt_a',
          sequence: 2,
          journalSeq: 9,
          assetId: 'asset-1',
          sourceId: 'src-1',
          provenance: 'FIELD',
          observedAt: '2026-11-11T21:00:00.000Z',
          eventDigest: 'a'.repeat(64),
          observations: [
            { kind: 'wind_speed', unit: 'kt', value: '29.3' },
            { kind: 'bad', unit: 5, value: 1 },
            { kind: 'x', unit: 'y', value: { nested: true } },
          ],
          planningValidAtSnapshot: false,
        },
      ],
      constraints: [{ assetId: 'asset-1', state: 'blocked', reason: 'wind-limit', basis: 'b' }, 7],
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.observations).toEqual([{ kind: 'wind_speed', unit: 'kt', value: '29.3' }]);
    expect(events[0]!.planningValidAtSnapshot).toBe(false);
    expect(constraints).toHaveLength(1);
  });

  it('newestEvent picks the highest journal sequence', () => {
    const mk = (id: string, journalSeq: number) => ({
      eventId: id,
      journalSeq,
      sequence: 1,
      assetId: 'a',
      sourceId: 's',
      provenance: 'FIELD',
      observedAt: '',
      eventDigest: '',
      observations: [],
    });
    expect(newestEvent([mk('a', 3), mk('b', 7), mk('c', 5)])?.eventId).toBe('b');
    expect(newestEvent([])).toBeNull();
  });
});
