import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import './authority-execution-polish.css';
import { Panel } from '../components/Panel';
import {
  ApiError,
  approvalsFromEvidence,
  fetchDecisionPlans,
  fetchMandates,
  fetchMissionEvidence,
  fetchOperations,
  mayApprove,
  type DecisionPlanProposal,
  type MandateRow,
  type OperationListView,
  type OperationReadView,
  type RecordedApproval,
  type SessionState,
} from '../lib/api';
import {
  formatDate,
  moneyAmount,
  parseJsonArray,
  percent,
  safeMoney,
  shortId,
} from '../lib/format';
import { StatusChip } from '../components/StatusChip';
import {
  mandatePresentation,
  operationPresentationFor,
  type PresentationEntry,
} from '../status/statusMap';
import { ApprovePlanSheet } from '../components/GovernedActions';
import { CopyButton, HaloBadge, SkeletonRows, Stepper } from '../components/ui';

/**
 * Authority & Execution (MTV-20) — the financial authority console.
 * Everything renders from real server reads: durable decision plans
 * (immutable id/version/digest + server-derived terms), journal-verified
 * approvals, effective mandates with envelope consumption, and the
 * mission's operations with their factual status. No checkout theatrics:
 * the approval act stays a quiet, high-contrast control, and the stepper is
 * the factual sequence, never an animation.
 *
 * The presentation derives from journalled evidence ONLY (proposal rows are
 * matched to their operation by plan id + version; a step is "done" when the
 * ledger says so, never by assumption). Derivations are pure functions
 * exported below and unit-tested in apps/web/test/authorityExecution.test.ts.
 */

/** Compact relative window ("in 26h") with the absolute timestamp one
 *  title/`title` hover away; invalid input renders raw, never a guess. */
export function formatWindow(iso: string, now: Date): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const ms = at - now.getTime();
  const past = ms < 0;
  const abs = Math.abs(ms);
  let compact: string;
  if (abs < 90_000) compact = '1m';
  else if (abs < 5_400_000) compact = `${String(Math.round(abs / 60_000))}m`;
  else if (abs < 172_800_000) compact = `${String(Math.round(abs / 3_600_000))}h`;
  else if (abs < 45 * 86_400_000) compact = `${String(Math.round(abs / 86_400_000))}d`;
  else return formatDate(iso); // far out: the absolute date reads clearer
  return past ? `${compact} ago` : `in ${compact}`;
}

/** Effective = active status AND wall-clock unexpired (the ledger's own
 *  spend gate); everything else is inspectable history, never spendable. */
export function splitMandates(
  mandates: readonly MandateRow[],
  now: Date,
): { effective: readonly MandateRow[]; history: readonly MandateRow[] } {
  const effective = mandates.filter(
    (m) => m.status === 'active' && Date.parse(m.expires_at) > now.getTime(),
  );
  const history = mandates.filter(
    (m) => !(m.status === 'active' && Date.parse(m.expires_at) > now.getTime()),
  );
  return { effective, history };
}

/** Per-currency authority rollup. Same-currency envelopes may aggregate
 *  (identical unit); unlike currencies are NEVER summed or merged. */
export interface AuthorityRollup {
  readonly currency: string;
  readonly count: number;
  readonly capMinor: number;
  readonly remainingMinor: number;
  readonly totalMinor: number;
}

