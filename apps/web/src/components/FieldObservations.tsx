import type { JSX } from 'react';
import { provenanceCopy } from '../lib/decisionCopy';
import type { FieldState } from '../lib/fieldEvents';
import { formatDate } from '../lib/format';
import { CopyButton, HaloBadge, SkeletonRows } from './ui';

/**
 * The authenticated field journal, as the operator sees it: WHICH registered
 * source claimed WHAT about WHICH asset, WHEN, with the integrity digest of
 * the admitted event. This is the evidence the decision reads — shown before
 * the decision so the operator can judge the inputs, not just the output.
 *
 * Honesty rules rendered here:
 *  - FIELD is labelled a source-authenticated CLAIM, never "measured truth";
 *  - SYNTHETIC is labelled not-a-field-measurement;
 *  - a reading the planner withheld (stale / not planning-valid) says so;
 *  - an unavailable read is "unavailable", never an empty journal.
 */

export function FieldObservations({
  field: state,
  admittedCount,
}: {
  field: FieldState;
  /** Count from the operations read — authoritative even when the list is not. */
  admittedCount: number | null;
}): JSX.Element {
  return (
    <section
      className="mv-governed"
      aria-label="Field observations"
      data-testid="field-observations"
    >
      <h3 className="mv-droom__secttitle">Field observations (authenticated journal)</h3>
      {state.kind === 'loading' && <SkeletonRows label="Reading the authenticated journal…" />}

      {state.kind === 'unavailable' && (
        <p className="mv-governed__note" role="status" data-testid="field-unavailable">
          The sanitized event list is unavailable for this mission&rsquo;s shape ({state.code}). The
          journal itself is intact
          {admittedCount !== null
            ? ` — ${String(admittedCount)} admitted event${admittedCount === 1 ? '' : 's'}`
            : ''}
          ; the evaluation below reads it directly.
        </p>
      )}

      {state.kind === 'ready' && state.events.length === 0 && (
        <div data-testid="field-empty">
          <p className="mv-governed__lead">
            <strong>No authenticated observations yet.</strong> This screen never invents evidence.
            A registered source must submit signed events from your field system.
          </p>
          <p className="mv-governed__note">
            Open <a href="#setup">Setup → how a field system sends signed evidence</a> for the
            endpoint, signing rule and an example envelope.
          </p>
        </div>
      )}

      {state.kind === 'ready' && state.events.length > 0 && (
        <>
          <ul
            className="mv-field__list"
            aria-label="Admitted field events"
            data-testid="field-events"
          >
            {[...state.events]
              .sort((a, b) => (b.journalSeq ?? b.sequence) - (a.journalSeq ?? a.sequence))
              .map((e) => {
                const p = provenanceCopy(e.provenance);
                return (
                  <li
                    key={e.eventId}
                    className="mv-field__event"
                    data-testid={`field-event-${e.eventId}`}
                  >
                    <div className="mv-field__eventhead">
                      <HaloBadge
                        tone={e.provenance === 'FIELD' ? 'info' : 'neutral'}
                        glyph={e.provenance === 'FIELD' ? '◈' : '◇'}
                        label={p.badge}
                      />
                      <time dateTime={e.observedAt} title={e.observedAt} className="mv-hud">
                        {formatDate(e.observedAt)}
                      </time>
                    </div>
                    <p className="mv-num mv-break">
                      {e.observations.length === 0
                        ? '(no allowlisted observation kinds)'
                        : e.observations
                            .map(
                              (o) =>
                                `${o.kind} ${String(o.value)}${o.unit === 'state' || o.unit === 'category' ? '' : ' ' + o.unit}`,
                            )
                            .join(' · ')}
                    </p>
                    <p className="mv-hud mv-break">
                      asset <span className="mv-num">{e.assetId}</span> · source{' '}
                      <span className="mv-num">{e.sourceId}</span>
                      {e.sourceType !== undefined && e.sourceType !== ''
                        ? ` (${e.sourceType})`
                        : ''}{' '}
                      · seq {String(e.sequence)}
                      {e.planningValidAtSnapshot === false
                        ? ' · WITHHELD from planning (stale or not planning-valid)'
                        : e.freshnessAtSnapshot
                          ? ` · ${e.freshnessAtSnapshot}`
                          : ''}
                    </p>
                    <p className="mv-hud">
                      digest{' '}
                      <span className="mv-num" title={e.eventDigest}>
                        {e.eventDigest.slice(0, 16)}…
                      </span>
                      <CopyButton value={e.eventDigest} label="digest" />
                    </p>
                  </li>
                );
              })}
          </ul>
          <p className="mv-governed__note">
            FIELD labels mean the registered source <em>authenticated with its credential</em> and{' '}
            <em>claimed</em> these readings. MOTERVA checks who signed an event, not that the
            instrument is right. Evidence informs a proposal; it never approves or moves money.
          </p>
          {state.constraints.length > 0 && (
            <ul className="mv-field__constraints" aria-label="Operating status per asset">
              {state.constraints.map((c) => (
                <li key={c.assetId} data-testid={`constraint-${c.assetId}`}>
                  <HaloBadge
                    tone={c.state === 'blocked' ? 'hold' : c.state === 'clear' ? 'info' : 'neutral'}
                    glyph={c.state === 'blocked' ? '✕' : c.state === 'clear' ? '○' : '?'}
                    label={`${c.assetId}: ${c.state.toUpperCase()} · ${c.reason}`}
                  />{' '}
                  <span className="mv-hud">{c.basis}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
