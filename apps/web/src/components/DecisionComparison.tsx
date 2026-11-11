import type { JSX } from 'react';
import type { PhysicalDecisionSummary } from '../lib/api';
import { describeOutcome, rejectionCopy } from '../lib/decisionCopy';
import { safeMoney } from '../lib/format';
import { HaloBadge } from './ui';

/**
 * Financial alternatives, side by side, with the reason each one was or was
 * not usable. Amounts are exact (currency-aware — never a hardcoded USD) and
 * every refusal carries its typed code. A no-action, decline or escalation is
 * a first-class outcome with its own headline: none of them is rendered as a
 * "success" and none is hidden behind an empty state.
 */
export function DecisionComparison({
  decision,
  currency,
  title,
  recordedEvaluationId,
  testId,
}: {
  decision: PhysicalDecisionSummary;
  currency: string;
  title: string;
  /** Evaluation id of the durable snapshot this view is being compared with. */
  recordedEvaluationId?: string | null;
  testId: string;
}): JSX.Element {
  const outcome = describeOutcome(decision.outcome, decision.selected);
  const tone =
    outcome.kind === 'spend' ? 'transit' : outcome.kind === 'escalate' ? 'hold' : 'neutral';
  const glyph =
    outcome.kind === 'spend'
      ? '▶'
      : outcome.kind === 'escalate'
        ? '⚑'
        : outcome.kind === 'decline'
          ? '∅'
          : '■';
  const sameAsRecorded =
    recordedEvaluationId !== undefined && recordedEvaluationId !== null
      ? recordedEvaluationId === decision.evaluationId
      : null;

  return (
    <section className="mv-cmp" aria-label={title} data-testid={testId}>
      <h3 className="mv-droom__secttitle">{title}</h3>
      <div
        className="mv-cmp__headline"
        data-testid={`${testId}-outcome`}
        data-outcome={outcome.kind}
      >
        <HaloBadge tone={tone} glyph={glyph} label={outcome.label} />
        <p className="mv-governed__note">{outcome.explanation}</p>
        {decision.selected !== null && outcome.kind === 'spend' && (
          <p className="mv-num" data-testid={`${testId}-selected`}>
            {decision.selected.label} · gross{' '}
            <strong>{safeMoney(currency, decision.selected.grossMinor)}</strong> · expected net{' '}
            {safeMoney(currency, decision.selected.expectedNetMinor)}
          </p>
        )}
      </div>

      <ul className="mv-cmp__list" aria-label="Alternatives considered">
        {decision.alternatives.map((alt) => {
          const selected = decision.selected?.candidateId === alt.id;
          return (
            <li
              key={alt.id}
              className={`mv-cmp__item ${selected ? 'is-selected' : alt.feasible ? 'is-eligible' : 'is-refused'}`}
              data-testid={`cmp-option-${alt.id}`}
              data-feasible={alt.feasible ? 'true' : 'false'}
            >
              <div className="mv-cmp__head">
                <strong className="mv-break">{alt.label}</strong>
                {selected ? (
                  <HaloBadge tone="info" glyph="◆" label="SELECTED" />
                ) : alt.feasible ? (
                  <HaloBadge tone="neutral" glyph="○" label="ELIGIBLE, NOT BEST" />
                ) : (
                  <HaloBadge tone="hold" glyph="✕" label="REFUSED" />
                )}
              </div>
              <dl className="mv-cmp__nums">
                <div>
                  <dt>Gross cost</dt>
                  <dd className="mv-num">{safeMoney(currency, alt.grossMinor)}</dd>
                </div>
                <div>
                  <dt>Expected net</dt>
                  <dd className="mv-num">{safeMoney(currency, alt.expectedNetMinor)}</dd>
                </div>
              </dl>
              <p className="mv-cmp__why">
                {rejectionCopy(alt.rejection)}{' '}
                {alt.rejection !== null && alt.rejection !== 'none' && (
                  <span className="mv-spec__code">{alt.rejection}</span>
                )}
              </p>
            </li>
          );
        })}
      </ul>

      {decision.reasons.length > 0 && (
        <ul className="mv-xcard__list" aria-label="Decision reasons">
          {decision.reasons.map((reason, index) => (
            <li key={`${reason.code}-${String(index)}`}>
              <span className="mv-tag">{reason.code}</span> {reason.message}
            </li>
          ))}
        </ul>
      )}

      <dl className="mv-mandate__meta" aria-label="What this decision assumes">
        <div>
          <dt>Expected net means</dt>
          <dd>
            probability-weighted benefit minus cost, using the success probabilities, availability
            and economics YOU configured — assumptions, not forecasts.
          </dd>
        </div>
        <div>
          <dt>Balance observation</dt>
          <dd className="mv-num">
            {decision.currentBalanceStatus}
            {decision.currentSpendableMinor !== null
              ? ` · spendable ${safeMoney(currency, decision.currentSpendableMinor)}`
              : ' · no spendable figure'}
          </dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd className="mv-num">
            {String(decision.evidenceIds.length)} admitted event
            {decision.evidenceIds.length === 1 ? '' : 's'} used
            {decision.withheldEventIds.length > 0
              ? ` · ${String(decision.withheldEventIds.length)} withheld (stale or not planning-valid)`
              : ''}
          </dd>
        </div>
        <div>
          <dt>Evaluation id</dt>
          <dd className="mv-num mv-break">
            {decision.evaluationId.slice(0, 24)}…
            {sameAsRecorded === true && ' · identical to the recorded evaluation'}
            {sameAsRecorded === false &&
              ' · differs from the recorded evaluation (facts changed since it was recorded)'}
          </dd>
        </div>
      </dl>
      <p className="mv-governed__note">
        {decision.authorization} · provider verified: no · {decision.mode}
      </p>
    </section>
  );
}
