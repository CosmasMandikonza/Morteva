/**
 * Evidence HUD — shared by the 3D and 2D views.
 *
 * Readability law: every chip states what kind of truth it carries
 * (observed / inferred / illustrative / simulated). Financial authority is
 * NEVER rendered here except as a host-provided link (S3), and no provider
 * success can ever appear (there is no provider data in the contract).
 */
import type { JSX } from 'react';
import type { PhysicalViewSnapshot, SceneState, SelectedEventView } from './contract.js';

export function EvidenceHud(props: {
  state: SceneState;
  snapshot: PhysicalViewSnapshot;
  selected: SelectedEventView | null;
  theme: 'dark' | 'light';
  frameInfo: { fps: number; triangles: number; calls: number } | null;
  reducedMotion: boolean;
  decisionHref?: string;
  decisionLabel: string;
  fallbackReason: string | null;
  requested3d: boolean;
  effectiveMode: '3d' | '2d';
  onRetry3d: () => void;
  onSwitch2d: () => void;
  onResetCamera: () => void;
}): JSX.Element {
  const {
    state,
    snapshot,
    selected,
    theme,
    frameInfo,
    reducedMotion,
    decisionHref,
    decisionLabel,
    fallbackReason,
    requested3d,
    effectiveMode,
    onRetry3d,
    onSwitch2d,
    onResetCamera,
  } = props;

  const uav = state.constraints.find((c) => c.assetId === state.policy.uavAssetId);
  const phaseLabel = PHASE_LABEL[state.phase];
  const phaseTone =
    state.phase === 'S2-restricted' || state.phase === 'S3-restricted-escalated'
      ? 'restricted'
      : state.phase === 'S5-uncertain' || state.phase === 'S0-initial'
        ? 'uncertain'
        : 'nominal';

  return (
    <div className="mpv-hud" data-testid="mpv-hud">
      <div className="mpv-hud__row">
        <span className="mpv-chip mpv-chip--truth" data-testid="mpv-truth-chip">
          {snapshot.truthLabel}
        </span>
        <span className={`mpv-chip mpv-chip--${phaseTone}`} data-testid="mpv-phase">
          {phaseLabel}
        </span>
        {state.selected?.isHistoricalReplay === true && (
          <span className="mpv-chip mpv-chip--history" data-testid="mpv-replay-chip">
            Historical replay — state as of that event
          </span>
        )}
      </div>

      <div className="mpv-hud__grid">
        {/* Observed: aerial wind vs modeled limit — always present, muted
            when no fresh reading exists (uncertainty is a first-class state). */}
        <div className="mpv-card">
          <h5 className="mpv-card__k">Observed · aerial wind</h5>
          {state.aerialWindKt !== null ? (
            <p className="mpv-card__v mpv-num" data-testid="mpv-wind">
              {state.aerialWindKt.toFixed(1)} kt{' '}
              <span className="mpv-card__sub">
                vs modeled limit {state.policy.uavWindLimitKt} kt
                {state.windBreached ? ' — exceeded' : ''}
              </span>
            </p>
          ) : (
            <p className="mpv-card__v mpv-card__v--muted" data-testid="mpv-wind">
              no fresh wind reading — unknown
            </p>
          )}
        </div>

        {/* Inferred: operational constraint */}
        <div className="mpv-card">
          <h5 className="mpv-card__k">Inferred · operational constraint</h5>
          <p className="mpv-card__v" data-testid="mpv-constraint">
            {uav === undefined ? 'unknown' : `${uav.state} · ${uav.reason}`}
            <span className="mpv-card__sub"> modeled rule, not a measurement</span>
          </p>
        </div>
      </div>

      {/* Selected evidence */}
      {selected !== null && (
        <dl className="mpv-selected" data-testid="mpv-selected">
          <div>
            <dt>Evidence</dt>
            <dd className="mpv-num">{selected.event.eventId}</dd>
          </div>
          <div>
            <dt>Digest</dt>
            <dd className="mpv-num">{selected.event.eventDigest.slice(0, 16)}…</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              {selected.event.sourceId} ({selected.event.sourceType})
            </dd>
          </div>
          <div>
            <dt>Provenance</dt>
            <dd data-testid="mpv-provenance">{selected.event.provenance}</dd>
          </div>
          <div>
            <dt>Observed / ingested</dt>
            <dd className="mpv-num">
              {selected.event.observedAt.slice(11, 19)}Z / {selected.event.ingestedAt.slice(11, 19)}
              Z
            </dd>
          </div>
          <div>
            <dt>Order</dt>
            <dd className="mpv-num">
              journal #{selected.event.journalSeq} · src seq {selected.event.sequence}
            </dd>
          </div>
          <div>
            <dt>Freshness at snapshot</dt>
            <dd data-testid="mpv-freshness">
              {selected.event.freshnessAtSnapshot}
              {selected.event.planningValidAtSnapshot ? '' : ' · not planning-valid'}
            </dd>
          </div>
          <div>
            <dt>Constraint at event</dt>
            <dd>
              {selected.constraintAtEvent.state} · {selected.constraintAtEvent.reason}
            </dd>
          </div>
        </dl>
      )}

      {/* S3: host-provided financial link only — never a viewer-owned result */}
      {state.phase === 'S3-restricted-escalated' && decisionHref !== undefined && (
        <a className="mpv-decision-link" data-testid="mpv-decision-link" href={decisionHref}>
          {decisionLabel} →
        </a>
      )}

      <div className="mpv-hud__foot">
        <span className="mpv-note">
          Scene placement illustrative — the evidence contract carries no coordinates.
        </span>
        <span className="mpv-note mpv-note--dim">
          {state.planningValidCount}/{state.eventCount} events planning-valid · asOf{' '}
          {state.asOf.slice(11, 19)}Z
        </span>
        {frameInfo !== null && (
          <span className="mpv-note mpv-note--dim mpv-num" data-testid="mpv-perf">
            {frameInfo.fps} fps · {frameInfo.triangles} tris · {frameInfo.calls} calls
          </span>
        )}
        {reducedMotion && <span className="mpv-note">reduced motion: transitions instant</span>}
      </div>

      {fallbackReason !== null && (
        <p className="mpv-fallback-note" role="status" data-testid="mpv-fallback-note">
          {fallbackReason}{' '}
          <button type="button" className="mpv-hud__modebtn" onClick={onRetry3d}>
            Try 3D again
          </button>
        </p>
      )}
      {fallbackReason === null && (
        <div className="mpv-hud__modes">
          <button
            type="button"
            className="mpv-hud__modebtn"
            data-testid="mpv-mode-3d"
            aria-pressed={effectiveMode === '3d'}
            onClick={requested3d ? onRetry3d : onRetry3d}
          >
            3D
          </button>
          <button
            type="button"
            className="mpv-hud__modebtn"
            data-testid="mpv-mode-2d"
            aria-pressed={effectiveMode === '2d'}
            onClick={onSwitch2d}
          >
            2D
          </button>
          {effectiveMode === '3d' && (
            <button
              type="button"
              className="mpv-hud__modebtn"
              data-testid="mpv-reset-camera"
              onClick={onResetCamera}
            >
              Reset view
            </button>
          )}
          {theme === 'dark' ? null : null}
        </div>
      )}
    </div>
  );
}

const PHASE_LABEL: Record<SceneState['phase'], string> = {
  'S0-initial': 'Awaiting admitted evidence — status unknown by design',
  'S1-nominal': 'Operating within modeled limits',
  'S2-restricted': 'Modeled limit exceeded — activity restricted',
  'S3-restricted-escalated': 'Restricted — financial decision required',
  'S4-historical': 'Historical evidence replay',
  'S5-uncertain': 'Evidence stale or insufficient — status unknown',
};
