/**
 * PhysicalMissionViewport (MTV-09/12, issue #14 integrated acceptance) —
 * the Decision Room's embeddable wrapper that OWNS the one authenticated
 * physical-view fetch and hands the strict-validated snapshot to the lazy
 * viewer. Kept in the Agent C module so the shell's only responsibility is
 * placement and styling.
 *
 * Truth laws (CTO final review, P0-A / P1-C):
 *  - ONLY a real, strict-parseable server payload (HTTP 200) may render a
 *    ready scene — including S0: the accepted endpoint now returns a
 *    server-authoritative EMPTY-EVIDENCE snapshot (real tenant, real asOf,
 *    real policy, known catalog asset, zero events) when nothing has been
 *    admitted yet. There is NO client-side snapshot fabrication: 409/404/
 *    401/network/parse failures render the honest unavailable card.
 *  - `decisionVerified` is a HOST prop derived from actual verified financial
 *    decision evidence (a recorded incident evaluation), default false. The
 *    viewer never decides this itself; a wind event alone never upgrades
 *    S2 to S3.
 *
 * Selection: `incidentEventId` (from the host's journey) seeds the selected
 * evidence; user selection inside the viewer is local to this component and
 * never triggers backend mutations.
 */
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { ApiError, fetchPhysicalView } from '../lib/api.js';
import { MissionViewerLoadingCard, MissionViewerUnavailableCard } from './availability-cards.js';
import { MissionPhysicalViewerLazy } from './lazy.js';
import { snapshotFromServerPayload, PhysicalViewShapeError } from './adapter.js';
import type { PhysicalViewSnapshot } from './contract.js';

type ViewportState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly snapshot: PhysicalViewSnapshot }
  | { readonly kind: 'unavailable'; readonly reason: string };

export function PhysicalMissionViewport(props: {
  missionId: string;
  /** Journey-incident evidence id — seeds the selected event (replay). */
  incidentEventId: string | null;
  /**
   * Host-declared, default false: TRUE only when a verified financial
   * decision/evaluation exists for the current incident (e.g. a recorded
   * incident snapshot from an authenticated read). S3 and the decision link
   * are shown only then; a physical restriction alone stays S2.
   */
  decisionVerified?: boolean;
  /**
   * Chrome composition passed through to the viewer ('below' = the Decision
   * Room composition: unobstructed scene, HUD beneath, evidence timeline).
   */
  chrome?: 'overlay' | 'below';
  /** chrome='below' only: omit the evidence disclosure (host renders its own list). */
  hideDisclosure?: boolean;
}): JSX.Element {
  const { missionId, incidentEventId, decisionVerified = false, chrome, hideDisclosure } = props;
  const [state, setState] = useState<ViewportState>({ kind: 'loading' });
  const [selectedEventId, setSelectedEventId] = useState<string | null>(incidentEventId);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  // The journey's incident evidence seeds the replay selection when it is
  // admitted; user selection takes over afterwards.
  useEffect(() => {
    setSelectedEventId(incidentEventId);
  }, [incidentEventId]);

  // One authenticated read per mission/journey change (aborted on change;
  // refetched when the journal grows after a synthetic stage). EVERY ready
  // render — including S0 — comes from a strict-parsed server payload.
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    fetchPhysicalView(missionId, controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        try {
          setState({ kind: 'ready', snapshot: snapshotFromServerPayload(payload) });
        } catch (error) {
          setState({
            kind: 'unavailable',
            reason:
              error instanceof PhysicalViewShapeError
                ? `The physical-view response did not match the agreed contract and was refused: ${error.message}`
                : 'The physical-view response could not be validated.',
          });
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const message =
          reason instanceof ApiError && reason.code === 'ASSET_DOMAIN_UNAVAILABLE'
            ? 'An admitted asset has no authoritative physical-domain metadata — the scene is withheld rather than fabricated.'
            : reason instanceof ApiError && reason.code === 'UAV_POLICY_UNRESOLVABLE'
              ? 'The mission has admitted assets but not exactly one aerial asset — the scene is withheld rather than fabricated.'
              : reason instanceof Error && reason.message.startsWith('API responded')
                ? `The physical-view read failed (${reason.message}).`
                : 'The physical-view read is unavailable — showing no scene rather than an unverified one.';
        setState({ kind: 'unavailable', reason: message });
      });
    return () => controller.abort();
  }, [missionId]);

  if (state.kind === 'loading') {
    return <MissionViewerLoadingCard />;
  }
  if (state.kind === 'unavailable') {
    return <MissionViewerUnavailableCard reason={state.reason} />;
  }

  return (
    <MissionPhysicalViewerLazy
      missionId={missionId}
      snapshot={state.snapshot}
      availability="ready"
      selectedEventId={selectedEventId}
      onSelectEvent={setSelectedEventId}
      selectedAssetId={selectedAssetId}
      onSelectAsset={setSelectedAssetId}
      decisionAvailable={decisionVerified}
      decisionHref="#decisions"
      decisionLabel="Inspect the financial decision below"
      chrome={chrome}
      hideDisclosure={hideDisclosure}
    />
  );
}
