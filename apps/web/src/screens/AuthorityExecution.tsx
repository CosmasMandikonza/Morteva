import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Panel } from '../components/Panel';
import {
  approvalsFromEvidence,
  fetchDecisionPlans,
  fetchMandates,
  fetchMissionEvidence,
  fetchOperations,
  mayApprove,
  type DecisionPlanProposal,
  type MandateRow,
  type OperationListView,
  type RecordedApproval,
  type SessionState,
} from '../lib/api';
import { formatDate, safeMoney } from '../lib/format';
import { StatusChip } from '../components/StatusChip';
import { operationPresentation } from '../status/statusMap';
import { ApprovePlanSheet } from '../components/GovernedActions';
import { CopyButton, HaloBadge, HaloProgress, SkeletonRows, Stepper } from '../components/ui';

/**
 * Authority & Execution (MTV-20) — the financial authority system surface.
 * Everything renders from real server reads: durable decision plans
 * (immutable id/version/digest + server-derived terms), journal-verified
 * approvals, effective mandates with envelope consumption, and the
 * mission's operations with their factual status. No checkout theatrics:
 * the approval act stays a quiet, high-contrast control, and the stepper is
 * the factual sequence, not an animation.
 */
export function AuthorityExecution({
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
  const [plans, setPlans] = useState<readonly DecisionPlanProposal[]>([]);
  const [approvals, setApprovals] = useState<RecordedApproval[]>([]);
  const [mandates, setMandates] = useState<readonly MandateRow[]>([]);
  const [operations, setOperations] = useState<OperationListView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'none' | 'approve'>('none');
  const [approveTarget, setApproveTarget] = useState<DecisionPlanProposal | null>(null);
  const role = session.kind === 'signed-in' ? session.session.actor.role : null;

  const refresh = useCallback((missionId: string, signal: AbortSignal): void => {
    fetchDecisionPlans(missionId, signal)
      .then((r) => {
        if (!signal.aborted) setPlans(r.plans);
      })
      .catch(() => undefined);
    fetchMissionEvidence(missionId, { topic: 'financial', limit: 100 }, signal)
      .then((r) => {
        if (!signal.aborted) {
          setApprovals(
            approvalsFromEvidence(
              r.events.map((e) => ({
                type: e.type ?? '',
                payload: (e.payload ?? {}) as Record<string, unknown>,
              })),
            ),
          );
        }
      })
      .catch(() => undefined);
    fetchMandates(missionId, signal)
      .then((rows) => {
        if (!signal.aborted) setMandates(rows);
      })
      .catch(() => undefined);
    fetchOperations({ missionId, limit: 25 }, signal)
      .then((r) => {
        if (!signal.aborted) setOperations(r);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (session.kind !== 'signed-in' || mission === null) {
      setPlans([]);
      setApprovals([]);
      setMandates([]);
      setOperations(null);
      setSheet('none');
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    refresh(mission.id, controller.signal);
    // Loading ends when the first wave settles; individual panels degrade
    // independently (an unavailable renderer must not block finances).
    const t = window.setTimeout(() => setLoading(false), 1200);
    return () => {
      controller.abort();
      window.clearTimeout(t);
    };
  }, [mission?.id, session.kind, refresh, onSessionExpired]);

  const effective = mandates.filter(
    (m) => m.status === 'active' && Date.parse(m.expires_at) > Date.now(),
  );
  const history = mandates.filter(
    (m) => !(m.status === 'active' && Date.parse(m.expires_at) > Date.now()),
  );

  if (session.kind !== 'signed-in') {
    return (
      <Panel title="Authority & Execution" testId="authority-surface">
        <p>Sign in through Mission Treasury to inspect spending authority.</p>
      </Panel>
    );
  }
  if (mission === null) {
    return (
      <Panel title="Authority & Execution" testId="authority-surface">
        <p>Select an inspection mission in Mission Treasury first.</p>
      </Panel>
    );
  }

  const planFor = (planId: string, planVersion: number) =>
    approvals.find((a) => a.planId === planId && a.planVersion === planVersion) ?? null;

  return (
    <Panel
      title="Authority & Execution"
      meta={
        <span className="mv-tag">
          {mission.title.slice(0, 24)}
          {mission.title.length > 24 ? '…' : ''}
        </span>
      }
      testId="authority-surface"
    >
      {error !== null && (
        <p role="alert" className="mv-sheet__error">
          {error}
        </p>
      )}
      {loading && plans.length === 0 && mandates.length === 0 && <SkeletonRows rows={4} />}

      {/* ---- spending authority (mandates) with envelope consumption ---- */}
      <section className="mv-auth__section" aria-label="Spending authority">
        <h3 className="mv-auth__head">Spending authority under this mission</h3>
        {effective.length === 0 ? (
          <p className="mv-governed__note">
            No effective mandate — spending authority is granted in Mission Treasury (owner/admin,
            exact review). Without it, no payment can be proposed, approved or reserved.
          </p>
        ) : (
          <ul className="mv-auth__list">
            {effective.map((m) => (
              <li key={m.id} className="mv-auth__mandate" data-testid="authority-mandate">
                <div className="mv-auth__mandatehead">
                  <HaloBadge tone="verified" glyph="◆" label={`active · v${String(m.version)}`} />
                  <span className="mv-num mv-auth__mandatecap">
                    {safeMoney(m.currency, m.max_amount_minor)} per action
                  </span>
                  <span className="mv-hud">expires {formatDate(m.expires_at)}</span>
                </div>
                <HaloProgress
                  label="Mission budget envelope"
                  usedMinor={m.consumed_minor}
                  totalMinor={m.total_budget_minor}
                  currency={m.currency}
                  warn={m.consumed_minor > m.total_budget_minor * 0.8}
                />
                <p className="mv-hud">
                  kinds{' '}
                  {(() => {
                    try {
                      return (JSON.parse(m.permitted_kinds_json) as string[]).join(' · ');
                    } catch {
                      return m.permitted_kinds_json;
                    }
                  })()}
                </p>
              </li>
            ))}
          </ul>
        )}
        {history.length > 0 && (
          <details className="mv-auth__history">
            <summary>Superseded / expired / revoked authority ({String(history.length)})</summary>
            <ul className="mv-governed__list">
              {history.map((m) => (
                <li key={m.id}>
                  {m.currency} v{String(m.version)} — {m.status}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* ---- exact-term proposals + approval state ---- */}
      <section className="mv-auth__section" aria-label="Proposals and approvals">
        <h3 className="mv-auth__head">Immutable proposals awaiting authority</h3>
        {plans.length === 0 ? (
          <p className="mv-governed__note">
            No proposals recorded for this mission. Propose from a recorded evaluation in the
            Decision Room — terms are derived by the server, never typed.
          </p>
        ) : (
          <ul className="mv-auth__list">
            {plans.map((p) => {
              const recorded = planFor(p.plan.id, p.plan.version);
              return (
                <li key={`${p.plan.id}:${String(p.plan.version)}`} className="mv-auth__plan">
                  <div className="mv-auth__planterms">
                    <span className="mv-auth__amount mv-num">
                      {safeMoney(p.plan.terms.currency, p.plan.terms.amountMinor)}
                    </span>
                    <span className="mv-auth__terms">
                      {p.plan.terms.beneficiary} · {p.plan.terms.purpose} · {p.plan.terms.currency}
                    </span>
                  </div>
                  <dl className="mv-mandate__meta">
                    <div>
                      <dt>Plan</dt>
                      <dd>
                        <span className="mv-num" title={p.plan.id}>
                          {p.plan.id}
                        </span>{' '}
                        v{String(p.plan.version)}
                        <CopyButton value={p.plan.id} label="plan id" />
                      </dd>
                    </div>
                    <div>
                      <dt>Terms digest</dt>
                      <dd>
                        <span className="mv-num mv-break" title={p.plan.digest}>
                          {p.plan.digest}
                        </span>
                        <CopyButton value={p.plan.digest} label="digest" />
                      </dd>
                    </div>
                    <div>
                      <dt>Proposed by</dt>
                      <dd>
                        <span className="mv-num" title={p.proposedBy}>
                          {p.proposedBy}
                        </span>
                      </dd>
                    </div>
                  </dl>
                  <Stepper
                    ariaLabel="This proposal's authority sequence"
                    steps={[
                      {
                        key: 'proposed',
                        label: 'Proposed',
                        state: 'done',
                        note: 'evaluation-linked',
                      },
                      {
                        key: 'approved',
                        label: 'Approved',
                        state: recorded ? 'done' : 'active',
                        note: recorded ? undefined : 'different actor required',
                      },
                      {
                        key: 'reserved',
                        label: 'Reserved',
                        state: 'pending',
                        note: 'ledger re-checks all authority',
                      },
                      {
                        key: 'submitted',
                        label: 'Submitted',
                        state: 'pending',
                        note: 'provider rail — disabled offline',
                      },
                      {
                        key: 'verified',
                        label: 'Verified settled',
                        state: 'pending',
                        note: 'provider readback only',
                      },
                    ]}
                  />
                  {recorded ? (
                    <p className="mv-auth__approval" data-testid="authority-approval">
                      <HaloBadge tone="hold" glyph="◆" label="approval recorded" /> approval{' '}
                      <span className="mv-num" title={recorded.approvalId}>
                        {recorded.approvalId}
                      </span>{' '}
                      · kind {recorded.kind} · decided by{' '}
                      <span className="mv-num" title={recorded.decidedBy}>
                        {recorded.decidedBy.slice(0, 10)}…
                      </span>{' '}
                      · expires {formatDate(recorded.expiresAt)}
                    </p>
                  ) : (
                    mayApprove(role) && (
                      <button
                        type="button"
                        className="mv-btn mv-btn--primary"
                        data-testid="authority-open-approve"
                        disabled={csrfToken === null}
                        onClick={() => {
                          setApproveTarget(p);
                          setSheet('approve');
                        }}
                      >
                        Review exact terms and approve
                      </button>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="mv-governed__note">
          Approval authorizes reservation only — submission and verification are separate, later
          controls, and the provider rail is offline on this build (no settlement is ever implied).
        </p>
      </section>

      {/* ---- operations under this authority ---- */}
      <section className="mv-auth__section" aria-label="Operations under this authority">
        <h3 className="mv-auth__head">Operations executing under this mission</h3>
        {operations === null ? (
          <p className="mv-governed__note">Operations are loading or unavailable.</p>
        ) : operations.operations.length === 0 ? (
          <p className="mv-governed__note">No operations yet for this mission.</p>
        ) : (
          <ul className="mv-governed__list">
            {operations.operations.slice(0, 8).map((op) => (
              <li key={op.id}>
                <StatusChip entry={operationPresentation(op.state)} />{' '}
                <span className="mv-num" title={op.id}>
                  {op.id.slice(0, 14)}…
                </span>{' '}
                · {op.amount.currency} {op.amount.major}
              </li>
            ))}
          </ul>
        )}
      </section>

      {sheet === 'approve' && approveTarget !== null && (
        <ApprovePlanSheet
          missionId={mission.id}
          missionTitle={mission.title}
          plan={approveTarget.plan}
          terms={approveTarget.plan.terms}
          role={role}
          mandates={mandates}
          onClose={() => setSheet('none')}
          onApproved={() => {
            setSheet('none');
            refresh(mission.id, new AbortController().signal);
          }}
          csrfToken={csrfToken}
        />
      )}
    </Panel>
  );
}
