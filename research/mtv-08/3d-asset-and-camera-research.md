# 3D asset and camera research — MTV-08 (reconnaissance only; NO placeholder scene built)

Scope per issue #10 CTO handoff: **3D reconnaissance only.** The prototype belongs to MTV-09 (#11). Nothing here was downloaded or committed. All asset facts below were verified on the asset's Sketchfab page and/or through Sketchfab's public model API (license, downloadable flag, triangle/vertex counts, animation count) on 2026-11-02/03. Method note: Sketchfab renders pages with JS, so per-model facts were cross-checked via `api.sketchfab.com/v3/models/{uid}`; license IDs via `api.sketchfab.com/v3/licenses` (CC-BY = `322a749bcfa841b29dff1e8a1bb74b0b`, CC-BY-NC = `bbfe3f7dbcdd4122b966b85b9786a989`, CC0 = `7c23a1ba438d4306920229c12afcb5f9`).

**License ground rule:** the hackathon carries cash awards → treat as commercial context → **CC-BY-NC and view-only assets are excluded outright.** Everything shortlisted is CC-BY (commercial use allowed, attribution required) or CC0. Per Sketchfab's download docs, every downloadable model ships original format + auto-converted glTF 2.0 + USDZ, so GLB for three.js is guaranteed.

## 1. First-choice gate (docs/04): drone vs ROV comparison

| Criterion                        | (A) Offshore inspection drone                                            | (B) Underwater ROV/AUV                                                                  |
| -------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Best real asset available        | DJI Matrice 30T / Matrice 300 RTK (real industry inspection platforms)   | MBARI **Doc Ricketts** (official institution model of a real 4000m ROV)                 |
| Realism ceiling                  | Very high (real DJI geometry)                                            | Very high (institutional provenance, manipulator arms, sensor/sensor pods)              |
| Animation potential              | Static rotors on top picks → rig rotors procedurally (4 rotating meshes) | Doc Ricketts ships an animation clip; manipulator arms invite an "intervention" beat    |
| Web perf                         | 200k–904k tris → compression required on the 300 RTK                     | 42k tris (Doc Ricketts) is comfortably web-viable as-is                                 |
| Mission story vs MOTERVA finance | Drone finds damage → planner prices repair options → approval → pay      | ROV intervention/buy-data decision maps 1:1 to Metal "paid diagnostics" award narrative |
| Environment cost                 | Sky/ocean HDRI + water plane (cheaper)                                   | Underwater volumetrics/caustics (heavier, but hideable via depth fog)                   |
| Camera risk                      | Small airframe easy to clip on zoom-in → strict min-distance clamps      | Boxy frame with protruding arms → wider safe orbit radius needed                        |
| Time risk                        | Lower (rotor spin is trivial)                                            | Medium (water shading can rabbit-hole; discipline: fog + gradient, no caustics MVP)     |

**Recommendation (founder decision D3):** primary vertical = **offshore inspection drone** (clearer "mission" arc, cheaper scene, real DJI assets, strongest fit with Journey A), with the **Doc Ricketts ROV as the second typed adapter** story (docs/08 V2 item 14: second physical adapter consuming the same contracts) and as the underwater fallback demo if drone scene time runs short. Both asset directions stay licensed and ready; the choice is which gets built FIRST in #11.

## 2. Verified asset shortlist

### Drone candidates (A) — all Sketchfab, all CC-BY, all downloadable

