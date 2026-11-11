import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Panel } from '../components/Panel';
import {
  ApiError,
  approvalsFromEvidence,
  fetchDecisionPlans,
  fetchDecisionSnapshots,
  fetchMandates,
  fetchMissionEvidence,
  fetchPhysicalDecision,
  fetchReviewerDemoCapability,
  mayApprove,
  mayPropose,
  proposePlanFromEvaluation,
  provisionReviewerMission,
  recordDecisionSnapshot,
  submitSyntheticStep,
  submitReviewerSyntheticStep,
  type DecisionPlanProposal,
  type MandateRow,
  type PhysicalDecisionJourney,
  type PhysicalDecisionSummary,
  type RecordedApproval,
  type RecordedSnapshot,
  type RecordedSnapshotDecision,
  WAREHOUSE_STEPS,
  admitWarehouseStep,
  fetchMissionSpec,
  fetchWarehouseDecision,
  refreshMissionAuthority,
  type MissionSpecView,
  type SessionState,
  type WarehouseDecisionJourney,
  type WarehouseStep,
} from '../lib/api';
import { money as moneyOf, moneyAmount, safeMoney } from '../lib/format';
import { ApprovePlanSheet, ManualPlanSheet } from '../components/GovernedActions';
import {
  CopyButton,
  ExpandableCard,
  HaloBadge,
  HaloTabs,
  SkeletonRows,
  Stepper,
} from '../components/ui';
// MTV-09/12 (Agent C): LIVE physical mission viewport. The authenticated
// sanitized physical-view read (Agent A, PR #52 implementation) is fetched
// per mission inside the module; the strict adapter fails closed on any
// shape deviation; the lazy chunk loads three.js only when a ready scene
// exists; failure states render the honest unavailable card — no fixture is
// EVER substituted for live data. Placement/styling is Agent B
// —s (this composition).
import { PhysicalMissionViewport } from '../mission-viewer/PhysicalMissionViewport.js';

// USD catalog amounts via the shared exact formatter (exponent from the
// domain table — never a local /100).
function money(minor: number): string {
  return moneyAmount('USD', minor);
}

/** Candidate decision card — Cult UI Expandable pattern: the collapsed row
 *  always carries the action, the gross figure and the verdict; expansion
 *  reveals reasoning, uncertainty and evidence identities. */
function DecisionExpandable({
  title,
  decision,
  tone,
  defaultOpen,
}: {
  title: string;
  decision: PhysicalDecisionSummary | null;
  tone: 'noaction' | 'selected' | 'eligible';
  defaultOpen?: boolean;
}): JSX.Element {
  const selected = decision?.selected ?? null;
  const summary = (
    <>
      <span className="mv-xcard__title">{title}</span>
      {decision === null ? (
        <span className="mv-xcard__sub">Not evaluated yet — record the baseline evaluation.</span>
      ) : (
        <>
          <span className="mv-xcard__action">
            {selected?.label ?? 'No eligible financial action'}
          </span>
          <span className="mv-xcard__money mv-num">
            {selected === null || selected.grossMinor <= 0
              ? 'no spend proposed'
              : `gross ${money(selected.grossMinor)} · net ${money(selected.expectedNetMinor)}`}
          </span>
          {decision !== null && outcomeBadge(decision)}
          <span className="mv-xcard__meta">
            {decision.outcome} · POLICY-ONLY ·{' '}
            {decision.authorization ===
            'PROPOSED_ONLY — requires separate human approval and ledger recheck'
              ? 'requires human approval'
              : decision.authorization}
          </span>
        </>
      )}
    </>
  );
  return (
    <ExpandableCard
      tone={tone}
      defaultOpen={defaultOpen}
      testId={`decision-card-${title
        .toLowerCase()
        .replace(/[^a-z]+/g, '-')
        .replace(/^-|-$/g, '')}`}
      summary={summary}
      details={
        decision === null ? (
          <p className="mv-governed__note">
            The evaluation appears here only after the signed observation is admitted and its
            durable snapshot is recorded.
          </p>
        ) : (
          <>
            <dl className="mv-mandate__meta">
              <div>
                <dt>Evaluation</dt>
                <dd className="mv-num" title={decision.evaluationId}>
                  {decision.evaluationId.slice(0, 16)}…
                </dd>
              </div>
              <div>
                <dt>Assumptions</dt>
                <dd>model gross/net — POLICY-ONLY, no live model inference</dd>
              </div>
            </dl>
            <h4 className="mv-xcard__subhead">Alternatives and reasons</h4>
            <ul className="mv-xcard__list">
              {decision.alternatives.map((alternative) => (
                <li key={alternative.id}>
                  {alternative.label} —{' '}
                  {alternative.feasible
                    ? 'eligible'
                    : `blocked: ${alternative.rejection ?? 'policy'}`}{' '}
                  · <span className="mv-num">{money(alternative.grossMinor)}</span> gross
                </li>
              ))}
            </ul>
            <ul className="mv-xcard__list">
              {decision.reasons.map((reason, index) => (
                <li key={index}>
                  <span className="mv-tag">{reason.code}</span> {reason.message}
                </li>
              ))}
            </ul>
          </>
        )
      }
    />
  );
}

function outcomeLine(decision: RecordedSnapshotDecision): string {
  const selected = decision.selected;
  if (decision.outcome !== 'select' || selected === null) {
    return `recorded outcome: ${decision.outcome} — no spend selected`;
  }
  if (selected.grossMinor <= 0) {
    return 'recorded outcome: select with a zero-gross (no-action) selection';
  }
  return `recorded selection: ${selected.candidateId} · ${moneyOf(selected.currency, selected.grossMinor)} gross (server terms)`;
}

