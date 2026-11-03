# Research record — MTV-08

Method, sources, dates, and verification level for everything in this package. Recorded per AGENTS.md ("Record exact outputs… never fabricate") and issue #10's working agreement.

## Environments and dates

- Research performed 2026-11-02 → 2026-11-03 (UTC) from a live desktop browser session plus targeted fetches.
- Product context sources read first, in full, from latest `main` (`06afbca`): `AGENTS.md`, `README.md`, `docs/STATE.md`, `docs/00` through `docs/09`, `docs/adr/0001-stack-and-runtime.md`, the existing `apps/web` shell (`App.tsx`, `styles.css`, `nav.ts`), and issue #10 including the CTO handoff comment.
- Every external claim below was observed on the live page at the recorded URL at research time. Where a page could not be observed, that is stated.

## Source-by-source verification

### 1. Cult UI — https://www.cult-ui.com/docs/components (verified live)

- Full component taxonomy browsed from the docs sidebar (component names below were all visible links on the site; nothing is invented).
- GitHub: https://github.com/nolly-studio/cult-ui — **MIT license** (© Nolly Studio), ~6.8k stars. Distribution: shadcn CLI copy-in (`npx shadcn@latest add @cult-ui/...`), i.e. source lands in our repo and we own it — MIT notice retention applies.
- Stack: React + shadcn/ui conventions, Tailwind (v4), Motion (framer-motion successor) for most animated parts, Base UI primitives for tabs/segmented/toggle-group.
- Component pages read in detail: `dynamic-island` (full API), `halo-tabs`, `side-panel`, `onboarding`, `rolling-number`, `analytics-chart`, `halo-segmented`, `halo-badge`.
- Catalog families observed: AI (Prompt Composer, Halo Search, Halo Dropzone…), App & Workspace (Analytics Chart, Kanban Board, Timer, Collab Avatar/Toolbar…), Form Controls (Halo Input/Field/Select/Switch/Segmented/Toggle Group, Border Beam Input, Color Picker), Feedback & Status (Halo Badge/Progress/Toast/Notification, Dynamic Island), Navigation & Overlays (Halo Tabs, Direction Aware Tabs, Popover, Popover Form, Floating Panel, Family Drawer, Side Panel, Morph Surface, Expandable Screen), Onboarding & Flows (Onboarding, Intro Disclosure, Wizard Expandable…), Buttons, Cards (Minimal, Halo, Shadow, Folded, Shift, Cutout, Texture, Border Beam, Expandable), Landing heroes, Illustrations, Media & Mockups, Backgrounds & Effects, Typography (Text Animate, Typewriter, **Rolling Number**…).
- A11y observed: Halo Badge documents reduced-motion handling and tabular figures. Halo Tabs/Halo Segmented inherit Base UI semantics (roving tabindex, arrow keys) — **inherited, not re-verified in source**; flagged as an implementation-time audit item.

### 2. React Bits — https://www.reactbits.dev/get-started/index (verified live)

- GitHub: https://github.com/DavidHDev/react-bits — 51.1k stars; license read from the repo's LICENSE file: **MIT + Commons Clause** (© 2026 David Haz). Free for personal and commercial use **within an application**; the Clause only forbids selling/sublicensing/redistributing the components themselves (alone, bundled, ported, or as a hosted service) and selling tool exports as packs. Using components inside MOTERVA (including a prize-bearing hackathon) is permitted; the license text must be preserved. Flagged in the ledger as "permissive for our use, not pure MIT" so nobody re-exports the components.
- 217 free components, categories: Text Animations (33), Animations (38), Components (48), Micro (34), Backgrounds (63); plus paid Pro tier (230 components/300 blocks — NOT used; one-time purchase, out of scope unless founder buys).
- Distribution: copy-in source via `npx shadcn@latest add @react-bits/...` or jsrepo; each component ships JS/TS × CSS/Tailwind flavors. Per-component dependencies are listed per page (Animated List: Motion; Model Viewer: three.js stack; etc.).
- Component pages read in detail: `animated-list` (full props; listbox semantics; arrow-key select; Desktop/Tablet 768/Mobile 375 preview sizes), `model-viewer` (glb/gltf/fbx/obj; environment presets; fit/offset/tilt/shadow controls; 29 props; demo models are Khronos glTF sample assets CC BY 4.0), `counter` (odometer digits, currency/separators/locales).
- Docs preview panel exposes per-component size testing (Desktop / Tablet 768px / Mobile 375px) — useful during founder review.

### 3. Skiper UI — https://www.skiper-ui.com/components (verified live)