export function authorityByCurrency(effective: readonly MandateRow[]): readonly AuthorityRollup[] {
  const groups = new Map<string, AuthorityRollup>();
  for (const m of effective) {
    const g = groups.get(m.currency);
    if (g === undefined) {
      groups.set(m.currency, {
        currency: m.currency,
        count: 1,
        capMinor: m.max_amount_minor,
        remainingMinor: m.remaining_minor,
        totalMinor: m.total_budget_minor,
      });
    } else {
      groups.set(m.currency, {
        currency: m.currency,
        count: g.count + 1,
        capMinor: Math.max(g.capMinor, m.max_amount_minor),
        remainingMinor: g.remainingMinor + m.remaining_minor,
        totalMinor: g.totalMinor + m.total_budget_minor,
      });
    }
  }
  return [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Version-exact approval match (a stale version is NOT this plan's approval). */
export function approvalFor(
  approvals: readonly RecordedApproval[],
  planId: string,
  planVersion: number,
): RecordedApproval | null {
  return approvals.find((a) => a.planId === planId && a.planVersion === planVersion) ?? null;
}

export interface ProposalStats {
  readonly open: number;
  readonly approved: number;
  readonly total: number;
}

export function proposalStats(
  plans: readonly DecisionPlanProposal[],
  approvals: readonly RecordedApproval[],
): ProposalStats {
  const open = plans.filter((p) => approvalFor(approvals, p.plan.id, p.plan.version) === null);
  return { open: open.length, approved: plans.length - open.length, total: plans.length };
}

/** Actionable = unapproved AND this actor may approve AND the session's CSRF
 *  protection is present. Anything less renders read-only, never a fake
 *  disabled affordance implying permission. */
export function isActionableProposal(
  plan: DecisionPlanProposal,
  approvals: readonly RecordedApproval[],
  role: string | null,
  csrfToken: string | null,
): boolean {
  return (
    approvalFor(approvals, plan.plan.id, plan.plan.version) === null &&
    mayApprove(role) &&
    csrfToken !== null
  );
}

/** The journalled operation for a plan, matched by id AND version. */
export function operationForPlan(
  operations: readonly OperationReadView[],
  planId: string,
  planVersion: number,
): OperationReadView | null {
  return operations.find((o) => o.planId === planId && o.planVersion === planVersion) ?? null;
}

/** History-row presentation: a mandate whose status is still "active" but
 *  whose expiry lapsed by wall clock is NEVER shown as "Mandate active" —
 *  it renders a distinct lapsed entry (the founder UX gate the Treasury
 *  screen already enforces for its own lapsed section). */
export function historyPresentation(m: MandateRow, now: Date): PresentationEntry {
  if (m.status === 'active' && !(Date.parse(m.expires_at) > now.getTime())) {
    return {
      tone: 'hold',
      glyph: '⌛',
      label: 'Lapsed — not spendable',
      meaning:
        'ledger status is active but the expiry has passed by wall clock; no new spend is possible',
    };
  }
  return mandatePresentation(m.status);
}

export type JourneyStep = {
  readonly key: string;
  readonly label: string;
  readonly state: 'done' | 'active' | 'pending' | 'halted' | 'unknown';
  readonly note?: string;
};

const RESERVATION_PROVEN: ReadonlySet<string> = new Set([
  'RESERVED',
  'SUBMITTING',
  'IN_FLIGHT',
  'STATUS_UNKNOWN',
  'SETTLED',
  'RECONCILED',
]);
const DISPATCH_PROVEN: ReadonlySet<string> = new Set([
  'SUBMITTING',
  'IN_FLIGHT',
  'SETTLED',
  'RECONCILED',
]);
const REFUSED: ReadonlySet<string> = new Set(['REJECTED', 'EXPIRED', 'CANCELLED']);

/** The five-stage authority sequence, every stage marked from ledger
 *  evidence only. "done" needs proof; unproven future stages stay pending
 *  and honestly say why. */
export function journeySteps(
  proposal: DecisionPlanProposal,
  recorded: RecordedApproval | null,
  operation: OperationReadView | null,
  role: string | null,
): readonly JourneyStep[] {
  const state = operation?.state ?? null;
  const rail = operation?.dispatch?.rail ?? null;
  const completed = state === 'SETTLED' || state === 'RECONCILED';
  // Internal holds can complete without ever going to a payment provider.
  // Do not put a green "Verified settled" step on that ledger-only path.
  const internalPath =
    operation !== null && (operation.kind === 'internal_hold' || (completed && rail === null));
  const authoritySteps: JourneyStep[] = [
    {
      key: 'proposed',
      label: 'Proposed',
      state: 'done',
      note: 'evaluation-linked',
    },
    {
      key: 'approved',
      label: 'Approved',
      state: recorded !== null ? 'done' : 'active',
      note:
        recorded !== null
          ? `journal-verified · ${shortId(recorded.approvalId)}`
          : mayApprove(role)
            ? 'awaiting your approval'
            : 'different actor required',
    },
    {
      key: 'reserved',
      label: 'Reserved',
      state:
        state !== null && RESERVATION_PROVEN.has(state)
          ? 'done'
          : state !== null && REFUSED.has(state)
            ? 'halted'
            : 'pending',
      note:
        state !== null && REFUSED.has(state)
          ? 'reservation refused — see operations'
          : state !== null && RESERVATION_PROVEN.has(state)
            ? 'internal ledger hold — not provider escrow'
            : 'ledger re-checks all authority',
    },
  ];

  if (internalPath) {
    return [
      ...authoritySteps,
      {
        key: 'verified',
        label: completed
          ? state === 'RECONCILED'
            ? 'Reconciled internally'
            : 'Completed internally'
          : 'Internal completion',
        state: completed ? 'done' : state === 'STATUS_UNKNOWN' ? 'unknown' : 'pending',
        note: completed
          ? 'internal completion — no provider dispatch or provider settlement'
          : 'ledger-only operation — no provider submission',
      },
    ];
  }

  return [
    ...authoritySteps,
    {
      key: 'submitted',
      label: 'Submitted',
      state:
        rail !== null && state !== null && DISPATCH_PROVEN.has(state)
          ? 'done'
          : state === 'STATUS_UNKNOWN'
            ? 'unknown'
            : 'pending',
      note:
        rail !== null && state !== null && DISPATCH_PROVEN.has(state)
          ? `outbox · ${rail}`
          : state === 'STATUS_UNKNOWN'
            ? 'status unknown — awaiting provider readback'
            : 'provider rail — disabled offline',
    },
    {
      key: 'verified',
      label: 'Verified settled',
      state: completed && rail !== null ? 'done' : 'pending',
      note: completed && rail !== null ? 'provider readback attested' : 'provider readback only',
    },
  ];
}

/** The proposal's current state chip: operation truth when an operation
 *  exists (rail-aware), otherwise the authorization truth. Approval is
 *  never conflated with reservation or settlement. */
export function proposalStateEntry(
  recorded: RecordedApproval | null,
  operation: OperationReadView | null,
): PresentationEntry {
  if (operation !== null) {
    return operationPresentationFor(operation.state, {
      kind: operation.kind,
      dispatch: operation.dispatch,
    });
  }
  if (recorded !== null) {
    return {
      tone: 'info',
      glyph: '✓',
      label: 'Approved — awaiting reservation',
      meaning: 'journal-verified approval; reservation is a separate ledger step',
    };
  }
  return {
    tone: 'neutral',
    glyph: '○',
    label: 'Proposed — awaiting approval',
    meaning: 'exact terms recorded; nothing reserved, nothing paid',
  };
}

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
  /** Per-read outcome: each section renders its own truth — R3 P1-5 forbids
   *  collapsing a failed read into an "empty" state. */
  type ReadState =
    | { kind: 'loading' }
    | { kind: 'ready' }
    | { kind: 'error'; status: number | null; code: string };
  const [plansState, setPlansState] = useState<ReadState>({ kind: 'loading' });
  const [mandatesState, setMandatesState] = useState<ReadState>({ kind: 'loading' });
  const [opsState, setOpsState] = useState<ReadState>({ kind: 'loading' });
  const [sheet, setSheet] = useState<'none' | 'approve'>('none');
  const [approveTarget, setApproveTarget] = useState<DecisionPlanProposal | null>(null);
  const role = session.kind === 'signed-in' ? session.session.actor.role : null;

  const refresh = useCallback(
    (missionId: string, signal: AbortSignal): void => {
      const settle =
        (set: (v: ReadState) => void): ((error: unknown) => void) =>
        (error: unknown) => {
          if (signal.aborted) return; // stale request (mission/org/tab changed)
          if (error instanceof ApiError && error.status === 401) {
            onSessionExpired(); // expired/revoked session — drop everything
            return;
          }
          set({
            kind: 'error',
            status: error instanceof ApiError ? error.status : null,
            code: error instanceof ApiError ? error.code : 'NETWORK',
          });
        };
      fetchDecisionPlans(missionId, signal)
        .then((r) => {
          if (signal.aborted) return;
          setPlans(r.plans);
          setPlansState({ kind: 'ready' });
        })
        .catch(settle(setPlansState));
      fetchMissionEvidence(missionId, { topic: 'financial', limit: 100 }, signal)
        .then((r) => {
          if (signal.aborted) return;
          setApprovals(
            approvalsFromEvidence(
              r.events.map((e) => ({
                type: e.type ?? '',
                payload: (e.payload ?? {}) as Record<string, unknown>,
              })),
            ),
          );
        })
        .catch(settle(() => undefined)); // approvals piggyback on the evidence read
      fetchMandates(missionId, signal)
        .then((rows) => {
          if (signal.aborted) return;
          setMandates(rows);
          setMandatesState({ kind: 'ready' });
        })
        .catch(settle(setMandatesState));
      fetchOperations({ missionId, limit: 25 }, signal)
        .then((r) => {
          if (signal.aborted) return;
          setOperations(r);
          setOpsState({ kind: 'ready' });
        })
        .catch(settle(setOpsState));
    },
    [onSessionExpired],
  );

  useEffect(() => {
    if (session.kind !== 'signed-in' || mission === null) {
      setPlans([]);
      setApprovals([]);
      setMandates([]);
      setOperations(null);
      setPlansState({ kind: 'loading' });
      setMandatesState({ kind: 'loading' });
      setOpsState({ kind: 'loading' });
      setSheet('none');
      return;
    }
    const controller = new AbortController();
    setPlansState({ kind: 'loading' });
    setMandatesState({ kind: 'loading' });
    setOpsState({ kind: 'loading' });
    refresh(mission.id, controller.signal);
    return () => controller.abort();
  }, [mission?.id, session.kind, refresh, onSessionExpired]);

  const now = new Date();
  const { effective, history } = splitMandates(mandates, now);
  const rollups = authorityByCurrency(effective);
  const stats = proposalStats(plans, approvals);
  const attention = plans.filter((p) => isActionableProposal(p, approvals, role, csrfToken));

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

  /** R3 P1-5: per-section outcome note — a failed read NEVER renders as
   *  "no mandates"/"no proposals". Distinct states: loading, truly empty,
   *  401 (handled upstream), 403, 404, 429, 500, network, aborted. */
  const sectionError = (state: ReadState & { kind: 'error' }, label: string): JSX.Element => {
    const status = state.status !== null ? String(state.status) : 'network';
    return (
      <p className="mv-apx-error" role="alert">
        “{label}” read failed (HTTP {status} · {state.code}) — the data is unavailable, NOT empty.
        Retry by reselecting the mission.
      </p>
    );
  };

  const openSheet = (p: DecisionPlanProposal): void => {
    setApproveTarget(p);
    setSheet('approve');
  };

  return (
    <Panel
      title="Authority & Execution"
      meta={
        <span className="mv-tag" title={mission.title}>
          {mission.title.slice(0, 24)}
          {mission.title.length > 24 ? '…' : ''}
        </span>
      }
      testId="authority-surface"
    >
      {/* ---- needs attention: this actor can act on these exact terms ---- */}
      {attention.length > 0 && (
        <section
          className="mv-apx-attention"
          aria-label="Proposals requiring review"
          data-testid="authority-attention"
        >
          <header className="mv-apx-attention__head">
            <h3 className="mv-apx-heading">Needs your review</h3>
            <HaloBadge
              tone="transit"
              glyph="◆"
              label="awaiting your approval"
              count={attention.length}
            />
          </header>
          <ul className="mv-apx-attention__list">
            {attention.map((p) => (
              <li key={`${p.plan.id}:${String(p.plan.version)}`} className="mv-apx-attention__row">
                <span className="mv-num mv-apx-attention__amount">
                  {safeMoney(p.plan.terms.currency, p.plan.terms.amountMinor)}
                </span>
                <span className="mv-apx-attention__terms">
                  <strong>{p.plan.terms.beneficiary}</strong> · {p.plan.terms.purpose}
                </span>
                <span className="mv-apx-readonlynote">Proposed — awaiting approval</span>
                <button
                  type="button"
                  className="mv-btn mv-btn--primary"
                  data-testid="authority-open-approve"
                  onClick={() => openSheet(p)}
                >
                  Review exact terms and approve
                </button>
              </li>
            ))}
          </ul>
          <p className="mv-apx-note">
            Your role ({role ?? 'unknown'}) can approve these exact server-derived terms. Approval
            authorizes reservation only — it is not a payment.
          </p>
        </section>
      )}

      {/* ---- restrained summary row: live per-read truth ---- */}
      <div className="mv-apx-summary">
        <div className="mv-apx-stat" aria-label="Active authority by currency">
          <span className="mv-apx-stat__label">Active authority</span>
          <span className="mv-hud">mandate envelopes — not account balances</span>
          {mandatesState.kind === 'loading' && <SkeletonRows rows={1} label="reading authority…" />}
          {mandatesState.kind === 'error' && (
            <p className="mv-apx-unavailable" role="alert">
              Authority read failed (HTTP{' '}
              {mandatesState.status !== null ? String(mandatesState.status) : 'network'} ·{' '}
              {mandatesState.code}) — unavailable, not zero.
            </p>
          )}
          {mandatesState.kind === 'ready' &&
            (rollups.length === 0 ? (
              <p className="mv-apx-stat__empty">No effective mandate under this mission.</p>
            ) : (
              <ul className="mv-apx-stat__cur">
                {rollups.map((r) => (
                  <li key={r.currency} className="mv-apx-stat__currow">
                    <span className="mv-num mv-apx-stat__code">{r.currency}</span>
                    <span>
                      {r.count === 1 ? '1 active mandate' : `${String(r.count)} active mandates`}
                      {' · cap '}
                      <span className="mv-num">{moneyAmount(r.currency, r.capMinor)}</span>
                      {' per action'}
                    </span>
                    <span className="mv-hud">
                      <span className="mv-num">{moneyAmount(r.currency, r.remainingMinor)}</span>
                      {' of '}
                      <span className="mv-num">{moneyAmount(r.currency, r.totalMinor)}</span>{' '}
                      unspent
                    </span>
                  </li>
                ))}
              </ul>
            ))}
        </div>
        <div className="mv-apx-stat" aria-label="Open proposals">
          <span className="mv-apx-stat__label">Open proposals</span>
          <span className="mv-hud">exact terms recorded by the server</span>
          {plansState.kind === 'loading' && <SkeletonRows rows={1} label="reading proposals…" />}
          {plansState.kind === 'error' && (
            <p className="mv-apx-unavailable" role="alert">
              Proposals read failed (HTTP{' '}
              {plansState.status !== null ? String(plansState.status) : 'network'} ·{' '}
              {plansState.code}) — unavailable, not zero.
            </p>
          )}
          {plansState.kind === 'ready' && (
            <>
              <p className="mv-apx-stat__figure">
                <span className="mv-num mv-apx-stat__number">{String(stats.open)}</span>{' '}
                {stats.open === 1 ? 'proposal' : 'proposals'} awaiting approval
              </p>
              <p className="mv-hud">
                <span className="mv-num">{String(stats.approved)}</span> approved ·{' '}
                <span className="mv-num">{String(stats.total)}</span> total
              </p>
            </>
          )}
        </div>
        <div className="mv-apx-stat" aria-label="Mission operations">
          <span className="mv-apx-stat__label">Mission operations</span>
          <span className="mv-hud">ledger-recorded, nothing inferred</span>
          {opsState.kind === 'loading' && <SkeletonRows rows={1} label="reading operations…" />}
          {opsState.kind === 'error' && (
            <p className="mv-apx-unavailable" role="alert">
              Operations read failed (HTTP{' '}
              {opsState.status !== null ? String(opsState.status) : 'network'} · {opsState.code}) —
              unavailable, not zero.
            </p>
          )}
          {opsState.kind === 'ready' && operations !== null && (
            <>
              <p className="mv-apx-stat__figure">
                <span className="mv-num mv-apx-stat__number">
                  {String(operations.operations.length)}
                </span>{' '}
                {operations.operations.length === 1 ? 'operation' : 'operations'} recorded
              </p>
              <p className="mv-hud">
                org-wide: {String(operations.counts.needsHuman)} need human review ·{' '}
                {String(operations.counts.ambiguous)} ambiguous
              </p>
            </>
          )}
        </div>
      </div>

      {/* ---- spending authority matrix (compact, Ramp-style) ---- */}
      <section className="mv-apx-section" aria-label="Spending authority">
        <h3 className="mv-apx-heading">Spending authority</h3>
        {mandatesState.kind === 'error' ? (
          sectionError(mandatesState, 'Spending authority')
        ) : mandatesState.kind === 'loading' ? (
          <SkeletonRows rows={2} label="reading authority…" />
        ) : effective.length === 0 ? (
          <p className="mv-apx-note">
            No effective mandate — spending authority is granted in Mission Treasury (owner/admin,
            exact review). Without it, no payment can be proposed, approved or reserved.
          </p>
        ) : (
          <div className="mv-apx-matrixwrap">
            <table className="mv-apx-matrix">
              <caption className="mv-visually-hidden">
                Effective mandates: status, currency, per-action maximum, budget envelope
                consumption, expiry and permitted payment kinds.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Currency</th>
                  <th scope="col">Per action</th>
                  <th scope="col">Budget envelope</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Payment kinds</th>
                </tr>
              </thead>
              <tbody>
                {effective.map((m) => {
                  const pct = percent(m.consumed_minor, m.total_budget_minor);
                  return (
                    <tr key={m.id} data-testid="authority-mandate">
                      <td data-label="Status">
                        <StatusChip entry={mandatePresentation(m.status)} size="sm" />
                      </td>
                      <td data-label="Currency">
                        <span className="mv-num mv-apx-matrix__code">{m.currency}</span>
                      </td>
                      <td data-label="Per action">
                        <span className="mv-num mv-apx-matrix__money">
                          {moneyAmount(m.currency, m.max_amount_minor)}
                        </span>
                        <span className="mv-hud mv-apx-matrix__unit">per action</span>
                      </td>
                      <td data-label="Budget envelope">
                        <div
                          className={`mv-apx-meter${
                            m.consumed_minor > m.total_budget_minor * 0.8
                              ? ' mv-apx-meter--warn'
                              : ''
                          }`}
                          role="img"
                          aria-label={`Budget envelope: ${String(pct)}% committed, ${safeMoney(
                            m.currency,
                            m.consumed_minor,
                          )} of ${safeMoney(m.currency, m.total_budget_minor)}`}
                        >
                          <span className="mv-apx-meter__track">
                            <span
                              className="mv-apx-meter__fill"
                              style={{ width: `${String(pct)}%` }}
                            />
                          </span>
                          <span className="mv-apx-meter__text">
                            <span className="mv-num">{String(pct)}%</span> committed ·{' '}
                            <span className="mv-num">
                              {moneyAmount(m.currency, m.consumed_minor)}
                            </span>{' '}
                            of{' '}
                            <span className="mv-num">
                              {moneyAmount(m.currency, m.total_budget_minor)}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td data-label="Expires">
                        <span title={formatDate(m.expires_at)} className="mv-apx-matrix__expiry">
                          {formatWindow(m.expires_at, now)}
                        </span>
                      </td>
                      <td data-label="Payment kinds">
                        <span className="mv-apx-matrix__kinds">
                          {parseJsonArray(m.permitted_kinds_json).join(' · ') ||
                            m.permitted_kinds_json}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {mandatesState.kind === 'ready' && effective.length > 0 && (
          <details className="mv-apx-audit">
            <summary>Audit details — mandates ({String(effective.length)})</summary>
            <ul className="mv-apx-audit__list">
              {effective.map((m) => (
                <li key={m.id} className="mv-apx-audit__item">
                  <dl className="mv-mandate__meta">
                    <div>
                      <dt>Mandate</dt>
                      <dd>
                        <span className="mv-num" title={m.id}>
                          {m.id}
                        </span>{' '}
                        v{String(m.version)} <CopyButton value={m.id} label="mandate id" />
                      </dd>
                    </div>
                    <div>
                      <dt>Permitted kinds (raw)</dt>
                      <dd>
                        <span className="mv-num mv-apx-audit__raw" title={m.permitted_kinds_json}>
                          {m.permitted_kinds_json}
                        </span>
                        <CopyButton value={m.permitted_kinds_json} label="permitted kinds" />
                      </dd>
                    </div>
                    <div>
                      <dt>Rails</dt>
                      <dd>
                        <span className="mv-num">{m.rails_json ?? '—'}</span>
                      </dd>
                    </div>
                    <div>
                      <dt>Allowed beneficiaries</dt>
                      <dd>
                        {parseJsonArray(m.allowed_beneficiaries_json).join(' · ') || 'unrestricted'}
                      </dd>
                    </div>
                    <div>
                      <dt>Allowed purposes</dt>
                      <dd>
                        {parseJsonArray(m.allowed_purposes_json).join(' · ') || 'unrestricted'}
                      </dd>
                    </div>
                    <div>
                      <dt>Separate approver</dt>
                      <dd>{m.require_separate_approver === 1 ? 'required' : 'not required'}</dd>
                    </div>
                    <div>
                      <dt>Created / expires</dt>
                      <dd>
                        {formatDate(m.created_at)} → {formatDate(m.expires_at)}
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </details>
        )}
        {history.length > 0 && (
          <details className="mv-apx-audit">
            <summary>Expired / revoked / superseded authority ({String(history.length)})</summary>
            <ul className="mv-apx-audit__list">
              {history.map((m) => (
                <li key={m.id} className="mv-apx-histrow">
                  <StatusChip entry={historyPresentation(m, now)} size="sm" />
                  <span className="mv-num mv-apx-matrix__code">{m.currency}</span>
                  <span className="mv-num" title={m.id}>
                    v{String(m.version)} · {shortId(m.id)}
                  </span>
                  <span title={formatDate(m.expires_at)}>
                    expired {formatWindow(m.expires_at, now)}
                  </span>
                  <span className="mv-num">
                    {moneyAmount(m.currency, m.consumed_minor)} consumed
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* ---- proposals with journalled journey state ---- */}
      <section className="mv-apx-section" aria-label="Proposals and approvals">
        <h3 className="mv-apx-heading">Proposals</h3>
        {plansState.kind === 'error' ? (
          sectionError(plansState, 'Proposals')
        ) : plansState.kind === 'loading' ? (
          <SkeletonRows rows={2} label="reading proposals…" />
        ) : plans.length === 0 ? (
          <div className="mv-apx-empty" data-testid="authority-empty-proposals">
            <span className="mv-apx-empty__glyph" aria-hidden="true">
              ◇
            </span>
            <p className="mv-apx-empty__title">No proposals recorded for this mission.</p>
            <p className="mv-apx-note">
              Propose from a recorded evaluation in the Decision Room — terms are derived by the
              server, never typed.
            </p>
          </div>
        ) : (
          <ul className="mv-apx-proposals">
            {plans.map((p) => {
              const recorded = approvalFor(approvals, p.plan.id, p.plan.version);
              const operation = operationForPlan(
                operations?.operations ?? [],
                p.plan.id,
                p.plan.version,
              );
              const actionable = isActionableProposal(p, approvals, role, csrfToken);
              return (
                <li
                  key={`${p.plan.id}:${String(p.plan.version)}`}
                  className="mv-apx-proposal"
                  data-testid="authority-proposal"
                >
                  <div className="mv-apx-proposal__main">
                    <StatusChip entry={proposalStateEntry(recorded, operation)} size="sm" />
                    <span className="mv-num mv-apx-proposal__amount">
                      {safeMoney(p.plan.terms.currency, p.plan.terms.amountMinor)}
                    </span>
                    <span className="mv-apx-proposal__terms">
                      <strong>{p.plan.terms.beneficiary}</strong> · {p.plan.terms.purpose}
                    </span>
                    {actionable ? (
                      <button
                        type="button"
                        className="mv-btn"
                        data-testid="authority-row-review"
                        onClick={() => openSheet(p)}
                      >
                        Review terms
                      </button>
                    ) : recorded === null && mayApprove(role) ? (
                      <span className="mv-apx-readonlynote">
                        Session protection unavailable — reload to approve.
                      </span>
                    ) : recorded === null ? (
                      <span className="mv-apx-readonlynote" data-testid="authority-readonly">
                        Read-only — your role ({role ?? 'unknown'}) cannot approve.
                      </span>
                    ) : null}
                  </div>
                  <Stepper
                    ariaLabel="This proposal's authority sequence"
                    steps={journeySteps(p, recorded, operation, role)}
                  />
                  {recorded !== null && (
                    <p className="mv-apx-proposal__approval" data-testid="authority-approval">
                      approval{' '}
                      <span className="mv-num" title={recorded.approvalId}>
                        {recorded.approvalId}
                      </span>{' '}
                      · kind {recorded.kind} · decided by{' '}
                      <span className="mv-num" title={recorded.decidedBy}>
                        {shortId(recorded.decidedBy)}
                      </span>{' '}
                      · expires {formatDate(recorded.expiresAt)}
                    </p>
                  )}
                  <details className="mv-apx-audit mv-apx-proposal__audit">
                    <summary>Audit details</summary>
                    <dl className="mv-mandate__meta">
                      <div>
                        <dt>Plan</dt>
                        <dd>
                          <span className="mv-num" title={p.plan.id}>
                            {p.plan.id}
                          </span>{' '}
                          v{String(p.plan.version)} <CopyButton value={p.plan.id} label="plan id" />
                        </dd>
                      </div>
                      <div>
                        <dt>Terms digest</dt>
                        <dd>
                          <span className="mv-num mv-apx-audit__raw" title={p.plan.digest}>
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
                      <div>
                        <dt>Created</dt>
                        <dd>{formatDate(p.plan.createdAt)}</dd>
                      </div>
                      {recorded !== null && (
                        <div>
                          <dt>Approval (journal)</dt>
                          <dd>
                            <span className="mv-num" title={recorded.approvalId}>
                              {recorded.approvalId}
                            </span>{' '}
                            <CopyButton value={recorded.approvalId} label="approval id" /> · decided
                            by{' '}
                            <span className="mv-num" title={recorded.decidedBy}>
                              {recorded.decidedBy}
                            </span>{' '}
                            · expires {formatDate(recorded.expiresAt)}
                          </dd>
                        </div>
                      )}
                    </dl>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mv-apx-note">
          Approval authorizes reservation only — submission and verification are separate, later
          controls, and the provider rail is offline on this build (no settlement is ever implied).
        </p>
      </section>

      {/* ---- concise operational history ---- */}
      <section className="mv-apx-section" aria-label="Operations under this authority">
        <h3 className="mv-apx-heading">Operational history</h3>
        {opsState.kind === 'error' ? (
          sectionError(opsState, 'Operations')
        ) : opsState.kind === 'loading' || operations === null ? (
          <SkeletonRows rows={2} label="reading operations…" />
        ) : operations.operations.length === 0 ? (
          <p className="mv-apx-note">No operations yet for this mission.</p>
        ) : (
          <>
            <ul className="mv-apx-ops">
              {operations.operations.slice(0, 6).map((op) => (
                <li key={op.id} className="mv-apx-op">
                  <StatusChip
                    entry={operationPresentationFor(op.state, {
                      kind: op.kind,
                      dispatch: op.dispatch,
                    })}
                    size="sm"
                  />
                  <span className="mv-num" title={op.id}>
                    {shortId(op.id)}
                  </span>
                  <span className="mv-num mv-apx-op__amount">
                    {op.amount.currency} {op.amount.major}
                  </span>
                  <span className="mv-apx-op__beneficiary">{op.beneficiary}</span>
                  <span className="mv-hud">{op.kind}</span>
                </li>
              ))}
            </ul>
            <p className="mv-hud">
              showing {String(Math.min(6, operations.operations.length))} of{' '}
              {String(operations.operations.length)} · org-wide counts:{' '}
              {String(operations.counts.needsHuman)} need human review ·{' '}
              {String(operations.counts.ambiguous)} ambiguous
            </p>
          </>
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
