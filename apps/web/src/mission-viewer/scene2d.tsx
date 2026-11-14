/**
 * 2D fallback — semantic SVG schematic sharing the SAME SceneState projection
 * and the SAME selection callbacks as the 3D view (acceptance #7/#15/#16).
 * Top-down harbor: quay band, moored vessel, UAV glyph per illustrative pose.
 * Every marker is a real <button> — keyboard reachable, screen-reader labeled.
 */
import type { JSX } from 'react';
import type { PhysicalViewSnapshot, SceneState } from './contract.js';

/** Mirrors the 3D LAYOUT (illustrative meters) → 2D viewBox mapping. */
const WORLD = { minX: -110, maxX: 110, minZ: -70, maxZ: 70 };
const VIEW = { w: 1100, h: 700 };

function x(v: number): number {
  return ((v - WORLD.minX) / (WORLD.maxX - WORLD.minX)) * VIEW.w;
}
function y(v: number): number {
  return ((v - WORLD.minZ) / (WORLD.maxZ - WORLD.minZ)) * VIEW.h;
}

const UAV_POSES_2D: Record<string, { x: number; z: number }> = {
  on_station: { x: 26, z: -4 },
  transit: { x: -48, z: 16 },
  returning: { x: -22, z: 6 },
  docked: { x: -34, z: -32 },
  off_station: { x: 58, z: 34 },
  unknown: { x: 12, z: 10 },
};

export function Viewer2d(props: {
  state: SceneState;
  snapshot: PhysicalViewSnapshot;
  selectedEventId: string | null;
  onSelectEvent: (eventId: string | null) => void;
  theme: 'dark' | 'light';
}): JSX.Element {
  const { state, snapshot, selectedEventId, onSelectEvent, theme } = props;
  const uavPose = state.poses.find((p) => p.assetId === state.policy.uavAssetId);
  const uav = UAV_POSES_2D[uavPose?.pose ?? 'unknown'] ?? UAV_POSES_2D.unknown!;

  return (
    <div className="mpv-2d" data-testid="mpv-2d">
      <svg
        viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
        role="img"
        aria-label={`2D harbor schematic for mission ${snapshot.tenant.missionId}. Illustrative placement; marker positions derive from admitted evidence identity.`}
        data-testid="mpv-2d-svg"
      >
        {/* water */}
        <rect
          x={0}
          y={0}
          width={VIEW.w}
          height={VIEW.h}
          className={`mpv-2d__sea mpv-2d__sea--${theme}`}
        />
        {/* quay band */}
        <rect
          x={x(WORLD.minX)}
          y={y(-70)}
          width={x(WORLD.maxX) - x(WORLD.minX)}
          height={y(-46) - y(-70)}
          className={`mpv-2d__quay mpv-2d__quay--${theme}`}
        />
        <text x={x(-104)} y={y(-58)} className={`mpv-2d__label mpv-2d__label--${theme}`}>
          QUAY · OPS
        </text>
        {/* moored vessel (length along X at berth) */}
        <rect
          x={x(-47)}
          y={y(-24)}
          width={x(47) - x(-47)}
          height={y(-4) - y(-24)}
          rx={14}
          className={`mpv-2d__vessel mpv-2d__vessel--${theme}`}
          data-testid="mpv-2d-vessel"
        />
        <text x={x(-40)} y={y(-10)} className={`mpv-2d__label mpv-2d__label--${theme}`}>
          MOORED VESSEL
        </text>
        {/* dock pad */}
        <rect
          x={x(-37)}
          y={y(-35)}
          width={x(-31) - x(-37)}
          height={y(-29) - y(-35)}
          className={`mpv-2d__pad mpv-2d__pad--${theme}`}
        />
        {/* UAV glyph */}
        <g data-testid="mpv-2d-uav">
          <circle
            cx={x(uav.x)}
            cy={y(uav.z)}
            r={10}
            className={`mpv-2d__uav mpv-2d__uav--${theme}`}
          />
          <text
            x={x(uav.x) + 16}
            y={y(uav.z) - 6}
            className={`mpv-2d__label mpv-2d__label--${theme}`}
          >
            INSPECTION UAV · {uavPose?.pose ?? 'unknown'}
          </text>
        </g>
      </svg>

      {/* markers as real buttons over the schematic */}
      <div className="mpv-2d__markers">
        {state.markers.map((marker) => {
          const anchor =
            marker.assetId === state.policy.uavAssetId
              ? uav
              : { x: 18 + ((marker.journalSeq * 7) % 40), z: -14 };
          return (
            <button
              key={marker.eventId}
              type="button"
              className="mpv-marker"
              style={{
                left: `${(x(anchor.x) / VIEW.w) * 100}%`,
                top: `${(y(anchor.z) / VIEW.h) * 100}%`,
              }}
              data-event-id={marker.eventId}
              data-selected={marker.selected ? 'true' : 'false'}
              data-severity={marker.severity}
              aria-label={`Evidence ${marker.eventId} on ${marker.assetId} — ${marker.severity}`}
              onClick={() => onSelectEvent(marker.selected ? null : marker.eventId)}
            >
              <span className="mpv-marker__dot" aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <p className="mpv-2d__selected" data-testid="mpv-2d-selected">
        {selectedEventId === null
          ? 'No evidence selected — select a marker or timeline entry.'
          : `Selected evidence: ${selectedEventId}`}
      </p>
    </div>
  );
}
