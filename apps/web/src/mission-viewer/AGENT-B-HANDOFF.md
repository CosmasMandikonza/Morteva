# Agent B integration handoff — MissionPhysicalViewer (MTV-09/12)

**From Agent C. Agent B owns the Decision Room mount, navigation and app shell — this document is
the complete contract; nothing in your files was changed by me.**

## 1. Import and usage

```tsx
import { MissionPhysicalViewer } from '../mission-viewer/index.js';

// In DecisionRoom, beside the existing decision comparison:
const [selectedEventId, setSelectedEventId] = useState<string | null>(
  journey?.incident?.eventId ?? null, // the demo journey already carries the incident id
);

<MissionPhysicalViewer
  missionId={mission.id}
  snapshot={physicalSnapshot} // see §2 — the ONE missing production dependency
  selectedEventId={selectedEventId}
  onSelectEvent={(id) => setSelectedEventId(id)}
  selectedAssetId={selectedAssetId}
  onSelectAsset={setSelectedAssetId}
  theme={theme} // 'dark' | 'light' — the shell's existing mode
  displayMode="auto" // WebGL → 2D fallback handled internally
  decisionAvailable={journey?.stage === 'incident'}
  decisionHref="#decisions" // anchor to your decision comparison
  decisionLabel="Inspect the financial decision"
/>;
```

Lazy-load to keep three.js out of the main bundle (the harness entry is vite-gated; embedders
should do the same):

```tsx
const { MissionPhysicalViewer } = await import('../mission-viewer/index.js');
```

## 2. The mount in DecisionRoom (shipped — this PR)

The Decision Room now mounts the viewer through the THREE-FREE availability
cards (`availability-cards.tsx`): while Agent A's read endpoint is not
deployed, the product renders `MissionViewerUnavailableCard` with the
precise reason — **no demo fixture is substituted in the product shell** and
no 3D bundle is downloaded for a state with no scene. When the endpoint
ships:

1. Fetch the endpoint JSON in `lib/api.ts` (your file) and pass it through
   `snapshotFromServerPayload(json)` — strict validation, fails closed with
   `PhysicalViewShapeError` (catch → `availability="unavailable"`).
2. Mount `MissionPhysicalViewerLazy` (`lazy.tsx` — dynamic chunk: three.js
   - GLBs load only when a ready snapshot exists). Theme is auto-tracked
     from the shell's `data-theme` via `useDocumentTheme`; an explicit
     `theme` prop still wins.
3. Selection: seed `selectedEventId` from `journey.incident.eventId`;
   reset on mission change. All other props per §3/§6 below (unchanged).

Strict-shape reference: `adapter.ts`; the committed fixtures pass it and
the adversarial suite mutates them (contract version, digests, freshness
ladder, tenant closure…) to prove fail-closed behavior.

The standalone harness (`mission-viewer.html`) remains the reviewer preview
surface for the full 3D scene — clearly labeled PREVIEW, never mounted in
the product while live data is absent.

## 3. Selection callback contract

- `selectedEventId: string | null` — fully controlled by you. `null` = live latest state; an id =
  historical replay (the viewer computes the evidence state AS OF that event; the HUD shows a
  "Historical replay" chip).
- `onSelectEvent(id | null)` fires from scene markers and the built-in evidence list. Toggling the
  selected marker fires `null` (deselect).
- `selectedAssetId` / `onSelectAsset` — canvas raycast (UAV/vessel) sets it; framing follows
  (overview → asset focus → event focus automatically; user can also press "Reset view").
- Unknown/foreign ids are ignored gracefully (no crash, no selection).

## 4. Error / loading / empty handling

| Situation                             | Behavior                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| WebGL unavailable at init             | automatic 2D schematic + status note + "Try 3D again"                        |
| WebGL context lost mid-session        | automatic 2D switch, **selection preserved** (state is yours)                |
| GLB missing/fails to load             | placeholder geometry, `modelFallback` on the debug hook, scene fully usable  |
| Snapshot with zero events             | `S0-initial` phase — "Awaiting admitted evidence — status unknown by design" |
| Stale/expired-only evidence           | `S5-uncertain` — history visible, never current clearance                    |
| Bad `fixture`/deep-link ids (harness) | explicit "Unknown fixture" message / id ignored                              |

## 5. Asset credits component

The built-in evidence aside ends with: _“3D models: NateGazzard, Alex Safayan (CC-BY 3.0) · scene
placement illustrative”_. If you hide the aside (`hideEventList`), surface
`assets/attribution.md` in your own credits row — CC-BY 3.0 requires it.

## 6. Exact embedding instructions

1. Add the import (lazy, above) inside `DecisionRoom.tsx`.
2. Keep a `selectedEventId` state seeded from `journey?.incident?.eventId` when the stage changes;
   reset it when `mission.id` changes (the viewer clears highlights when the snapshot changes, but
   your state must reset too).
3. Place the viewer in the `mv-decision-room` grid ABOVE the `mv-decision-room__comparison` block —
   causality first (scene), consequence second (cards).
4. Pass `decisionAvailable={journey?.stage === 'incident'}` and `decisionHref="#decisions"`.
5. Nothing else: no CSS imports needed beyond the module's own (self-scoped `mpv-*`), no new
   providers, no API calls from the viewer.

## 7. Known limitations (honest)

- **Scene placement is illustrative** — the evidence contract carries no coordinates; poses derive
  from observed `asset_position_status` only (labeled in-HUD and in the harness).
- No continuous flight paths, no weather visualization beyond state, no invented recovery imagery.
- The wind limit is the operator's modeled number (22 kt) — shown as "modeled rule, not a
  measurement".
- Touch-gesture rotation cannot be exercised by synthetic Playwright events (OrbitControls
  requires trusted pointer capture); covered by manual review captures, with `touch-action: none`
  - control config suite-verified.
- Software-GL environments run ~12 fps at 1440×900 (measured); reduced-motion is the intended
  degraded path.
