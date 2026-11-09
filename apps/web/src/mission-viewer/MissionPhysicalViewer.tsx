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
import { EvidenceHud } from './hud.jsx';
import type { PhysicalViewSnapshot, SceneState } from './contract.js';
import './mission-viewer.css';

export interface MissionPhysicalViewerProps {
  /** Host-owned mission identity (rendered, never fetched). */
  readonly missionId: string;
  /** Authoritative physical-view snapshot v1 for THIS mission. */
  readonly snapshot: PhysicalViewSnapshot;
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
  readonly className?: string;
}

type EffectiveMode = '3d' | '2d';

export function MissionPhysicalViewer(props: MissionPhysicalViewerProps): JSX.Element {
  const {
    missionId,
    snapshot,
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
    className,
  } = props;

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

  // Pure projection — the single source of everything the renderer draws.
  const selection: SceneSelection = useMemo(
    () => ({
      selectedEventId,
      selectedAssetId,
      decisionAvailable,
    }),
    [selectedEventId, selectedAssetId, decisionAvailable],
  );
  const state: SceneState = useMemo(
    () => projectSceneState(snapshot, selection),
    [snapshot, selection],
  );

  // 3D engine lifecycle: one engine per mount; full disposal on unmount or
  // mode change. The engine performs no fetches and no API writes ever.
  useEffect(() => {
    if (effectiveMode !== '3d') return;
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
      engine.applyState(state, snapshot);
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
    // Rebuild only on mode/theme change; per-frame state flows via applyState.
    // (The exhaustive-deps rule is not configured in this repo's eslint set,
    // so no disable comment is needed — the narrower dep array is deliberate.)
  }, [effectiveMode, theme]);

  // Push projected state into the engine without rebuilding it.
  useEffect(() => {
    if (effectiveMode === '3d') engineRef.current?.applyState(state, snapshot);
  }, [state, snapshot, effectiveMode]);

  useEffect(() => {
    engineRef.current?.setReducedMotion(reduced);
  }, [reduced]);

  // Framing follows the storyboard: overview → asset focus → event focus.
  useEffect(() => {
    if (effectiveMode !== '3d') return;
    if (state.selected !== null) engineRef.current?.setFraming('event');
    else if (selectedAssetId !== null) engineRef.current?.setFraming('asset');
    else engineRef.current?.setFraming('overview');
  }, [state, selectedAssetId, effectiveMode]);

  const requested3d = displayMode !== '2d';
  const show3d = effectiveMode === '3d';

  return (
    <section
      className={['mpv', className ?? ''].join(' ')}
      data-testid="mission-viewer"
      data-phase={state.phase}
      data-mode={show3d ? '3d' : '2d'}
      data-theme-mode={theme}
      aria-label={`Physical mission viewer for mission ${missionId} — ${snapshot.truthLabel}`}
    >
      <div className="mpv-stage">
        {show3d ? (
          <>
            <div ref={canvasHostRef} className="mpv-canvas-host" data-testid="mpv-canvas" />
            <div ref={markerLayerRef} className="mpv-marker-layer" aria-hidden="false">
              {state.markers.map((marker) => (
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
            state={state}
            snapshot={snapshot}
            selectedEventId={selectedEventId}
            onSelectEvent={onSelectEvent}
            theme={theme}
          />
        )}

        <EvidenceHud
          state={state}
          snapshot={snapshot}
          selected={state.selected}
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
      </div>

      {!hideEventList && (
        <aside className="mpv-events" aria-label="Admitted evidence timeline">
          <h4 className="mpv-events__title">Admitted evidence ({state.eventCount})</h4>
          <ol className="mpv-events__list">
            {[...state.markers].reverse().map((marker) => {
              const event = snapshot.events.find((e) => e.eventId === marker.eventId);
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
            })}
          </ol>
          <p className="mpv-events__credits">
            3D models: NateGazzard, Alex Safayan (CC-BY 3.0) · scene placement illustrative
          </p>
        </aside>
      )}

      {/* Non-visual incident description for screen readers (acceptance #34). */}
      <p className="mpv-visually-hidden" role="status" data-testid="mpv-sr-status">
        {srDescription(state, snapshot)}
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
