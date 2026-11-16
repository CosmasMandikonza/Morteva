/**
 * Evidence Replay (MTV-20 polish pass) — a compact, auditable mission
 * history in the spirit of Sentry's event stream and Linear's activity
 * views: newest-first by verified journal sequence, honest one-line
 * summaries from KNOWN event types and allowlisted payload fields only,
 * full factual detail one click away in the Side Panel inspector.
 *
 * Integrity laws carried over unchanged:
 *  - read-only replay (inspecting history never writes anything);
 *  - the API's allowlisted payload projection is the only payload shown;
 *  - journal ordering (seq desc) and topic classification come from the
 *    server; this screen never re-types or re-orders evidence;
 *  - internal journal evidence, signed field claims and provider-verified
 *    financial facts are visually distinguished (see evidenceTiers).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { MissionEvidenceEventView } from '@moterva/domain';
import { Panel, SkeletonRows } from '../components/Panel';
import { fetchMissionEvidence, type MissionRow, type SessionState } from '../lib/api';
import { formatDate, shortId } from '../lib/format';
import { CopyButton, HaloSegmented, SidePanel } from '../components/ui';
import './evidence-polish.css';

type MissionContext = Pick<MissionRow, 'id' | 'title' | 'status' | 'created_at'>;

type EvidenceLoad =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; events: readonly MissionEvidenceEventView[] };

type Topic = 'all' | 'financial' | 'operational';

/**
 * How much corroboration an event row carries. This is a display tier over
 * facts the journal already states — it never upgrades trust:
 *  - journal  : internal record of a system action or observation
 *  - field    : signed field/sensor claim ingested through a source
 *  - provider : provider-verified financial fact (readback/receipt-backed)
 */
type EvidenceTier = 'journal' | 'field' | 'provider';

interface EventPresentation {
  readonly title: string;
  readonly summary: string | null;
  readonly tier: EvidenceTier;
}

/** The event name alone cannot prove provider verification. In particular,
 *  internal holds can be SETTLED/RECONCILED without any external dispatch,
 *  and an unknown/failed dispatch result is explicitly NOT verified. The
 *  allowlisted reconciliation projection contains the provider's readback
 *  status and timestamp, so only a confirmed, dated readback earns this tier.
 */
function isProviderVerifiedReadback(event: MissionEvidenceEventView): boolean {
  if (event.type !== 'dispatch.reconcile') return false;
  const payload = event.payload as Record<string, unknown> | null;
  if (payload?.providerStatus !== 'confirmed') return false;
  const verifiedAt = payload.verifiedAt;
  return typeof verifiedAt === 'string' && Number.isFinite(Date.parse(verifiedAt));
}

/** Ingest can also carry a SYNTHETIC test event. Its name alone must not
 *  award the stronger signed-field tier. Provenance is explicitly projected
 *  by the server; absent provenance remains ordinary journal evidence. */
function isSignedFieldClaim(event: MissionEvidenceEventView): boolean {
  if (event.type !== 'mission.event.ingested') return false;
  const payload = event.payload as Record<string, unknown> | null;
  return payload?.provenance === 'FIELD';
}

/**
 * Honest, conservative copy for every event type the engines write today
 * (inventoried from the ledger services, routes and integration modules).
 * Titles report WHAT WAS RECORDED, never an outcome the journal does not
 * state: "operation reconciliation recorded", not "funds settled".
 */
