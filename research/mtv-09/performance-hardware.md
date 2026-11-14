# MTV-09/12 measured performance on REAL hardware GPU (C3)

Complements `performance.md` (SwiftShader / CI-class) with measurements from the
actual development hardware: **Intel integrated graphics via ANGLE/Direct3D11**
(`ANGLE (Intel, Intel(R) Graphics (0x00007D45) Direct3D11 vs_5_0 ps_5_0, D3D11)`),
Chromium 1440×900 @1x, ZCode in-app browser pane, Windows, Node 24.

## Frame cost (event-focus framing, forced single-frame renders ×120)

| Metric              | Measured                                                |
| ------------------- | ------------------------------------------------------- |
| Median frame render | **3 ms** (≈330 fps ceiling before compositing)          |
| p95                 | 13.7 ms (shader/texture state transitions, GC)          |
| Max                 | 160 ms (first-frame shader compilation — one-time cost) |
| Triangles / frame   | 6,136                                                   |
| Draw calls / frame  | 91                                                      |

→ On real hardware the scene is comfortably within 60 fps; the earlier "12 fps"
figure is a **SwiftShader (CPU rasterizer)** property and must not be read as
product graphics performance.

## Demand-based rendering (C3) — measured behavior

- **Hidden tab:** zero frames rendered (rAF budget returned to the page);
  resuming renders on the next `needsRender` trigger.
- **Reduced motion + settled camera:** frames are rendered only when something
  changes (control input, state push, transition) — an idle evidence view costs
  zero GPU work. Verified: camera/pose frozen across samples.
- **Adaptive resolution:** sustained <20 fps steps the pixel ratio down to a
  0.75× floor; ≥55 fps steps back up. Geometry fidelity is never reduced.
- **Occlusion caveat (honest):** when the browser window is fully occluded,
  Chromium throttles rAF to zero without flipping `document.hidden`; markers
  (DOM) keep rendering while the canvas waits. Foregrounding resumes at the
  next trigger. Captured during measurement; not a product defect.

## Defect found and fixed during hardware measurement

The async GLB attach callbacks did not set the demand-render latch — on a
gated/static view the freshly loaded models would never paint. Fixed
(`needsRender = true` on all four attach paths: UAV/vessel load + fallbacks);
the hardware capture above is post-fix, showing both models + strobe.

## Record

Hardware screenshot: `captures/hardware-intel-igpu-event-focus-1440x900.png`
(event focus: vessel hull + hovering UAV with strobe + projected evidence
markers). SwiftShader record: `captures/performance.json`.
