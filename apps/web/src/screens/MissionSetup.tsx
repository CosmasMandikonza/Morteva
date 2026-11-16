import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Panel } from '../components/Panel';
import { CopyButton, HaloBadge, SkeletonRows } from '../components/ui';
import { SpecForm } from '../components/SpecForm';
import { SourceCredentials } from '../components/SourceCredentials';
import { HeadlessGuide } from '../components/HeadlessGuide';
import { MandateCreateSheet } from '../components/OnboardingDialog';
import {
  ApiError,
  fetchMandates,
  fetchMissionSpec,
  fetchOperationsDecision,
  mayManageAuthority,
  mayOperate,
  registerMissionSpec,
  type MandateRow,
  type MissionSpecDraftWire,
  type MissionSpecSourceView,
  type MissionSpecView,
  type SessionState,
} from '../lib/api';
import { money, safeMoney } from '../lib/format';
import './mission-setup-polish.css';
import {
  draftToWire,
  emptyDraft,
  reviewRows,
  type DomainKind,
  type FieldIssue,
  type SpecDraft,
} from '../lib/missionSpecForm';

/**
 * Mission Setup — the customer-operated configuration surface (issue #13
 * product workflow). A customer authors THEIR mission here: assets, trusted
 * sources, safety thresholds, economics, suppliers and the financial
 * constraints derived from them; registers it through the production API;
 * onboards sources with one-time credentials; and sees exactly how their own
 * field system sends signed evidence. Nothing on this screen calls a demo
 * fixture route, and nothing here grants spending authority.
 */

function describeSpecError(error: ApiError): string {
  switch (error.code) {
    case 'SPEC_ID_COLLISION':
      return 'This spec id is already registered with DIFFERENT content. Specifications are immutable history — choose a new spec id to register a new version.';
    case 'NOT_FOUND_OR_UNAVAILABLE':
      return 'The selected mission is not available to you (it may belong to another organization or no longer exist).';
    case 'SPEC_REGISTRATION_REJECTED':
      return 'The server rejected the registration. Nothing was stored.';
    default:
      break;
  }
  if (error.status === 403) {
    return 'Your role cannot register mission specifications (the server requires operator or above).';
  }
  return `${error.code}: ${error.message}`;
}

function effectiveMandate(mandates: readonly MandateRow[], currency: string): MandateRow | null {
  const now = Date.now();
  return (
    mandates.find(
      (m) =>
        m.status === 'active' &&
        m.currency === currency &&
        new Date(m.expires_at).getTime() > now &&
        m.remaining_minor > 0,
    ) ?? null
  );
}