/** Factual lifecycle strip derived from the unified journey view + durable records. */
function journeySteps(
  view: { hasBaseline: boolean; hasIncident: boolean; stage: string },
  incidentRecorded: boolean,
): readonly {
  key: string;
  label: string;
  state: 'done' | 'active' | 'pending' | 'halted' | 'unknown';
  note?: string;
}[] {
  return [
    {
      key: 'observe',
      label: 'Physical observation event',
      state: view.hasBaseline ? 'pending' : 'done',
      note: view.hasBaseline ? 'awaiting signed observation' : 'admitted to the journal',
    },
    {
      key: 'baseline',
      label: 'Baseline evaluation',
      state: view.hasBaseline ? 'pending' : 'done',
    },
    {
      key: 'incident',
      label: 'Incident evaluation',
      state: incidentRecorded
        ? 'done'
        : !view.hasIncident && view.hasBaseline
          ? 'active'
          : 'pending',
      note: incidentRecorded ? undefined : 'recorded explicitly when the incident lands',
    },
    {
      key: 'propose',
      label: 'Proposal',
      state: 'pending',
      note: 'ID-only, server-derived terms',
    },
    {
      key: 'approve',
      label: 'Approval',
      state: 'pending',
      note: 'different actor required',
    },
  ];
}

/** Structured outcome chip — no-action, decline and escalation are
 *  first-class outcomes with their own tone+glyph, never collapsed into a
 *  generic success state (R-final directive). */
