# MTV-21 — Public landing: design-transfer ledger and composition rationale

Branch: `feat/mtv-21-landing-page` (from `main` @ `9923057bda27012f9bb71e2e554a5f5dc9fab74c`, verified).
Scope: public landing at `/`, product app moved to `/app`, legacy deep links preserved.

## Design-transfer ledger (studied, not cloned)

| Source | Observed quality | Relevant to MOTERVA | Deliberately avoided | License/asset implication |
| --- | --- | --- | --- | --- |
| FOLLOW.ART case study (Vide Infra) | Functional marketplace UI presented through a strong product narrative; real screens over stock | Show the actual Decision Room imagery with honest provenance captions | Marketplace card grids, commerce patterns | Reference only; no assets copied |
| Exo Ape / Ottografie | Deliberate pacing, generous negative space, overview→inspection rhythm | The hero's negative space and the chapter pacing (wide → close) | Full-bleed decorative video, scroll theater | Inspiration only; typography is ours |
| Pentagram Archive | Confident editorial grid, restrained typographic hierarchy | The four-chapter OBSERVE/DECIDE/AUTHORIZE/PROVE grid with numbered rules | Decoration for its own sake | No Pentagram assets used |
| Rijksmuseum Collection | Artifact-first browsing: object first, metadata beneath | Hero scene first, factual caption beneath; evidence-first framing | Dense museum-style filtering UI | No assets used |
| OFF+BRAND / Aether 1 | Controlled cinematic 3D production craft | Our interactive 3D harbor is the cinematic element — kept in-product, not faked on the landing | A second WebGL runtime on the landing page | No assets used |
| Cult UI / React Bits / Skiper UI / Awwwards (docs/03) | Component-level patterns | Existing `mv-btn`/`mv-hud`/token system reused; no new component library | Copying source code | Already governed by docs/03 licenses |

## Composition rationale

- **Hero:** mandated headline, verbatim support line, one primary CTA (`Enter MOTERVA` / `Open Mission Treasury` when a session exists), one quiet explanatory anchor. The harbor scene beneath is a **repo-owned Decision Room screenshot** (`mtv-13-customer-decision-incident-s2-live-scene-1440x900.png`, captured from the real app) — documentary, not stock. The founder's `Harbor Drone Inspection Operations.png` is **not present in the repository** (reported missing rather than assumed).
- **Signature interaction:** a four-step walkthrough (baseline → signed wind incident → vessel alternative → governed proposal) with physical steps on the left and the financial consequence on the right, linked by a fine rule and an `aria-live` region. All figures come from the documented demo mission (`evt_demo_incident_*`, 24.6 kt vs 22 kt modeled limit, vessel alternative USD 18,500.00) and are labeled "sample scenario".
- **Chapters:** OBSERVE/DECIDE/AUTHORIZE/PROVE as one narrative grid — each links into the real surface it describes (`/app#evidence`, `/app#decisions`, `/app#authority`).
- **Buyer:** operations leads vs finance/treasury vs the tooling gap — from `docs/PRODUCT_NARRATIVE.md`, no invented traction.
- **Trust:** five plain statements (signed claims, deterministic evaluation, mandates + separate approval, provider status honesty, replayable evidence). No partner logos.
- **Invitation:** session-aware primary CTA + a working GitHub documentation link. No fake forms.

## Route decision (audited end to end)

- App keeps **hash sections** (`#missions…#evidence`) and moves to `/app`; the landing is `/`. Caddy's `try_files {path} /index.html` already serves the SPA for both paths; `vite preview` behaves identically locally.
- Legacy links: `/#decisions` and `/decisions` are rewritten in place to `/app#decisions` (pure function, unit-tested). Unknown paths fall to the public page — no financial exposure.
- **OIDC return:** `finishSignIn` now redirects to `WEB_ORIGIN + '/app'` (open-redirect safety preserved — the target derives only from configured WEB_ORIGIN). Disclosed minimal backend change; identity tests updated and green (113/113).
- Invitation acceptance is unchanged (inside the signed-in app shell).

## Honest limitations

- Founder hero asset `Harbor Drone Inspection Operations.png` absent from the repo — Decision Room screenshot used instead; swap is a one-file change when the asset lands.
- Performance measured locally (Lighthouse-style lab figures in the PR evidence); field CWV data does not exist pre-launch.
- Recording: not produced in this run.
