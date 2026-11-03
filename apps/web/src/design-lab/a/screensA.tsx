import type { JSX } from 'react';
import {
  treasury,
  missions,
  exceptions,
  decisionCase,
  approvalRequest,
  replayEvents,
  spendable,
  missionCommitmentHistory,
} from '../lab/data';
import { money, moneyAmount, status } from '../lab/format';
import { EnvChip, KV, LifecycleStrip, Sparkline, StatusChip } from '../lab/primitives';
import { FLOW_STEPS } from '../lab/state-machine';
import type { LabState } from '../lab/use-lab-state';
import { Scene } from '../viewport/Scene';

/* ---------------- Mission Treasury ---------------- */

export function TreasuryA({ lab }: { lab: LabState }): JSX.Element {
  const usdAcc = treasury.accounts[0]!;
  const eurAcc = treasury.accounts[1]!;
  const loading = lab.override === 'loading';
  const empty = lab.override === 'empty';
  const offline = lab.override === 'provider_offline';
  const stale = lab.override === 'stale_balance';

  return (
    <section aria-labelledby="a-treasury-h">
      <div className="a-screenhead">
        <div>
          <h1 id="a-treasury-h" className="a-h1">
            Mission Treasury
          </h1>
          <p className="a-sub">
            {offline
              ? 'Provider OFFLINE — figures below are the last snapshot; retry to refresh.'
              : stale
                ? 'Balance snapshot aged 47 min (policy 30 min) — autonomous commitments suspended.'
                : `Balances as of ${treasury.asOf} · providers independent of reservations.`}
          </p>
        </div>
        <button type="button" className="a-btn a-btn--quiet">
          {offline ? 'Retry provider' : 'Refresh snapshot'}
        </button>
      </div>

      {(offline || stale) && (
        <div
          className={`a-alert${offline ? ' a-alert--offline' : ' a-alert--stale'}`}
          role="status"
        >
          <span aria-hidden="true">{offline ? '⏸' : '⌛'}</span>
          <div>
            <strong>
              {offline ? 'Airwallex SANDBOX offline' : 'Stale balance — autonomy suspended'}
            </strong>
            <p>
              {offline
                ? 'No live provider call succeeded. Values shown are the last verified snapshot; nothing here is live.'
                : 'Snapshot age 47 min exceeds the 30-minute freshness policy. Autonomous spending is refused until a fresh balance read succeeds.'}
            </p>
          </div>
        </div>
      )}

      <div className="a-grid a-grid--liquidity">
        {[usdAcc, eurAcc].map((acc) => (
          <article className="a-card a-liquidity" key={acc.currency} data-currency={acc.currency}>
            {loading ? (
              <>
                <div className="skel skel--w40" />
                <div className="skel skel--h32" />
                <div className="skel skel--w60" />
                <div className="skel skel--w80" />
              </>
            ) : (
              <>
                <header className="a-liquidity__head">
                  <h2 className="a-h2">{acc.currency} operating account</h2>
                  <span className="a-liquidity__prov">
                    {acc.provider} <EnvChip env={offline ? 'OFFLINE' : acc.env} />
                  </span>
                </header>
                <p className="a-liquidity__balance">
                  <span className="a-num" data-testid={`balance-${acc.currency}`}>
                    {empty ? '—' : money(acc.balance)}
                  </span>
                  <span className="a-liquidity__age">
                    {stale ? 'as of 13:45 UTC · 47 min old' : `as of ${treasury.asOf}`}
                  </span>
                </p>
                <dl className="a-liquidity__rows">
                  <div className="a-liqrow">
                    <dt>Reserved (internal commitments)</dt>
                    <dd className="a-num">{empty ? '—' : moneyAmount(acc.reserved)}</dd>
                  </div>
                  <div className="a-liqrow">
                    <dt>Pending settlement</dt>
                    <dd className="a-num">{empty ? '—' : moneyAmount(acc.pending)}</dd>
                  </div>
                  <div className="a-liqrow">
                    <dt>Protected reserve floor</dt>
                    <dd className="a-num">{empty ? '—' : moneyAmount(acc.protectedReserve)}</dd>
                  </div>
                  <div className="a-liqrow a-liqrow--spend">
                    <dt>Spendable now</dt>
                    <dd className="a-num">{empty ? '—' : money(spendable(acc))}</dd>
                  </div>
                </dl>
                <Sparkline
                  points={acc.history.map((h) => h.committedPctK)}
                  label={`${acc.currency} committed trend`}
                  threshold={100}
                  endLabel={`${acc.history[acc.history.length - 1]?.committedPctK}k`}
                  className="a-spark"
                />
              </>
            )}
          </article>
        ))}
      </div>

      <div className="a-grid a-grid--work">
        <div className="a-col a-col--main">
          <article className="a-card">
            <header className="a-card__head">
              <h2 className="a-h2">Operating missions</h2>
              <span className="a-card__meta">{missions.length} active · 1 awaiting evidence</span>
            </header>
            <div className="a-clockstrip" role="status" aria-label="Mission clock">
              <span className="a-clock">
                <span className="a-clock__k">M-104 mandate</span>
                <span className="a-num a-clock__v">26 h 04 m left</span>
              </span>
              <span className="a-clock">
                <span className="a-clock__k">Weather window</span>
                <span className="a-clock__v">opens Tue 05:40 · 6 h 20 m</span>
              </span>
              <span className="a-clock">
                <span className="a-clock__k">Tide (Havsul)</span>
                <span className="a-clock__v">high 16:12 · low 22:38</span>
              </span>
              <span className="a-clock">
                <span className="a-clock__k">UAV SEAGULL-2</span>
                <span className="a-clock__v">on station · 71 % bat</span>
              </span>
            </div>
            {empty ? (
              <div className="a-empty">
                <p className="a-empty__title">No missions configured</p>
                <p>
                  Configure the first mission mandate — budget envelope, reserve floor,
                  counterparties, expiry.
                </p>
                <button type="button" className="a-btn a-btn--primary">
                  Configure first mission
                </button>
              </div>
            ) : loading ? (
              <div className="a-table-skel">
                {[0, 1, 2].map((i) => (
                  <div className="skel skel--row" key={i} />
                ))}
              </div>
            ) : (
              <table className="a-table">
                <caption className="sr-only">
                  Operating missions with budget, committed amount and next action
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Mission</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num">
                      Budget
                    </th>
                    <th scope="col" className="num">
                      Committed
                    </th>
                    <th scope="col" className="num">
                      Remaining
                    </th>
                    <th scope="col">Next action</th>
                  </tr>
                </thead>
                <tbody>
                  {missions.map((m) => {
                    const pct = Math.round((m.committed.amount / m.budget.amount) * 100);
                    return (
                      <tr
                        key={m.id}
                        className={lab.selectedMission === m.id ? 'is-selected' : undefined}
                        onClick={() => lab.setSelectedMission(m.id)}
                      >
                        <th scope="row">
                          <span className="a-table__id">{m.id}</span>
                          <span className="a-table__name">{m.name}</span>
                          <span className="a-table__sub">
                            {m.field} · {m.asset}
                          </span>
                        </th>
                        <td data-col="Status">
                          <StatusChip
                            state={
                              m.status === 'LIVE'
                                ? 'PROPOSED'
                                : m.status === 'PENDING_EVIDENCE'
                                  ? 'STATUS_UNKNOWN'
                                  : 'EXPIRED'
                            }
                            compact
                          />
                        </td>
                        <td data-col="Budget" className="num a-num">
                          {moneyAmount(m.budget)}
                        </td>
                        <td data-col="Committed" className="num a-num">
                          {moneyAmount(m.committed)}
                          <span className="a-table__pct">
                            {pct}% of {moneyAmount(m.budget)}
                          </span>
                          <span
                            className="a-table__burn"
                            role="img"
                            aria-label={`${pct} percent of envelope committed`}
                          >
                            <span style={{ width: `${pct}%` }} />
                          </span>
                        </td>
                        <td data-col="Remaining" className="num a-num">
                          {moneyAmount({
                            ...m.budget,
                            amount: m.budget.amount - m.committed.amount,
                          })}
                        </td>
                        <td data-col="Next" className="a-table__action">
                          <button
                            type="button"
                            className="a-linkbtn"
                            onClick={(e) => {
                              e.stopPropagation();
                              lab.setSelectedMission(m.id);
                              lab.setScreen('decision');
                            }}
                          >
                            {m.nextAction} →
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </article>

          <article className="a-card">
            <header className="a-card__head">
              <h2 className="a-h2">Exceptions</h2>
              <span className="a-card__meta">2 require attention</span>
            </header>
            {empty || loading ? (
              <p className="a-muted">{loading ? 'Reading journal…' : 'No open exceptions.'}</p>
            ) : (
              <ul className="a-exceptions">
                {exceptions.map((ex) => (
                  <li key={ex.id} className={`a-exception a-exception--${ex.severity}`}>
                    <span className="a-exception__kind" aria-hidden="true">
                      {ex.kind === 'STATUS_UNKNOWN'
                        ? '⚠'
                        : ex.kind === 'STALE_EVIDENCE'
                          ? '⌛'
                          : '⏱'}
                    </span>
                    <div>
                      <p className="a-exception__title">{ex.title}</p>
                      <p className="a-exception__detail">{ex.detail}</p>
                    </div>
                    <button type="button" className="a-linkbtn">
                      Inspect →
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>

        <aside className="a-col a-col--rail">
          <article className="a-card">
            <header className="a-card__head">
              <h2 className="a-h2">Envelope · M-104</h2>
            </header>
            <p className="a-envelope">
              <span className="a-num a-num--xl">USD 7,750.00</span> remaining of USD 12,000.00
            </p>
            <div
              className="a-meter"
              role="img"
              aria-label="USD 4,250 of the USD 12,000 envelope committed — 35 percent"
            >
              <span style={{ width: '35%' }} />
            </div>
            <b className="a-meter__label">USD 4,250.00 / 12,000.00 · 35 %</b>
            <p className="a-muted">M-104 committed vs envelope, 14 days (USD thousands):</p>
            <Sparkline
              points={missionCommitmentHistory}
              label="M-104 committed vs envelope"
              threshold={12}
              endLabel="4.25k"
              className="a-spark"
            />
          </article>

          <article className="a-card a-feed">
            <header className="a-card__head">
              <h2 className="a-h2">Recent operations · org-wide</h2>
            </header>
            {loading ? (
              <div className="a-table-skel">
                {[0, 1, 2, 3].map((i) => (
                  <div className="skel skel--row" key={i} />
                ))}
              </div>
            ) : (
              <ul className="a-feed__list" aria-label="Recent operations">
                {[
                  {
                    id: 'OP-3127',
                    s: 'SUBMITTED' as const,
                    t: 'NorthSea Divers AS · USD 2,150.00',
                  },
                  { id: 'OP-3126', s: 'SETTLED' as const, t: 'MareData GmbH · USD 180.00 · Metal' },
                  {
                    id: 'OP-3119',
                    s: 'STATUS_UNKNOWN' as const,
                    t: 'Rig fuel vendor · USD 6,400.00',
                  },
                  { id: 'OP-3104', s: 'RECONCILED' as const, t: 'Port authority · USD 820.00' },
                ].map((op) => (
                  <li key={op.id}>
                    <button
                      type="button"
                      className="a-feed__row"
                      onClick={() => lab.setScreen('authority')}
                    >
                      <span className="a-feed__id">{op.id}</span>
                      <span className="a-feed__t">{op.t}</span>
                      <StatusChip state={op.s} compact />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </aside>
      </div>
    </section>
  );
}

/* ---------------- Decision Room ---------------- */

export function DecisionA({ lab }: { lab: LabState }): JSX.Element {
  const ev = decisionCase.event;
  const aiDown = lab.override === 'ai_unavailable';
  const evidenceDown = lab.override === 'evidence_unavailable';
  const webglDown = lab.override === 'webgl_lost';

  return (
    <section aria-labelledby="a-decision-h">
      <div className="a-screenhead">
        <div>
          <h1 id="a-decision-h" className="a-h1">
            Decision Room
          </h1>
          <p className="a-sub">
            {decisionCase.mission.id} · {decisionCase.mission.name} — {decisionCase.mission.field}
          </p>
        </div>
        <ol className="a-crumbs" aria-label="Context">
          <li>Finance lens</li>
          <li>Operations lens</li>
          <li>Evidence lens</li>
        </ol>
      </div>

      <div className="a-grid a-grid--decision">
        <div className="a-col a-col--scene">
          <article className="a-card a-viewport">
            <header className="a-card__head">
              <h2 className="a-h2">Operational viewport</h2>
              <span className="a-card__meta">
                <button
                  type="button"
                  className={`a-seg${lab.framing === 'overview' ? ' is-on' : ''}`}
                  onClick={() => lab.setFraming('overview')}
                >
                  Overview
                </button>
                <button
                  type="button"
                  className={`a-seg${lab.framing === 'asset' ? ' is-on' : ''}`}
                  onClick={() => lab.setFraming('asset')}
                >
                  Asset
                </button>
                <button
                  type="button"
                  className={`a-seg${lab.framing === 'event' ? ' is-on' : ''}`}
                  onClick={() => lab.setFraming('event')}
                >
                  Event
                </button>
              </span>
            </header>
            {webglDown ? (
              <div className="a-viewport-fallback" data-testid="viewport-fallback">
                <p className="a-viewport-fallback__title">3D unavailable — 2D tactical view</p>
                <p>
                  WebGL is unavailable or was lost. Financial decisions, evidence and execution are
                  fully usable; the synthetic staging falls back to this schematic.
                </p>
                <div className="a-schematic" aria-hidden="true">
                  <span className="a-schematic__row">T-12 · 62.1462°N 5.9123°E</span>
                  <span className="a-schematic__row">
                    SEAGULL-2 · holding 41 m · 38 m span point
                  </span>
                  <span className="a-schematic__row">EV-2214 · optical · 4 min old</span>
                </div>
              </div>
            ) : (
              <Scene
                theme="day"
                framing={lab.framing}
                onFraming={lab.setFraming}
                selectedPin={lab.selectedPin}
                onSelectPin={lab.setSelectedPin}
                reducedMotion={lab.reducedMotion}
                className="a-scene"
              />
            )}
            <p className="a-viewport__staging">
              SYNTHETIC STAGING — production 3D asset + camera system land in MTV-09 (#11)
            </p>
          </article>

          <article className="a-card">
            <header className="a-card__head">
              <h2 className="a-h2">Evidence narrative</h2>
              {evidenceDown ? (
                <StatusChip state="EXPIRED" compact />
              ) : (
                <span className="env">SIMULATED</span>
              )}
            </header>
            {evidenceDown ? (
              <div className="a-alert a-alert--stale" role="status">
                <span aria-hidden="true">⌛</span>
                <div>
                  <strong>Evidence source unavailable</strong>
                  <p>
                    EV-2214 payload cannot be re-read. The recorded observation stays visible with
                    its age; no fresh commitments are permitted from it.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <p className="a-ev-title">
                  <strong>{ev.title}</strong>
                </p>
                <dl className="a-ev-meta">
                  <div>
                    <dt>Observed</dt>
                    <dd>{ev.observedAt}</dd>
                  </div>
                  <div>
                    <dt>Provenance</dt>
                    <dd>{ev.provenance}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>{ev.source}</dd>
                  </div>
                  <div>
                    <dt>Confidence</dt>
                    <dd>{ev.confidence}</dd>
                  </div>
                </dl>
              </>
            )}
          </article>
        </div>

        <div className="a-col a-col--plans">
          <article className="a-card a-constraints">
            <header className="a-card__head">
              <h2 className="a-h2">Active mandate constraints</h2>
            </header>
            <dl className="a-constraints__list">
              {decisionCase.constraintSet.map((cs) => (
                <div key={cs.clause}>
                  <dt>{cs.clause}</dt>
                  <dd>{cs.value}</dd>
                </div>
              ))}
            </dl>
          </article>

          <article className="a-card">
            <header className="a-card__head">
              <h2 className="a-h2">Candidate plans</h2>
              <span className="a-card__meta">
                {aiDown ? 'planner offline' : '4 compared · incl. no-payment'}
              </span>
            </header>
            {aiDown && (
              <div className="a-alert a-alert--offline" role="status">
                <span aria-hidden="true">⏸</span>
                <div>
                  <strong>Planner unavailable</strong>
                  <p>
                    Model access is down. The case, evidence and financial state remain readable;
                    manual decisions within mandate are still permitted. No fallback authority is
                    invented.
                  </p>
                </div>
              </div>
            )}
            <ul className="a-plans" role="radiogroup" aria-label="Candidate plans">
              {decisionCase.plans.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={lab.selectedPlan === p.id}
                    className={`a-plan${lab.selectedPlan === p.id ? ' is-selected' : ''}${p.policy === 'REJECTED_BY_POLICY' ? ' is-blocked' : ''}`}
                    onClick={() => lab.selectPlan(p.id)}
                  >
                    <span className="a-plan__head">
                      <span className="a-plan__id">{p.id}</span>
                      <span className="a-plan__title">{p.title}</span>
                      <span className="a-num a-plan__cost">
                        {p.cost.amount === 0 ? 'USD 0' : money(p.cost)}
                      </span>
                    </span>
                    <span className="a-plan__meta">
                      <span className={`a-plan__policy a-plan__policy--${p.policy.toLowerCase()}`}>
                        {p.policy === 'REJECTED_BY_POLICY'
                          ? '✕ blocked by policy'
                          : p.policy === 'NEEDS_APPROVAL'
                            ? '☥ needs approval'
                            : p.policy === 'AUTO_AUTHORIZED'
                              ? '✓ auto-authorized'
                              : '✓ within authority'}
                      </span>
                      <span>{p.timeToDecide}</span>
                      <span>uncertainty {p.uncertainty}</span>
                    </span>
                    <span className="a-plan__body">
                      {p.assumption} — {p.economics}
                    </span>
                    <span className="a-plan__reason">{p.policyReason}</span>
                  </button>
                </li>
              ))}
            </ul>
          </article>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Authority & Execution ---------------- */

export function AuthorityA({ lab }: { lab: LabState }): JSX.Element {
  const { flow, advance, reset, loseResponse, resolveUnknown, tamperTerms, expireMandate } =
    lab.flow;
  const s = status(flow.state);

  return (
    <section aria-labelledby="a-authority-h">
      <div className="a-screenhead">
        <div>
          <h1 id="a-authority-h" className="a-h1">
            Authority & Execution
          </h1>
          <p className="a-sub">
            {approvalRequest.planRef} · digest {approvalRequest.digest} · exact terms only
          </p>
        </div>
        <StatusChip state={flow.state} />
      </div>

      <div className="a-grid a-grid--authority">
        <div className="a-col a-col--terms">
          <article className="a-card">
            <header className="a-card__head">
              <h2 className="a-h2">Immutable terms</h2>
              <span className="a-card__meta">bound to approval digest</span>
            </header>
            <dl className="a-terms">
              {approvalRequest.terms.map((t) => (
                <KV key={t.label} k={t.label} v={t.value} locked={t.locked} />
              ))}
            </dl>
          </article>

          <article className="a-card">
            <header className="a-card__head">
              <h2 className="a-h2">Policy evaluation</h2>
            </header>
            <ul className="a-policy">
              {approvalRequest.policyChecks.map((c) => (
                <li key={c.clause} data-verdict={c.verdict}>
                  <span aria-hidden="true">{c.verdict === 'pass' ? '✓' : '☥'}</span>
                  <span className="a-policy__clause">{c.clause}</span>
                  <span className="a-policy__detail">{c.detail}</span>
                </li>
              ))}
            </ul>
          </article>
        </div>

        <div className="a-col a-col--exec">
          <article className="a-card a-exec">
            <header className="a-card__head">
              <h2 className="a-h2">Execution</h2>
              <span className="a-card__meta">
                OP-3127 · req {approvalRequest.operation.requestId} <EnvChip env="SANDBOX" />
              </span>
            </header>

            <LifecycleStrip state={flow.state} steps={FLOW_STEPS} />

            <div
              className={`a-statebox a-statebox--${s.tone}`}
              data-testid="authority-state"
              data-state={flow.state}
            >
              <span className="a-statebox__glyph" aria-hidden="true">
                {s.glyph}
              </span>
              <div>
                <p className="a-statebox__title">{flow.state.replace(/_/g, ' ')}</p>
                <p className="a-statebox__blurb">
                  {flow.state === 'STATUS_UNKNOWN' && flow.unknownSince
                    ? `Response lost at ${flow.unknownSince}. Commitment retained. Verify by original request id — never resubmit blind.`
                    : flow.settledAt
                      ? `${s.blurb} · ${flow.settledAt}`
                      : (flow.rejectReason ?? s.blurb)}
                </p>
              </div>
            </div>

            <div className="a-exec__actions">
              <button
                type="button"
                className="a-btn a-btn--primary"
                onClick={advance}
                disabled={flow.branch !== 'clean'}
              >
                {flow.state === 'PROPOSED'
                  ? 'Reserve USD 2,150.00'
                  : flow.state === 'RESERVED'
                    ? 'Approve exact terms'
                    : flow.state === 'APPROVED'
                      ? 'Submit to Airwallex sandbox'
                      : flow.state === 'SUBMITTING'
                        ? 'Dispatching…'
                        : flow.state === 'SUBMITTED'
                          ? 'Verify by read-back'
                          : flow.state === 'SETTLED'
                            ? 'Reconcile outcome'
                            : 'Complete'}
              </button>
              <button
                type="button"
                className="a-btn"
                onClick={loseResponse}
                disabled={flow.branch !== 'clean'}
              >
                Simulate lost response
              </button>
              <button
                type="button"
                className="a-btn"
                onClick={tamperTerms}
                disabled={flow.branch !== 'clean'}
              >
                Simulate changed terms
              </button>
              <button
                type="button"
                className="a-btn"
                onClick={expireMandate}
                disabled={flow.branch !== 'clean'}
              >
                Simulate mandate expiry
              </button>
              {flow.branch === 'unknown' && (
                <button type="button" className="a-btn a-btn--verify" onClick={resolveUnknown}>
                  Resolve by original ID
                </button>
              )}
              <button type="button" className="a-btn a-btn--quiet" onClick={reset}>
                Reset
              </button>
            </div>

            <details className="a-receipt">
              <summary>Provider receipt (raw, redacted)</summary>
              <pre>
                {`{
  "operation_id": "OP-3127",
  "request_id": "req_2xK91mQz",
  "provider": "airwallex",
  "environment": "SANDBOX",
  "amount": { "currency": "USD", "major_units": 2150.00 },
  "state": "${flow.state}",
  "source": "SYNTHETIC DESIGN FIXTURE — not a provider response"
}`}
              </pre>
            </details>
          </article>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Evidence Replay ---------------- */

export function ReplayA({ lab }: { lab: LabState }): JSX.Element {
  const ev = replayEvents.find((e) => e.id === lab.selectedEvent) ?? replayEvents[0]!;
  return (
    <section aria-labelledby="a-replay-h">
      <div className="a-screenhead">
        <div>
          <h1 id="a-replay-h" className="a-h1">
            Evidence Replay
          </h1>
          <p className="a-sub">Mission M-104 · journal rebuilt read-only · REPLAY MODE</p>
        </div>
        <span className="env">REPLAY</span>
      </div>
      <div className="a-grid a-grid--replay">
        <ol className="a-timeline" aria-label="Journal timeline">
          {replayEvents.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                className={`a-tl${lab.selectedEvent === e.id ? ' is-selected' : ''}`}
                data-kind={e.kind}
                onClick={() => lab.selectEvent(e.id)}
              >
                <span className="a-tl__t">{e.t}</span>
                <span className="a-tl__glyph" aria-hidden="true">
                  {e.kind === 'observation'
                    ? '◎'
                    : e.kind === 'plan'
                      ? '◇'
                      : e.kind === 'policy'
                        ? '§'
                        : e.kind === 'approval'
                          ? '✓'
                          : e.kind === 'reservation'
                            ? '▣'
                            : e.kind === 'provider' || e.kind === 'diagnostic'
                              ? '⇄'
                              : e.kind === 'delivery'
                                ? '↓'
                                : '★'}
                </span>
                <span className="a-tl__body">
                  <span className="a-tl__title">{e.title}</span>
                  {e.status && e.status !== 'INFO' && <StatusChip state={e.status} compact />}
                  {e.env && <EnvChip env={e.env} />}
                </span>
              </button>
            </li>
          ))}
        </ol>

        <article className="a-card a-evdetail">
          <header className="a-card__head">
            <h2 className="a-h2">
              {ev.id} · {ev.t}
            </h2>
            {ev.env && <EnvChip env={ev.env} />}
          </header>
          <p className="a-evdetail__title">{ev.title}</p>
          <p className="a-evdetail__detail">{ev.detail}</p>
          <div className="a-evdetail__links">
            <span className="a-evdetail__chip">links: EV-2214</span>
            <span className="a-evdetail__chip">plan P2 v1</span>
            <span className="a-evdetail__chip">digest 0x9f3a…c41d</span>
            <span className="a-evdetail__chip">
              receipt {ev.kind === 'provider' ? 'TRX-8813' : '—'}
            </span>
          </div>
          <div className="a-evdetail__sep">
            <span>
              Financial status and operating status are tracked separately — settlement never
              implies mission success.
            </span>
          </div>
        </article>
      </div>
    </section>
  );
}
