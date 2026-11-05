import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { MissionEvidenceEventView } from '@moterva/domain';
import { Panel, SkeletonRows } from '../components/Panel';
import { fetchMissionEvidence, type MissionRow, type SessionState } from '../lib/api';
import { formatDate, shortId } from '../lib/format';

type MissionContext = Pick<MissionRow, 'id' | 'title' | 'status' | 'created_at'>;

type EvidenceLoad =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; events: readonly MissionEvidenceEventView[] };

/**
 * Evidence Replay — real append-only journal (#37) for the selected mission,
 * newest first (seq descending = replay order). The operator can filter by
 * topic and — when arriving from an operation inspector — see exactly the
 * events for THAT operation identity, never an invented causal link.
 */
export function Evidence({
  session,
  mission,
  operationFilter,
  onClearOperationFilter,
}: {
  session: SessionState;
  mission: MissionContext | null;
  operationFilter: string | null;
  onClearOperationFilter: () => void;
}): JSX.Element {
  const [load, setLoad] = useState<EvidenceLoad>({ kind: 'loading' });
  const [topic, setTopic] = useState<'all' | 'financial' | 'operational'>('all');
  const signedIn = session.kind === 'signed-in';

  useEffect(() => {
    if (!signedIn || mission === null) {
      setLoad({ kind: 'loading' });
      return;
    }
    const controller = new AbortController();
    setLoad({ kind: 'loading' });
    fetchMissionEvidence(
      mission.id,
      { topic: topic === 'all' ? undefined : topic, limit: 50 },
      controller.signal,
    )
      .then((list) => setLoad({ kind: 'ok', events: list.events }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      });
    return () => controller.abort();
  }, [signedIn, mission, topic]);

  const events = load.kind === 'ok' ? load.events : [];
  const filtered = useMemo(() => {
    if (operationFilter === null) return events;
    return events.filter((e) => {
      const payload = e.payload as Record<string, unknown> | null;
      return payload !== null && payload.operationId === operationFilter;
    });
  }, [events, operationFilter]);

  if (!signedIn) {
    return (
      <Panel title="Evidence Replay" meta={<span className="mv-tag">sign-in required</span>}>
        <p className="mv-empty">Mission evidence requires an authenticated session.</p>
      </Panel>
    );
  }
  if (mission === null) {
    return (
      <Panel title="Evidence Replay" meta={<span className="mv-tag">no mission selected</span>}>
        <p className="mv-empty">Select a mission in the Mission Treasury to replay its evidence.</p>
      </Panel>
    );
  }

  return (
    <Panel
      title="Evidence Replay"
      meta={
        <span className="mv-num mv-panel__crumb" title={mission.id}>
          {shortId(mission.id)} · {mission.title}
        </span>
      }
      testId="evidence-panel"
    >
      <div className="mv-evidence__bar">
        <div className="mv-seg" role="tablist" aria-label="Evidence topic">
          {(['all', 'financial', 'operational'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={topic === t}
              className={`mv-seg__btn ${topic === t ? 'is-active' : ''}`}
              onClick={() => setTopic(t)}
            >
              {t}
            </button>
          ))}
        </div>
        {operationFilter !== null && (
          <button
            type="button"
            className="mv-btn mv-btn--ghost"
            onClick={onClearOperationFilter}
            data-testid="clear-op-filter"
          >
            operation filter: {shortId(operationFilter)} ✕
          </button>
        )}
      </div>

      {load.kind === 'loading' && <SkeletonRows rows={4} />}
      {load.kind === 'error' && (
        <div className="mv-alert" role="alert">
          <p className="mv-alert__body">{load.message}</p>
        </div>
      )}
      {load.kind === 'ok' && filtered.length === 0 && (
        <p className="mv-empty" data-testid="evidence-empty">
          {operationFilter !== null
            ? `No journal events reference operation ${shortId(operationFilter)} under this topic.`
            : 'No events recorded for this mission yet.'}
        </p>
      )}
      {load.kind === 'ok' && filtered.length > 0 && (
        <ol className="mv-evidence" data-testid="evidence-list">
          {filtered.map((event) => {
            const payload = event.payload as Record<string, unknown> | null;
            return (
              <li className="mv-evidence__event" key={event.id} data-seq={event.seq}>
                <span className="mv-evidence__seq mv-num">#{String(event.seq)}</span>
                <div className="mv-evidence__body">
                  <p className="mv-evidence__type">
                    <span className="mv-evidence__topic mv-hud">{event.topic}</span>{' '}
                    {event.type ?? 'journal event'}
                  </p>
                  {payload !== null && (
                    <dl className="mv-evidence__payload">
                      {Object.entries(payload)
                        .slice(0, 6)
                        .map(([key, value]) => (
                          <div key={key}>
                            <dt>{key}</dt>
                            <dd className="mv-num">
                              {typeof value === 'string'
                                ? value.length > 40
                                  ? shortId(value)
                                  : value
                                : String(value)}
                            </dd>
                          </div>
                        ))}
                    </dl>
                  )}
                  <p className="mv-evidence__meta">
                    {formatDate(event.recordedAt)} · digest{' '}
                    <span className="mv-num">{shortId(event.payloadDigest)}</span>
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <p className="mv-panel__note">
        Append-only internal journal, newest first. Payloads are the API&rsquo;s allowlisted
        projection — physical-world observations are labeled by topic and are never provider truth.
      </p>
    </Panel>
  );
}

export { Evidence as EvidenceReplay };