| Rank   | Asset / author / link                                                                                                                          | Tris/Verts | Anim          | Assessment                                                                                                                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1** | [DJI+ Matrice 30T-XXL](https://sketchfab.com/3d-models/dji-matrice-30t-xxl-a1e1827266964f0eba7529a86b457d0d) · TG13730                         | 200k/106k  | 0             | **Primary pick.** Real DJI compact _enterprise inspection_ platform (the actual product category MOTERVA's first buyer operates). Web-viable triangle budget; rig rotors procedurally. |
| **A2** | [Quadcopter DJI Matrice 300 RTK](https://sketchfab.com/3d-models/quadcopter-dji-matrice-300-rtk-6677d02d66df4b73aad0d8e7bb9e3d9c) · 19vitali99 | 904k/427k  | 0             | Maximum authenticity (the wind-turbine inspection standard), but needs `gltf-transform` decimation + Meshopt/Draco before the web. Keep as cinematic close-up / marketing variant.     |
| **A3** | [Dji Tello](https://sketchfab.com/3d-models/dji-tello-36365bad0ebd46428e6241676725dcec) · Temooor                                              | 66k/34k    | **1 (props)** | Zero-effort motion (propeller clip included) but consumer-grade subject — acceptable fallback, weaker story.                                                                           |
| A4     | [FPV Racing Drone Quadcopter](https://sketchfab.com/3d-models/fpv-racing-drone-quadcopter-fa8b1ca2695e4022a9b4c70401f04b05) · eagleanurag      | 272k/139k  | 1             | Camera-forward look; racing silhouette less "fleet inspection".                                                                                                                        |
| A5     | [Drone Quadrocopter](https://sketchfab.com/3d-models/drone-quadrocopter-5b2ba428c16547a4abc93e96d00a5124) · shivam                             | 33k/17k    | 0             | Generic but clean mechanical build that "holds up under close-up shots" per author.                                                                                                    |
| A6     | [Drone Animated](https://sketchfab.com/3d-models/drone-animated-9d2125a226834767bb0d898263578ad7) · PolytricityLtd                             | 4.5k/2.5k  | 1             | PBR + animated ultra-light; low-end-hardware fallback only.                                                                                                                            |

### ROV candidates (B) — all Sketchfab, all CC-BY, all downloadable

| Rank   | Asset / author / link                                                                                                                                                | Tris/Verts | Anim  | Assessment                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1** | [Doc Ricketts ROV](https://sketchfab.com/3d-models/doc-ricketts-rov-def365ad47894a06b5f0fb2876795bf9) · **MBARI (official)**                                         | 42k/23k    | **1** | **Primary pick.** Official model of a real 4000m-rated electro-hydraulic inspection ROV (1100+ dives). Web-friendly, animated, institutional provenance. |
| **B2** | [ROV Hercules](https://sketchfab.com/3d-models/rov-hercules-b182d28a62854465b6574e7edb743dfc) · EVNautilus (Ocean Exploration Trust)                                 | 382k/188k  | 0     | Flagship realism: two manipulator arms, sensors/samplers, HD camera, LED arrays. Needs compression.                                                      |
| **B3** | [Weaver: Vectored 8-Thruster ROV/AUV](https://sketchfab.com/3d-models/weaver-vectored-8-thruster-rov-auv-a34c315bae734a2eaae97a2029c0a016) · moyshik                 | 103k/52k   | 0     | Purpose-built-for-inspection aesthetic (8 vectored thrusters); mid-weight.                                                                               |
| B4     | [Hydrus Micro AUV](https://sketchfab.com/3d-models/underwater-infrustructure-hydrus-micro-auv-a3fe8fe2e2764a8e9187fe8873d1527d) · Advanced Navigation (manufacturer) | 495k/261k  | 0     | Real commercial micro-AUV + seabed-infrastructure scene; heavy.                                                                                          |
| B5     | [Mini-ROV Guardian](https://sketchfab.com/3d-models/mini-rov-guardian-40b4de5ad9634c1780e97bd2e2767b22) · Harberth                                                   | 129k/65k   | 0     | Generic boxy mini-ROV.                                                                                                                                   |

**Rejected on verification:** Argo ROV (Titanic) — view-only, no license; all CC-BY-NC results; Poly Pizza (stylized low-poly only — e.g. camera-drone CC-BY 3.0 at ~836 tris; no real ROV); Smithsonian 3D (CC0 but no vehicle models — only specimens collected _by_ ROVs); Quaternius/Kenney (CC0 but no drone/ROV packs); CGTrader paid ROVs ($10–$250, Royalty-Free) recorded as pricing context only — a paid purchase is a founder decision, not needed given CC-BY quality above.

### Environment / lighting (all CC0, no attribution required)

- [Poly Haven — Simon's Town Harbour](https://polyhaven.com/a/simons_town_harbour): harbour/ocean/marina HDRI (1K–16K EXR/HDR + backplates) — best marine match for an offshore platform scene.
- [Poly Haven — Secluded Beach](https://polyhaven.com/a/secluded_beach) and [Venice Dawn 1](https://polyhaven.com/a/venice_dawn_1) as alternates.
- **Verified negative:** Poly Haven has no true open-ocean/offshore HDRI. Deep-offshore look = harbour HDRI sky + custom water surface (three.js `Water` addon) and/or depth fog for underwater.

## 3. Rendering, camera, selection, and performance strategy (verified sources)

Pipeline references (from three.js manual / R3F & drei docs — verified during this research):
https://threejs.org/manual/pages/loading-3d-models.html · https://threejs.org/docs/#examples/en/loaders/GLTFLoader · https://r3f.docs.pmnd.rs/advanced/scaling-performance · https://polyhaven.com/license

**Load & compression.** Sketchfab GLB → `GLTFLoader` with `DRACOLoader`/`KTX2Loader`/`MeshoptDecoder` (official, chainable addons). For A2 (904k tris): `gltf-transform` decimate + Meshopt before it ever ships; target ≤150k tris on the hero asset, ≤50k for continuous-visible scene geometry on integrated GPUs.

**Camera (docs/04 acceptance, item by item).**

- `OrbitControls` with `enableDamping`; **`minDistance`/`maxDistance` clamps per framing** so zoom can never enter the hull (no clipping) nor lose the asset (no lost object); `maxPolarAngle` keeps the horizon sane.
- **Camera storyboard mapping** (docs/04 requires overview → object focus → event focus → intervention → return): (1) _Overview_: platform + asset, 35–45° elevation; (2) _Object focus_: eased dolly to drone, min-distance clamped outside its bounding sphere; (3) _Event focus_: camera reframes the damage point (same mission-time source drives 3D + panels); (4) _Intervention_: ROV/repair asset arrives or drone descends; (5) _Return_: scripted ease back to overview. All transitions ≤600ms, eased, and **fully disabled under `prefers-reduced-motion`** (instant cuts instead).
- **Finance-panel overlap rule:** the 3D viewport reserves an inset (CSS grid, not absolute overlay) so the financial inspector never covers the asset; on ≤768px the 3D becomes a fixed-aspect media block above the panels.

**Selection.** Raycast picking on the asset → drei-style outline/highlight + `aria-pressed`-equivalent state mirrored into the 2D evidence rail; keyboard parity via the evidence list itself (selecting an event focuses the 3D object — the list is the accessible path to the scene, per docs/02 "WebGL unavailable → 2D fully usable").

**Lighting.** Poly Haven HDRI via scene environment (IBL) + one directional key with shadow only in _object focus_ framings (shadow maps off in overview on low tier). Underwater variant: depth fog + gradient background instead of full volumetrics (MVP discipline).

**Responsive composition.** `PerformanceMonitor`/`AdaptiveDpr` (drei) scaling DPR 1.0→1.75; dpr floor keeps text-bearing screenshots crisp; canvas `resize` observer with debounce.

**Failure handling (docs/04 + issue #10 adversarial list).**

- `webglcontextlost` → preventDefault, show "3D paused — finances unaffected" inline card, attempt `webglcontextrestored` re-init; if WebGL is unavailable entirely → render the 2D scene card (SVG schematic + map-style asset track) with **all financial function intact** (docs/08 P1 risk: "financial first; 2D-parity").
- Lazy-load the 3D bundle (route-level code split) so first paint of Mission Treasury never waits on three.js.
- Loading UX: percent + stage text from GLTFLoader progress; skeleton 2D card underneath until first frame.

**Determinism.** One mission-time/event source (the evidence journal) drives 3D pose, charts, decision room and replay — no independent animation timelines (docs/04 "single deterministic mission time/event source").

## 4. Attribution obligations if assets are adopted

CC-BY 4.0 §3(a): credit creator, link license, mark modifications — a **credits surface in-app** (About / footer drawer listing model + author + CC-BY link per asset) satisfies this for interactive media per Creative Commons guidance. Poly Haven HDRIs are CC0 (no credit). This credits surface is a hard acceptance item for #11/#14, alongside the per-file license record in the asset manifest docs/04 requires (author, URL, file hash, license, scale/coordinate system, rigging, textures, tris, loading behavior).