function outcomeBadge(decision: {
  outcome: 'select' | 'decline' | 'escalate';
  selected: { readonly grossMinor: number } | null;
}): JSX.Element {
  if (decision.outcome === 'escalate') {
    return <HaloBadge tone="hold" glyph="??" label="ESCALATED — HUMAN DECISION" />;
  }
  if (decision.outcome === 'decline') {
    return <HaloBadge tone="neutral" glyph="∅" label="DECLINED" />;
  }
  if (decision.selected === null || decision.selected.grossMinor <= 0) {
    return <HaloBadge tone="hold" glyph="∅" label="NO ACTION" />;
  }
  return <HaloBadge tone="transit" glyph="▶" label="EXECUTABLE — PROPOSAL PENDING" />;
}
export function DecisionRoom({
  session,
  mission,
  csrfToken,
  onSessionExpired,
  onReviewerMissionReady,
}: {
  session: SessionState;
  mission: { id: string; title: string } | null;
  csrfToken: string | null;
  onSessionExpired: () => void;
  onReviewerMissionReady: (missionId: string) => void;
}): JSX.Element {
  const [journey, setJourney] = useState<PhysicalDecisionJourney | null>(null);
  const [whJourney, setWhJourney] = useState<WarehouseDecisionJourney | null>(null);
  const [missionSpec, setMissionSpec] = useState<MissionSpecView | null>(null);
  const [specState, setSpecState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<readonly RecordedSnapshot[]>([]);
  const [plans, setPlans] = useState<readonly DecisionPlanProposal[]>([]);
  const [approvals, setApprovals] = useState<RecordedApproval[]>([]);
  const [snapshotNotice, setSnapshotNotice] = useState<string | null>(null);
  const [proposeError, setProposeError] = useState<{ code: string; message: string } | null>(null);
  const [proposeBusy, setProposeBusy] = useState(false);
  const [sheet, setSheet] = useState<'none' | 'manual' | 'approve'>('none');
  const [approveTarget, setApproveTarget] = useState<DecisionPlanProposal | null>(null);
  const [mandates, setMandates] = useState<readonly MandateRow[]>([]);
  const [lens, setLens] = useState<'finance' | 'operations' | 'evidence'>('finance');
  const role = session.kind === 'signed-in' ? session.session.actor.role : null;
  const [reviewerMode, setReviewerMode] = useState<
    'checking' | 'enabled' | 'disabled' | 'unavailable'
  >('checking');
  const [reviewerBusy, setReviewerBusy] = useState(false);
  const [reviewerError, setReviewerError] = useState<string | null>(null);

  useEffect(() => {
    if (session.kind !== 'signed-in') {
      setReviewerMode('disabled');
      return;
    }
    const controller = new AbortController();
    setReviewerMode('checking');
    fetchReviewerDemoCapability(controller.signal)
      .then((available) => {
        if (!controller.signal.aborted) setReviewerMode(available ? 'enabled' : 'disabled');
      })
      .catch(() => {
        if (!controller.signal.aborted) setReviewerMode('unavailable');
      });
    return () => controller.abort();
  }, [session.kind, session.kind === 'signed-in' ? session.session.actor.id : null]);

  const canAdmitSynthetic =
    session.kind === 'signed-in' &&
    (session.session.demoAuth ||
      (reviewerMode === 'enabled' && mission?.title.startsWith('reviewer-demo:') === true));

  const beginReviewerMission = (): void => {
    if (
      session.kind !== 'signed-in' ||
      reviewerMode !== 'enabled' ||
      csrfToken === null ||
      reviewerBusy
    )
      return;
    setReviewerBusy(true);
    setReviewerError(null);
    provisionReviewerMission(csrfToken)
      .then(({ mission: provisioned }) => onReviewerMissionReady(provisioned.id))
      .catch((reason: unknown) => {
        if (reason instanceof ApiError && reason.status === 401) {
          onSessionExpired();
        } else {
          setReviewerError(
            reason instanceof ApiError
              ? `${reason.code} — ${reason.message}`
              : 'Could not open the authenticated reviewer mission.',
          );
        }
      })
      .finally(() => setReviewerBusy(false));
  };

  // C1 spec read — typed mission configuration; industry decides which
  // journey endpoints this room uses (harbor vs warehouse), never a guess.
  useEffect(() => {
    if (session.kind !== 'signed-in' || mission === null) {
      setMissionSpec(null);
      setSpecState('loading');
      return;
    }
    const controller = new AbortController();
    setSpecState('loading');
    fetchMissionSpec(mission.id, controller.signal)
      .then((spec) => {
        if (!controller.signal.aborted) {
          setMissionSpec(spec);
          setSpecState('ready');
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiError && reason.status === 401) {
          onSessionExpired();
          return;
        }
        setMissionSpec(null);
        setSpecState('unavailable');
      });
    return () => controller.abort();
  }, [mission?.id, session.kind, onSessionExpired]);

  const isWarehouse = missionSpec?.industry === 'warehouse-amr';

  // Warehouse journey read — mirrors the harbor read on the same durable
  // state; the two domains never mix inside one mission journal.
  useEffect(() => {
    if (session.kind !== 'signed-in' || mission === null) {
      setWhJourney(null);
      return;
    }
    if (!isWarehouse) {
      setWhJourney(null);
      return;
    }
    const controller = new AbortController();
    fetchWarehouseDecision(mission.id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setWhJourney(result);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [mission?.id, session.kind, isWarehouse]);

  const refreshDurableState = useCallback((missionId: string, signal: AbortSignal): void => {
    fetchDecisionSnapshots(missionId, signal)
      .then((r) => {
        if (!signal.aborted) setSnapshots(r.snapshots);
      })
      .catch(() => undefined);
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
  }, []);

  useEffect(() => {
    if (session.kind !== 'signed-in' || mission === null) {
      setJourney(null);
      setSnapshots([]);
      setPlans([]);
      setApprovals([]);
      setSheet('none');
      return;
    }
    // OIDC reviewer mode must never query the devAuth-only physical decision route.
    if (!session.session.demoAuth && reviewerMode === 'checking') {
      setJourney(null);
      setLoading(true);
      return;
    }
    if (!session.session.demoAuth && reviewerMode !== 'enabled') {
      setJourney(null);
      setLoading(false);
      setError('The authorized reviewer decision route is unavailable.');
      return;
    }
    const controller = new AbortController();
    setJourney(null); // never carry another mission's physical stage across selection
    setLoading(true);
    setError(null);
    fetchPhysicalDecision(
      mission.id,
      controller.signal,
      session.session.demoAuth ? 'local-demo' : 'reviewer-demo',
    )
      .then((result) => {
        if (!controller.signal.aborted) setJourney(result);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
        else setError(reason instanceof Error ? reason.message : 'Decision API unavailable');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    // Durable state rebuilds from the SERVER on mount and reload — the
    // recorded evaluations, proposals and journal-verified approvals. GETs
    // never create snapshots (the API enforces that too).
    refreshDurableState(mission.id, controller.signal);
    return () => controller.abort();
  }, [
    mission?.id,
    session.kind,
    session.kind === 'signed-in' ? session.session.demoAuth : false,
    reviewerMode,
    onSessionExpired,
    refreshDurableState,
  ]);

  // Mandates for the approval step: effective = active AND unexpired (clock-checked,
  // same rule the Treasury applies). Server remains the enforcer at approval time.
  useEffect(() => {
    if (session.kind !== 'signed-in' || mission === null) {
      setMandates([]);
      return;
    }
    const controller = new AbortController();
    fetchMandates(mission.id, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) setMandates(rows);
      })
      .catch(() => {
        if (!controller.signal.aborted) setMandates([]);
      });
    return () => controller.abort();
  }, [mission?.id, session.kind]);

  // Unified journey view across both domains (identical decision-view shape;
  // the warehouse journey maps its stage ladder + last event onto the same
  // fields, so every read below stays domain-neutral).
  const view: {
    stage: string;
    hasBaseline: boolean;
    hasIncident: boolean;
    before: PhysicalDecisionSummary | null;
    after: PhysicalDecisionSummary | null;
    lastEvent: {
      eventId: string;
      sourceId: string;
      eventDigest: string;
      observedAt: string;
      reading: string;
      provenance: string;
    } | null;
    disclaimer: string | null;
  } = (() => {
    if (whJourney !== null) {
      const last = whJourney.lastEvent;
      const stepped = whJourney.stage !== 'empty' && whJourney.stage !== 'baseline';
      return {
        stage: whJourney.stage,
        hasBaseline: whJourney.stage !== 'empty',
        hasIncident: stepped,
        before: whJourney.before,
        after: whJourney.after,
        lastEvent:
          last === null
            ? null
            : {
                eventId: last.eventId,
                sourceId: last.sourceId,
                eventDigest: last.eventDigest,
                observedAt: last.observedAt,
                reading: last.reading,
                provenance: last.provenance + ' · asset ' + last.assetId,
              },
        disclaimer: whJourney.disclaimer,
      };
    }
    const harborStage = journey?.stage ?? 'empty';
    return {
      stage: harborStage,
      hasBaseline: harborStage !== 'empty',
      hasIncident: harborStage === 'incident',
      before: journey?.before ?? null,
      after: journey?.after ?? null,
      lastEvent: journey?.incident ?? null,
      disclaimer: journey?.disclaimer ?? null,
    };
  })();

  const runStep = (step: 'baseline' | 'incident'): void => {
    if (
      session.kind !== 'signed-in' ||
      mission === null ||
      csrfToken === null ||
      busy ||
      !canAdmitSynthetic
    )
      return;
    setBusy(true);
    setError(null);
    setSnapshotNotice(null);
    const finish = (): void => {
      // Refresh the live journey view (cards/incident) from the journal.
      const controller = new AbortController();
      fetchPhysicalDecision(
        mission.id,
        controller.signal,
        session.session.demoAuth ? 'local-demo' : 'reviewer-demo',
      )
        .then((result) => {
          if (!controller.signal.aborted) setJourney(result);
        })
        .catch(() => undefined)
        .finally(() => controller.abort());
      setBusy(false);
    };
    const proceedToSnapshot = (): void => {
      // Explicit, idempotent durable-snapshot write; a replay returns the
      // existing evaluation (replayed=true) and is shown honestly.
      recordDecisionSnapshot(mission.id, step, csrfToken)
        .then((result) => {
          setSnapshotNotice(
            result.replayed
              ? `${step} evaluation already recorded — replayed the existing durable snapshot (idempotent).`
              : `${step} evaluation recorded as a durable snapshot (${result.snapshot.evaluationId.slice(0, 14)}…).`,
          );
          // One-shot refresh: a fresh controller aborted right after dispatch
          // would cancel the GETs before they resolve.
          refreshDurableState(mission.id, new AbortController().signal);
          finish();
        })
        .catch((reason: unknown) => {
          if (reason instanceof ApiError && reason.status === 401) {
            onSessionExpired();
            setBusy(false);
            return;
          }
          // Partial failure (event journaled, snapshot missing) is recoverable:
          // the recorded-evaluations panel offers an explicit finish action and
          // retrying the action replays idempotently.
          setError(
            reason instanceof ApiError
              ? `snapshot ${step}: ${reason.code} — ${reason.message}`
              : 'snapshot recording failed',
          );
          setBusy(false);
        });
    };
    // 1) journal the physical event (explicit POST); DUPLICATE_EVENT means it
    //    is already journaled — recovery, not failure. 2) record the snapshot.
    const admit = session.session.demoAuth
      ? submitSyntheticStep(mission.id, step, csrfToken)
      : submitReviewerSyntheticStep(mission.id, step, csrfToken);
    admit
      .then(() => proceedToSnapshot())
      .catch((reason: unknown) => {
        if (reason instanceof ApiError && reason.status === 401) {
          onSessionExpired();
          setBusy(false);
          return;
        }
        if (reason instanceof ApiError && reason.code === 'DUPLICATE_EVENT') {
          proceedToSnapshot();
          return;
        }
        setError(reason instanceof Error ? reason.message : 'Synthetic step failed');
        setBusy(false);
      });
  };

  /** DEMO EVENT SOURCE admission for one warehouse step (operate + CSRF;
   *  idempotent; registers the warehouse spec once). */
  const runWarehouseStep = (step: WarehouseStep): void => {
    if (session.kind !== 'signed-in' || mission === null || csrfToken === null || busy) return;
    setBusy(true);
    setError(null);
    setSnapshotNotice(null);

    admitWarehouseStep(mission.id, step, csrfToken)
      .then((result) => {
        setWhJourney(result);
        // The spec registry changed on first admission — refetch so the room
        // flips to the registered industry journey.
        fetchMissionSpec(mission.id)
          .then((spec) => setMissionSpec(spec))
          .catch(() => undefined);
        setSnapshotNotice('Warehouse step admitted — evaluations refreshed from the journal.');
        // After the first baseline admission, an owner/admin must refresh the
        // mission authority from the registered spec shape (server enforces
        // the role; operators see the honest note).
        if (step === 'baseline' && (role === 'owner' || role === 'admin') && csrfToken !== null) {
          refreshMissionAuthority(mission.id, csrfToken)
            .then(() =>
              setSnapshotNotice(
                'Baseline admitted and mission authority refreshed from the registered spec.',
              ),
            )
            .catch(() =>
              setSnapshotNotice(
                'Baseline admitted — authority refresh failed; an owner/admin can retry from Mission Treasury.',
              ),
            );
        }
        refreshDurableState(mission.id, new AbortController().signal);
        setBusy(false);
      })
      .catch((reason: unknown) => {
        if (reason instanceof ApiError && reason.status === 401) {
          onSessionExpired();
          setBusy(false);
          return;
        }
        setError(
          reason instanceof ApiError
            ? `warehouse step ${step}: ${reason.code} — ${reason.message}`
            : 'warehouse step admission failed',
        );
        setBusy(false);
      });
  };

  /** Refresh evaluations from the journal — the PRIMARY operator action.
   *  Evaluations exist only from ADMITTED events; in production those arrive
   *  from authenticated sources, not from this screen. */
  const refreshFromJournal = (): void => {
    if (session.kind !== 'signed-in' || mission === null) return;
    const controller = new AbortController();
    refreshDurableState(mission.id, controller.signal);
    if (isWarehouse) {
      fetchWarehouseDecision(mission.id, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setWhJourney(result);
        })
        .catch(() => undefined)
        .finally(() => controller.abort());
    } else {
      fetchPhysicalDecision(
        mission.id,
        controller.signal,
        session.session.demoAuth ? 'local-demo' : 'reviewer-demo',
      )
        .then((result) => {
          if (!controller.signal.aborted) setJourney(result);
        })
        .catch(() => undefined)
        .finally(() => controller.abort());
    }
  };
  const incidentSnapshot =
    [...snapshots].reverse().find((s) => s.stage === 'incident') ??
    snapshots.find((s) => s.stage === 'incident') ??
    null;
  const baselineSnapshot = snapshots.find((s) => s.stage === 'baseline') ?? null;

  const proposeFromEvaluation = (evaluationId: string): void => {
    if (session.kind !== 'signed-in' || mission === null || csrfToken === null || proposeBusy)
      return;
    setProposeBusy(true);
    setProposeError(null);
    proposePlanFromEvaluation(mission.id, evaluationId, csrfToken)
      .then(() => {
        setProposeBusy(false);
        refreshDurableState(mission.id, new AbortController().signal);
      })
      .catch((reason: unknown) => {
        setProposeBusy(false);
        if (reason instanceof ApiError && reason.status === 401) {
          onSessionExpired();
          return;
        }
        setProposeError(
          reason instanceof ApiError
            ? { code: reason.code, message: reason.message }
            : { code: 'NETWORK', message: 'Could not reach the server.' },
        );
      });
  };

  if (session.kind !== 'signed-in') {
    return (
      <Panel title="Physical-to-financial decisions" testId="decision-room">
        <p>Sign in through Mission Treasury to use the authenticated local demo.</p>
        <p>No simulated financial figures are shown without an active session.</p>
      </Panel>
    );
  }
  if (mission === null) {
    return (
      <Panel title="Physical-to-financial decisions" testId="decision-room">
        <p>Select an inspection mission in Mission Treasury first.</p>
        {reviewerMode === 'enabled' && (
          <button
            type="button"
            className="mv-btn mv-btn--primary"
            data-testid="reviewer-demo-start"
            disabled={csrfToken === null || reviewerBusy}
            onClick={beginReviewerMission}
          >
            {reviewerBusy ? 'Preparing mission…' : 'Start guided reviewer mission'}
          </button>
        )}
        {reviewerError !== null && <p role="alert">{reviewerError}</p>}
      </Panel>
    );
  }

  const planFor = (planId: string, planVersion: number) =>
    approvals.find((a) => a.planId === planId && a.planVersion === planVersion) ?? null;
  const incidentRecorded = incidentSnapshot !== null;

  // Halo Tabs (R3 P1-4): tablist + panels share ONE component-generated
  // baseId; all three panels always render (inactive = hidden) so
  // aria-controls/aria-labelledby always resolve and nothing hidden is
  // keyboard-focusable.
  const FINANCE_PANEL = (
    <>
      {/* before/after as expandable candidate cards */}
      <div className="mv-droom__cards">
        <DecisionExpandable title="Before · initial plan" decision={view.before} tone="noaction" />
        <DecisionExpandable
          title="After · updated constraints"
          decision={view.after}
          tone={view.after?.selected ? 'selected' : 'noaction'}
          defaultOpen={view.hasIncident}
        />
      </div>

      {/* server-authoritative ID-only proposal (planner-derived golden path) */}
      {incidentSnapshot !== null && (
        <section
          className="mv-governed"
          aria-label="Governed follow-through"
          data-testid="governed-actions"
        >
          <h3 className="mv-droom__secttitle">From recorded evaluation to governed action</h3>
          <p className="mv-governed__lead">
            The proposal is created <strong>only</strong> from the recorded incident evaluation: the
            server derives the economic terms from its own durable snapshot and journal (
            <span className="mv-num" title={incidentSnapshot.evaluationId}>
              {incidentSnapshot.evaluationId.slice(0, 14)}…
            </span>
            ). No amount, beneficiary or purpose is entered here.
          </p>
          <p className="mv-governed__note">{outcomeLine(incidentSnapshot.decision)}</p>
          <button
            type="button"
            className="mv-btn mv-btn--primary"
            data-testid="propose-plan"
            disabled={proposeBusy || csrfToken === null}
            onClick={() => proposeFromEvaluation(incidentSnapshot.evaluationId)}
          >
            {proposeBusy ? 'Proposing…' : 'Propose plan from recorded evaluation'}
          </button>
          {!mayPropose(role) && (
            <p className="mv-governed__note">
              Your role ({role ?? 'unknown'}) does not carry a propose grant — the server will
              refuse the submission (operator or above required).
            </p>
          )}
          {proposeError !== null && (
            <p className="mv-sheet__error" role="alert" data-testid="propose-error">
              {proposeError.code}: {proposeError.message}
            </p>
          )}
          <details className="mv-governed__manual">
            <summary data-testid="open-manual">Manual plan entry — NOT planner-derived</summary>
            <p className="mv-governed__note">
              Separate, clearly-labeled generic plan entry. It does not claim the planner&rsquo;s
              selected terms, evidence or costs.
            </p>
            <button
              type="button"
              className="mv-btn"
              data-testid="open-manual-sheet"
              disabled={csrfToken === null}
              onClick={() => setSheet('manual')}
            >
              Open manual plan entry
            </button>
          </details>
        </section>
      )}

      {/* persisted proposals + journal-verified approvals (server truth) */}
      <section
        className="mv-governed"
        aria-label="Recorded proposals and approvals"
        data-testid="decision-plans"
      >
        <h3 className="mv-droom__secttitle">Recorded proposals</h3>
        {plans.length === 0 ? (
          <p className="mv-governed__note">
            No plans proposed for this mission yet. Proposals appear here from the server&rsquo;s
            durable record — visible to a different approver after logout/login and after reload.
          </p>
        ) : (
          <ul className="mv-governed__list">
            {plans.map((p) => {
              const recorded = planFor(p.plan.id, p.plan.version);
              return (
                <li key={`${p.plan.id}:${String(p.plan.version)}`} data-testid="decision-plan-row">
                  <span className="mv-num" title={p.plan.id}>
                    {p.plan.id.slice(0, 16)}…
                  </span>{' '}
                  v{String(p.plan.version)} ·{' '}
                  <strong data-testid="plan-terms">
                    {moneyOf(p.plan.terms.currency, p.plan.terms.amountMinor)} ·{' '}
                    {p.plan.terms.beneficiary} · {p.plan.terms.purpose}
                  </strong>
                  <br />
                  <span className="mv-hud">
                    from evaluation {p.evaluationId.slice(0, 14)}… · proposed by{' '}
                    <span className="mv-num" title={p.proposedBy}>
                      {p.proposedBy.slice(0, 10)}…
                    </span>{' '}
                    · digest{' '}
                    <span className="mv-num" title={p.plan.digest}>
                      {p.plan.digest.slice(0, 12)}…
                    </span>
                    <CopyButton value={p.plan.digest} label="digest" /> · provider verified: no
                  </span>
                  <br />
                  {recorded !== null ? (
                    <p data-testid="plan-approval-recorded">
                      Approval recorded (journal-verified):{' '}
                      <span className="mv-num" title={recorded.approvalId}>
                        {recorded.approvalId}
                      </span>{' '}
                      · kind {recorded.kind} · decided by{' '}
                      <span className="mv-num" title={recorded.decidedBy}>
                        {recorded.decidedBy.slice(0, 10)}…
                      </span>
                    </p>
                  ) : (
                    mayApprove(role) && (
                      <button
                        type="button"
                        className="mv-btn mv-btn--primary"
                        data-testid="open-approve"
                        disabled={csrfToken === null}
                        onClick={() => {
                          setApproveTarget(p);
                          setSheet('approve');
                        }}
                      >
                        Review and approve this plan
                      </button>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="mv-governed__note">
          Provider verification: none — no provider observation exists for any recorded proposal.
          Approval, reservation and provider settlement remain separate, later controls.
        </p>
      </section>
    </>
  );

  const OPERATIONS_PANEL = (
    <>
      <section className="mv-governed" aria-label="Workflow state">
        <h3 className="mv-droom__secttitle">Workflow</h3>
        <Stepper
          ariaLabel="Mission decision workflow"
          steps={journeySteps(view, incidentRecorded)}
        />
      </section>
      <section className="mv-governed" aria-label="Live evaluation detail">
        <h3 className="mv-droom__secttitle">Live evaluation detail</h3>
        <p className="mv-governed__note">
          The full alternatives/reasons breakdown for the live journey evaluations lives on the
          Finance cards (expand After · updated constraints). This lens follows the operational
          story as the physical evidence lands.
        </p>
        {view.lastEvent !== null ? (
          <p className="mv-droom__incidentreading">
            {view.lastEvent.reading} — admitted against this mission 's registered safety policy
            (deterministic domain policy; no live inference). The planner reselects under the
            revised constraints.
          </p>
        ) : (
          <p className="mv-governed__note">
            No incident admitted yet — the operational story begins with the signed observation.
          </p>
        )}
      </section>
    </>
  );

  const EVIDENCE_PANEL = (
    <>
      <section className="mv-governed" aria-label="Evidence chain">
        <h3 className="mv-droom__secttitle">Evidence chain</h3>
        <p className="mv-governed__note">
          Every identity on this screen — event ids, evaluation ids, plan digests — is journaled and
          replayable on the Evidence surface with the same identity.
        </p>
        <a href="#evidence">Inspect mission evidence in Evidence Replay →</a>
        <p className="mv-decision-room__disclaimer" data-testid="decision-provenance">
          {view.disclaimer ??
            'Synthetic inspection only. No Airwallex funds or live physical vehicle are involved.'}
        </p>
        <p className="mv-governed__note">
          Every decision is a proposal. Approval, reservation, provider execution and service
          delivery are separate controls; none is implied by this demonstration.
        </p>
      </section>
    </>
  );

  return (
    <Panel
      title="Physical incident → financial decision"
      meta={
        <span className="mv-tag">
          {view.hasIncident
            ? 'INCIDENT RECORDED'
            : view.hasBaseline && !view.hasIncident
              ? 'BASELINE RECORDED'
              : 'AWAITING OBSERVATION'}
        </span>
      }
      testId="decision-room"
    >
      {/* ---- mission header band: editorial title + factual status ---- */}
      <header className="mv-droom__head">
        <div className="mv-droom__titlebox">
          <h2 className="mv-droom__title">{mission.title}</h2>
          <p className="mv-droom__sub mv-hud">
            mission <span className="mv-num">{mission.id.slice(0, 14)}…</span> ·{' '}
            {view.hasIncident
              ? 'incident constraints active'
              : view.hasBaseline && !view.hasIncident
                ? 'baseline established'
                : 'no evaluation yet'}
          </p>
        </div>
        <div className="mv-droom__badges">
          <HaloBadge tone="hold" glyph="⚑" label="SIMULATED OPERATION" />
          <HaloBadge tone="neutral" glyph="◇" label="POLICY-ONLY" />
          <HaloBadge
            tone={view.hasIncident ? 'transit' : 'neutral'}
            glyph="◆"
            label={view.hasIncident ? 'INCIDENT ACTIVE' : '22 KT MODELED LIMIT'}
            live={view.hasIncident}
          />
        </div>
      </header>

      {reviewerMode === 'enabled' && (
        <div className="mv-droom__actions" data-testid="reviewer-demo-controls">
          <button
            type="button"
            className="mv-btn mv-btn--primary"
            data-testid="reviewer-demo-start"
            disabled={csrfToken === null || reviewerBusy}
            onClick={beginReviewerMission}
          >
            {reviewerBusy ? 'Preparing mission…' : 'Open guided reviewer mission'}
          </button>
          <p className="mv-droom__note">
            Signed, fixed SYNTHETIC observations only. No provider payment is triggered.
          </p>
          {reviewerError !== null && <p role="alert">{reviewerError}</p>}
        </div>
      )}
      <div className="mv-droom">
        {/* ================= LEFT — physical mission column (≈7 cols) */}
        <section className="mv-droom__physical" aria-label="Physical mission context">
          {/*
            MTV-09/12 physical mission viewport (Agent C module). The
            physical-view read endpoint (planner-endpoint-request.v1) is NOT
            deployed on this build yet, so this renders the honest UNAVAILABLE
            card — no demo fixture is substituted in the product shell, and no
            3D bundle is downloaded for a state with no scene. When Agent A
            ships the endpoint: load its JSON, validate via
            `snapshotFromServerPayload`, and mount `MissionPhysicalViewerLazy`
            with `availability="ready"` (selection below is already wired to
            the journey's incident event id).
          */}
          {/*
            LIVE physical mission viewport (Agent C module). Selection is
            seeded from the journey
's incident event id; scene state derives only from admitted
            journal events. P1-C: `decisionVerified` is derived ONLY from
            actual verified financial decision evidence — a recorded incident
            evaluation (journey.incident AND journey.after present). A wind
            event alone stays S2; a fetch failure implies no decision.
          */}
          <PhysicalMissionViewport
            key={`${mission.id}:${view.stage ?? 'empty'}`}
            missionId={mission.id}
            incidentEventId={view.lastEvent?.eventId ?? null}
            decisionVerified={
              view.lastEvent !== null &&
              view.lastEvent !== undefined &&
              view.after !== null &&
              view.after !== undefined
            }
          />

          <div className="mv-droom__actions">
            <button
              type="button"
              className="mv-btn mv-btn--primary"
              data-testid="refresh-journal"
              onClick={refreshFromJournal}
            >
              Refresh evaluations from journal
            </button>
            <button
              type="button"
              className="mv-btn mv-btn--primary"
              data-testid="start-synthetic"
              disabled={
                busy || loading || view.hasBaseline || csrfToken === null || !canAdmitSynthetic
              }
              onClick={() => runStep('baseline')}
            >
              Start signed synthetic inspection
            </button>
            <button
              type="button"
              className="mv-btn"
              data-testid="introduce-incident"
              disabled={
                busy ||
                loading ||
                !view.hasBaseline ||
                view.hasIncident ||
                csrfToken === null ||
                !canAdmitSynthetic
              }
              onClick={() => runStep('incident')}
            >
              Introduce wind incident (24.6 kt)
            </button>
          </div>
          <p className="mv-droom__note">
            Modeled flight limit <strong>22 kt</strong> — the operator's rule, not a measurement.
            The physical source does not control banking authority.
          </p>
          {loading && <SkeletonRows label="Loading actual journal and planner results…" />}
          {busy && <p role="status">Admitting signed synthetic observation to the server…</p>}
          {error !== null && (
            <p role="alert" data-testid="step-error" className="mv-sheet__error">
              {error}
            </p>
          )}
          {snapshotNotice !== null && (
            <p role="status" data-testid="snapshot-notice" className="mv-droom__notice">
              {snapshotNotice}
            </p>
          )}

          {/* DEMO EVENT SOURCE — warehouse domain. Admitting a baseline
              registers the mission spec (warehouse-inventory-v1) and switches
              the mission journal to warehouse events; harbor events then
              fail closed with MISSION_SPEC_CONFLICT. */}
          <section className="mv-governed" data-testid="demo-source">
            <h3 className="mv-droom__secttitle">
              DEMO EVENT SOURCE{' '}
              <span className="mv-hud">
                local demo catalog only — production events arrive from authenticated sources
              </span>
            </h3>
            {isWarehouse ? (
              <div className="mv-droom__actions">
                {WAREHOUSE_STEPS.filter((step) => step !== 'baseline').map((step) => (
                  <button
                    key={step}
                    type="button"
                    className="mv-btn"
                    data-testid={`warehouse-step-${step}`}
                    disabled={
                      busy ||
                      loading ||
                      !view.hasBaseline ||
                      csrfToken === null ||
                      !canAdmitSynthetic
                    }
                    onClick={() => runWarehouseStep(step)}
                  >
                    DEMO · Admit {step.replace(/-/g, ' ')}
                  </button>
                ))}
              </div>
            ) : (
              <div className="mv-droom__actions">
                <button
                  type="button"
                  className="mv-btn"
                  data-testid="warehouse-entry"
                  disabled={
                    busy || loading || view.hasBaseline || csrfToken === null || !canAdmitSynthetic
                  }
                  onClick={() => runWarehouseStep('baseline')}
                >
                  DEMO · Register warehouse spec + admit baseline
                </button>
                <p className="mv-governed__note">
                  Switches this mission 's journal to the warehouse domain (AMR runner;
                  aisle/charger/comms conditions). The mission 's harbor events then fail closed —
                  domains never mix in one journal.
                </p>
              </div>
            )}
          </section>
          {view.lastEvent !== null && view.lastEvent !== undefined && (
            <section className="mv-droom__incident" data-testid="physical-incident">
              <h3 className="mv-droom__secttitle">Admitted physical incident</h3>
              <p className="mv-droom__incidentreading">{view.lastEvent.reading}</p>
              <p className="mv-hud">
                {view.lastEvent.provenance} · {view.lastEvent.sourceId} · event
                <span className="mv-num mv-break">{view.lastEvent.eventId}</span> ·
                {view.lastEvent.observedAt}
              </p>
              <p className="mv-hud">
                digest
                <span className="mv-num">{view.lastEvent.eventDigest.slice(0, 16)}…</span>
                <CopyButton value={view.lastEvent.eventDigest} label="digest" />
              </p>
            </section>
          )}

          {/* ---- typed mission specification (C1, READ-ONLY) ---- */}
          <section
            className="mv-governed"
            aria-label="Mission specification"
            data-testid="mission-spec-panel"
          >
            <h3 className="mv-droom__secttitle">Mission specification</h3>
            {specState === 'loading' && <SkeletonRows rows={2} />}
            {specState === 'unavailable' && (
              <p className="mv-sheet__error" role="alert">
                The mission specification read failed — configuration is unavailable, NOT absent.
                Retry by reselecting the mission.
              </p>
            )}
            {specState === 'ready' && missionSpec !== null && (
              <>
                <dl className="mv-mandate__meta">
                  <div>
                    <dt>Industry / objective</dt>
                    <dd>
                      <HaloBadge
                        tone={missionSpec.industry === 'warehouse-amr' ? 'info' : 'hold'}
                        glyph="⌘"
                        label={missionSpec.industry}
                      />
                      <span className="mv-governed__note"> {missionSpec.objective}</span>
                    </dd>
                  </div>
                  <div>
                    <dt>Assets</dt>
                    <dd>
                      {missionSpec.assets
                        .map((a) => `${a.label} (${a.domainKind}, ${a.assetId.slice(0, 12)}…)`)
                        .join(' · ')}
                    </dd>
                  </div>
                  <div>
                    <dt>Safety policy v{String(missionSpec.safetyPolicy.version)}</dt>
                    <dd>
                      {missionSpec.safetyPolicy.uavWindLimitKt !== undefined
                        ? `modeled UAV wind limit ${String(missionSpec.safetyPolicy.uavWindLimitKt)} kt (operator rule, not a measurement)`
                        : null}
                      {missionSpec.safetyPolicy.groundInterrupts !== undefined
                        ? `ground interrupts: ${missionSpec.safetyPolicy.groundInterrupts.join(', ')}`
                        : null}
                      {' — '}
                      {missionSpec.safetyPolicy.clearanceAuthority}
                    </dd>
                  </div>
                  <div>
                    <dt>Economics</dt>
                    <dd className="mv-num">
                      {safeMoney(
                        missionSpec.economics.currency,
                        missionSpec.economics.missionValueMinor,
                      )}
                      {' mission value · failure cost '}
                      {safeMoney(
                        missionSpec.economics.currency,
                        missionSpec.economics.failureCostMinor,
                      )}
                      {' · protected reserve '}
                      {safeMoney(
                        missionSpec.economics.currency,
                        missionSpec.economics.protectedReserveMinor,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Supplier offers</dt>
                    <dd>
                      {missionSpec.offers.incumbent.label}
                      {missionSpec.offers.alternatives.length > 0
                        ? ' + ' + missionSpec.offers.alternatives.map((o) => o.label).join(' + ')
                        : ''}
                      {missionSpec.offers.diagnostics !== undefined
                        ? ' + diagnostics: ' + missionSpec.offers.diagnostics.label
                        : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Mandate shape</dt>
                    <dd>
                      {missionSpec.financialMandateShape.currency} · beneficiaries:
                      {missionSpec.financialMandateShape.allowedBeneficiaries.join(', ') ||
                        ' (none registered)'}
                    </dd>
                  </div>
                  {missionSpec.caseLineage !== null && (
                    <div>
                      <dt>Decision case lineage</dt>
                      <dd className="mv-num">
                        {missionSpec.caseLineage.caseId.slice(0, 16)}… · evaluation
                        {missionSpec.caseLineage.evaluationId.slice(0, 14)}…
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Spec digest</dt>
                    <dd className="mv-num">
                      {missionSpec.specDigest}
                      <CopyButton value={missionSpec.specDigest} label="spec digest" />
                    </dd>
                  </div>
                </dl>
                <p className="mv-governed__note">
                  {missionSpec.truthLabel} — this panel is READ-ONLY mission configuration; spending
                  authority lives only in ledger mandates.
                </p>
              </>
            )}
          </section>
          {/* durable recorded evaluations — physical/evidence context, always visible */}
          <section
            className="mv-governed"
            aria-label="Recorded durable evaluations"
            data-testid="recorded-snapshots"
          >
            <h3 className="mv-droom__secttitle">Recorded durable evaluations</h3>
            {snapshots.length === 0 ? (
              <div>
                <p className="mv-governed__note">
                  No durable evaluations recorded yet.
                  {view.hasBaseline
                    ? ' The journal already carries admitted events — record their evaluations now (explicit, idempotent):'
                    : ' The actions above journal the physical event and then explicitly record its evaluation snapshot — GET requests never create records.'}
                </p>
                {view.hasBaseline && (
                  <div className="mv-droom__actions">
                    <button
                      type="button"
                      className="mv-btn mv-btn--primary"
                      data-testid="record-baseline-snapshot"
                      disabled={busy || csrfToken === null}
                      onClick={() => runStep('baseline')}
                    >
                      Record baseline evaluation
                    </button>
                    <button
                      type="button"
                      className="mv-btn"
                      data-testid="record-incident-snapshot"
                      disabled={busy || csrfToken === null}
                      onClick={() => runStep('incident')}
                    >
                      Record incident evaluation
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <ul className="mv-governed__list">
                {[...snapshots].reverse().map((s) => {
                  const journalStageReached =
                    s.stage === 'baseline' ? view.hasBaseline : view.hasIncident;
                  return (
                    <li key={s.evaluationId} data-testid={`snapshot-${s.stage}`}>
                      <HaloBadge
                        tone={s.stage === 'incident' ? 'transit' : 'info'}
                        glyph={s.stage === 'incident' ? '▲' : '○'}
                        label={s.stage}
                      />{' '}
                      <span className="mv-num" title={s.evaluationId}>
                        {s.evaluationId.slice(0, 14)}…
                      </span>{' '}
                      {outcomeBadge(s.decision)} · {outcomeLine(s.decision)}
                      {!journalStageReached && (
                        <>
                          {' '}
                          <button
                            type="button"
                            className="mv-btn mv-btn--ghost"
                            data-testid={`record-snapshot-${s.stage}`}
                            disabled={busy || csrfToken === null}
                            onClick={() => runStep(s.stage)}
                          >
                            Finish recording this snapshot
                          </button>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {baselineSnapshot !== null &&
              incidentSnapshot === null &&
              view.hasBaseline &&
              !view.hasIncident && (
                <p className="mv-governed__note">
                  Baseline is recorded; the incident evaluation is recorded explicitly when the
                  incident is introduced — never by a background process or a read.
                </p>
              )}
          </section>
        </section>

        {/* ================= RIGHT — financial decision column (≈5 cols) */}
        <section className="mv-droom__financial" aria-label="Financial decisions and authority">
          <HaloTabs
            ariaLabel="Decision room lenses"
            tabs={[
              { id: 'finance', label: 'Finance' },
              { id: 'operations', label: 'Operations' },
              { id: 'evidence', label: 'Evidence' },
            ]}
            panels={[
              { id: 'finance', content: FINANCE_PANEL },
              { id: 'operations', content: OPERATIONS_PANEL },
              { id: 'evidence', content: EVIDENCE_PANEL },
            ]}
            value={lens}
            onChange={setLens}
          />
        </section>
      </div>

      {sheet === 'manual' && (
        <ManualPlanSheet
          missionId={mission.id}
          missionTitle={mission.title}
          role={role}
          onClose={() => setSheet('none')}
          onProposed={() => {
            setSheet('none');
            refreshDurableState(mission.id, new AbortController().signal);
          }}
          csrfToken={csrfToken}
        />
      )}
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
            refreshDurableState(mission.id, new AbortController().signal);
          }}
          csrfToken={csrfToken}
        />
      )}
    </Panel>
  );
}
