/**
 * Mission physical viewer — public surface (MTV-09/12, issue #11/#14).
 *
 * OWNERSHIP: Agent C. The host (Decision Room / harness) owns mission data
 * and selection; this module renders. No financial state, no fetches, no
 * journal writes. Three.js never enters the main app bundle (the harness
 * entry is vite-gated; embedders lazy-load via import()).
 */
export { MissionPhysicalViewer } from './MissionPhysicalViewer.jsx';
export type { MissionPhysicalViewerProps } from './MissionPhysicalViewer.jsx';
export { projectSceneState, framingFor } from './scene-state.js';
export type { SceneSelection } from './scene-state.js';
export { WebGLUnavailableError } from './viewer3d.js';
export type {
  PhysicalViewSnapshot,
  PhysicalViewEvent,
  PhysicalViewAsset,
  PhysicalViewObservation,
  PhysicalViewPolicy,
  PhysicalConstraintView,
  SceneState,
  ScenePhase,
  EventMarkerView,
  SelectedEventView,
  AssetPose,
  PoseName,
  PhysicalProvenance,
  PhysicalFreshness,
  PhysicalAssetKind,
} from './contract.js';
