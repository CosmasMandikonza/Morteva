# MTV-09/12 asset gate — verification record and decision (issue #11)

**Date:** 2026-11-08 · **Verifier:** Agent C · **Method:** live catalog scraping of per-model
license fields, direct CDN download, SHA-256 hashing, binary glTF inspection
(`glb-inspect.mjs`), and visual review of the official poster renders (all candidates' posters
committed beside this record). No manufacturer partnership is implied by any choice.

## Decision

| Slot                         | Asset                                                                        | License            | Why                                                                                                                                                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Aerial inspection UAV**    | **"Drone" by NateGazzard** (`inspection-uav.glb`)                            | CC-BY 3.0          | Only visually credible enterprise-style quadcopter with verifiable license; separate rotor meshes enable real rotor idle (no fake trajectories); 4.5k tris; camera gimbal + landing gear; proportions ≈ 0.58 × 0.21 × 0.78 model units → scaled to a ~1.1 m inspection UAV |
| **Moored inspection target** | **"Container Ship" by Alex Safayan** (`moored-vessel.glb`)                   | CC-BY 3.0          | Modern coastal cargo vessel matching the actual harbor mission; 1.6k tris; 94 primitives / 9 materials, no textures                                                                                                                                                        |
| **Harbor environment**       | **Procedural geometry (original code)**                                      | none needed (ours) | Quay, bollards, fenders, ops cabin, crane silhouette — full art control, zero additional license surface; avoids the toy-scale "port" models available                                                                                                                     |
| Attribution                  | `apps/web/src/mission-viewer/assets/attribution.md` + in-viewer credits chip | —                  | CC-BY 3.0 requires attribution for redistribution; public repo = redistribution; conditions recorded                                                                                                                                                                       |

## Rejected candidates (with reasons)

| Candidate                                         | License                   | Reason for rejection                                                                                                                                 |
| ------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| DJI Matrice 30T (prior research shortlist)        | unclear/unverified        | Trademark/brand implication risk explicitly rejected by docs/04 and the brief; provenance never verified                                             |
| MBARI Doc Ricketts ROV (prior research shortlist) | listed CC-BY on Sketchfab | Download requires authenticated Sketchfab access — hash/format could not be verified anonymously; underwater domain, not the flagship harbor mission |
| "camera drone" — Christopher Burgess              | CC-BY 3.0                 | It is a static camera prop, not a UAV                                                                                                                |
| "Little Drone" — Nick Olson                       | CC-BY 3.0                 | Toy-like rounded quad; fails "industrial realism" bar                                                                                                |
| "Drone core" — Poly by Google                     | CC-BY 3.0                 | Abstract primitive assembly; not recognizable inspection equipment                                                                                   |
| "Ship" — Kenney                                   | **CC0 1.0**               | Sailing galleon — wrong domain entirely                                                                                                              |
| "Ship" — Quaternius                               | **CC0 1.0**               | Pirate ship — wrong domain                                                                                                                           |
| "Shipping Port" — Quaternius                      | **CC0 1.0**               | Wooden pirate dock — wrong mood/scale for an industrial harbor                                                                                       |

No CC0 quadcopter exists in the poly.pizza indexed catalog (checked Kenney, Quaternius creator
catalogs and license-filtered searches). The brief permits CC-BY when "Exact license and
commercial-use conditions… Attribution requirements" are recorded: CC-BY 3.0 authorizes commercial
use and redistribution **with attribution**, which this repository satisfies via the attribution
file and an in-viewer credits line. No CC-BY-NC, view-only or unverifiable asset was used.

### Full SHA-256 of every downloaded candidate (re-downloadable from the recorded URLs)