const EVENT_COPY: Readonly<Record<string, string>> = {
  // actor / identity / access
  'actor.created': 'Team member account created',
  'actor.revoked': 'Team member access revoked',
  'session.created': 'Signed-in session recorded',
  'identity.linked': 'External identity linked',
  'identity.provisioned': 'Identity actor provisioned',
  'identity.revoked': 'Identity actor revoked',
  'invitation.created': 'Invitation issued',
  'invitation.redeemed': 'Invitation redeemed',
  'invitation.revoked': 'Invitation revoked',
  'grant.created': 'Mission access granted',
  'grant.revoked': 'Mission access revoked',
  // financial authority
  'mandate.issued': 'Spending mandate issued',
  'mandate.revoked': 'Spending mandate revoked',
  'approval.granted': 'Plan approval granted',
  'approval.revoked': 'Approval revoked',
  'reservation.denied': 'Reservation refused',
  'token_asset.registered': 'Token asset registered',
  'token_asset.revoked': 'Token asset registration revoked',
  'token_balance.observed': 'Token balance observation recorded',
  'balance.snapshot': 'Balance snapshot recorded',
  // operations (transition events are all "recorded" — the journal states
  // the state change, not provider truth; only readback-backed types tier up)
  'operation.reserved': 'Funds reservation recorded',
  'operation.submitting': 'Provider submission started',
  'operation.in_flight': 'Operation in flight',
  'operation.status_unknown': 'Outcome recorded as unknown',
  'operation.settled': 'Operation settlement recorded',
  'operation.reconciled': 'Operation reconciliation recorded',
  'operation.cancelled': 'Operation cancellation recorded',
  'operation.rejected': 'Operation rejection recorded',
  'operation.expired': 'Operation expiry recorded',
  'operation.requires_human': 'Human decision requested',
  // dispatch
  'dispatch.attempt': 'Provider dispatch attempt recorded',
  'dispatch.result': 'Provider dispatch result recorded',
  'dispatch.blocked': 'Dispatch blocked before send',
  'dispatch.unknown': 'Dispatch outcome unknown',
  'dispatch.reconcile': 'Dispatch reconciliation recorded',
  'settlement.reversed': 'Settlement reversal recorded',
  'settlement.reversed.after_reconciled': 'Late reversal recorded',
  // planner / decision
  'planner.decision.snapshot': 'Planner decision snapshot recorded',
  'planner.plan.proposed': 'Plan proposed from decision',
  'model.interpretation': 'Model interpretation recorded',
  'planner.decision': 'Planner decision recorded',
  // mission sources & spec
  'mission.source.registered': 'Event source registered',
  'mission.source.revoked': 'Event source revoked',
  'mission.source.resealed': 'Event source credentials resealed',
  'mission.spec.registered': 'Mission specification registered',
  // operational ingest
  'mission.event.ingested': 'Field event ingested',
  'inspection.finding': 'Inspection finding recorded',
};

function safeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function safeAmount(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return String(value);
}

/**
 * Builds the one-line explanation ONLY from fields the allowlisted payload
 * projection is known to carry for each type. Unknown shapes contribute
 * nothing — the summary simply stays null (title + tier only).
 */
