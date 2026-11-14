/**
 * Lazy viewer mount (MTV-09/12, C2) — the DECISION-ROOM ENTRY for the live
 * state. React.lazy splits three.js + the GLB assets into a separate chunk
 * that loads only when a ready snapshot actually exists, so the shell never
 * pays the 3D cost for the honest unavailable state.
 *
 * Host usage when Agent A's read endpoint ships:
 *
 *   const snapshot = snapshotFromServerPayload(apiJson); // strict, fail-closed
 *   <MissionPhysicalViewerLazy
 *     missionId={mission.id}
 *     snapshot={snapshot}
 *     availability="ready"
 *     …selection props per AGENT-B-HANDOFF.md…
 *   />
 */
import { lazy, Suspense } from 'react';
import type { JSX } from 'react';
import { MissionViewerLoadingCard, useDocumentTheme } from './availability-cards.js';
import type { MissionPhysicalViewerProps } from './MissionPhysicalViewer.js';

const Viewer = lazy(() =>
  import('./MissionPhysicalViewer.js').then((m) => ({ default: m.MissionPhysicalViewer })),
);

export function MissionPhysicalViewerLazy(
  props: Omit<MissionPhysicalViewerProps, 'theme'> & { theme?: 'dark' | 'light' },
): JSX.Element {
  // Theme defaults to the shell's live mode; an explicit prop still wins.
  const documentTheme = useDocumentTheme();
  const theme = props.theme ?? documentTheme;
  return (
    <Suspense fallback={<MissionViewerLoadingCard className={props.className} />}>
      <Viewer {...props} theme={theme} />
    </Suspense>
  );
}