| Candidate                              | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| kenney-ship.glb                        | `eb6560f8e62ad4d7f382fcad47894bec7c09c5ef6e0a1db6855eb971e5aff609` |
| quaternius-ship.glb                    | `b3cfa69180926216867e1060f442c6de8db405d60edd777ad658e1a162f5ae67` |
| quaternius-port.glb                    | `47ec6781831808cf6593048514064832711ed71e25d1af316e1ae5c010720b8e` |
| storage-ship.glb (Alex Safayan, CC-BY) | `c6209a3fb71222218b6580257c9b63d0c22e012dd854ac64f4d7a6161341d7f8` |
| nategazzard-drone.glb (**adopted**)    | `bc9f0d765e0fdb838a9baf26b472f955a11bb2509a3337e918054241b134638d` |
| little-drone.glb                       | `7de8285cd839ddb28475e4ceb4c0e58ad5ce82b5f08f5883a6e5484b23ed8567` |
| camera-drone.glb                       | `4ad6bf3b6b688f24621571f758defc67bf110029b484f34693d19e83c5c2e7b2` |
| drone-core.glb                         | `34658baf0c3ffc29fe9994ba31a45dc501dbab3777a1112f6a5215cae6f9d785` |
| container-ship.glb (**adopted**)       | `a6f5e74082c8dfe8d251b7d70af5c2bd8570d108b3ca2a97c3d55f38871fcb4b` |

Rejected-candidate binaries are not committed (posters + hashes above are the evidence; the CDN
URLs allow independent re-download and hash verification). The adopted UAV hash was verified
reproducible across two independent downloads.

## Machine verification (chosen assets)

| Field                               | inspection-uav.glb                                                              | moored-vessel.glb                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Source page                         | https://poly.pizza/m/DNbUoMtG3H                                                 | https://poly.pizza/m/3AmDGcCu6Ll                                   |
| Author                              | NateGazzard                                                                     | Alex Safayan                                                       |
| License (page field `Licence`)      | `CC-BY 3.0`                                                                     | `CC-BY 3.0`                                                        |
| License text                        | Creative Commons Attribution 3.0 — https://creativecommons.org/licenses/by/3.0/ | same                                                               |
| Commercial use / redistribution     | permitted with attribution                                                      | permitted with attribution                                         |
| CDN file                            | https://static.poly.pizza/4eb88feb-cb2d-46c3-980d-3e704868361c.glb              | https://static.poly.pizza/df197d9f-5d8c-4744-bc03-75ee514e8df3.glb |
| SHA-256                             | `bc9f0d765e0fdb838a9baf26b472f955a11bb2509a3337e918054241b134638d`              | `a6f5e74082c8dfe8d251b7d70af5c2bd8570d108b3ca2a97c3d55f38871fcb4b` |
| Size                                | 259,676 bytes                                                                   | 203,056 bytes                                                      |
| Generator                           | obj2gltf                                                                        | obj2gltf                                                           |
| Triangles / vertices                | 4,564 / 6,956                                                                   | 1,620 / 3,198                                                      |
| Meshes / primitives / materials     | 6 / 6 / 1 (+ embedded PNG palette texture)                                      | 88 / 94 / 9 (no textures)                                          |
| Named parts                         | Body, Rotor_FL, Rotor_FR, Rotor_BL, Rotor_BR, mount                             | hull, deck, superstructure, containers (88 nodes)                  |
| Animations                          | none (rotor spin implemented by us as idle state, not recorded motion)          | none                                                               |
| Dimensions (accessor bounds, x×y×z) | 0.574 × 0.208 × 0.781                                                           | 0.21 × 0.381 × 0.975                                               |
| Orientation                         | Y-up, length on −Z/+Z, verified at runtime                                      | Y-up, length on Z (scaled ~×97 → ≈95 m coastal vessel)             |
| Compression                         | none (no draco/meshopt) — loads via standard GLTFLoader                         | none                                                               |

Measured loading/rendering characteristics are recorded in `performance.md` (Phase 3), measured on
the running scene — not estimated.

## Verification commands

```bash
node scripts/mtv-09-glb-inspect.mjs apps/web/src/mission-viewer/assets/*.glb
sha256sum apps/web/src/mission-viewer/assets/*.glb   # must match the table above
```