- Full catalog browsed: ~107 components in 14 collections (New Releases, Out of the box, Minimal interactions, Crazy Hover, Preloaders, Crazy Hero, OG NavBars, Scroll Effects, Web3 Unlocked, Rauno, Vercel Unlocked, Carousals, Development tools, Video Players, AI Input).
- Licensing (from https://www.skiper-ui.com/docs/quick-start and /pricing): free components usable in personal **and commercial** projects but **attribution required**; Skiper Pro ($129 one-time) unlocks premium components and removes attribution; Pro installs use a `SKIPER_LICENSE_KEY`. Stack: React + Tailwind + framer-motion + GSAP + lucide-react via shadcn registry.
- **Provenance red flag, observed directly:** a large share of the catalog is named after and recreates third-party brand designs — "Nike preloader", "Nike menu", "Apple Navbar V001/V002", "Apple carousel", "Apple play button", "Apple Feature Block", "Vercel navigation bar", "Vercel Tooltip", "Vercel Liquid simulation", "UniSwap Country Dialog", "Aave token swap", "Tik tik color list", "Dia Browser's Carousal". The author states components are recreations and credits creators "where possible". AGENTS.md forbids copying proprietary designs/logos without rights; docs/03 allows Skiper only "after its precise license and DOM behavior are inspected". Our ledger therefore recommends **rejecting Skiper for the core system** and (at most) one audited free utility component with attribution — founder decision, not silently decided.
- Also noted: the catalog is marketing/landing-page-centric (heroes, preloaders, hover effects, navbars, carousals). It has no financial-console primitives (no data tables, no reserve/commitment surfaces).

### 4. Awwwards — https://www.awwwards.com/ (verified live; art-direction study only)

- Category used: https://www.awwwards.com/websites/fintech/ (public category page; links verified).
- Specific awarded references recorded with dates/levels and live URLs:
  - **VELTO — Fintech App Concept** (Nominee, Oct 30, 2026; New Minds Studio) — "clear transfer totals, card controls and savings goals… illustrative data and no real payments" → https://newminds.studio/concept-velto, award page https://www.awwwards.com/sites/velto-fintech-app-concept. Directly relevant: honest finance UI, tabular totals.
  - **Contiant Open Banking Fintech** (Honorable Mention, Jun 12, 2023; StanVision) — https://www.contiant.com/ — B2B open-banking product site; reference for restrained fintech credibility.
  - **Sunbit — Fintech Interaction** (Honorable Mention, Aug 24, 2020; Isadora Agency) — jury text: "super sleek and interactive experience… motion graphics, smooth transitions, slide-in effects"; recorded palette anchor `#2779a7` — https://sunbit.com/.
  - Current Site-of-the-Day winners (Nov 2026: Grids by Obys 7.63; MECHA; Spyker Cars) studied for 2026-era motion/typography direction only.
- **No Awwwards imagery or layouts are reused.** Awwwards content is editorially copyrighted; per docs/03 it is art-direction study, not freely reusable assets.

### 5. Typography sources (verified live; details in visual-direction-proposals.md)

- Google Fonts / foundry / npm pages for each candidate: license, tabular-numerals support, variable availability, `@fontsource/*` package existence. Fonts only enter the repo via npm dependencies (no font binaries committed), per AGENTS.md asset-provenance rule.

### 6. 3D sources (verified live; details in 3d-asset-and-camera-research.md)

- Sketchfab (license-filtered searches + asset pages + https://sketchfab.com/licenses), Poly Pizza, Smithsonian 3D, Poly Haven (CC0, https://polyhaven.com/license), plus three.js manual and react-three-fiber/drei docs for the rendering technique stack.

## What was NOT researched (and why)

- **"Webby Design"** — the exact URL was never supplied (docs/03 line 8). No substitute was invented. If the founder supplies the URL, it can be audited as an addendum without reopening this package.
- **React Bits Pro / Cult UI "AI SDK Agents" blocks / Skiper Pro** — paid tiers; no purchase was made, no code inspected beyond public previews. Adopting any paid tier is a founder purchase decision.
- **Figma-level design tokens** — tokens.json is a post-approval artifact (docs/03); this package proposes token _candidates_ only.
- **No WebGL prototype was built** — the 3D spike is issue #11; this package only selects assets/strategy.

## Licensing uncertainties (honest list)

1. React Bits' Commons Clause is written by the author, not by a lawyer-reviewed foundation; we treat "use inside your app = allowed, resale/redistribution = forbidden" as the operative rule and will not re-export any of its code.
2. Cult UI Halo-family components inherit Base UI behavior; their exact ARIA/keyboard behavior must be re-verified in the copied source at implementation time (docs/03 requires logging keyboard/screen-reader behavior per imported component).
3. Sketchfab CC-BY attribution must appear in the app's credits surface; CC-BY-NC items are excluded from the shortlist entirely (hackathon has cash prizes → treat as commercial).
4. Fontside (Fontshare) fonts are free for commercial use under the Fontshare license, but it is a custom license (not OFL); flagged per-candidate in the proposals file.
5. Skiper attribution mechanics (where the credit must appear) are not documented precisely on the site — one more reason the ledger recommends against relying on Skiper.

## CTO recheck and evidence limitations (review of PR #22)

This package is substantial research by the coding agent, **not an independently reproduced component-by-component lab evaluation**. The reviewer separately checked: Cult UI's official MIT repository, React Bits' official license text, Skiper's attribution rules, MBARI's official Doc Ricketts listing, Poly Haven's Simon's Town HDRI, and DJI/Sketchfab trademark caveats. The reviewer **could not directly inspect every third-party DJI model page or all claimed font binaries**; those details remain agent-reported and are pending a downloaded-asset audit/recorded hash. The absence of original font scan artifacts also prevents a third party reproducing the binary feature claims as documented.

- A CC-BY listing is not a guarantee of manufacturer trademark or trade-dress permission. See https://www.dji.com/terms and https://sketchfab.com/licenses.
- React Bits has a public-copying ambiguity: permission to use source as part of an application is distinct from restrictions on redistributing components themselves in a public repository. Verify before importing its copied code. See https://github.com/DavidHDev/react-bits/blob/main/LICENSE.md.
- The selected Sketchfab file must be downloaded under the applicable right, inspected for actual glTF/GLB format, animations, dimensions, quality and performance, then recorded with file hashes before it becomes an approved asset. No such inspection was performed in this research issue.
- Candidate direction choice requires real reference-grounded visual comparison, not a document-only style preference; Issue #10 remains open after merging the research PR.
