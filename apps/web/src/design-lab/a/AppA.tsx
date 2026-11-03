import { useState } from 'react';
import type { JSX } from 'react';
import { OVERRIDES, SCREENS, useLabState, type LabOverride } from '../lab/use-lab-state';
import { labNotice } from '../lab/data';
import { AuthorityA, DecisionA, ReplayA, TreasuryA } from './screensA';

/**
 * Candidate A — "Harbour Watch" (UNAPPROVED direction).
 * Light institutional instrument: dense ledger tables, IBM Plex family,
 * single harbour-blue accent, quiet mechanical motion.
 * Interaction patterns credit Cult UI Halo family (MIT) — re-implemented
 * originally here; see research mapping for production adoption path.
 */
export function AppA(): JSX.Element {
  const lab = useLabState();
  const [labOpen, setLabOpen] = useState(false);

  return (
    <div className={`lab lab-a${lab.reducedMotion ? ' is-reduced' : ''}`} data-lab="a">
      <div className="lab__banner" role="note">
        <span className="lab__banner-tag">SYNTHETIC</span>
        <p>{labNotice}</p>
      </div>

      <header className="a-topbar">
        <div className="a-topbar__left">
          <span className="a-mark">MOTERVA</span>
          <span className="a-org">
            Northwind Offshore Inspection AS
            <span className="a-org__sub">Finance console · role: fleet finance approver</span>
          </span>
        </div>
        <div className="a-topbar__right">
          <button
            type="button"
            className="a-ghostbtn"
            onClick={lab.toggleReducedMotion}
            aria-pressed={lab.reducedMotion}
          >
            Reduced motion {lab.reducedMotion ? 'on' : 'off'}
          </button>
          <button
            type="button"
            className="a-ghostbtn"
            aria-expanded={labOpen}
            aria-controls="state-lab-a"
            onClick={() => setLabOpen((v) => !v)}
          >
            State laboratory
          </button>
          <span className="a-envrow">
            <span className="env">SANDBOX</span>
            <span className="env">TESTNET</span>
          </span>
        </div>
      </header>

      {labOpen && (
        <section id="state-lab-a" className="a-statelab" aria-label="State laboratory">
          <h2 className="a-statelab__h">State laboratory — demonstrate every honest state</h2>
          <div className="a-statelab__grid" role="radiogroup" aria-label="State override">
            {OVERRIDES.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={lab.override === o.id}
                className={`a-statelab__opt${lab.override === o.id ? ' is-on' : ''}`}
                onClick={() => lab.setOverride(o.id as LabOverride)}
              >
                <span className="a-statelab__label">{o.label}</span>
                <span className="a-statelab__effect">{o.effect}</span>
              </button>
            ))}
          </div>
          <p className="a-statelab__note">
            Overrides are preview-only toggles for design review. The Authority screen additionally
            simulates the operation lifecycle, including STATUS UNKNOWN (commitment retained) and
            digest-mismatch rejection.
          </p>
        </section>
      )}

      <nav className="a-tabs" aria-label="Screens">
        <ul>
          {SCREENS.map((s) => (
            <li key={s.id}>
              <a
                href={`#a-${s.id}`}
                aria-current={lab.screen === s.id ? 'page' : undefined}
                className={lab.screen === s.id ? 'is-active' : undefined}
                title={s.hint}
                onClick={(e) => {
                  e.preventDefault();
                  lab.setScreen(s.id);
                }}
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <main className="a-main" id="a-main">
        {lab.screen === 'treasury' && <TreasuryA lab={lab} />}
        {lab.screen === 'decision' && <DecisionA lab={lab} />}
        {lab.screen === 'authority' && <AuthorityA lab={lab} />}
        {lab.screen === 'replay' && <ReplayA lab={lab} />}
      </main>

      <footer className="a-footer">
        <span>Candidate A · Harbour Watch — UNAPPROVED design direction</span>
        <span>
          All figures synthetic · no provider calls · production 3D is MTV-09 · references: Cult UI
          Halo family (MIT), IBM Plex (OFL)
        </span>
      </footer>
    </div>
  );
}