export function MissionSetup({
  session,
  mission,
  csrfToken,
  onSessionExpired,
}: {
  session: SessionState;
  mission: { id: string; title: string } | null;
  csrfToken: string | null;
  onSessionExpired: () => void;
}): JSX.Element {
  const role = session.kind === 'signed-in' ? session.session.actor.role : null;
  const orgId = session.kind === 'signed-in' ? (session.session.actor.orgId ?? null) : null;
  const canOperate = mayOperate(role);
  const canGrant = mayManageAuthority(role);

  const [spec, setSpec] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; view: MissionSpecView }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [mandates, setMandates] = useState<readonly MandateRow[] | null>(null);
  const [eventCount, setEventCount] = useState<number | null>(null);
  const [issuedKeyCount, setIssuedKeyCount] = useState(0);

  const [draft, setDraft] = useState<SpecDraft>(emptyDraft);
  const [issues, setIssues] = useState<readonly FieldIssue[]>([]);
  const [wire, setWire] = useState<MissionSpecDraftWire | null>(null);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registered, setRegistered] = useState<{
    specId: string;
    digest: string;
    replayed: boolean;
  } | null>(null);
  /** Sources of the spec registered in THIS session (fallback when the API
   *  build does not expose declared sources on the read). */
  const [sessionSources, setSessionSources] = useState<readonly MissionSpecSourceView[] | null>(
    null,
  );
  const [sessionDomains, setSessionDomains] = useState<Readonly<Record<string, DomainKind>>>({});
  const [showForm, setShowForm] = useState(false);
  const [sheet, setSheet] = useState<'none' | 'mandate'>('none');
  const [mandateNotice, setMandateNotice] = useState<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  const missionId = mission?.id ?? null;

  const reload = useCallback(
    (signal?: AbortSignal): void => {
      if (session.kind !== 'signed-in' || missionId === null) return;
      fetchMissionSpec(missionId, signal)
        .then((view) => {
          if (signal?.aborted === true) return;
          setSpec({ kind: 'ready', view });
        })
        .catch((reason: unknown) => {
          if (signal?.aborted === true) return;
          if (reason instanceof ApiError && reason.status === 401) {
            onSessionExpired();
            return;
          }
          setSpec({
            kind: 'error',
            message:
              reason instanceof ApiError
                ? `${reason.code} (HTTP ${String(reason.status)})`
                : 'The server could not be reached.',
          });
        });
      fetchMandates(missionId, signal)
        .then((rows) => {
          if (signal?.aborted !== true) setMandates(rows);
        })
        .catch(() => {
          if (signal?.aborted !== true) setMandates(null);
        });
      fetchOperationsDecision(missionId, signal)
        .then((d) => {
          if (signal?.aborted !== true) setEventCount(d.eventCount);
        })
        .catch(() => {
          if (signal?.aborted !== true) setEventCount(null);
        });
    },
    [session.kind, missionId, onSessionExpired],
  );

  // Fresh state per mission: a draft, a registration result or an in-memory
  // credential note from another mission must never carry over.
  useEffect(() => {
    setSpec({ kind: 'loading' });
    setMandates(null);
    setEventCount(null);
    setIssuedKeyCount(0);
    setDraft(emptyDraft());
    setIssues([]);
    setWire(null);
    setRegistered(null);
    setRegisterError(null);
    setSessionSources(null);
    setSessionDomains({});
    setShowForm(false);
    setSheet('none');
    setMandateNotice(null);
    const controller = new AbortController();
    reload(controller.signal);
    return () => controller.abort();
  }, [missionId, session.kind, reload]);

  if (session.kind !== 'signed-in') {
    return (
      <Panel title="Mission setup" testId="mission-setup">
        <p>Sign in through Mission Treasury to configure a mission.</p>
        <p>Nothing is shown or stored without an authenticated session.</p>
      </Panel>
    );
  }
  if (mission === null) {
    return (
      <Panel title="Mission setup" testId="mission-setup">
        <p data-testid="setup-no-mission">
          Select or create a mission in Mission Treasury first. A mission specification is
          registered against one mission.
        </p>
      </Panel>
    );
  }

  const view = spec.kind === 'ready' ? spec.view : null;
  const isRegistered = view?.registered === true;
  const declaredSources: readonly MissionSpecSourceView[] | null = view?.sources ?? sessionSources;
  const credentialsMeta = view?.credentials;
  const sourceForGuide = declaredSources?.[0] ?? null;
  const domainOf = (assetId: string | undefined): DomainKind => {
    if (assetId === undefined) return 'ground';
    const fromView = view?.assets.find((a) => a.assetId === assetId)?.domainKind;
    return fromView ?? sessionDomains[assetId] ?? 'ground';
  };

  const startReview = (): void => {
    const result = draftToWire(draft);
    if (!result.ok) {
      setIssues(result.issues);
      setWire(null);
      window.setTimeout(() => summaryRef.current?.focus(), 0);
      return;
    }
    setIssues([]);
    setRegisterError(null);
    setWire(result.wire);
  };

  const register = (): void => {
    if (wire === null || csrfToken === null || registering) return;
    setRegistering(true);
    setRegisterError(null);
    registerMissionSpec(mission.id, wire, csrfToken)
      .then((r) => {
        setRegistering(false);
        setRegistered({ specId: r.specId, digest: r.digest, replayed: r.replayed });
        setSessionSources(wire.sources);
        setSessionDomains(Object.fromEntries(wire.assets.map((a) => [a.assetId, a.domainKind])));
        setWire(null);
        setShowForm(false);
        reload();
      })
      .catch((reason: unknown) => {
        setRegistering(false);
        if (reason instanceof ApiError && reason.status === 401) {
          onSessionExpired();
          return;
        }
        setRegisterError(
          reason instanceof ApiError
            ? describeSpecError(reason)
            : 'Could not reach the server — nothing was registered.',
        );
      });
  };

  const economicsCurrency = view?.economics.currency ?? 'USD';
  const mandate =
    mandates === null || !isRegistered ? null : effectiveMandate(mandates, economicsCurrency);
  const keysKnown =
    credentialsMeta !== undefined
      ? credentialsMeta.some((c) => c.status === 'active')
      : issuedKeyCount > 0
        ? true
        : null;

  /** Readiness strip: the same five real states, as one lightweight row.
   *  Unknown stays unknown; unavailable never becomes complete. */
  const readiness: readonly {
    key: string;
    label: string;
    state: 'done' | 'active' | 'pending' | 'unknown';
    note?: string;
  }[] = [
    {
      key: 'spec',
      label: 'Specification',
      state: isRegistered ? 'done' : 'active',
      note: isRegistered ? (view?.specId ?? undefined) : 'not registered',
    },
    {
      key: 'sources',
      label: 'Sources',
      state: !isRegistered
        ? 'pending'
        : keysKnown === true
          ? 'done'
          : keysKnown === false
            ? 'active'
            : 'unknown',
      note: !isRegistered
        ? undefined
        : keysKnown === null
          ? 'key inventory not exposed by this API build'
          : keysKnown === false
            ? 'no credentials issued yet'
            : undefined,
    },
    {
      key: 'authority',
      label: 'Authority',
      state: !isRegistered ? 'pending' : mandate !== null ? 'done' : 'active',
      note:
        mandate !== null
          ? money(mandate.currency, mandate.remaining_minor) + ' remaining'
          : 'no active mandate',
    },
    {
      key: 'evidence',
      label: 'Field evidence',
      state: !isRegistered
        ? 'pending'
        : eventCount === null
          ? 'unknown'
          : eventCount > 0
            ? 'done'
            : 'active',
      note:
        eventCount === null
          ? 'count unavailable'
          : eventCount > 0
            ? String(eventCount) + ' admitted event' + (eventCount === 1 ? '' : 's')
            : 'none admitted yet',
    },
    {
      key: 'decide',
      label: 'Decision',
      state: 'pending',
      note: 'Decision Room',
    },
  ];

  const formDisabled = !canOperate || registering;
  const statusBadge = isRegistered ? (
    <HaloBadge tone="info" glyph="●" label="Specification registered" />
  ) : (
    <HaloBadge tone="neutral" glyph="○" label="No specification yet" />
  );

  return (
    <Panel
      title="Mission Setup"
      testId="mission-setup"
      meta={<span className="mv-tag">{isRegistered ? 'CONFIGURED' : 'UNCONFIGURED'}</span>}
    >
      {/* ---- header: mission name is the primary title; one status badge ---- */}
      <header className="ms-head">
        <div className="ms-head__titlebox">
          <p className="ms-kicker mv-hud">
            mission <span className="mv-num">{mission.id.slice(0, 14)}…</span> · configure what
            MOTERVA may observe, decide and propose
          </p>
          <h2 className="ms-title">{mission.title}</h2>
          {isRegistered && view !== null && (
            <p className="ms-support" data-testid="ms-objective">
              {view.objective}
            </p>
          )}
        </div>
        <div className="ms-head__badges">
          {statusBadge}
          <span
            className="ms-policychip mv-hud"
            title="MOTERVA only proposes financial actions. Approval, reservation and provider execution are separate, human-governed controls."
          >
            Proposes only
          </span>
        </div>
      </header>

      {/* ---- readiness strip: real states only, never fake completion ---- */}
      <ol className="ms-rstrip" aria-label="Mission setup readiness" data-testid="ms-readiness">
        {readiness.map((r) => (
          <li className={'ms-rstrip__item is-' + r.state} key={r.key}>
            <span className="ms-rstrip__dot" aria-hidden="true">
              {r.state === 'done'
                ? '●'
                : r.state === 'active'
                  ? '◐'
                  : r.state === 'unknown'
                    ? '?'
                    : '○'}
            </span>
            <span className="ms-rstrip__label">{r.label}</span>
            {r.note !== undefined && <span className="ms-rstrip__note mv-hud">{r.note}</span>}
          </li>
        ))}
      </ol>

      {spec.kind === 'loading' && <SkeletonRows label="Reading the registered specification…" />}
      {spec.kind === 'error' && (
        <p className="mv-sheet__error" role="alert" data-testid="setup-spec-error">
          The mission specification could not be read ({spec.message}). Configuration is unavailable
          — not absent. Reselect the mission to retry.
        </p>
      )}
      {!canOperate && (
        <p className="mv-governed__note" role="note" data-testid="setup-role-note">
          Your role ({role ?? 'unknown'}) can read this configuration but cannot register or change
          it — the server requires operator or above.
        </p>
      )}
      {registered !== null && (
        <p role="status" className="mv-droom__notice" data-testid="setup-registered-notice">
          {registered.replayed
            ? 'This exact specification was already registered — nothing changed (idempotent).'
            : 'Specification registered.'}{' '}
          The next step is to onboard the sources that will report.
        </p>
      )}

      {/* ================= registered: brief (65) + financial boundaries (35) */}
      {view !== null && view.registered && (
        <div className="ms-grid">
          {/* ---------- left · mission brief ---------- */}
          <section className="ms-brief" aria-label="Mission brief" data-testid="setup-spec-summary">
            <h3 className="ms-coltitle">Mission brief</h3>
            <dl className="ms-rows">
              <div className="ms-row">
                <dt>Objective</dt>
                <dd>{view.objective}</dd>
              </div>
              <div className="ms-row">
                <dt>Participating assets</dt>
                <dd>
                  <ul className="ms-assets">
                    {view.assets.map((a) => (
                      <li key={a.assetId}>
                        <span className="ms-assets__name">{a.label}</span>
                        <span className="ms-assets__meta mv-hud">
                          {a.domainKind} · <span className="mv-num">{a.assetId}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
              <div className="ms-row">
                <dt>Safety policy</dt>
                <dd>
                  {view.safetyPolicy.uavWindLimitKt !== undefined && (
                    <p className="ms-row__line">
                      Flights are permitted only below{' '}
                      <strong>{String(view.safetyPolicy.uavWindLimitKt)} kt modeled wind</strong> —
                      an operating rule this mission declares, not a measurement.
                    </p>
                  )}
                  {view.safetyPolicy.groundInterrupts !== undefined && (
                    <p className="ms-row__line">
                      Ground operations halt on{' '}
                      <strong>{view.safetyPolicy.groundInterrupts.join(', ')}</strong>.
                    </p>
                  )}
                  {view.safetyPolicy.uavWindLimitKt === undefined &&
                    view.safetyPolicy.groundInterrupts === undefined && (
                      <p className="ms-row__line">No domain thresholds declared.</p>
                    )}
                </dd>
              </div>
              <div className="ms-row">
                <dt>Operating constraints</dt>
                <dd>
                  <ul className="ms-suppliers">
                    <li>
                      <span className="ms-suppliers__role">Incumbent</span>{' '}
                      {view.offers.incumbent.id} → {view.offers.incumbent.beneficiary} ·{' '}
                      <span className="mv-num">
                        {safeMoney(
                          view.offers.incumbent.currency,
                          view.offers.incumbent.baseCostMinor + view.offers.incumbent.feeMinor,
                        )}
                      </span>
                    </li>
                    {view.offers.alternatives.map((o) => (
                      <li key={o.id}>
                        <span className="ms-suppliers__role">Alternative</span> {o.id} →{' '}
                        {o.beneficiary} ·{' '}
                        <span className="mv-num">
                          {safeMoney(o.currency, o.baseCostMinor + o.feeMinor)}
                        </span>
                      </li>
                    ))}
                    {view.offers.diagnostics !== undefined && (
                      <li>
                        <span className="ms-suppliers__role">Diagnostics</span>{' '}
                        {view.offers.diagnostics.id} → {view.offers.diagnostics.beneficiary}
                      </li>
                    )}
                  </ul>
                </dd>
              </div>
            </dl>

            <details className="ms-details" data-testid="ms-techdetails">
              <summary>Technical details</summary>
              <div className="ms-details__body">
                <dl className="ms-rows">
                  <div className="ms-row">
                    <dt>Specification id</dt>
                    <dd className="mv-num">{view.specId}</dd>
                  </div>
                  <div className="ms-row">
                    <dt>Digest</dt>
                    <dd className="mv-num">
                      {view.specDigest} <CopyButton value={view.specDigest} label="digest" />
                    </dd>
                  </div>
                  <div className="ms-row">
                    <dt>Industry label</dt>
                    <dd>{view.industry}</dd>
                  </div>
                  <div className="ms-row">
                    <dt>Truth label</dt>
                    <dd>{view.truthLabel}</dd>
                  </div>
                </dl>
                <details className="mv-governed__manual">
                  <summary>Raw specification JSON</summary>
                  <pre className="ms-json mv-num" tabIndex={0}>
                    {JSON.stringify(view, null, 2)}
                  </pre>
                </details>
                <p className="mv-governed__note">
                  Read-only configuration; spending authority lives only in ledger mandates.
                </p>
              </div>
            </details>

            {canOperate && (
              <div className="ms-brief__actions">
                <button
                  type="button"
                  className="mv-btn"
                  data-testid="setup-new-version"
                  onClick={() => setShowForm(true)}
                >
                  Create new specification version
                </button>
              </div>
            )}
          </section>

          {/* ---------- right · financial boundaries ---------- */}
          <section
            className="ms-financial"
            aria-label="Financial boundaries"
            data-testid="setup-authority"
          >
            <h3 className="ms-coltitle">Financial boundaries</h3>
            <p className="mv-governed__note">
              Planning parameters for this mission — not account balances. Spending authority exists
              only as a ledger mandate granted by an owner or admin; a separate human approves every
              plan.
            </p>
            <dl className="ms-rows">
              <div className="ms-row">
                <dt>Mission value at stake</dt>
                <dd className="mv-num">
                  {safeMoney(view.economics.currency, view.economics.missionValueMinor)}
                </dd>
              </div>
              <div className="ms-row">
                <dt>Failure cost avoided</dt>
                <dd className="mv-num">
                  {safeMoney(view.economics.currency, view.economics.failureCostMinor)}
                </dd>
              </div>
              <div className="ms-row">
                <dt>Protected reserve — never spendable</dt>
                <dd className="mv-num">
                  {safeMoney(view.economics.currency, view.economics.protectedReserveMinor)}
                </dd>
              </div>
              <div className="ms-row">
                <dt>Decision deadline</dt>
                <dd className="mv-num">
                  +{String(view.economics.deadlineOffsetMinutes)} min after evaluation
                </dd>
              </div>
            </dl>
            <p className="mv-governed__note" data-testid="setup-mandate-shape">
              Expected mandate shape: {view.financialMandateShape.currency} · beneficiaries{' '}
              {view.financialMandateShape.allowedBeneficiaries.join(', ')} · purposes{' '}
              {view.financialMandateShape.allowedPurposes.join(', ')}
            </p>
            {mandate !== null ? (
              <p role="status" data-testid="setup-mandate-active">
                Active mandate v{String(mandate.version)}:{' '}
                <span className="mv-num">{money(mandate.currency, mandate.remaining_minor)}</span>{' '}
                remaining of {money(mandate.currency, mandate.total_budget_minor)} · expires{' '}
                {mandate.expires_at}
              </p>
            ) : (
              <p className="mv-governed__note">
                No active mandate in {economicsCurrency} for this mission — every spend candidate
                will be refused until one is granted.
              </p>
            )}
            {mandateNotice !== null && (
              <p role="status" className="mv-droom__notice" data-testid="setup-mandate-notice">
                {mandateNotice}
              </p>
            )}
            <div className="ms-financial__actions">
              <button
                type="button"
                className="mv-btn"
                data-testid="setup-grant-authority"
                disabled={csrfToken === null}
                onClick={() => setSheet('mandate')}
              >
                {canGrant ? 'Grant spending authority' : 'Review the authority request'}
              </button>
              <a
                className="mv-btn mv-btn--primary"
                href="#decisions"
                data-testid="setup-open-decisions"
              >
                Continue: evaluate field evidence →
              </a>
            </div>
          </section>
        </div>
      )}

      {/* ================= unregistered: honest note, then the authoring form */}
      {view !== null && !view.registered && (
        <section
          className="ms-brief"
          aria-label="Registered specification"
          data-testid="setup-spec-summary"
        >
          <h3 className="ms-coltitle">Mission brief</h3>
          <p className="mv-governed__note" data-testid="setup-unregistered">
            <strong>No specification is registered for this mission.</strong> Without one the server
            would evaluate against the built-in harbor DEMO default — MOTERVA will not do that for a
            customer mission silently. Register your own specification below before evaluating.
          </p>
        </section>
      )}

      {/* ------------------------------------------------------ authoring form */}
      {view !== null && (!view.registered || showForm) && (
        <section
          className="mv-governed"
          aria-label="Author a mission specification"
          data-testid="setup-author"
        >
          <h3 className="mv-droom__secttitle">
            {view.registered ? 'New specification version' : 'Author your mission specification'}
          </h3>
          <p className="mv-governed__lead">
            Describe <em>your</em> mission. The form is intentionally empty — MOTERVA does not
            prefill example numbers. Every amount is checked exactly (no rounding), and the same
            rules the server enforces are applied here first. The server remains the authority.
          </p>
          {issues.length > 0 && (
            <div
              className="mv-sheet__error"
              role="alert"
              tabIndex={-1}
              ref={summaryRef}
              data-testid="setup-issues"
            >
              <strong>
                {String(issues.length)} problem{issues.length === 1 ? '' : 's'} to fix:
              </strong>
              <ul>
                {issues.map((i) => (
                  <li key={`${i.path}:${i.code}`}>
                    {i.message} <span className="mv-spec__code">{i.code}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {wire === null ? (
            <>
              <SpecForm draft={draft} onChange={setDraft} issues={issues} disabled={formDisabled} />
              <div className="mv-sheet__actions">
                <button
                  type="button"
                  className="mv-btn mv-btn--primary"
                  data-testid="setup-review"
                  disabled={formDisabled}
                  onClick={startReview}
                >
                  Review exact specification
                </button>
              </div>
            </>
          ) : (
            <div data-testid="setup-review-pane">
              <p className="mv-governed__lead">
                Review exactly what will be registered. Once registered a specification is immutable
                history; change it later by registering a NEW spec id.
              </p>
              <dl className="mv-mandate__meta">
                {reviewRows(wire).map((row) => (
                  <div key={row.label}>
                    <dt>{row.label}</dt>
                    <dd className="mv-wrap">{row.value}</dd>
                  </div>
                ))}
              </dl>
              {registerError !== null && (
                <p className="mv-sheet__error" role="alert" data-testid="setup-register-error">
                  {registerError}
                </p>
              )}
              <div className="mv-sheet__actions">
                <button
                  type="button"
                  className="mv-btn"
                  disabled={registering}
                  onClick={() => {
                    setWire(null);
                    setRegisterError(null);
                  }}
                >
                  Back to edit
                </button>
                <button
                  type="button"
                  className="mv-btn mv-btn--primary"
                  data-testid="setup-register"
                  disabled={registering || csrfToken === null || !canOperate}
                  onClick={register}
                >
                  {registering ? 'Registering…' : 'Register specification'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ---------------------------- sources + collapsed developer integration */}
      {isRegistered && (
        <>
          <SourceCredentials
            key={mission.id}
            missionId={mission.id}
            sources={declaredSources}
            credentials={credentialsMeta}
            csrfToken={csrfToken}
            canIssue={canOperate}
            canRevoke={canGrant}
            onSessionExpired={onSessionExpired}
            onIssued={() => setIssuedKeyCount((n) => n + 1)}
          />
          <details className="ms-devint" data-testid="developer-integration">
            <summary>
              Developer integration / API reference
              <span className="ms-devint__hint mv-hud">
                how a field system sends signed evidence
              </span>
            </summary>
            <div className="ms-devint__inner">
              <h3 className="ms-coltitle">How a field system sends signed evidence</h3>
              <HeadlessGuide
                missionId={mission.id}
                orgId={orgId}
                source={sourceForGuide}
                assetDomain={domainOf(sourceForGuide?.assetIds[0])}
                embedded
              />
            </div>
          </details>
        </>
      )}

      {sheet === 'mandate' && view !== null && (
        <MandateCreateSheet
          missionId={mission.id}
          missionTitle={mission.title}
          canManageAuthority={canGrant}
          csrfToken={csrfToken}
          prefill={{
            currency: view.financialMandateShape.currency,
            beneficiaries: view.financialMandateShape.allowedBeneficiaries,
            purposes: view.financialMandateShape.allowedPurposes,
          }}
          onClose={() => setSheet('none')}
          onCreated={() => {
            setSheet('none');
            // Exact amounts come from the server RE-READ (reload below) —
            // never from assumptions about the create response shape.
            setMandateNotice(
              'Spending authority granted. A separate approver must still approve every plan; nothing is spent by granting it.',
            );
            reload();
          }}
        />
      )}
    </Panel>
  );
}
