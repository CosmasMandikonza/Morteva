import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Panel } from '../components/Panel';
import { HaloBadge, SkeletonRows, Stepper } from '../components/ui';
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

  const steps = [
    {
      key: 'spec',
      label: 'Mission specification',
      state: isRegistered ? ('done' as const) : ('active' as const),
      note: isRegistered
        ? `registered · ${view?.specId ?? ''}`
        : 'not registered — a fresh mission would fall back to the harbor DEMO default',
    },
    {
      key: 'sources',
      label: 'Source credentials',
      state: !isRegistered
        ? ('pending' as const)
        : keysKnown === true
          ? ('done' as const)
          : keysKnown === false
            ? ('active' as const)
            : ('unknown' as const),
      note: !isRegistered
        ? 'after the specification'
        : keysKnown === null
          ? 'key inventory not exposed by this API build'
          : undefined,
    },
    {
      key: 'authority',
      label: 'Spending authority',
      state: !isRegistered
        ? ('pending' as const)
        : mandate !== null
          ? ('done' as const)
          : ('active' as const),
      note:
        mandate !== null
          ? `active mandate v${String(mandate.version)} · ${money(mandate.currency, mandate.remaining_minor)} remaining`
          : 'no active mandate — decisions cannot propose spend',
    },
    {
      key: 'evidence',
      label: 'Authenticated field evidence',
      state: !isRegistered
        ? ('pending' as const)
        : eventCount === null
          ? ('unknown' as const)
          : eventCount > 0
            ? ('done' as const)
            : ('active' as const),
      note:
        eventCount === null
          ? undefined
          : eventCount > 0
            ? `${String(eventCount)} admitted event${eventCount === 1 ? '' : 's'}`
            : 'no observations admitted yet',
    },
    {
      key: 'decide',
      label: 'Evaluate & approve',
      state: 'pending' as const,
      note: 'Decision Room',
    },
  ];

  const formDisabled = !canOperate || registering;

  return (
    <Panel
      title="Mission setup"
      testId="mission-setup"
      meta={
        <span className="mv-tag">
          {isRegistered ? 'SPECIFICATION REGISTERED' : 'NO SPECIFICATION YET'}
        </span>
      }
    >
      <header className="mv-droom__head">
        <div className="mv-droom__titlebox">
          <h2 className="mv-droom__title">{mission.title}</h2>
          <p className="mv-droom__sub mv-hud">
            mission <span className="mv-num">{mission.id.slice(0, 14)}…</span> · configure what
            MOTERVA may observe, decide and propose
          </p>
        </div>
        <div className="mv-droom__badges">
          <HaloBadge tone="hold" glyph="⚑" label="PROPOSES ONLY" />
          <HaloBadge tone="neutral" glyph="◇" label="POLICY-ONLY DECISIONS" />
        </div>
      </header>

      <Stepper steps={steps} ariaLabel="Mission setup readiness" />

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
          Spec <span className="mv-num">{registered.specId}</span> · digest{' '}
          <span className="mv-num">{registered.digest}</span>. Specifications are immutable history;
          the next step is to onboard the sources that will report.
        </p>
      )}

      {/* -------------------------------------------- registered specification */}
      {view !== null && (
        <section
          className="mv-governed"
          aria-label="Registered specification"
          data-testid="setup-spec-summary"
        >
          <h3 className="mv-droom__secttitle">Registered specification</h3>
          {!view.registered ? (
            <p className="mv-governed__note" data-testid="setup-unregistered">
              <strong>No specification is registered for this mission.</strong> Without one the
              server would evaluate against the built-in harbor DEMO default — MOTERVA will not do
              that for a customer mission silently. Register your own specification below before
              evaluating.
            </p>
          ) : (
            <>
              <dl className="mv-mandate__meta">
                <div>
                  <dt>Spec id · digest</dt>
                  <dd className="mv-num">
                    {view.specId} · {view.specDigest}
                  </dd>
                </div>
                <div>
                  <dt>Industry label</dt>
                  <dd>{view.industry}</dd>
                </div>
                <div>
                  <dt>Objective</dt>
                  <dd>{view.objective}</dd>
                </div>
                <div>
                  <dt>Assets</dt>
                  <dd>
                    {view.assets
                      .map((a) => `${a.label} (${a.domainKind}, ${a.assetId})`)
                      .join(' · ')}
                  </dd>
                </div>
                <div>
                  <dt>Safety thresholds</dt>
                  <dd>
                    {view.safetyPolicy.uavWindLimitKt !== undefined
                      ? `wind limit ${String(view.safetyPolicy.uavWindLimitKt)} kt (modeled rule, not a measurement)`
                      : null}
                    {view.safetyPolicy.groundInterrupts !== undefined
                      ? ` ground interrupts: ${view.safetyPolicy.groundInterrupts.join(', ')}`
                      : null}
                    {view.safetyPolicy.uavWindLimitKt === undefined &&
                    view.safetyPolicy.groundInterrupts === undefined
                      ? 'none declared'
                      : null}
                  </dd>
                </div>
                <div>
                  <dt>Economics</dt>
                  <dd className="mv-num">
                    value {safeMoney(view.economics.currency, view.economics.missionValueMinor)} ·
                    failure {safeMoney(view.economics.currency, view.economics.failureCostMinor)} ·
                    reserve{' '}
                    {safeMoney(view.economics.currency, view.economics.protectedReserveMinor)} ·
                    deadline +{String(view.economics.deadlineOffsetMinutes)} min
                  </dd>
                </div>
                <div>
                  <dt>Suppliers</dt>
                  <dd>
                    incumbent {view.offers.incumbent.id} → {view.offers.incumbent.beneficiary} (
                    {safeMoney(
                      view.offers.incumbent.currency,
                      view.offers.incumbent.baseCostMinor + view.offers.incumbent.feeMinor,
                    )}
                    )
                    {view.offers.alternatives.map((o) => (
                      <span key={o.id}>
                        {' '}
                        · alternative {o.id} → {o.beneficiary} (
                        {safeMoney(o.currency, o.baseCostMinor + o.feeMinor)})
                      </span>
                    ))}
                    {view.offers.diagnostics !== undefined
                      ? ` · diagnostics ${view.offers.diagnostics.id}`
                      : ''}
                  </dd>
                </div>
              </dl>
              <p className="mv-governed__note">
                {view.truthLabel}. Read-only: spending authority lives only in ledger mandates.
              </p>
            </>
          )}
          {canOperate && view.registered && !showForm && (
            <button
              type="button"
              className="mv-btn"
              data-testid="setup-new-version"
              onClick={() => setShowForm(true)}
            >
              Register a new specification version
            </button>
          )}
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
                    <dd className="mv-break">{row.value}</dd>
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

      {/* ------------------------------------------------- sources + guide */}
      {isRegistered && (
        <>
          <SourceCredentials
            key={mission.id}
            missionId={mission.id}
            sources={declaredSources}
            credentials={credentialsMeta}
            csrfToken={csrfToken}
            canIssue={canOperate}
            onSessionExpired={onSessionExpired}
            onIssued={() => setIssuedKeyCount((n) => n + 1)}
          />
          <HeadlessGuide
            missionId={mission.id}
            orgId={orgId}
            source={sourceForGuide}
            assetDomain={domainOf(sourceForGuide?.assetIds[0])}
          />

          {/* -------------------------------------------------- authority */}
          <section
            className="mv-governed"
            aria-label="Spending authority"
            data-testid="setup-authority"
          >
            <h3 className="mv-droom__secttitle">Spending authority</h3>
            <p className="mv-governed__lead">
              The specification only states which suppliers and purposes this mission{' '}
              <em>expects</em>. Authority to spend exists only as a ledger mandate granted by a
              human owner or admin — with a cap, a budget, an expiry, and exact beneficiaries and
              purposes. A separate human approves every plan.
            </p>
            <p className="mv-governed__note" data-testid="setup-mandate-shape">
              Expected mandate shape: {view?.financialMandateShape.currency} · beneficiaries{' '}
              {view?.financialMandateShape.allowedBeneficiaries.join(', ')} · purposes{' '}
              {view?.financialMandateShape.allowedPurposes.join(', ')}
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
            <div className="mv-droom__actions">
              <button
                type="button"
                className="mv-btn"
                data-testid="setup-grant-authority"
                disabled={csrfToken === null}
                onClick={() => setSheet('mandate')}
              >
                {canGrant
                  ? 'Grant spending authority (prefilled from the specification)'
                  : 'Review the authority request (owner or admin grants it)'}
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
