import type { JSX } from 'react';
import {
  commitmentHistory,
  decisionCase,
  exceptions,
  approvalRequest,
  missions,
  replayEvents,
  spendable,
  treasury,
} from '../lab/data';
import { money, moneyAmount, status } from '../lab/format';
import { EnvChip, KV, LifecycleStrip, Sparkline, StatusChip } from '../lab/primitives';
import { FLOW_STEPS } from '../lab/state-machine';
import type { LabState } from '../lab/use-lab-state';
import { Scene } from '../viewport/Scene';

/* ---------------- Mission Treasury — cinematic money room ---------------- */

export function TreasuryB({ lab }: { lab: LabState }): JSX.Element {
  const usdAcc = treasury.accounts[0]!;
  const eurAcc = treasury.accounts[1]!;
  const loading = lab.override === 'loading';
  const empty = lab.override === 'empty';
  const offline = lab.override === 'provider_offline';
  const stale = lab.override === 'stale_balance';
  const hideFinancialValues = loading || empty || offline;

  return (
    <section className="b-screen" aria-labelledby="b-treasury-h">
      <div className="b-hero">
        <div className="b-hero__left">
          <p className="b-eyebrow">Mission Treasury · {treasury.org}</p>
          <h1 id="b-treasury-h" className="b-h1">
            {stale ? 'Spendable frozen — stale snapshot' : 'Spendable across missions'}
          </h1>
          <p className="b-hero__figure">
            <span className="b-num b-num--hero" data-testid="balance-USD-hero">
              {hideFinancialValues ? 'USD —' : money(spendable(usdAcc))}
            </span>
            <span className="b-hero__figure-sub">
              {loading
                ? 'Loading synthetic funding scenario…'
                : offline
                  ? 'provider OFFLINE — synthetic fixture, never verified provider funds'
                  : stale
                    ? 'snapshot 47 min old · autonomy suspended until fresh read'
                    : `of ${money(usdAcc.balance)} on hand · as of ${treasury.asOf}`}
            </span>
          </p>
          <div className="b-hero__chips">
            <EnvChip env={offline ? 'OFFLINE' : usdAcc.env} />
            <span className="b-hero__chip">
              reserve floor {empty ? '—' : money(usdAcc.protectedReserve)}
            </span>
            <span className="b-hero__chip">
              reserved {empty ? '—' : moneyAmount(usdAcc.reserved)}
            </span>
            <span className="b-hero__chip">
              pending {empty ? '—' : moneyAmount(usdAcc.pending)}
            </span>
          </div>
        </div>
        <div className="b-hero__right">
          <div className="b-fundmap" aria-label="USD account decomposition — semantic instrument">
            <p className="b-fundmap__k">USD account decomposition</p>
            <p className="b-fundmap__total b-num">
              {hideFinancialValues ? 'USD —' : money(usdAcc.balance)}
            </p>
            <div
              className="b-fundmap__bar"
              role="img"
              aria-label="USD 184,250 on hand: 99,250 spendable, 28,600 reserved, 6,400 pending settlement, 50,000 protected reserve floor"
            >
              <span
                className="b-fundmap__seg b-fundmap__seg--spend"
                style={{ width: '53.9%' }}
                title="Spendable USD 99,250.00"
              />
              <span
                className="b-fundmap__seg b-fundmap__seg--reserved"
                style={{ width: '15.5%' }}
                title="Reserved USD 28,600.00"
              />
              <span
                className="b-fundmap__seg b-fundmap__seg--pending"
                style={{ width: '3.5%' }}
                title="Pending USD 6,400.00"
              />
              <span
                className="b-fundmap__seg b-fundmap__seg--protected"
                style={{ width: '27.1%' }}
                title="Protected USD 50,000.00"
              />
            </div>
            <ul className="b-fundmap__legend">
              <li>
                <i className="b-dot b-dot--spend" />
                spendable{' '}
                <b className="b-num">
                  {hideFinancialValues ? '—' : moneyAmount(spendable(usdAcc))}
                </b>
              </li>
              <li>
                <i className="b-dot b-dot--reserved" />
                reserved{' '}
                <b className="b-num">{hideFinancialValues ? '—' : moneyAmount(usdAcc.reserved)}</b>
              </li>
              <li>
                <i className="b-dot b-dot--pending" />
                pending{' '}
                <b className="b-num">{hideFinancialValues ? '—' : moneyAmount(usdAcc.pending)}</b>
              </li>
              <li>
                <i className="b-dot b-dot--protected" />
                protected{' '}
                <b className="b-num">
                  {hideFinancialValues ? '—' : moneyAmount(usdAcc.protectedReserve)}
                </b>
              </li>
            </ul>
            <p className="b-fundmap__note">
              reservations are internal holds — never provider escrow
            </p>
          </div>
        </div>
      </div>

      {(offline || stale) && (
        <div
          className={`b-alert${offline ? ' b-alert--offline' : ' b-alert--stale'}`}
          role="status"
        >
          <strong>
            {offline ? 'Airwallex SANDBOX offline' : 'Stale balance — autonomy suspended'}
          </strong>
          <p>
            {offline
              ? 'SIMULATED provider-offline state; all displayed balances are synthetic fixtures, not provider-verified.'
              : 'Simulated snapshot age exceeds the 30-minute policy. Spending is disabled in the scenario until the synthetic snapshot is restored.'}
          </p>
          <button
            type="button"
            className="b-btn b-btn--ghost"
            onClick={() => lab.setOverride('none')}
            title="Restore the synthetic scenario; no provider is contacted"
          >
            Restore synthetic snapshot
          </button>
        </div>
      )}

      <div className="b-grid b-grid--treasury">
        <article className="b-panel b-missions">
          <header className="b-panel__head">
            <h2 className="b-h2">Operating missions</h2>
            <span className="b-panel__meta">{missions.length} active</span>
          </header>
          {loading ? (
            <div className="skel skel--row" role="status" aria-label="Loading synthetic missions" />
          ) : empty ? (
            <div className="b-empty">
              <p className="b-empty__title">The deck is clear</p>
              <p>
                No missions configured. Set the first mandate — envelope, reserve floor,
                counterparties, expiry.
              </p>
              <p className="b-panel__note" role="note">
                Onboarding is planned for MTV-10; mission creation is unavailable in this preview.
              </p>
            </div>
          ) : (
            <ul className="b-missionlist">
              {missions.map((m) => {
                const pct = Math.round((m.committed.amount / m.budget.amount) * 100);
                const selected = lab.selectedMission === m.id;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      className={`b-mission${selected ? ' is-selected' : ''}`}
                      onClick={() => lab.setSelectedMission(m.id)}
                      aria-pressed={selected}
                    >
                      <span className="b-mission__head">
                        <span className="b-mission__id">{m.id}</span>
                        <span className="b-mission__name">{m.name}</span>
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
                      </span>
                      <span className="b-mission__meta">
                        {m.field} · {m.asset}
                      </span>
                      <span
                        className="b-mission__bar"
                        role="img"
                        aria-label={`${pct} percent committed`}
                      >
                        <span style={{ width: `${pct}%` }} />
                      </span>
                      <span className="b-mission__figs">
                        <span className="b-num">{moneyAmount(m.committed)} committed</span>
                        <span className="b-num b-num--dim">
                          of {moneyAmount(m.budget)} {m.currencyNote}
                        </span>
                        <span className="b-mission__next">{m.nextAction} →</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </article>

        <div className="b-col">
          <article className="b-panel">
            <header className="b-panel__head">
              <h2 className="b-h2">EUR account</h2>
              <EnvChip env={offline ? 'OFFLINE' : eurAcc.env} />
            </header>
            {loading ? (
              <>
                <div className="skel skel--h32" />
                <div className="skel skel--w60" />
                <div className="skel skel--w80" />
              </>
            ) : (
              <>
                <p className="b-panel__figure b-num">{empty ? '—' : money(eurAcc.balance)}</p>
                <dl className="b-liq">
                  <div>
                    <dt>spendable</dt>
                    <dd className="b-num">{empty ? '—' : money(spendable(eurAcc))}</dd>
                  </div>
                  <div>
                    <dt>reserved</dt>
                    <dd className="b-num">{empty ? '—' : moneyAmount(eurAcc.reserved)}</dd>
                  </div>
                  <div>
                    <dt>protected</dt>
                    <dd className="b-num">{empty ? '—' : moneyAmount(eurAcc.protectedReserve)}</dd>
                  </div>
                </dl>
              </>
            )}
          </article>

          <article className="b-panel">
            <header className="b-panel__head">
              <h2 className="b-h2">Commitment trend · 14 d</h2>
            </header>
            {loading ? (
              <div className="skel skel--row" />
            ) : (
              <Sparkline
                points={commitmentHistory.map((d) => d.usdK)}
                label="USD committed trend"
                threshold={100}
                endLabel="81k"
                className="b-spark"
              />
            )}
            <p className="b-panel__note">USD thousands · committed vs envelope</p>
          </article>

          <article className="b-panel b-exceptions">
            <header className="b-panel__head">
              <h2 className="b-h2">Exceptions</h2>
              <span className="b-panel__meta">2 open</span>
            </header>
            {loading ? (
              <div className="skel skel--row" />
            ) : (
              <ul>
                {exceptions.map((ex) => (
                  <li key={ex.id} className={`b-exception b-exception--${ex.severity}`}>
                    <span className="b-exception__glyph" aria-hidden="true">
                      {ex.kind === 'STATUS_UNKNOWN'
                        ? '⚠'
                        : ex.kind === 'STALE_EVIDENCE'
                          ? '⌛'
                          : '⏱'}
                    </span>
                    <span className="b-exception__body">
                      <strong>{ex.title}</strong>
                      <em>{ex.detail}</em>
                    </span>
                    <button
                      type="button"
                      className="b-btn b-btn--ghost b-btn--xs"
                      onClick={() =>
                        lab.setScreen(ex.kind === 'STALE_EVIDENCE' ? 'decision' : 'authority')
                      }
                      aria-label={`Inspect ${ex.title}`}
                    >
                      inspect
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Decision Room — the night bridge ---------------- */

export function DecisionB({ lab }: { lab: LabState }): JSX.Element {
  const ev = decisionCase.event;
  const aiDown = lab.override === 'ai_unavailable';
  const evidenceDown = lab.override === 'evidence_unavailable';
  const webglDown = lab.override === 'webgl_lost';
  const selected = decisionCase.plans.find((p) => p.id === lab.selectedPlan)!;

  return (
    <section className="b-screen" aria-labelledby="b-decision-h">
      <div className="b-stage">
        {webglDown ? (
          <div className="b-stage-fallback" data-testid="viewport-fallback">
            <p className="b-stage-fallback__k">3D unavailable</p>
            <p className="b-stage-fallback__title">2D tactical fallback — finances unaffected</p>
            <p>
              WebGL is unavailable or lost. Every decision, approval and verification remains fully
              operable from the panels below.
            </p>
          </div>
        ) : (
          <Scene
            theme="night"
            framing={lab.framing}
            onFraming={lab.setFraming}
            selectedPin={lab.selectedPin}
            onSelectPin={lab.setSelectedPin}
            reducedMotion={lab.reducedMotion}
            hudFraming={false}
            className="b-scene"
          />
        )}
        <div className="b-stage__dock">
          <div className="b-dockcard">
            <p className="b-eyebrow">Active event</p>
            {evidenceDown ? (
              <p className="b-dockcard__title">
                Evidence source unavailable — recorded copy shown with age
              </p>
            ) : (
              <p className="b-dockcard__title">{ev.title}</p>
            )}
            <p className="b-dockcard__meta">
              {evidenceDown
                ? 'payload cannot be re-read · no fresh commitments permitted'
                : `${ev.observedAt} · ${ev.provenance} · ${ev.confidence}`}
            </p>
            <div className="b-dockcard__framing" role="group" aria-label="Viewport framing">
              {(['overview', 'asset', 'event'] as const).map((fr) => (
                <button
                  key={fr}
                  type="button"
                  className={`b-fr${lab.framing === fr ? ' is-on' : ''}`}
                  onClick={() => lab.setFraming(fr)}
                  aria-pressed={lab.framing === fr}
                >
                  {fr}
                </button>
              ))}
            </div>
          </div>
          <p className="b-stage__staging">
            SYNTHETIC STAGING · production 3D + camera rails land in MTV-09
          </p>
        </div>
      </div>

      {aiDown && (
        <div className="b-alert b-alert--offline" role="status">
          <strong>Planner unavailable</strong>
          <p>
            Case and financial state remain readable; manual decisions within mandate are permitted.
            No invented fallback authority.
          </p>
        </div>
      )}

      <div className="b-grid b-grid--decision">
        <article className="b-panel b-plans">
          <header className="b-panel__head">
            <h2 className="b-h2">Alternative plans</h2>
            <span className="b-panel__meta">
              {aiDown ? 'planner offline' : '4 compared · no-payment first'}
            </span>
          </header>
          <ul className="b-planlist" role="radiogroup" aria-label="Candidate plans">
            {decisionCase.plans.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={lab.selectedPlan === p.id}
                  className={`b-plan${lab.selectedPlan === p.id ? ' is-selected' : ''}${p.policy === 'REJECTED_BY_POLICY' ? ' is-blocked' : ''}`}
                  onClick={() => lab.selectPlan(p.id)}
                >
                  <span className="b-plan__rail" aria-hidden="true" />
                  <span className="b-plan__body">
                    <span className="b-plan__head">
                      <strong>{p.title}</strong>
                      <span className="b-num b-plan__cost">
                        {p.cost.amount === 0 ? 'USD 0' : money(p.cost)}
                      </span>
                    </span>
                    <span className="b-plan__meta">
                      <span className={`b-plan__policy b-plan__policy--${p.policy.toLowerCase()}`}>
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
                    <span className="b-plan__econ">{p.economics}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="b-planfocus">
            <p className="b-eyebrow">Selected plan · {selected.id}</p>
            <p className="b-planfocus__line">{selected.policyReason}</p>
            <p className="b-planfocus__line b-planfocus__line--dim">{selected.assumption}</p>
            <button
              type="button"
              className="b-btn b-btn--amber b-btn--full"
              disabled={selected.policy === 'REJECTED_BY_POLICY'}
              onClick={() => lab.setScreen('authority')}
            >
              {selected.policy === 'NEEDS_APPROVAL'
                ? `Review approval · ${money(selected.cost)}`
                : selected.policy === 'REJECTED_BY_POLICY'
                  ? 'Blocked by mandate'
                  : `Open execution · ${money(selected.cost)}`}
            </button>
          </div>
        </article>

        <article className="b-panel b-constraints">
          <header className="b-panel__head">
            <h2 className="b-h2">Mandate constraints</h2>
          </header>
          <dl className="b-kvlist">
            {decisionCase.constraintSet.map((cs) => (
              <div key={cs.clause}>
                <dt>{cs.clause}</dt>
                <dd>{cs.value}</dd>
              </div>
            ))}
          </dl>
          <p className="b-panel__note">
            Constraints are enforced by typed policy, not by this panel.
          </p>
        </article>
      </div>
    </section>
  );
}

/* ---------------- Authority & Execution — the amber console ---------------- */

export function AuthorityB({ lab }: { lab: LabState }): JSX.Element {
  const { flow, advance, reset, loseResponse, resolveUnknown, tamperTerms, expireMandate } =
    lab.flow;
  const s = status(flow.state);

  return (
    <section className="b-screen" aria-labelledby="b-authority-h">
      <div className="b-auth-head">
        <div>
          <p className="b-eyebrow">Authority & Execution · {approvalRequest.planRef}</p>
          <h1 id="b-authority-h" className="b-h1">
            Approve exact terms
          </h1>
          <p className="b-auth-digest">digest {approvalRequest.digest} · any change invalidates</p>
        </div>
        <StatusChip state={flow.state} />
      </div>

      <div className="b-grid b-grid--authority">
        <article className="b-panel">
          <header className="b-panel__head">
            <h2 className="b-h2">Terms</h2>
            <span className="b-panel__meta">immutable once approved</span>
          </header>
          <dl className="b-terms">
            {approvalRequest.terms.map((t) => (
              <KV key={t.label} k={t.label} v={t.value} locked={t.locked} />
            ))}
          </dl>
          <header className="b-panel__head b-panel__head--gap">
            <h2 className="b-h2">Policy</h2>
          </header>
          <ul className="b-policy">
            {approvalRequest.policyChecks.map((c) => (
              <li key={c.clause} data-verdict={c.verdict}>
                <span aria-hidden="true">{c.verdict === 'pass' ? '✓' : '☥'}</span>
                <span>{c.clause}</span>
                <em>{c.detail}</em>
              </li>
            ))}
          </ul>
        </article>

        <article className="b-panel b-console">
          <header className="b-panel__head">
            <h2 className="b-h2">Execution console</h2>
            <span className="b-panel__meta">
              OP-3127 <EnvChip env="SANDBOX" />
            </span>
          </header>

          <LifecycleStrip state={flow.state} steps={FLOW_STEPS} />

          <div
            className={`b-statebox b-statebox--${s.tone}`}
            data-testid="authority-state"
            data-state={flow.state}
          >
            <span className="b-statebox__glyph" aria-hidden="true">
              {s.glyph}
            </span>
            <div>
              <p className="b-statebox__title">{flow.state.replace(/_/g, ' ')}</p>
              <p className="b-statebox__blurb">
                {flow.state === 'STATUS_UNKNOWN' && flow.unknownSince
                  ? `Response lost at ${flow.unknownSince}. Commitment retained. Verify by original request id — never resubmit blind.`
                  : flow.settledAt
                    ? `${s.blurb} · ${flow.settledAt}`
                    : (flow.rejectReason ?? s.blurb)}
              </p>
            </div>
          </div>

          <button
            type="button"
            className="b-btn b-btn--amber b-btn--xl"
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

          <div className="b-console__sims">
            <span className="b-console__simlabel">simulate:</span>
            <button
              type="button"
              className="b-chipbtn"
              onClick={loseResponse}
              disabled={flow.branch !== 'clean'}
            >
              lost response
            </button>
            <button
              type="button"
              className="b-chipbtn"
              onClick={tamperTerms}
              disabled={flow.branch !== 'clean'}
            >
              changed terms
            </button>
            <button
              type="button"
              className="b-chipbtn"
              onClick={expireMandate}
              disabled={flow.branch !== 'clean'}
            >
              mandate expiry
            </button>
            {flow.branch === 'unknown' && (
              <button
                type="button"
                className="b-chipbtn b-chipbtn--verify"
                onClick={resolveUnknown}
              >
                resolve by original ID
              </button>
            )}
            <button type="button" className="b-chipbtn" onClick={reset}>
              reset
            </button>
          </div>

          <details className="b-receipt">
            <summary>Provider receipt · raw</summary>
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
    </section>
  );
}

/* ---------------- Evidence Replay — the after-action rail ---------------- */

export function ReplayB({ lab }: { lab: LabState }): JSX.Element {
  const ev = replayEvents.find((e) => e.id === lab.selectedEvent) ?? replayEvents[0]!;
  return (
    <section className="b-screen" aria-labelledby="b-replay-h">
      <div className="b-auth-head">
        <div>
          <p className="b-eyebrow">Evidence Replay · mission M-104</p>
          <h1 id="b-replay-h" className="b-h1">
            The whole case, linked
          </h1>
        </div>
        <span className="env">REPLAY</span>
      </div>
      <div className="b-grid b-grid--replay">
        <ol className="b-rail" aria-label="Journal timeline">
          {replayEvents.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                className={`b-rail__ev${lab.selectedEvent === e.id ? ' is-selected' : ''}`}
                data-kind={e.kind}
                onClick={() => lab.selectEvent(e.id)}
                aria-current={lab.selectedEvent === e.id ? 'true' : undefined}
              >
                <span className="b-rail__node" aria-hidden="true">
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
                <span className="b-rail__body">
                  <span className="b-rail__t">{e.t}</span>
                  <span className="b-rail__title">{e.title}</span>
                  <span className="b-rail__chips">
                    {e.status && e.status !== 'INFO' && <StatusChip state={e.status} compact />}
                    {e.env && <EnvChip env={e.env} />}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>

        <article className="b-panel b-evdetail">
          <p className="b-eyebrow">
            {ev.id} · {ev.t}
          </p>
          <p className="b-evdetail__title">{ev.title}</p>
          <p className="b-evdetail__detail">{ev.detail}</p>
          <div className="b-evdetail__links">
            <span>EV-2214</span>
            <span>plan P2 v1</span>
            <span>digest 0x9f3a…c41d</span>
            <span>receipt {ev.kind === 'provider' ? 'TRX-8813' : '—'}</span>
          </div>
          <p className="b-evdetail__sep">
            Financial and operating status travel separately — settlement never implies mission
            success.
          </p>
        </article>
      </div>
    </section>
  );
}
