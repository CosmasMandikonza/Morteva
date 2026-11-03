import { useState } from 'react';
import type { JSX } from 'react';
import { OVERRIDES, SCREENS, useLabState, type LabOverride } from '../lab/use-lab-state';
import { labNotice } from '../lab/data';
import { AuthorityB, DecisionB, ReplayB, TreasuryB } from './screensB';

/**
 * Candidate B — "Night Sortie" (UNAPPROVED direction).
 * Dark cinematic mission console: Space Grotesk / Inter / Geist Mono, near-black
 * deck, instrument amber reserved for authority and money decisions.
 * Interaction patterns credit Cult UI Halo family + React Bits motion
 * language (MIT / MIT+Commons) — re-implemented originally; nothing copied.
 */
export function AppB(): JSX.Element {
  const lab = useLabState();
  const [labOpen, setLabOpen] = useState(false);

  return (
    <div className={`lab lab-b${lab.reducedMotion ? ' is-reduced' : ''}`} data-lab="b">
      <div className="lab__banner" role="note">
        <span className="lab__banner-tag">SYNTHETIC</span>
        <p>{labNotice}</p>
      </div>

      <header className="b-topbar">
        <span className="b-mark">MOTERVA</span>
        <span className="b-topbar__div" aria-hidden="true" />
        <nav className="b-nav" aria-label="Screens">
          {SCREENS.map((s) => (
            <a
              key={s.id}
              href={`#b-${s.id}`}
              aria-current={lab.screen === s.id ? 'page' : undefined}
              className={lab.screen === s.id ? 'is-active' : undefined}
              onClick={(e) => {
                e.preventDefault();
                lab.setScreen(s.id);
              }}
            >
              {s.label}
            </a>
          ))}
        </nav>
        <div className="b-topbar__right">
          <button
            type="button"
            className="b-chipbtn"
            onClick={lab.toggleReducedMotion}
            aria-pressed={lab.reducedMotion}
          >
            motion {lab.reducedMotion ? 'off' : 'on'}
          </button>
          <button
            type="button"
            className="b-chipbtn"
            aria-expanded={labOpen}
            aria-controls="state-lab-b"
            onClick={() => setLabOpen((v) => !v)}
          >
            state lab
          </button>
          <span className="env">SANDBOX</span>
          <span className="env">TESTNET</span>
        </div>
      </header>

      {labOpen && (
        <section id="state-lab-b" className="b-statelab" aria-label="State laboratory">
          <h2 className="b-statelab__h">State laboratory — every honest state, on demand</h2>
          <div className="b-statelab__grid" role="radiogroup" aria-label="State override">
            {OVERRIDES.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={lab.override === o.id}
                className={`b-statelab__opt${lab.override === o.id ? ' is-on' : ''}`}
                onClick={() => lab.setOverride(o.id as LabOverride)}
              >
                <span className="b-statelab__label">{o.label}</span>
                <span className="b-statelab__effect">{o.effect}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <main className="b-main" id="b-main">
        {lab.screen === 'treasury' && <TreasuryB lab={lab} />}
        {lab.screen === 'decision' && <DecisionB lab={lab} />}
        {lab.screen === 'authority' && <AuthorityB lab={lab} />}
        {lab.screen === 'replay' && <ReplayB lab={lab} />}
      </main>

      <footer className="b-footer">
        <span>Candidate B · Night Sortie — UNAPPROVED design direction</span>
        <span>
          All figures synthetic · no provider calls · production 3D is MTV-09 · references: Cult UI
          Halo (MIT), React Bits motion language, Space Grotesk/Inter/Geist Mono (OFL)
        </span>
      </footer>
    </div>
  );
}
