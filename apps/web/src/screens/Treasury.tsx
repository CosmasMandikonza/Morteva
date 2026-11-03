import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { StatusChip } from '../components/StatusChip';
import { Panel, SkeletonRows } from '../components/Panel';
import { SignInPanel } from '../components/SignInPanel';
import {
  ApiError,
  fetchMandates,
  fetchMissions,
  type MandateRow,
  type MissionRow,
  type SessionState,
} from '../lib/api';
import { formatDate, money, moneyAmount, parseJsonArray, percent, shortId } from '../lib/format';
import { mandatePresentation } from '../status/statusMap';

type Load<T> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; status?: number }
  | { kind: 'ok'; data: T };

/**
 * Mission Treasury — the first production surface. Every number rendered
 * here comes from the authenticated, org-scoped MOTERVA API. Capabilities
 * with no authorized endpoint render one explicit unavailable panel; the
 * design-lab fixtures are never presented as financial truth.
 */
export function Treasury({
  session,
  selectedMissionId,
  onSelectMission,
  onLogin,
  loginBusy,
  loginError,
}: {
  session: SessionState;
  selectedMissionId: string | null;
  onSelectMission: (id: string | null) => void;
  onLogin: (username: string, password: string) => void;
  loginBusy: boolean;
  loginError: string | null;
}): JSX.Element {
  const [missions, setMissions] = useState<Load<MissionRow[]>>({ kind: 'loading' });
  const [mandates, setMandates] = useState<Load<MandateRow[]>>({ kind: 'loading' });

  const signedIn = session.kind === 'signed-in';
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
        setMissions({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
          status: error instanceof ApiError ? error.status : undefined,
        });
      });
    return () => controller.abort();
  }, [signedIn, actorId]);

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
        setMandates({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      });
    return () => controller.abort();
  }, [signedIn, effectiveMissionId]);

  const selectedMission = missionList.find((m) => m.id === effectiveMissionId) ?? null;
  const mandateList = mandates.kind === 'ok' ? mandates.data : [];
  const activeMandates = mandateList.filter((m) => m.status === 'active');
  const historyMandates = mandateList.filter((m) => m.status !== 'active');
  const envelopeTotals = useMemo(() => {
    const totals = new Map<string, { total: number; consumed: number }>();
    for (const mandate of activeMandates) {
      const total =
        mandate.total_budget_minor !== -1 ? mandate.total_budget_minor : mandate.max_amount_minor;
      const current = totals.get(mandate.currency) ?? { total: 0, consumed: 0 };
      totals.set(mandate.currency, {
        total: current.total + total,
        consumed: current.consumed + mandate.consumed_minor,
      });
    }
    return totals;
  }, [activeMandates]);

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
                      .catch((error: unknown) =>
                        setMissions({
                          kind: 'error',
                          message: error instanceof Error ? error.message : 'Unknown error',
                        }),
                      );
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
              title="Ledger capabilities"
              meta={<span className="mv-tag mv-tag--unavailable">not available</span>}
              testId="capabilities-panel"
            >
              <ul className="mv-caps">
                <li>
                  <span className="mv-caps__name">Organization balances</span>
                  <span className="mv-caps__why">
                    Spendable capacity and the protected reserve live in the ledger engine; no
                    authorized read endpoint exists yet.
                  </span>
                </li>
                <li>
                  <span className="mv-caps__name">Operations &amp; exceptions</span>
                  <span className="mv-caps__why">
                    Reserved / in-flight / unknown / verified outcomes and the needs-human queue
                    need a list route (single-ID lookup exists only).
                  </span>
                </li>
              </ul>
              <p className="mv-panel__note">
                No simulated or fixture data is shown. These panels activate when the financial API
                surface ships.
              </p>
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
                        envelope remaining · {moneyAmount(t.total)} {currency} active authority
                      </span>
                    </div>
                  ))}
                  {envelopeTotals.size === 0 && mandates.kind === 'ok' && (
                    <div className="mv-hero__figure">
                      <span className="mv-hero__value">—</span>
                      <span className="mv-hero__label">no active authority</span>
                    </div>
                  )}
                </div>
                <p className="mv-hero__meta">
                  {selectedMission.status} mission · created{' '}
                  {formatDate(selectedMission.created_at)}. Mission-scoped envelopes from active
                  mandates — not an account balance.
                </p>
              </section>
            )}

            <Panel
              title="Spending authority"
              meta="mandates, newest version first"
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
              {mandates.kind === 'ok' && activeMandates.length > 0 && (
                <ul className="mv-mandates">
                  {activeMandates.map((mandate) => {
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