function summarize(type: string, payload: Record<string, unknown> | null): string | null {
  if (payload === null) return null;
  const parts: string[] = [];
  const push = (s: string | null) => {
    if (s !== null && parts.length < 3) parts.push(s);
  };
  switch (type) {
    case 'mandate.issued':
    case 'mandate.revoked': {
      push(safeText(payload.currency) !== null ? `mandate · ${safeText(payload.currency)}` : null);
      const max = safeAmount(payload.maxAmountMinor) ?? safeAmount(payload.max_amount_minor);
      if (max !== null) push(`cap ${max} minor`);
      break;
    }
    case 'approval.granted':
    case 'approval.revoked': {
      push(safeText(payload.kind) !== null ? `approval kind ${safeText(payload.kind)}` : null);
      break;
    }
    case 'operation.reserved':
    case 'operation.submitting':
    case 'operation.in_flight':
    case 'operation.settled':
    case 'operation.reconciled':
    case 'operation.cancelled':
    case 'operation.rejected':
    case 'operation.expired':
    case 'operation.requires_human':
    case 'operation.status_unknown': {
      const from = safeText(payload.from);
      const to = safeText(payload.to);
      if (from !== null && to !== null) push(`${from} → ${to}`);
      const currency = safeText(payload.currency);
      const amount = safeAmount(payload.amountMinor);
      if (currency !== null && amount !== null) push(`${amount} ${currency} minor`);
      break;
    }
    case 'dispatch.attempt':
    case 'dispatch.result':
    case 'dispatch.blocked':
    case 'dispatch.unknown':
    case 'dispatch.reconcile': {
      push(safeText(payload.rail) !== null ? `rail ${safeText(payload.rail)}` : null);
      push(safeText(payload.outcome) ?? safeText(payload.status));
      break;
    }
    case 'planner.decision.snapshot':
    case 'planner.plan.proposed': {
      push(safeText(payload.stage) ?? safeText(payload.decision));
      break;
    }
    case 'mission.event.ingested': {
      push(safeText(payload.eventType));
      const asset = safeText(payload.assetId);
      if (asset !== null) push(`asset ${shortId(asset)}`);
      break;
    }
    case 'inspection.finding': {
      const turbine = safeText(payload.turbine);
      if (turbine !== null) push(`turbine ${turbine}`);
      push(safeText(payload.recommendation));
      break;
    }
    case 'actor.created':
    case 'identity.provisioned': {
      push(safeText(payload.role) !== null ? `role ${safeText(payload.role)}` : null);
      break;
    }
    case 'token_balance.observed': {
      const currency = safeText(payload.currency);
      const minor = safeAmount(payload.minorUnits);
      if (currency !== null && minor !== null) push(`${minor} ${currency} minor`);
      break;
    }
    default:
      break;
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function presentEvent(event: MissionEvidenceEventView): EventPresentation {
  const type = event.type ?? '';
  const payload = (event.payload ?? null) as Record<string, unknown> | null;
  const known = Object.prototype.hasOwnProperty.call(EVENT_COPY, type);
  const title = known ? (EVENT_COPY[type] as string) : 'Journal event recorded';
  const tier: EvidenceTier = isProviderVerifiedReadback(event)
    ? 'provider'
    : isSignedFieldClaim(event)
      ? 'field'
      : 'journal';
  const summary = known ? summarize(type, payload) : null;
  return { title, summary, tier };
}

function tierLabel(tier: EvidenceTier): string {
  switch (tier) {
    case 'provider':
      return 'provider-verified';
    case 'field':
      return 'field claim';
    default:
      return 'journal';
  }
}

function relativeDay(iso: string, nowMs: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return formatDate(iso);
  const day = 86_400_000;
  const delta = Math.floor((nowMs - ms) / day);
  if (delta <= 0) return 'today';
  if (delta === 1) return 'yesterday';
  if (delta < 7) return `${String(delta)} days ago`;
  return formatDate(iso);
}

const SEARCHABLE_FIELDS = [
  'type',
  'eventKey',
  'eventId',
  'operationId',
  'planId',
  'evaluationId',
  'sourceId',
  'assetId',
  'currency',
  'rail',
  'role',
  'stage',
  'eventType',
  'from',
  'to',
];

function eventSearchText(event: MissionEvidenceEventView, presentation: EventPresentation): string {
  const parts: string[] = [presentation.title];
  if (event.type !== null) parts.push(event.type);
  if (event.eventKey !== null) parts.push(event.eventKey);
  if (presentation.summary !== null) parts.push(presentation.summary);
  const payload = (event.payload ?? null) as Record<string, unknown> | null;
  if (payload !== null) {
    for (const field of SEARCHABLE_FIELDS) {
      const value = payload[field];
      if (typeof value === 'string' && value !== '') parts.push(value);
    }
  }
  return parts.join(' ').toLowerCase();
}

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
  const [topic, setTopic] = useState<Topic>('all');
  const [selected, setSelected] = useState<MissionEvidenceEventView | null>(null);
  const [query, setQuery] = useState('');
  const [focusSeq, setFocusSeq] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
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

  // Presentations are derived per event (pure, memoized with the list).
  const presentations = useMemo(() => {
    const map = new Map<string, EventPresentation>();
    for (const event of events) map.set(event.id, presentEvent(event));
    return map;
  }, [events]);

  const operationFiltered = useMemo(() => {
    if (operationFilter === null) return events;
    return events.filter((e) => {
      const payload = e.payload as Record<string, unknown> | null;
      return payload !== null && payload.operationId === operationFilter;
    });
  }, [events, operationFilter]);

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return operationFiltered;
    return operationFiltered.filter((event) => {
      const presentation = presentations.get(event.id);
      if (presentation === undefined) return true;
      return eventSearchText(event, presentation).includes(q);
    });
  }, [operationFiltered, presentations, query]);

  // Server returns newest-first (seq desc); keep that order verbatim.
  const visible = searched;

  const summary = useMemo(() => {
    const nowMs = Date.now();
    const financial = visible.filter((e) => e.topic === 'financial').length;
    const operational = visible.filter((e) => e.topic === 'operational').length;
    const latest = visible.reduce<string | null>(
      (acc, e) => (acc === null || e.recordedAt > acc ? e.recordedAt : acc),
      null,
    );
    return {
      count: visible.length,
      financial,
      operational,
      latestRelative: latest === null ? null : relativeDay(latest, nowMs),
      latestExact: latest,
    };
  }, [visible]);

  // Keyboard list navigation (roving focus over the rendered rows). The
  // anchor row is derived from the ACTUAL focused element so that focus
  // arriving by any means (Tab, click, programmatic) navigates correctly.
  const moveFocus = (delta: number): void => {
    const rows = listRef.current?.querySelectorAll<HTMLButtonElement>('.mv-evrow__select');
    if (rows === undefined || rows.length === 0) return;
    const active = document.activeElement as HTMLButtonElement | null;
    const activeIsRow = active !== null && Array.from(rows).includes(active);
    const index = activeIsRow
      ? Array.from(rows).indexOf(active)
      : focusSeq === null
        ? -1
        : Array.from(rows).findIndex((r) => r.dataset.seq === String(focusSeq));
    const next = Math.min(Math.max(index + delta, 0), rows.length - 1);
    const target = rows[next];
    if (target !== undefined) {
      target.focus();
      setFocusSeq(Number(target.dataset.seq));
    }
  };

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
  const selectedPresentation =
    selected !== null ? (presentations.get(selected.id) ?? presentEvent(selected)) : null;

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
          onChange={(next) => {
            setTopic(next as Topic);
            setSelected(null);
          }}
        />
        <div className="mv-evidence__searchwrap">
          <input
            type="search"
            className="mv-evidence__search"
            placeholder="Filter loaded events…"
            aria-label="Filter the loaded event set (local search of the retrieved list only)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="evidence-search"
          />
          <span className="mv-evidence__searchscope">in loaded set</span>
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
        <div className="mv-alert" role="alert" data-testid="evidence-error">
          <p className="mv-alert__body">{load.message}</p>
          <p className="mv-evrow__subtle">
            The journal itself is untouched — this is a read failure, not missing evidence.
          </p>
        </div>
      )}
      {load.kind === 'ok' && visible.length === 0 && (
        <p className="mv-empty" data-testid="evidence-empty">
          {operationFilter !== null
            ? `No loaded events reference operation ${shortId(operationFilter)} under this topic.`
            : query.trim() !== ''
              ? 'No loaded events match this filter.'
              : 'No events recorded for this mission yet.'}
        </p>
      )}
      {load.kind === 'ok' && (
        <p className="mv-evsum" data-testid="evidence-summary">
          <span className="mv-num">{String(summary.count)}</span> loaded{' '}
          {summary.count === 1 ? 'event' : 'events'}
          <span className="mv-evsum__dot" aria-hidden="true" />
          <span className="mv-evsum__topic mv-evsum__topic--financial">
            {String(summary.financial)} financial
          </span>
          <span className="mv-evsum__dot" aria-hidden="true" />
          <span className="mv-evsum__topic mv-evsum__topic--operational">
            {String(summary.operational)} operational
          </span>
          {summary.latestRelative !== null && (
            <>
              <span className="mv-evsum__dot" aria-hidden="true" />
              latest {summary.latestRelative}
            </>
          )}
          <span className="mv-evsum__scope">newest first · most recent 50 per fetch</span>
        </p>
      )}
      {load.kind === 'ok' && visible.length > 0 && (
        <ol
          className="mv-evtl"
          data-testid="evidence-list"
          ref={listRef}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              moveFocus(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              moveFocus(-1);
            }
          }}
        >
          {visible.map((event) => {
            const presentation = presentations.get(event.id) ?? presentEvent(event);
            const isSel = selected?.id === event.id;
            const summaryLine = presentation.summary;
            return (
              <li
                className={`mv-evidence__event mv-evrow${isSel ? ' is-selected' : ''}${event.type === null || !Object.prototype.hasOwnProperty.call(EVENT_COPY, event.type ?? '') ? ' mv-evrow--unrecognized' : ''}`}
                key={event.id}
                data-seq={event.seq}
              >
                <button
                  type="button"
                  className="mv-evidence__select mv-evrow__select"
                  aria-pressed={isSel}
                  data-seq={event.seq}
                  onClick={() => {
                    setSelected(isSel ? null : event);
                    setFocusSeq(event.seq);
                  }}
                >
                  <span className="mv-evrow__seq mv-num" aria-hidden="true">
                    {String(event.seq)}
                  </span>
                  <span className="mv-evrow__spine" aria-hidden="true" />
                  <span className="mv-evidence__body mv-evrow__body">
                    <span className="mv-evrow__toprow">
                      <span className="mv-evrow__title">{presentation.title}</span>
                      <span
                        className={`mv-evrow__topic mv-evrow__topic--${event.topic}`}
                        title={`Topic: ${event.topic}`}
                      >
                        {event.topic === 'financial' ? 'Financial' : 'Operational'}
                      </span>
                      <span
                        className={`mv-evrow__tier mv-evrow__tier--${presentation.tier}`}
                        title={`Evidence tier: ${tierLabel(presentation.tier)}`}
                      >
                        {tierLabel(presentation.tier)}
                      </span>
                    </span>
                    {summaryLine !== null && <span className="mv-evrow__line">{summaryLine}</span>}
                    <span className="mv-evrow__meta">
                      <time dateTime={event.recordedAt}>{formatDate(event.recordedAt)}</time>
                      <span className="mv-evrow__inspect">Inspect evidence →</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <p className="mv-panel__note">
        Append-only internal journal, newest first. Payloads are the API&rsquo;s allowlisted
        projection — field observations are labeled as claims and are never provider truth;
        financial finality appears only with provider-verified readback evidence.
      </p>

      {selected !== null && selectedPresentation !== null && (
        <SidePanel
          title={`Event #${String(selected.seq)} — ${selected.type ?? 'journal event'}`}
          testId="evidence-detail"
          onClose={() => setSelected(null)}
        >
          <p
            className={`mv-evdetail__tier mv-evdetail__tier--${selectedPresentation.tier}`}
            data-testid="evidence-detail-tier"
          >
            {selectedPresentation.tier === 'provider'
              ? 'Provider-verified financial fact — backed by an independently read provider receipt.'
              : selectedPresentation.tier === 'field'
                ? 'Signed field claim — ingested from a registered source; not provider truth.'
                : 'Internal journal evidence — a system action or observation as recorded.'}
          </p>
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
              <dd>
                <time dateTime={selected.recordedAt}>{formatDate(selected.recordedAt)}</time>
              </dd>
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
              <dd className="mv-num mv-break">
                {selected.eventKey ?? '—'}
                {selected.eventKey !== null && <CopyButton value={selected.eventKey} label="key" />}
              </dd>
            </div>
            {selectedPayload?.operationId !== undefined &&
              typeof selectedPayload.operationId === 'string' && (
                <div>
                  <dt>Operation</dt>
                  <dd className="mv-num mv-break" title={selectedPayload.operationId}>
                    {selectedPayload.operationId}
                    <CopyButton value={selectedPayload.operationId} label="operation id" />
                  </dd>
                </div>
              )}
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
                    {typeof value === 'string' && value.length > 24 && (
                      <CopyButton value={value} label={key} />
                    )}
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
