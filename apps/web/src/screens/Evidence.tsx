import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { MissionEvidenceEventView } from '@moterva/domain';
import { Panel, SkeletonRows } from '../components/Panel';
import { fetchMissionEvidence, type MissionRow, type SessionState } from '../lib/api';
import { formatDate, shortId } from '../lib/format';
import { CopyButton, HaloSegmented, SidePanel } from '../components/ui';

type MissionContext = Pick<MissionRow, 'id' | 'title' | 'status' | 'created_at'>;

type EvidenceLoad =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; events: readonly MissionEvidenceEventView[] };

/**
 * Evidence Replay (MTV-20) — causal investigation layout: chronological
 * evidence rail (left/primary) with a selected-event detail inspector
 * (Side Panel on desktop). Selecting an event never triggers any write; it
 * only drives the detail view. One mission/event identity throughout.
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
  const [selected, setSelected] = useState<MissionEvidenceEventView | null>(null);
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

  // Keep the selection pointing at the same identity across refetches.
  useEffect(() => {
    if (load.kind !== 'ok') return;
    if (selected === null) return;
    const fresh = load.events.find((e) => e.id === selected.id);
    if (fresh === undefined) setSelected(null);
    else if (fresh !== selected) setSelected(fresh);
  }, [load, selected]);

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

  const selectedPayload = selected?.payload as Record<string, unknown> | null;

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
        <HaloSegmented
          ariaLabel="Evidence topic"
          options={[
            { id: 'all', label: 'All' },
            { id: 'financial', label: 'Financial' },
            { id: 'operational', label: 'Operational' },
          ]}
          value={topic}
          onChange={setTopic}
        />
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
            const isSel = selected?.id === event.id;
            return (
              <li
                className={`mv-evidence__event${isSel ? ' is-selected' : ''}`}
                key={event.id}
                data-seq={event.seq}
              >
                <button
                  type="button"
                  className="mv-evidence__select"
                  aria-pressed={isSel}
                  onClick={() => setSelected(isSel ? null : event)}
                >
                  <span className="mv-evidence__seq mv-num">#{String(event.seq)}</span>
                  <div className="mv-evidence__body">
                    <p className="mv-evidence__type">
                      <span className="mv-evidence__topic mv-hud">{event.topic}</span>{' '}
                      {event.type ?? 'journal event'}
                    </p>
                    {payload !== null && (
                      <dl className="mv-evidence__payload">
                        {Object.entries(payload)
                          .slice(0, 4)
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
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <p className="mv-panel__note">
        Append-only internal journal, newest first. Payloads are the API&rsquo;s allowlisted
        projection — physical-world observations are labeled by topic and are never provider truth.
      </p>

      {selected !== null && (
        <SidePanel
          title={`Event #${String(selected.seq)} — ${selected.type ?? 'journal event'}`}
          testId="evidence-detail"
          onClose={() => setSelected(null)}
        >
          <dl className="mv-mandate__meta">
            <div>
              <dt>Journal seq</dt>
              <dd className="mv-num">#{String(selected.seq)}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{selected.type ?? 'journal event'}</dd>
            </div>
            <div>
              <dt>Topic</dt>
              <dd>
                <HaloSegmented
                  ariaLabel="Selected event topic (read-only display)"
                  options={[{ id: selected.topic, label: selected.topic }]}
                  value={selected.topic}
                  onChange={() => undefined}
                />
              </dd>
            </div>
            <div>
              <dt>Recorded</dt>
              <dd>{formatDate(selected.recordedAt)}</dd>
            </div>
            <div>
              <dt>Payload digest</dt>
              <dd>
                <span className="mv-num mv-break" title={selected.payloadDigest}>
                  {selected.payloadDigest}
                </span>
                <CopyButton value={selected.payloadDigest} label="digest" />
              </dd>
            </div>
            <div>
              <dt>Event key</dt>
              <dd className="mv-num mv-break">{selected.eventKey ?? '—'}</dd>
            </div>
          </dl>
          <h4 className="mv-droom__secttitle">Full payload (allowlisted projection)</h4>
          {selectedPayload === null ? (
            <p className="mv-governed__note">No allowlisted payload projection for this event.</p>
          ) : (
            <dl className="mv-mandate__meta">
              {Object.entries(selectedPayload).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd className="mv-num mv-break">
                    {typeof value === 'string' || typeof value === 'number'
                      ? String(value)
                      : JSON.stringify(value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <p className="mv-governed__note">
            Replay is read-only by construction: inspecting history never repeats a provider
            operation and never creates a new financial decision. Linked plan/approval identities
            above carry through the Decision Room and Authority surfaces.
          </p>
        </SidePanel>
      )}
    </Panel>
  );
}

export { Evidence as EvidenceReplay };
