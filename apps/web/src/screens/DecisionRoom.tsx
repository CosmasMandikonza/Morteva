import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Panel } from '../components/Panel';
import {
  ApiError,
  fetchPhysicalDecision,
  submitSyntheticStep,
  type PhysicalDecisionJourney,
  type PhysicalDecisionSummary,
  type SessionState,
} from '../lib/api';

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

  useEffect(() => {
    if (session.kind !== 'signed-in' || mission === null) {
      setJourney(null);
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
    return () => controller.abort();
  }, [mission?.id, session.kind, onSessionExpired]);

  const runStep = (step: 'baseline' | 'incident'): void => {
    if (session.kind !== 'signed-in' || mission === null || csrfToken === null || busy) return;
    setBusy(true);
    setError(null);
    submitSyntheticStep(mission.id, step, csrfToken)
      .then(setJourney)
      .catch((reason: unknown) => {
        if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
        else setError(reason instanceof Error ? reason.message : 'Synthetic step failed');
      })
      .finally(() => setBusy(false));
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
        {error !== null && <p role="alert">{error}</p>}
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
        <div className="mv-decision-room__comparison">
          <DecisionCard title="Before · initial plan" decision={journey?.before ?? null} />
          <DecisionCard title="After · updated constraints" decision={journey?.after ?? null} />
        </div>
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
    </Panel>
  );
}
