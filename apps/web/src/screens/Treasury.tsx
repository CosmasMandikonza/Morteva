import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { FinancialOverviewView, OperationListView, OperationReadView } from '@moterva/domain';
import { StatusChip } from '../components/StatusChip';
import { Panel, SkeletonRows } from '../components/Panel';
import { SignInPanel } from '../components/SignInPanel';
import { OperationInspector } from '../components/OperationInspector';
import {
  ApiError,
  fetchFinancialOverview,
  fetchMandates,
  fetchMissions,
  fetchOperations,
  type MandateRow,
  type MissionRow,
  type SessionState,
} from '../lib/api';
import { formatDate, money, moneyAmount, parseJsonArray, percent, shortId } from '../lib/format';
import { mandatePresentation, operationPresentation } from '../status/statusMap';

type Load<T> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; status?: number }
  | { kind: 'ok'; data: T };

/**
 * Mission Treasury — the first production surface. Every number rendered
 * here comes from the authenticated, org-scoped MOTERVA API (#35/#37 merged
 * contracts): org financial position, mission mandates, and the mission's
 * real operations with an inspector carrying one operation identity into
 * Evidence Replay. The design-lab fixtures are never financial truth.
 */
export function Treasury({
  session,
  selectedMissionId,
  onSelectMission,
  onLogin,
  onSessionExpired,
  onInspectEvidence,
  loginBusy,
  loginError,
}: {
  session: SessionState;
  selectedMissionId: string | null;
  onSelectMission: (id: string | null) => void;
  onLogin: (username: string, password: string) => void;
  /** Invoked when an authenticated read returns 401: financial content must not remain exposed. */
  onSessionExpired: () => void;
  /** Carries ONE operation identity into the Evidence Replay surface. */
  onInspectEvidence: (operationId: string, missionId: string) => void;
  loginBusy: boolean;
  loginError: string | null;
}): JSX.Element {
  const [missions, setMissions] = useState<Load<MissionRow[]>>({ kind: 'loading' });
  const [mandates, setMandates] = useState<Load<MandateRow[]>>({ kind: 'loading' });
  const [overview, setOverview] = useState<Load<FinancialOverviewView>>({ kind: 'loading' });
  const [operations, setOperations] = useState<Load<OperationListView>>({ kind: 'loading' });
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);

  const signedIn = session.kind === 'signed-in';
  // Provenance: records are genuine internal ledger rows, but under DEMO_AUTH
  // the ledger itself is locally seeded demonstration data — never presented
  // as externally verified banking information.
  const isDemoLedger = session.kind === 'signed-in' && session.session.demoAuth;
  const actorId = session.kind === 'signed-in' ? session.session.actor.id : null;

  useEffect(() => {
    if (!signedIn) {
      setMissions({ kind: 'loading' });
      setMandates({ kind: 'loading' });
      return;
    }
    const controller = new AbortController();
    setMissions({ kind: 'loading' });
    fetchMissions(controller.signal)
      .then((rows) => setMissions({ kind: 'ok', data: rows }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          // Session expired / revoked server-side: drop the authenticated
          // state immediately so no financial content stays on screen.
          onSessionExpired();
          return;
        }
        setMissions({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
          status: error instanceof ApiError ? error.status : undefined,
        });
      });
    return () => controller.abort();
  }, [signedIn, actorId, onSessionExpired]);

  const missionList = missions.kind === 'ok' ? missions.data : [];
  const effectiveMissionId = useMemo(() => {
    if (missionList.length === 0) return null;
    if (selectedMissionId !== null && missionList.some((m) => m.id === selectedMissionId)) {
      return selectedMissionId;
    }
    return missionList[0]?.id ?? null;
  }, [missionList, selectedMissionId]);

  useEffect(() => {
    if (!signedIn || effectiveMissionId === null) {
      setMandates({ kind: 'loading' });
      return;
    }
    const controller = new AbortController();
    setMandates({ kind: 'loading' });
    fetchMandates(effectiveMissionId, controller.signal)
      .then((rows) => setMandates({ kind: 'ok', data: rows }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired();
          return;
        }
        setMandates({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      });
    return () => controller.abort();
  }, [signedIn, effectiveMissionId, onSessionExpired]);

  // Org financial position (#35) — session-scoped, not mission-scoped.
  useEffect(() => {
    if (!signedIn) {
      setOverview({ kind: 'loading' });
      return;
    }
    const controller = new AbortController();
    setOverview({ kind: 'loading' });
    fetchFinancialOverview(controller.signal)
      .then((view) => setOverview({ kind: 'ok', data: view }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired();
          return;
        }
        setOverview({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      });
    return () => controller.abort();
  }, [signedIn, onSessionExpired]);

  // Mission operations (#35), mission-scoped.
  useEffect(() => {
    if (!signedIn || effectiveMissionId === null) {
      setOperations({ kind: 'loading' });
      setSelectedOperationId(null);
      return;
    }
    const controller = new AbortController();
    setOperations({ kind: 'loading' });
    fetchOperations({ missionId: effectiveMissionId, limit: 25 }, controller.signal)
      .then((list) => {
        setOperations({ kind: 'ok', data: list });
        setSelectedOperationId((current) => {
          if (current !== null && list.operations.some((o) => o.id === current)) return current;
          // Auto-select the first operation needing attention, else the newest.
          const attention =
            list.operations.find((o) => o.attention === 'human') ??
            list.operations.find((o) => o.attention === 'ambiguous');
          return attention?.id ?? list.operations[0]?.id ?? null;
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired();
          return;
        }
        setOperations({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      });
    return () => controller.abort();
  }, [signedIn, effectiveMissionId, onSessionExpired]);

  const selectedMission = missionList.find((m) => m.id === effectiveMissionId) ?? null;
  const mandateList = mandates.kind === 'ok' ? mandates.data : [];
  // Persisted status is the ledger's truth and stays inspectable. EFFECTIVE
  // authority is separate: a mandate whose expiry has passed by wall clock is
  // not spendable now, whatever its recorded status — it must never inflate
  // usable-authority sums or counts (P0-1). The ledger's own financial
  // calculations are untouched.
  const isLapsed = (m: MandateRow): boolean =>
    m.status === 'active' && Date.parse(m.expires_at) <= Date.now();
  const effectiveMandates = mandateList.filter((m) => m.status === 'active' && !isLapsed(m));
  const lapsedMandates = mandateList.filter(isLapsed);
  const historyMandates = mandateList.filter((m) => m.status !== 'active');
  const envelopeTotals = useMemo(() => {
    const totals = new Map<string, { total: number; consumed: number }>();
    for (const mandate of effectiveMandates) {
      const total =
        mandate.total_budget_minor !== -1 ? mandate.total_budget_minor : mandate.max_amount_minor;
      const current = totals.get(mandate.currency) ?? { total: 0, consumed: 0 };
      totals.set(mandate.currency, {
        total: current.total + total,
        consumed: current.consumed + mandate.consumed_minor,
      });
    }
    return totals;
  }, [effectiveMandates]);

  return (
    <div className="mv-treasury">
      {/* ------------------------------------------------ session gate */}
      {session.kind === 'unavailable' && (
        <section className="mv-panel mv-panel--unavailable" data-testid="auth-unavailable">
          <header className="mv-panel__head">
            <h2 className="mv-panel__title">Mission financial data</h2>
            <span className="mv-tag mv-tag--unavailable">not available</span>
          </header>
          <div className="mv-panel__body">
            <p className="mv-unavailable__what">
              This deployment does not expose the financial API: authenticated financial routes
              exist only under the server&rsquo;s explicit loopback DEMO_AUTH gate, which is
              disabled here.
            </p>
            <p className="mv-unavailable__note">
              No simulated or fixture data is shown here. Run the API locally with the demo gate to
              browse real ledger data.
            </p>
          </div>
        </section>
      )}
      {session.kind === 'signed-out' && (
        <SignInPanel onSubmit={onLogin} busy={loginBusy} error={loginError} />
      )}

      {/* ------------------------------------------------ missions + mandates */}
      {signedIn && (
        <div className="mv-grid mv-grid--treasury">
          <div className="mv-grid__side">
            <Panel
              title="Missions"
              meta={<CountTag n={missionList.length} />}
              testId="missions-panel"
            >
              {missions.kind === 'loading' && <SkeletonRows rows={3} />}
              {missions.kind === 'error' && (
                <ErrorRetry
                  message={missions.message}
                  onRetry={() => {
                    setMissions({ kind: 'loading' });
                    void fetchMissions()
                      .then((rows) => setMissions({ kind: 'ok', data: rows }))
                      .catch((error: unknown) => {
                        if (error instanceof ApiError && error.status === 401) {
                          onSessionExpired();
                          return;
                        }
                        setMissions({
                          kind: 'error',
                          message: error instanceof Error ? error.message : 'Unknown error',
                        });
                      });
                  }}
                />
              )}
              {missions.kind === 'ok' && missionList.length === 0 && (
                <p className="mv-empty" data-testid="missions-empty">
                  No missions exist in this ledger yet. Missions are created through the authority
                  workflow — nothing is invented here.
                </p>
              )}
              {missions.kind === 'ok' && missionList.length > 0 && (
                <ul className="mv-missions">
                  {missionList.map((mission) => (
                    <li key={mission.id}>
                      <button
                        type="button"
                        className={`mv-mission ${mission.id === effectiveMissionId ? 'is-selected' : ''}`}
                        onClick={() => onSelectMission(mission.id)}
                        aria-pressed={mission.id === effectiveMissionId}
                      >
                        <span className="mv-mission__id" title={mission.id}>
                          {shortId(mission.id)}
                        </span>
                        <span className="mv-mission__title">{mission.title}</span>
                        <span className="mv-mission__meta">
                          {mission.status} · created {formatDate(mission.created_at)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title="Financial position"
              meta={
                overview.kind === 'ok' ? (
                  <span className="mv-tag">org · {overview.data.currencies.length} currencies</span>
                ) : undefined
              }
              testId="position-panel"
            >
              {overview.kind === 'loading' && <SkeletonRows rows={3} />}
              {overview.kind === 'error' && (
                <div className="mv-alert" role="alert">
                  <p className="mv-alert__body">{overview.message}</p>
                </div>
              )}
              {overview.kind === 'ok' &&
                overview.data.currencies.map((c) => (
                  <div className="mv-position" key={c.currency} data-testid="position-currency">
                    <div className="mv-position__head">
                      <span className="mv-position__currency mv-num">{c.currency}</span>
                      <span
                        className={`mv-chip mv-chip--sm ${
                          c.status === 'ok'
                            ? 'mv-chip--verified'
                            : c.status === 'stale'
                              ? 'mv-chip--hold'
                              : 'mv-chip--danger'
                        }`}
                        data-testid="freshness-chip"
                      >
                        {c.status === 'ok'
                          ? 'fresh snapshot'
                          : c.status === 'stale'
                            ? 'stale snapshot'
                            : 'no snapshot'}
                      </span>
                    </div>
                    <dl className="mv-position__figures">
                      <div>
                        <dt>Balance</dt>
                        <dd className="mv-num">
                          {c.balance === null ? '—' : `${c.currency} ${c.balance.major}`}
                        </dd>
                      </div>
                      <div>
                        <dt>Protected floor</dt>
                        <dd className="mv-num">{`${c.currency} ${c.protectedFloor.major}`}</dd>
                      </div>
                      <div>
                        <dt>Spendable now</dt>
                        <dd className="mv-num mv-position__spendable">
                          {c.spendable === null ? (
                            <span className="mv-position__unavailable">
                              {c.statusDetail ?? 'not computable'}
                            </span>
                          ) : (
                            <>
                              {c.currency} {c.spendable.major}
                              {c.spendable.overcommitted && (
                                <span className="mv-chip mv-chip--danger mv-chip--sm">
                                  overcommitted — spending halted
                                </span>
                              )}
                            </>
                          )}
                        </dd>
                      </div>
                    </dl>
                    <p className="mv-position__commitments">
                      Commitments — reserved{' '}
                      <span className="mv-num">{moneyAmount(c.commitments.reservedMinor)}</span> ·
                      unknown/held{' '}
                      <span className="mv-num">{moneyAmount(c.commitments.unknownMinor)}</span>
                      {c.commitments.settledPendingObservationMinor !== null && (
                        <>
                          {' '}
                          · settled pending observation{' '}
                          <span className="mv-num">
                            {moneyAmount(c.commitments.settledPendingObservationMinor)}
                          </span>
                        </>
                      )}
                      {c.commitments.totalOutstandingMinor !== null && (
                        <>
                          {' '}
                          · total outstanding{' '}
                          <span className="mv-num">
                            {moneyAmount(c.commitments.totalOutstandingMinor)}
                          </span>
                        </>
                      )}
                    </p>
                    {c.provenance !== null && (
                      <p className="mv-position__provenance">
                        source <span className="mv-num">{c.provenance.source}</span> · observed{' '}
                        {formatDate(c.provenance.observedAt)}
                        {c.provenance.providerVerified
                          ? ' · provider-verified'
                          : ' · internal record, not provider-verified'}
                        {isDemoLedger ? ' · seeded demo data' : ''}
                      </p>
                    )}
                    {c.provenance === null && (
                      <p className="mv-position__provenance">
                        no balance observation recorded{isDemoLedger ? ' · seeded demo data' : ''}
                      </p>
                    )}
                  </div>
                ))}
              {overview.kind === 'ok' && overview.data.currencies.length === 0 && (
                <p className="mv-empty">No treasury accounts configured for this organization.</p>
              )}
              <p className="mv-panel__note">
                Engine-computed spendable = fresh verified balance − protected floor − outstanding
                commitments (unknown and escalated exposure both retain capacity). Provider
                observation: none — adapter disabled until sandbox credentials (#5); see System
                status.
              </p>
            </Panel>

            <Panel
              title="Operations"
              meta={
                operations.kind === 'ok' ? (
                  <span className="mv-tag mv-num" data-testid="operations-counts">
                    {String(operations.data.operations.length)}·
                    {String(operations.data.counts.needsHuman)} human·
                    {String(operations.data.counts.ambiguous)} ambiguous
                  </span>
                ) : undefined
              }
              testId="operations-panel"
            >
              {operations.kind === 'loading' && <SkeletonRows rows={3} />}
              {operations.kind === 'error' && (
                <div className="mv-alert" role="alert">
                  <p className="mv-alert__body">{operations.message}</p>
                </div>
              )}
              {operations.kind === 'ok' && operations.data.operations.length === 0 && (
                <p className="mv-empty" data-testid="operations-empty">
                  No operations recorded for this mission.
                </p>
              )}
              {operations.kind === 'ok' && operations.data.operations.length > 0 && (
                <ul className="mv-ops">
                  {operations.data.operations.map((op) => {
                    const presentation = operationPresentation(op.state);
                    return (
                      <li key={op.id}>
                        <button
                          type="button"
                          className={`mv-op ${op.id === selectedOperationId ? 'is-selected' : ''}`}
                          data-state={op.state}
                          data-attention={op.attention}
                          onClick={() => setSelectedOperationId(op.id)}
                          aria-pressed={op.id === selectedOperationId}
                        >
                          <span className="mv-op__state">
                            <span aria-hidden="true">{presentation.glyph}</span>{' '}
                            {presentation.label}
                          </span>
                          <span className="mv-num mv-op__amount">
                            {op.amount.currency} {op.amount.major}
                          </span>
                          <span className="mv-op__purpose">
                            {op.purpose} · {op.beneficiary}
                          </span>
                          {op.attention !== 'none' && (
                            <span
                              className={`mv-chip mv-chip--sm ${op.attention === 'human' ? 'mv-chip--attention' : 'mv-chip--hold'}`}
                            >
                              {op.attention === 'human' ? '✋ decision' : '⚠ ambiguous'}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </div>

          <div className="mv-grid__main">
            {selectedMission !== null && (
              <section className="mv-hero" data-testid="mission-hero" aria-label="Selected mission">
                <div className="mv-hero__head">
                  <h2 className="mv-hero__title">{selectedMission.title}</h2>
                  <span className="mv-hero__id" title={selectedMission.id}>
                    {shortId(selectedMission.id)}
                  </span>
                </div>
                <div className="mv-hero__figures">
                  {[...envelopeTotals.entries()].map(([currency, t]) => (
                    <div className="mv-hero__figure" key={currency}>
                      <span className="mv-hero__value">
                        {money(currency, Math.max(0, t.total - t.consumed))}
                      </span>
                      <span className="mv-hero__label">
                        envelope remaining · {moneyAmount(t.total)} {currency} effective authority
                      </span>
                    </div>
                  ))}
                  {envelopeTotals.size === 0 && mandates.kind === 'ok' && (
                    <div className="mv-hero__figure">
                      <span className="mv-hero__value">—</span>
                      <span className="mv-hero__label">no effective authority</span>
                    </div>
                  )}
                </div>
                <p className="mv-hero__meta">
                  {selectedMission.status} mission · created{' '}
                  {formatDate(selectedMission.created_at)}. Mission-scoped envelopes from mandates
                  that are effective now (active and unexpired) — not an account balance. Source:
                  internal ledger
                  {isDemoLedger ? ' (locally seeded demonstration data)' : ''}.
                </p>
              </section>
            )}

            <Panel
              title="Spending authority"
              meta="mandate-authorized envelopes · newest version first"
              testId="mandates-panel"
            >
              {mandates.kind === 'loading' && <SkeletonRows rows={4} />}
              {mandates.kind === 'error' && (
                <ErrorRetry message={mandates.message} onRetry={undefined} />
              )}
              {mandates.kind === 'ok' && mandateList.length === 0 && (
                <p className="mv-empty" data-testid="mandates-empty">
                  No mandates for this mission. Spending authority is granted through the authority
                  workflow; nothing is invented here.
                </p>
              )}
              {mandates.kind === 'ok' && effectiveMandates.length > 0 && (
                <ul className="mv-mandates">
                  {effectiveMandates.map((mandate) => {
                    const presentation = mandatePresentation(mandate.status);
                    const total =
                      mandate.total_budget_minor !== -1
                        ? mandate.total_budget_minor
                        : mandate.max_amount_minor;
                    const used = percent(mandate.consumed_minor, total);
                    const kinds = parseJsonArray(mandate.permitted_kinds_json);
                    const rails = parseJsonArray(mandate.rails_json);
                    return (
                      <li className="mv-mandate" key={mandate.id} data-state={mandate.status}>
                        <div className="mv-mandate__head">
                          <StatusChip entry={presentation} />
                          <span className="mv-mandate__version">v{mandate.version}</span>
                          <span className="mv-mandate__currency">{mandate.currency}</span>
                        </div>
                        <div className="mv-mandate__envelope">
                          <div className="mv-mandate__figures">
                            <span className="mv-num mv-mandate__remaining">
                              {money(mandate.currency, mandate.remaining_minor)}
                            </span>
                            <span className="mv-num mv-mandate__total">
                              of {moneyAmount(total)} envelope
                            </span>
                            <span className="mv-mandate__pct mv-num">{used}% committed</span>
                          </div>
                          <div
                            className="mv-meter"
                            role="img"
                            aria-label={`${used} percent of the ${money(mandate.currency, total)} envelope committed`}
                          >
                            <span style={{ width: `${used}%` }} />
                          </div>
                          <dl className="mv-mandate__meta">
                            <div>
                              <dt>Committed</dt>
                              <dd className="mv-num">
                                {money(mandate.currency, mandate.consumed_minor)}
                              </dd>
                            </div>
                            <div>
                              <dt>Per-operation cap</dt>
                              <dd className="mv-num">
                                {money(mandate.currency, mandate.max_amount_minor)}
                              </dd>
                            </div>
                            <div>
                              <dt>Expires</dt>
                              <dd>{formatDate(mandate.expires_at)}</dd>
                            </div>
                            <div>
                              <dt>Kind / rails</dt>
                              <dd>
                                {kinds.join(' · ') || '—'}
                                {rails.length > 0 ? ` · ${rails.join(' · ')}` : ''}
                              </dd>
                            </div>
                          </dl>
                          <p className="mv-mandate__meaning">{presentation.meaning}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {mandates.kind === 'ok' && lapsedMandates.length > 0 && (
                <>
                  <p className="mv-subhead">Expired by clock — not spendable now</p>
                  <ul className="mv-mandates">
                    {lapsedMandates.map((mandate) => {
                      const total =
                        mandate.total_budget_minor !== -1
                          ? mandate.total_budget_minor
                          : mandate.max_amount_minor;
                      const used = percent(mandate.consumed_minor, total);
                      return (
                        <li
                          className="mv-mandate mv-mandate--lapsed"
                          key={mandate.id}
                          data-state="lapsed-by-clock"
                          data-testid="lapsed-mandate"
                        >
                          <div className="mv-mandate__head">
                            <span className="mv-chip mv-chip--danger">
                              <span className="mv-chip__glyph" aria-hidden="true">
                                ⏱
                              </span>
                              Lapsed — not spendable
                            </span>
                            <span className="mv-mandate__version">v{mandate.version}</span>
                            <span className="mv-mandate__currency">{mandate.currency}</span>
                            <span className="mv-mandate__recorded mv-num">
                              recorded status: {mandate.status}
                            </span>
                          </div>
                          <div className="mv-mandate__envelope">
                            <div className="mv-mandate__figures">
                              <span className="mv-num mv-mandate__remaining mv-mandate__remaining--muted">
                                {money(mandate.currency, mandate.remaining_minor)}
                              </span>
                              <span className="mv-num mv-mandate__total">
                                historical envelope {moneyAmount(total)} · {used}% committed
                              </span>
                            </div>
                            <div
                              className="mv-meter mv-meter--muted"
                              role="img"
                              aria-label={`historical: ${used} percent of the ${money(mandate.currency, total)} envelope was committed before expiry`}
                            >
                              <span style={{ width: `${used}%` }} />
                            </div>
                            <dl className="mv-mandate__meta">
                              <div>
                                <dt>Committed (historical)</dt>
                                <dd className="mv-num">
                                  {money(mandate.currency, mandate.consumed_minor)}
                                </dd>
                              </div>
                              <div>
                                <dt>Expired</dt>
                                <dd className="mv-mandate__lapsed">
                                  {formatDate(mandate.expires_at)}
                                </dd>
                              </div>
                            </dl>
                            <p className="mv-mandate__meaning">
                              Expiry passed by wall clock — this authority cannot authorize new
                              spending now. The remaining envelope is a historical figure, not
                              available authority; the ledger still records status “{mandate.status}
                              ” until it applies its own transition.
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
              {mandates.kind === 'ok' && historyMandates.length > 0 && (
                <>
                  <p className="mv-subhead">Superseded &amp; historical versions</p>
                  <ul className="mv-mandates">
                    {historyMandates.map((mandate) => {
                      const presentation = mandatePresentation(mandate.status);
                      return (
                        <li
                          className="mv-mandate mv-mandate--history"
                          key={mandate.id}
                          data-state={mandate.status}
                        >
                          <StatusChip entry={presentation} size="sm" />
                          <span className="mv-mandate__version">v{mandate.version}</span>
                          <span className="mv-mandate__currency">{mandate.currency}</span>
                          <span className="mv-mandate__note">{presentation.meaning}</span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </Panel>

            {operations.kind === 'ok' &&
              (() => {
                const selected: OperationReadView | undefined =
                  operations.data.operations.find((o) => o.id === selectedOperationId) ?? undefined;
                if (selected === undefined) return null;
                return (
                  <OperationInspector
                    operation={selected}
                    onInspectEvidence={(operationId) => {
                      if (selectedMission !== null)
                        onInspectEvidence(operationId, selectedMission.id);
                    }}
                  />
                );
              })()}
          </div>
        </div>
      )}
    </div>
  );
}

function CountTag({ n }: { n: number }): JSX.Element {
  return <span className="mv-tag mv-num">{n}</span>;
}

function ErrorRetry({
  message,
  onRetry,
}: {
  message: string;
  onRetry: (() => void) | undefined;
}): JSX.Element {
  return (
    <div className="mv-alert" role="alert">
      <p className="mv-alert__title">Could not load</p>
      <p className="mv-alert__body">{message}</p>
      {onRetry !== undefined && (
        <button type="button" className="mv-btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
