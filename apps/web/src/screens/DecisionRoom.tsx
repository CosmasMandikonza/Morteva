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
  mayApprove,
  mayPropose,
  proposePlanFromEvaluation,
  recordDecisionSnapshot,
  submitSyntheticStep,
  type DecisionPlanProposal,
  type MandateRow,
  type PhysicalDecisionJourney,
  type PhysicalDecisionSummary,
  type RecordedApproval,
  type RecordedSnapshot,
  type RecordedSnapshotDecision,
  type SessionState,
} from '../lib/api';
import { money as moneyOf } from '../lib/format';
import { ApprovePlanSheet, ManualPlanSheet } from '../components/GovernedActions';
// MTV-09/12 (Agent C): physical mission viewport mounted per the CTO
// integration directive. Placement/styling is Agent B's to evolve. While the
// physical-view read endpoint is not deployed, this renders the THREE-FREE
// honest unavailable card (no demo fixture substitution, no 3D bundle cost);
// when Agent A ships the endpoint, switch to `MissionPhysicalViewerLazy`
// with `snapshotFromServerPayload(json)` — see AGENT-B-HANDOFF.md.
import { PhysicalMissionViewport } from '../mission-viewer/PhysicalMissionViewport.js';

function money(minor: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minor / 100);
}

function DecisionCard({
  title,
  decision,
}: {
  title: string;
  decision: PhysicalDecisionSummary | null;
}): JSX.Element {
  return (
    <article className="mv-decision-card">
      <h3>{title}</h3>
      {decision === null ? (
        <p>Not evaluated yet — start the signed synthetic inspection to establish the baseline.</p>
      ) : (
        <>
          <p className="mv-decision-card__outcome">
            {decision.selected?.label ?? 'Human review or no eligible financial action'}
          </p>
          <p>
            {decision.selected === null
              ? 'No spend proposed.'
              : `Proposed gross: ${money(decision.selected.grossMinor)} · expected net: ${money(decision.selected.expectedNetMinor)} (model assumptions)`}
          </p>
          <p className="mv-hud">
            Evaluation {decision.evaluationId} · {decision.outcome} · POLICY-ONLY
          </p>
          <p className="mv-decision-card__authority">{decision.authorization}</p>
          <details>
            <summary>Alternatives and reasons</summary>
            <ul>
              {decision.alternatives.map((alternative) => (
                <li key={alternative.id}>
                  {alternative.label} —{' '}
                  {alternative.feasible
                    ? 'eligible'
                    : `blocked: ${alternative.rejection ?? 'policy'}`}
                  {' · '}
                  {money(alternative.grossMinor)} gross
                </li>
              ))}
            </ul>
            <ul>
              {decision.reasons.map((reason, index) => (
                <li key={index}>
                  {reason.code}: {reason.message}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </article>
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

export function DecisionRoom({
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
  const [journey, setJourney] = useState<PhysicalDecisionJourney | null>(null);
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
  const role = session.kind === 'signed-in' ? session.session.actor.role : null;

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
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchPhysicalDecision(mission.id, controller.signal)
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
  }, [mission?.id, session.kind, onSessionExpired, refreshDurableState]);

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

  const runStep = (step: 'baseline' | 'incident'): void => {
    if (session.kind !== 'signed-in' || mission === null || csrfToken === null || busy) return;
    setBusy(true);
    setError(null);
    setSnapshotNotice(null);
    const finish = (): void => {
      // Refresh the live journey view (cards/incident) from the journal.
      const controller = new AbortController();
      fetchPhysicalDecision(mission.id, controller.signal)
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
    submitSyntheticStep(mission.id, step, csrfToken)
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
      </Panel>
    );
  }

  const planFor = (planId: string, planVersion: number) =>
    approvals.find((a) => a.planId === planId && a.planVersion === planVersion) ?? null;

  return (
    <Panel
      title="Physical incident → financial decision"
      meta={<span className="mv-tag">SIMULATED_OPERATION · POLICY-ONLY</span>}
      testId="decision-room"
    >
      <section className="mv-decision-room" aria-label="Connected decision journey">
        <p className="mv-decision-room__intro">
          <strong>{mission.title}</strong> · one authenticated synthetic UAV observation,
          deterministic safety policy and live internal-ledger financial facts.
        </p>
        <p>
          Modeled flight limit: <strong>22 kt</strong>. The physical source does not control banking
          authority.
        </p>
        <div className="mv-decision-room__actions">
          <button
            type="button"
            className="mv-btn"
            data-testid="start-synthetic"
            disabled={busy || loading || journey?.stage !== 'empty' || csrfToken === null}
            onClick={() => runStep('baseline')}
          >
            Start signed synthetic inspection
          </button>
          <button
            type="button"
            className="mv-btn"
            data-testid="introduce-incident"
            disabled={busy || loading || journey?.stage !== 'baseline' || csrfToken === null}
            onClick={() => runStep('incident')}
          >
            Introduce wind incident (24.6 kt)
          </button>
        </div>
        {loading && <p role="status">Loading actual journal and planner results…</p>}
        {busy && <p role="status">Admitting signed synthetic observation to the server…</p>}
        {error !== null && (
          <p role="alert" data-testid="step-error">
            {error}
          </p>
        )}
        {snapshotNotice !== null && (
          <p role="status" data-testid="snapshot-notice">
            {snapshotNotice}
          </p>
        )}
        {journey?.incident !== null && journey?.incident !== undefined && (
          <section className="mv-decision-room__incident" data-testid="physical-incident">
            <h3>Admitted physical incident</h3>
            <p>{journey.incident.reading}</p>
            <p className="mv-hud">
              {journey.incident.provenance} · {journey.incident.sourceId} · event{' '}
              {journey.incident.eventId} · {journey.incident.observedAt}
            </p>
            <p className="mv-hud">Digest {journey.incident.eventDigest}</p>
          </section>
        )}
        {/*
          MTV-09/12 physical mission viewport (Agent C module) — LIVE. The
          authenticated sanitized read (Agent A, PR #52 implementation) is
          fetched per mission, validated by the strict adapter
          (snapshotFromServerPayload — fails closed on ANY shape deviation),
          and mounted through the lazy chunk (three.js loads only when
          evidence exists). Failure states render the honest unavailable
          card — no fixture is EVER substituted for live data. Selection is
          seeded from the journey's incident event id; scene state derives
          only from admitted journal events (no invented positions, no
          payment implications).

          P1-C: `decisionVerified` is derived ONLY from actual verified
          financial decision evidence — an authenticated journey read with a
          recorded incident evaluation (journey.incident AND journey.after
          both present). A physical wind event alone stays S2; a transient
          fetch failure implies no financial decision.
        */}
        <PhysicalMissionViewport
          key={`${mission.id}:${journey?.stage ?? 'empty'}`}
          missionId={mission.id}
          incidentEventId={journey?.incident?.eventId ?? null}
          decisionVerified={
            journey?.incident !== null &&
            journey?.incident !== undefined &&
            journey?.after !== null &&
            journey?.after !== undefined
          }
        />
        <div className="mv-decision-room__comparison">
          <DecisionCard title="Before · initial plan" decision={journey?.before ?? null} />
          <DecisionCard title="After · updated constraints" decision={journey?.after ?? null} />
        </div>

        {/* -------- durable recorded evaluations (server truth, rebuild after reload) */}
        <section
          className="mv-governed"
          aria-label="Recorded durable evaluations"
          data-testid="recorded-snapshots"
        >
          <h3>Recorded durable evaluations</h3>
          {snapshots.length === 0 ? (
            <p className="mv-governed__note">
              No durable evaluations recorded yet. The actions above journal the physical event and
              then explicitly record its evaluation snapshot — GET requests never create records.
            </p>
          ) : (
            <ul className="mv-governed__list">
              {[...snapshots].reverse().map((s) => {
                const journalStageReached =
                  s.stage === 'baseline'
                    ? journey?.stage !== 'empty'
                    : journey?.stage === 'incident';
                return (
                  <li key={s.evaluationId} data-testid={`snapshot-${s.stage}`}>
                    <span className="mv-tag">{s.stage}</span>{' '}
                    <span className="mv-num" title={s.evaluationId}>
                      {s.evaluationId.slice(0, 14)}…
                    </span>{' '}
                    · {outcomeLine(s.decision)} · recorded {s.recordedAt}
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
            journey?.stage === 'baseline' && (
              <p className="mv-governed__note">
                Baseline is recorded; the incident evaluation is recorded explicitly when the
                incident is introduced — never by a background process or a read.
              </p>
            )}
        </section>

        {/* -------- server-authoritative ID-only proposal (planner-derived golden path) */}
        {incidentSnapshot !== null && (
          <section
            className="mv-governed"
            aria-label="Governed follow-through"
            data-testid="governed-actions"
          >
            <h3>From recorded evaluation to governed action</h3>
            <p className="mv-governed__lead">
              The proposal is created <strong>only</strong> from the recorded incident evaluation:
              the server derives the economic terms from its own durable snapshot and journal ({' '}
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

        {/* -------- persisted proposals + journal-verified approvals (server truth) */}
        <section
          className="mv-governed"
          aria-label="Recorded proposals and approvals"
          data-testid="decision-plans"
        >
          <h3>Recorded proposals</h3>
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
                  <li
                    key={`${p.plan.id}:${String(p.plan.version)}`}
                    data-testid="decision-plan-row"
                  >
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
                      </span>{' '}
                      · provider verified: no
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

        <p className="mv-decision-room__disclaimer" data-testid="decision-provenance">
          {journey?.disclaimer ??
            'Synthetic inspection only. No Airwallex funds or live physical vehicle are involved.'}
        </p>
        <p>
          Every decision is a proposal. Approval, reservation, provider execution and service
          delivery are separate controls; none is implied by this demonstration.
        </p>
        <a href="#evidence">Inspect mission evidence in Evidence Replay</a>
      </section>
      {sheet === 'manual' && (
        <ManualPlanSheet
          missionId={mission.id}
          missionTitle={mission.title}
          role={role}
          onClose={() => setSheet('none')}
          onProposed={() => {
            setSheet('none');
            if (mission !== null) {
              refreshDurableState(mission.id, new AbortController().signal);
            }
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
            if (mission !== null) {
              refreshDurableState(mission.id, new AbortController().signal);
            }
          }}
          csrfToken={csrfToken}
        />
      )}
    </Panel>
  );
}
