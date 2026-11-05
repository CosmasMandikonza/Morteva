import type { JSX } from 'react';
import type { OperationReadView } from '@moterva/domain';
import { StatusChip } from './StatusChip';
import { operationPresentation } from '../status/statusMap';
import { formatDate, shortId } from '../lib/format';

/**
 * Operation inspector — the center of the operation-centered workflow
 * (Cult UI Expandable Card pattern: exact terms visible, detail in place).
 * Renders one real ledger operation: identity, exact terms, state + why it
 * matters financially, required human action when escalated, and the link
 * into Evidence Replay carrying the SAME operation identity.
 */
export function OperationInspector({
  operation,
  onInspectEvidence,
}: {
  operation: OperationReadView;
  onInspectEvidence: (operationId: string) => void;
}): JSX.Element {
  const presentation = operationPresentation(operation.state);
  const needsAction = operation.attention !== 'none';

  return (
    <section
      className="mv-inspector"
      data-testid="operation-inspector"
      aria-label={`Operation ${shortId(operation.id)} detail`}
    >
      <header className="mv-inspector__head">
        <StatusChip entry={presentation} />
        <span className="mv-inspector__id mv-num" title={operation.id}>
          {shortId(operation.id)}
        </span>
        <span className="mv-inspector__kind mv-num">{operation.kind}</span>
        {needsAction && (
          <span
            className={`mv-chip ${operation.attention === 'human' ? 'mv-chip--attention' : 'mv-chip--hold'}`}
            data-testid="attention-chip"
          >
            <span className="mv-chip__glyph" aria-hidden="true">
              {operation.attention === 'human' ? '✋' : '⚠'}
            </span>
            {operation.attention === 'human' ? 'needs human decision' : 'ambiguous outcome'}
          </span>
        )}
      </header>

      <div className="mv-inspector__amount">
        <span className="mv-num mv-inspector__amount-value">
          {operation.amount.currency} {operation.amount.major}
        </span>
        <span className="mv-inspector__purpose">
          {operation.purpose} · {operation.beneficiary}
        </span>
      </div>

      <dl className="mv-mandate__meta mv-inspector__terms">
        <div>
          <dt>Request ID</dt>
          <dd className="mv-num" title={operation.requestId}>
            {shortId(operation.requestId)}
          </dd>
        </div>
        <div>
          <dt>Plan</dt>
          <dd className="mv-num">
            {shortId(operation.planId)} v{operation.planVersion}
          </dd>
        </div>
        <div>
          <dt>Commitment</dt>
          <dd className="mv-num">{operation.commitment.state}</dd>
        </div>
        <div>
          <dt>Dispatch</dt>
          <dd>
            {operation.dispatch === null
              ? 'never dispatched'
              : operation.dispatch.attempts === 0 && operation.dispatch.status === 'pending'
                ? 'queued — not sent'
                : `${operation.dispatch.status} · ${String(operation.dispatch.attempts)} attempt(s)${operation.dispatch.rail !== null ? ` · ${operation.dispatch.rail}` : ''}`}
          </dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatDate(operation.updatedAt)}</dd>
        </div>
      </dl>

      <p className="mv-mandate__meaning mv-inspector__meaning">
        <strong>Why it matters:</strong> {presentation.meaning}.
        {operation.commitment.state === 'unknown' &&
          ' The amount still consumes spendable capacity until resolved.'}
        {operation.commitment.state === 'settled' &&
          ' Settlement consumed envelope; capacity frees on a newer balance observation.'}
      </p>

      {needsAction && (
        <p className="mv-inspector__action" data-testid="required-action">
          <strong>Required action:</strong>{' '}
          {operation.attention === 'human'
            ? 'a human must decide the next step for this operation; exposure stays held until then.'
            : 'resolve by the original request ID — verify before any retry; never resubmit with a new identity.'}
        </p>
      )}

      <button
        type="button"
        className="mv-btn"
        onClick={() => onInspectEvidence(operation.id)}
        data-testid="inspect-evidence"
      >
        Inspect evidence for this operation →
      </button>
    </section>
  );
}
