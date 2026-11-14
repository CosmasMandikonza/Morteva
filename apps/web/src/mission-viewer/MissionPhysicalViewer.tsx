/**
 * MissionPhysicalViewer — the production physical mission viewport (MTV-09/12).
 *
 * ISOLATION CONTRACT: the caller (Decision Room or the harness) owns mission
 * data, selection and all financial state. This component renders the
 * provided `snapshot` (physical-view contract v1) and reports selection
 * intent through callbacks. It never fetches, never writes, never evaluates
 * money, and never reads raw journal payloads.
 *
 * displayMode: '3d' renders WebGL; '2d' renders the SVG schematic; 'auto'
 * tries 3D and falls back to 2D on WebGL unavailability or context loss —
 * selection is preserved across the switch (acceptance #15/#16).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { projectSceneState, type SceneSelection } from './scene-state.js';
import { MissionViewer3d, WebGLUnavailableError } from './viewer3d.js';
import { Viewer2d } from './scene2d.jsx';
import { EvidenceHud, SceneBadge } from './hud.jsx';
import type { PhysicalViewSnapshot, SceneState } from './contract.js';
import './mission-viewer.css';

export type SnapshotAvailability = 'ready' | 'loading' | 'unavailable';

export interface MissionPhysicalViewerProps {
  /** Host-owned mission identity (rendered, never fetched). */
  readonly missionId: string;
  /**
   * Authoritative physical-view snapshot v1 for THIS mission. REQUIRED when
   * `availability` is 'ready' (default). The viewer NEVER substitutes demo
   * data: when the host cannot deliver a snapshot it must say so via
   * `availability: 'unavailable'` — an honest degraded card is rendered and
   * the 3D/2D scene is not shown at all.
   */
  readonly snapshot: PhysicalViewSnapshot | null;
  /**
   * Host-declared snapshot availability (default 'ready'). 'loading' renders
   * a pending state; 'unavailable' renders the honest degraded state with
   * `unavailableReason` — used when the physical-view read endpoint is
   * unreachable, unauthorized, or not yet deployed.
   */
  readonly availability?: SnapshotAvailability;
  /** Required, human-readable, when availability is 'unavailable'. */
  readonly unavailableReason?: string;
  /** Optional host retry handler rendered on the unavailable card. */
  readonly onRetryLoad?: () => void;
  /** Host-owned selection (controlled). */
  readonly selectedEventId: string | null;
  readonly onSelectEvent: (eventId: string | null) => void;
  readonly selectedAssetId: string | null;
  readonly onSelectAsset: (assetId: string | null) => void;
  /** B-led theme mode. */
  readonly theme?: 'dark' | 'light';
  /** Defaults to the user's prefers-reduced-motion. */
  readonly reducedMotion?: boolean;
  readonly displayMode?: '3d' | '2d' | 'auto';
  /**
   * HOST-SIGNAL: when true, a restricted phase shows the link to the
   * financial decision (S2→S3). The viewer itself evaluates nothing.
   */
  readonly decisionAvailable?: boolean;
  /** Host-provided anchor for the financial decision surface. */
  readonly decisionHref?: string;
  readonly decisionLabel?: string;
  /** Hide the default aside (host renders its own event list). */
  readonly hideEventList?: boolean;
  /**
   * Chrome composition (CTO visual gate, PR #65). 'overlay' (default) keeps
   * the accepted harness behavior: the full EvidenceHud floats over the scene
   * and the evidence aside sits beside it. 'below' is the Decision Room
   * composition — the scene is ONE unobstructed plane (a tiny non-interactive
   * status badge is the only in-scene UI), the full HUD renders as a static
   * block BENEATH the stage at every width, and the evidence rail becomes a
   * compact collapsible timeline below the strip. The host hides the
   * disclosure when it already renders the same journal list (customer mode).
   */
  readonly chrome?: 'overlay' | 'below';
  /** chrome='below' only: omit the evidence disclosure (host renders its own list). */
  readonly hideDisclosure?: boolean;
  readonly className?: string;
}

type EffectiveMode = '3d' | '2d';

