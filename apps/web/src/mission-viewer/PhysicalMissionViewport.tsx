/**
 * PhysicalMissionViewport (MTV-09/12, issue #14 integrated acceptance) —
 * the Decision Room's embeddable wrapper that OWNS the one authenticated
 * physical-view fetch and hands the strict-validated snapshot to the lazy
 * viewer. Kept in the Agent C module so the shell's only responsibility is
 * placement and styling.
 *
 * States (all honest, fail-closed):
 *   loading      — the read is in flight; no scene, no assumptions.
 *   ready        — strict parse succeeded; the live 3D/2D scene renders from
 *                  the admitted journal only.
 *   unavailable  — the read failed (404/401/network/strict-parse deviation):
 *                  the reason is displayed verbatim; NO fixture is ever
 *                  substituted for live data.
 *
 * S0 semantics: Agent A's accepted endpoint FAILS CLOSED (HTTP 409
 * `UAV_POLICY_UNRESOLVABLE`) when the mission has no admitted evidence yet —
 * the honest contract refuses to emit a half-trusted payload. The client
 * maps that code to the viewer's S0-initial state: harbor scene, the known
 * mission asset catalog, ZERO readings, explicitly unknown. No evidence is
 * invented; the policy constants shown are the operator-defined modeled
 * limits already displayed in the Decision Room intro.
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

/**
 * S0-initial snapshot: the KNOWN mission asset with ZERO readings — the
 * honest "no admitted evidence yet" state. Rendered only for the endpoint's
 * fail-closed UAV_POLICY_UNRESOLVABLE 409; never for parse or network
 * failures (those render the unavailable card).
 */
function s0InitialSnapshot(missionId: string): PhysicalViewSnapshot {
  return {
    contractVersion: 1,
    tenant: { orgId: '', missionId },
    asOf: new Date().toISOString(),
    truthLabel: 'SIMULATED_OPERATION — POLICY-ONLY',
    policy: {
      maxAgeMs: 15 * 60_000,
      expiredMs: 30 * 60_000,
      uavAssetId: 'uav-seeker-1',
      uavWindLimitKt: 22,
    },
    assets: [{ assetId: 'uav-seeker-1', kind: 'aerial', label: 'Inspection UAV' }],
    events: [],
  };
}

export function PhysicalMissionViewport(props: {
  missionId: string;
  /** Journey-incident evidence id — seeds the selected event (replay). */
  incidentEventId: string | null;
}): JSX.Element {
  const { missionId, incidentEventId } = props;
  const [state, setState] = useState<ViewportState>({ kind: 'loading' });
  const [selectedEventId, setSelectedEventId] = useState<string | null>(incidentEventId);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  // The journey's incident evidence seeds the replay selection when it is
  // admitted; user selection takes over afterwards.
  useEffect(() => {
    setSelectedEventId(incidentEventId);
  }, [incidentEventId]);

  // One authenticated read per mission/journey change (aborted on change;
  // refetched when the journal grows after a synthetic stage).
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
        if (reason instanceof ApiError && reason.code === 'UAV_POLICY_UNRESOLVABLE') {
          // Fail-closed S0: no admitted evidence yet — the accepted endpoint
          // refuses to emit a half-trusted payload. Render the honest initial
          // scene (explicitly unknown), not an error.
          setState({ kind: 'ready', snapshot: s0InitialSnapshot(missionId) });
          return;
        }
        const message =
          reason instanceof ApiError && reason.code === 'ASSET_DOMAIN_UNAVAILABLE'
            ? 'An admitted asset has no authoritative physical-domain metadata — the scene is withheld rather than fabricated.'
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
      decisionAvailable
      decisionHref="#decisions"
      decisionLabel="Inspect the financial decision below"
    />
  );
}
