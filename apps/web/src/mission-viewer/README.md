# Mission physical viewer (MTV-09/12 — Agent C lane)

Production 3D/2D physical mission viewport for the MOTERVA Decision Room. Renders the
**physical-view contract v1** snapshot (see `contract/physical-view.v1.md`) with evidence
synchronization: every marker, pose and constraint derives from admitted journal events via the
pure projection in `scene-state.ts`.

**TRUTH LAW:** observed readings, inferred constraints, illustrative placement, financial
evaluation, human authority and provider outcomes are six separate truths. The viewer renders the
first three and LINKS to the fourth; it never evaluates money, never writes, never fetches.

## Layout

| Path                                      | Role                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract.ts`                             | Physical-view snapshot v1 types (viewer-owned; the web bundle never imports server code)                                                      |
| `scene-state.ts`                          | Pure deterministic projection: snapshot + selection → SceneState (S0–S5, constraints, poses, markers, replay)                                 |
| `viewer3d.ts`                             | Vanilla three.js engine: procedural harbor, licensed GLB assets, camera storyboard with clamps, DOM-projected markers, full resource disposal |
| `MissionPhysicalViewer.tsx`               | The React component (controlled selection, WebGL→2D fallback, context-loss handling)                                                          |
| `hud.tsx` / `scene2d.tsx`                 | Shared HUD + semantic SVG 2D fallback (same state, same callbacks)                                                                            |
| `mission-viewer.css`                      | Scoped `mpv-*` styles on the B-led `--mv-*` tokens                                                                                            |
| `assets/`                                 | Licensed GLBs + `attribution.md` (CC-BY 3.0; hashes in `research/mtv-09/asset-manifest.md`)                                                   |
| `fixtures/`                               | Journal-derived snapshots (real ingest replay output) + registry                                                                              |
| `harness/`                                | Standalone preview page wiring (`?fixture&event&theme&mode&webgl&reducedMotion&asset`)                                                        |
| `AGENT-B-HANDOFF.md`                      | Integration contract for the Decision Room owner                                                                                              |
| `contract/planner-endpoint-request.v1.md` | Formal read-endpoint request to Agent A                                                                                                       |

## Running the standalone harness

```bash
VITE_MISSION_VIEWER=1 npm run build -w @moterva/web
npm run preview -w @moterva/web          # → http://127.0.0.1:4173/mission-viewer.html
```

The default production build **excludes** the harness and never bundles three.js (same isolation
discipline as the design lab; byte-identical main entry).

## Tests

- `e2e/mission-viewer.spec.ts` — 35-case adversarial matrix (physical truth, rendering, product)
- `e2e/mission-viewer-capture.spec.ts` — viewport/state captures + measured performance →
  `research/mtv-09/captures/`
- Both self-skip unless the gated build is present.

Regenerate fixtures: `npx tsx apps/api/src/mission-events/fixtures/generate-viewer-fixture.ts`
(real ingest pipeline; nothing hand-invented).