export function MissionPhysicalViewer(props: MissionPhysicalViewerProps): JSX.Element {
  const {
    missionId,
    snapshot,
    availability = 'ready',
    unavailableReason,
    onRetryLoad,
    selectedEventId,
    onSelectEvent,
    selectedAssetId,
    onSelectAsset,
    theme = 'dark',
    reducedMotion,
    displayMode = 'auto',
    decisionAvailable = false,
    decisionHref,
    decisionLabel = 'Inspect the financial decision',
    hideEventList = false,
    chrome = 'overlay',
    hideDisclosure = false,
    className,
  } = props;
  const below = chrome === 'below';

  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const markerLayerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<MissionViewer3d | null>(null);
  const [effectiveMode, setEffectiveMode] = useState<EffectiveMode>(
    displayMode === '2d' ? '2d' : '3d',
  );
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [frameInfo, setFrameInfo] = useState<{
    fps: number;
    triangles: number;
    calls: number;
  } | null>(null);

  const prefersReduced = usePrefersReducedMotion();
  const reduced = reducedMotion ?? prefersReduced;
  const snapshotReady = availability === 'ready' && snapshot !== null;

  // Pure projection — the single source of everything the renderer draws.
  const selection: SceneSelection = useMemo(
    () => ({
      selectedEventId,
      selectedAssetId,
      decisionAvailable,
    }),
    [selectedEventId, selectedAssetId, decisionAvailable],
  );
  const state: SceneState | null = useMemo(
    () => (snapshotReady && snapshot !== null ? projectSceneState(snapshot, selection) : null),
    [snapshotReady, snapshot, selection],
  );

  // 3D engine lifecycle: one engine per mount; full disposal on unmount or
  // mode change. The engine performs no fetches and no API writes ever.
  // It is also never created without a ready snapshot — an unavailable or
  // loading viewer shows the honest state card instead of a scene.
  useEffect(() => {
    if (effectiveMode !== '3d' || !snapshotReady) return;
    const host = canvasHostRef.current;
    const markerLayer = markerLayerRef.current;
    if (host === null || markerLayer === null) return;

    let engine: MissionViewer3d | null = null;
    try {
      engine = new MissionViewer3d(host, markerLayer, theme, reduced, {
        onSelectAsset: (assetId) => onSelectAsset(assetId),
        onContextLost: () => {
          // Preserve selection: state lives in the host, not the engine.
          setFallbackReason('WebGL context was lost — switched to the 2D view.');
          setEffectiveMode('2d');
        },
        onFrameDebug: (info) => setFrameInfo(info),
      });
      engineRef.current = engine;
      engine.applyState(state!, snapshot!);
      engine.setFraming('overview', false);
      (window as { __MPV_ENGINE?: MissionViewer3d }).__MPV_ENGINE = engine;
    } catch (error) {
      if (error instanceof WebGLUnavailableError) {
        setFallbackReason('WebGL is unavailable in this browser — showing the 2D view.');
        setEffectiveMode('2d');
      } else {
        throw error;
      }
    }
    return () => {
      engine?.dispose();
      engineRef.current = null;
      delete (window as { __MPV_ENGINE?: MissionViewer3d }).__MPV_ENGINE;
    };
    // Rebuild only on mode/theme/snapshot-availability change; per-frame
    // state flows via applyState. (The exhaustive-deps rule is not configured
    // in this repo's eslint set — the narrower dep array is deliberate.)
  }, [effectiveMode, theme, snapshotReady]);

  // Push projected state into the engine without rebuilding it.
  useEffect(() => {
    if (effectiveMode === '3d' && state !== null && snapshot !== null) {
      engineRef.current?.applyState(state, snapshot);
    }
  }, [state, snapshot, effectiveMode]);

  useEffect(() => {
    engineRef.current?.setReducedMotion(reduced);
  }, [reduced]);

  // Framing follows the storyboard: overview → asset focus → event focus.
  useEffect(() => {
    if (effectiveMode !== '3d' || state === null) return;
    if (state.selected !== null) engineRef.current?.setFraming('event');
    else if (selectedAssetId !== null) engineRef.current?.setFraming('asset');
    else engineRef.current?.setFraming('overview');
  }, [state, selectedAssetId, effectiveMode]);

  const requested3d = displayMode !== '2d';
  const show3d = effectiveMode === '3d' && snapshotReady;

  // Honest availability card: the viewer NEVER substitutes demo data — an
  // unavailable physical-view read renders this state instead of a scene.
  if (availability === 'unavailable' || (availability === 'ready' && snapshot === null)) {
    return (
      <section
        className={['mpv', 'mpv--unavailable', className ?? ''].join(' ')}
        data-testid="mission-viewer"
        data-availability="unavailable"
        data-theme-mode={theme}
        aria-label={`Physical mission viewer for mission ${missionId} — currently unavailable`}
      >
        <div className="mpv-unavailable" data-testid="mpv-unavailable">
          <span className="mpv-chip mpv-chip--truth">SIMULATED_OPERATION</span>
          <h4 className="mpv-unavailable__title">Physical evidence read-out unavailable</h4>
          <p className="mpv-unavailable__reason" data-testid="mpv-unavailable-reason">
            {unavailableReason ??
              'The physical-view snapshot for this mission could not be loaded. Showing no scene rather than an unverified one.'}
          </p>
          <p className="mpv-note">
            The viewer renders only admitted, authenticated journal evidence — no demo data is
            substituted while the read is down.
          </p>
          {onRetryLoad !== undefined && (
            <button
              type="button"
              className="mpv-hud__modebtn"
              data-testid="mpv-retry-load"
              onClick={onRetryLoad}
            >
              Retry
            </button>
          )}
        </div>
      </section>
    );
  }
  if (availability === 'loading') {
    return (
      <section
        className={['mpv', 'mpv--loading', className ?? ''].join(' ')}
        data-testid="mission-viewer"
        data-availability="loading"
        data-theme-mode={theme}
        aria-label={`Physical mission viewer for mission ${missionId} — loading evidence`}
      >
        <div className="mpv-unavailable" data-testid="mpv-loading" role="status">
          <span className="mpv-chip mpv-chip--truth">SIMULATED_OPERATION</span>
          <h4 className="mpv-unavailable__title">Loading admitted physical evidence…</h4>
        </div>
      </section>
    );
  }

  // Past the availability gates the snapshot is ready by construction.
  const readySnapshot = snapshot as PhysicalViewSnapshot;
  const readyState = state as SceneState;

  // The evidence items are the same markup in both compositions; the 'below'
  // chrome presents them as a compact collapsible timeline UNDER the stage
  // instead of a fixed aside column beside it.
  const evidenceItems = [...readyState.markers].reverse().map((marker) => {
    const event = readySnapshot.events.find((e) => e.eventId === marker.eventId);
    if (event === undefined) return null;
    return (
      <li key={marker.eventId}>
        <button
          type="button"
          className="mpv-events__item"
          data-event-id={marker.eventId}
          aria-pressed={marker.selected}
          onClick={() => onSelectEvent(marker.selected ? null : marker.eventId)}
        >
          <span className={`mpv-sev mpv-sev--${marker.severity}`} aria-hidden="true" />
          <span className="mpv-events__id">{marker.eventId}</span>
          <span className="mpv-events__meta">
            {marker.assetId} · {event.provenance} · {event.observedAt.slice(11, 19)}Z
          </span>
        </button>
      </li>
    );
  });
  const evidenceTimeline =
    readyState.eventCount === 0 ? (
      // Zero evidence is one honest line — never an empty rail or an empty list.
      <p className="mpv-evidence__empty" data-testid="mpv-evidence-empty">
        No admitted evidence yet — operating status unknown by design. A registered source must
        submit signed events from the field.
      </p>
    ) : hideDisclosure ? (
      // The host (customer Decision Room) already renders the journal list —
      // no duplicate. Counts and selection stay in the strip above.
      false
    ) : (
      <details className="mpv-evidence" open data-testid="mpv-evidence">
        <summary>
          Admitted evidence ({String(readyState.eventCount)}) — select to inspect in the scene
        </summary>
        <div className="mpv-events mpv-evidence__list" aria-label="Admitted evidence timeline">
          <ol className="mpv-events__list">{evidenceItems}</ol>
          <p className="mpv-events__credits">
            3D models: NateGazzard, Alex Safayan (CC-BY 3.0) · scene placement illustrative
          </p>
        </div>
      </details>
    );

  return (
    <section
      className={['mpv', below ? 'mpv--droom' : '', className ?? ''].join(' ')}
      data-testid="mission-viewer"
      data-availability="ready"
      data-phase={readyState.phase}
      data-mode={show3d ? '3d' : '2d'}
      data-theme-mode={theme}
      aria-label={`Physical mission viewer for mission ${missionId} — ${readySnapshot.truthLabel}`}
    >
      <div className="mpv-stage">
        {show3d ? (
          <>
            <div ref={canvasHostRef} className="mpv-canvas-host" data-testid="mpv-canvas" />
            <div ref={markerLayerRef} className="mpv-marker-layer" aria-hidden="false">
              {readyState.markers.map((marker) => (
                <button
                  key={marker.eventId}
                  type="button"
                  ref={(el) => {
                    engineRef.current?.registerMarkerElement(marker.eventId, el);
                  }}
                  className="mpv-marker"
                  data-event-id={marker.eventId}
                  data-selected={marker.selected ? 'true' : 'false'}
                  aria-label={`Evidence ${marker.eventId} on ${marker.assetId} — ${marker.severity}`}
                  title={`${marker.eventId} · ${marker.severity}`}
                  onClick={() => onSelectEvent(marker.selected ? null : marker.eventId)}
                >
                  <span className="mpv-marker__dot" aria-hidden="true" />
                </button>
              ))}
            </div>
          </>
        ) : (
          <Viewer2d
            state={readyState}
            snapshot={readySnapshot}
            selectedEventId={selectedEventId}
            onSelectEvent={onSelectEvent}
            theme={theme}
          />
        )}

        {below ? (
          // Decision Room composition: a tiny non-interactive status pill is
          // the ONLY in-scene UI; the full HUD renders beneath the stage.
          <SceneBadge state={readyState} effectiveMode={show3d ? '3d' : '2d'} />
        ) : (
          <EvidenceHud
            state={readyState}
            snapshot={readySnapshot}
            selected={readyState.selected}
            theme={theme}
            frameInfo={show3d ? frameInfo : null}
            reducedMotion={reduced}
            decisionHref={decisionHref}
            decisionLabel={decisionLabel}
            fallbackReason={fallbackReason}
            requested3d={requested3d}
            onRetry3d={() => {
              setFallbackReason(null);
              setEffectiveMode('3d');
            }}
            onSwitch2d={() => {
              setFallbackReason(null);
              setEffectiveMode('2d');
            }}
            effectiveMode={show3d ? '3d' : '2d'}
            onResetCamera={() => engineRef.current?.resetCamera()}
          />
        )}
      </div>

      {below && (
        <>
          <EvidenceHud
            placement="below"
            state={readyState}
            snapshot={readySnapshot}
            selected={readyState.selected}
            theme={theme}
            frameInfo={show3d ? frameInfo : null}
            reducedMotion={reduced}
            decisionHref={decisionHref}
            decisionLabel={decisionLabel}
            fallbackReason={fallbackReason}
            requested3d={requested3d}
            onRetry3d={() => {
              setFallbackReason(null);
              setEffectiveMode('3d');
            }}
            onSwitch2d={() => {
              setFallbackReason(null);
              setEffectiveMode('2d');
            }}
            effectiveMode={show3d ? '3d' : '2d'}
            onResetCamera={() => engineRef.current?.resetCamera()}
          />
          {evidenceTimeline}
        </>
      )}

      {!below && !hideEventList && (
        <aside className="mpv-events" aria-label="Admitted evidence timeline">
          <h4 className="mpv-events__title">Admitted evidence ({readyState.eventCount})</h4>
          <ol className="mpv-events__list">{evidenceItems}</ol>
          <p className="mpv-events__credits">
            3D models: NateGazzard, Alex Safayan (CC-BY 3.0) · scene placement illustrative
          </p>
        </aside>
      )}

      {/* Non-visual incident description for screen readers (acceptance #34). */}
      <p className="mpv-visually-hidden" role="status" data-testid="mpv-sr-status">
        {srDescription(readyState, readySnapshot)}
      </p>
    </section>
  );
}

function srDescription(state: SceneState, snapshot: PhysicalViewSnapshot): string {
  if (state.phase === 'S0-initial') {
    return `Mission ${snapshot.tenant.missionId}: no physical evidence admitted yet. Operating status unknown by design.`;
  }
  const uav = state.constraints.find((c) => c.assetId === state.policy.uavAssetId);
  const wind = state.aerialWindKt;
  const selectedPart =
    state.selected !== null
      ? ` Selected evidence ${state.selected.event.eventId} from source ${state.selected.event.sourceId}, observed at ${state.selected.event.observedAt}, currently ${state.selected.event.freshnessAtSnapshot}.`
      : '';
  const windPart =
    wind !== null
      ? ` Latest observed aerial wind ${wind} knots against the modeled limit of ${state.policy.uavWindLimitKt} knots.`
      : '';
  const constraintPart =
    uav !== undefined ? ` Aerial asset operational status: ${uav.state} (${uav.reason}).` : '';
  return `Mission ${snapshot.tenant.missionId}: ${state.eventCount} admitted synthetic observations.${windPart}${constraintPart}${selectedPart} All scene placement is illustrative; financial authority is separate.`;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
