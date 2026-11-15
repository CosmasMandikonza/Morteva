import { useEffect, useState } from 'react';
import type { JSX } from 'react';

/**
 * MOTERVA public landing (issue #21).
 *
 * One editorial page: hero → the signature physical→financial consequence
 * interaction → four connected chapters (OBSERVE / DECIDE / AUTHORIZE /
 * PROVE) → buyer clarity → trust → invitation. Everything is sample-scenario
 * content drawn from the documented demo fixtures and labeled as such; no
 * fabricated telemetry, balances, settlements or approvals. Design tokens are
 * the product's own (theme/tokens.css) — dark flagship, light functional.
 */
export function Landing(): JSX.Element {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return window.localStorage.getItem('moterva-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  // The signature interaction: the plan-break walkthrough step (0..3).
  const [step, setStep] = useState(0);
  const [hasSession, setHasSession] = useState<boolean | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem('moterva-theme', theme);
    } catch {
      /* storage unavailable — theme stays for this visit only */
    }
  }, [theme]);

  // Honest product entry: the landing never exposes financial data. A signed
  // session merely changes the primary action into "continue into the app".
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/session', { signal: controller.signal, credentials: 'same-origin' })
      .then((r) => setHasSession(r.ok))
      .catch(() => setHasSession(false));
    return () => controller.abort();
  }, []);

  const enter = hasSession === true ? 'Open Mission Treasury' : 'Enter MOTERVA';

  return (
    <div className="lp" data-testid="landing">
      <a className="mv-skip" href="#lp-main">
        Skip to content
      </a>

      {/* ---------------------------------------------------------- top bar */}
      <header className="lp-topbar">
        <span className="lp-mark" aria-hidden="true">
          ▚
        </span>
        <span className="lp-brand">MOTERVA</span>
        <span className="lp-brand__sub">Mission Treasury for the physical world</span>
        <span className="lp-topbar__spring" />
        <button
          type="button"
          className="mv-btn mv-btn--ghost lp-themetoggle"
          aria-pressed={theme === 'light'}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>
        <a className="mv-btn lp-enter" href="/app" data-testid="lp-enter">
          {enter}
        </a>
      </header>

      <main className="lp-main" id="lp-main">
        {/* ---------------------------------------------------------- hero */}
        <section className="lp-hero" aria-labelledby="lp-hero-title">
          <p className="lp-kicker mv-hud">Inspection fleets · asset-intensive operations</p>
          <h1 className="lp-title" id="lp-hero-title">
            When the mission changes,{' '}
            <span className="lp-title__accent">the money should know.</span>
          </h1>
          <p className="lp-support">
            MOTERVA connects changes in physical operations to explainable financial decisions —
            with the evidence, spending rules, approvals, and provider outcomes tied to the same
            mission.
          </p>
          <div className="lp-hero__actions">
            <a className="mv-btn mv-btn--primary" href="/app" data-testid="lp-hero-cta">
              {enter}
            </a>
            <a className="lp-quietlink" href="#lp-consequence">
              See the moment the plan breaks ↓
            </a>
          </div>
          <figure className="lp-hero__scene">
            <img
              src="/landing/harbor-scene.png"
              alt="MOTERVA Decision Room: a berthed container ship rendered in the mission's interactive harbor scene"
              width="1520"
              height="731"
              loading="eager"
              decoding="async"
              fetchPriority="high"
            />
            <figcaption className="mv-hud">
              The Mission Decision Room — the interactive 3D harbor scene shows the mission&rsquo;s
              real operational state. Sample scenario shown.
            </figcaption>
          </figure>
        </section>

        {/* ------------------------------------ the moment the plan breaks */}
        <section
          className="lp-consequence"
          aria-labelledby="lp-consequence-title"
          id="lp-consequence"
        >
          <p className="lp-kicker mv-hud">The moment the plan breaks</p>
          <h2 className="lp-chapter__title" id="lp-consequence-title">
            An interruption on the water becomes a governed financial decision.
          </h2>
          <div className="lp-consequence__grid">
            <div className="lp-consequence__physical">
              <p className="mv-hud">PHYSICAL · sample scenario</p>
              <ol className="lp-steps" aria-label="Mission walkthrough steps">
                {LP_STEPS.map((s, i) => (
                  <li key={s.key}>
                    <button
                      type="button"
                      className={`lp-step ${i === step ? 'is-active' : ''}`}
                      aria-pressed={i === step}
                      onClick={() => setStep(i)}
                    >
                      <span className="lp-step__num mv-num">{String(i + 1).padStart(2, '0')}</span>
                      <span className="lp-step__label">{s.label}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
            <div className="lp-consequence__financial" aria-live="polite">
              <p className="mv-hud">FINANCIAL · what the mission engine does</p>
              <h3 className="lp-consequence__headline">{LP_STEPS[step]!.headline}</h3>
              <p className="lp-consequence__body">{LP_STEPS[step]!.body}</p>
              <dl className="lp-consequence__facts">
                {LP_STEPS[step]!.facts.map((f) => (
                  <div key={f.k}>
                    <dt>{f.k}</dt>
                    <dd className="mv-num">{f.v}</dd>
                  </div>
                ))}
              </dl>
              <p className="lp-consequence__hint">
                <a href="/app#decisions">This exact view lives in the Decision Room →</a>
              </p>
            </div>
          </div>
          <p className="lp-consequence__provenance mv-hud">
            Sample scenario from the documented demo mission — figures are the engine&rsquo;s own
            deterministic evaluation, not live telemetry or a real account.
          </p>
        </section>

        {/* ----------------------------------------- four editorial chapters */}
        <section className="lp-chapters" aria-label="How MOTERVA works">
          {CHAPTERS.map((c, i) => (
            <article className="lp-chapter" key={c.word}>
              <span className="lp-chapter__num mv-num">{String(i + 1).padStart(2, '0')}</span>
              <h2 className="lp-chapter__word">{c.word}</h2>
              <h3 className="lp-chapter__title">{c.title}</h3>
              <p className="lp-chapter__body">{c.body}</p>
              <a className="lp-chapter__link" href={c.appHref}>
                {c.appLink} →
              </a>
            </article>
          ))}
        </section>

        {/* ------------------------------------------------- buyer + market */}
        <section className="lp-buyer" aria-labelledby="lp-buyer-title">
          <p className="lp-kicker mv-hud">Who this is for</p>
          <h2 className="lp-chapter__title" id="lp-buyer-title">
            Built for the people who own the mission <em>and</em> the money.
          </h2>
          <div className="lp-buyer__grid">
            <div className="lp-buyer__role">
              <h3>Operations leads</h3>
              <p>
                When wind grounds the aircraft or a subcontractor slips, the feasible set changes.
                MOTERVA shows what is still possible, what it costs, and what the safety rules allow
                — in one place, with the evidence attached.
              </p>
            </div>
            <div className="lp-buyer__role">
              <h3>Finance &amp; treasury</h3>
              <p>
                Spending stays inside exact mandates: per-operation caps, mission budgets, protected
                reserves and independent approval. No card, no ad-hoc wire, no after-the-fact
                reconciliation of a decision finance never saw.
              </p>
            </div>
            <div className="lp-buyer__role">
              <h3>Why existing tools leave the gap</h3>
              <p>
                Fleet platforms observe the exception. Spend tools move the money. Neither connects
                the two — the mission&rsquo;s own evidence is what makes this decision defensible
                months later.
              </p>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- trust */}
        <section className="lp-trust" aria-labelledby="lp-trust-title">
          <p className="lp-kicker mv-hud">Authority by design</p>
          <h2 className="lp-chapter__title" id="lp-trust-title">
            The engine recommends. People and mandates authorize.
          </h2>
          <ul className="lp-trust__list">
            <li>
              Field observations are signed by registered sources — a claim with provenance, never
              assumed sensor truth.
            </li>
            <li>
              Feasible options are computed under your stated policy, deadlines and economics —
              deterministically, and shown with refusals.
            </li>
            <li>
              Money moves only inside exact mandates with separate human approval; protected
              reserves are untouchable.
            </li>
            <li>
              Provider status is reported as pending, unknown, or verified — submitted is never
              presented as settled.
            </li>
            <li>
              Every event, decision, approval and receipt is replayable from the append-only
              journal.
            </li>
          </ul>
        </section>

        {/* ------------------------------------------------------ invitation */}
        <section className="lp-invitation" aria-labelledby="lp-invite-title">
          <p className="lp-kicker mv-hud">Ready when the weather is</p>
          <h2 className="lp-title lp-title--invite" id="lp-invite-title">
            Give your mission a treasury that listens.
          </h2>
          <div className="lp-hero__actions">
            <a className="mv-btn mv-btn--primary" href="/app" data-testid="lp-final-cta">
              {enter}
            </a>
            <a
              className="lp-quietlink"
              href="https://github.com/CosmasMandikonza/Morteva"
              rel="noreferrer noopener"
            >
              Read the engineering documentation ↗
            </a>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <p>
          MOTERVA · mission-scoped financial autonomy · sample scenarios and sandbox provider states
          are labeled as such throughout this site.
        </p>
      </footer>
    </div>
  );
}

const LP_STEPS = [
  {
    key: 'baseline',
    label: 'Baseline: the drone flies the survey',
    headline: 'The plan holds — hold the spend.',
    body: 'A healthy baseline observation is admitted against the mission\u2019s registered specification. The cheapest defensible choice is to do nothing: the incumbent flight continues under the current mandate.',
    facts: [
      { k: 'Recommendation', v: 'no new spend' },
      { k: 'Gross cost', v: 'USD 0.00' },
      { k: 'Authority', v: 'active mandate v1' },
    ],
  },
  {
    key: 'breach',
    label: 'A signed wind incident lands',
    headline: '24.6 kt against a 22 kt modeled limit.',
    body: 'A registered source signs a wind observation that exceeds the mission\u2019s own operating threshold. The engine does not argue with the weather \u2014 the UAV option becomes infeasible and every candidate is re-scored under the changed constraints.',
    facts: [
      { k: 'Observation', v: 'wind 24.6 kt (signed)' },
      { k: 'Incumbent option', v: 'refused \u2014 safety' },
      { k: 'Policy', v: 'deterministic, stated' },
    ],
  },
  {
    key: 'alternative',
    label: 'A vessel alternative becomes the feasible path',
    headline: 'The feasible set changes \u2014 and so does the money.',
    body: 'The vessel-inspection service is not gated on the grounded aircraft. The engine prices it exactly: base, fees, lead time and probability of success against the mission\u2019s own economics and deadline.',
    facts: [
      { k: 'Selected', v: 'vessel-inspection' },
      { k: 'Gross / expected net', v: 'USD 18,500.00 / 21,750.00' },
      { k: 'Beneficiary', v: 'harbor-marine' },
    ],
  },
  {
    key: 'governed',
    label: 'Governed proposal \u2014 a human approves exact terms',
    headline: 'Proposed \u2014 not paid. A separate person approves.',
    body: 'The plan is created only from the recorded evaluation, ID-only, with the server deriving the exact terms. A different human reviews the identical amount, beneficiary, purpose and digest before anything is reserved.',
    facts: [
      { k: 'Status', v: 'awaiting approval' },
      { k: 'Provider state', v: 'none \u2014 nothing sent' },
      { k: 'Evidence', v: 'replayable, same ids' },
    ],
  },
] as const;

const CHAPTERS = [
  {
    word: 'OBSERVE',
    title: 'An authenticated observation changes the mission facts.',
    body: 'Registered sources sign every field claim with their own credentials \u2014 provenance and freshness travel with the reading, and the append-only journal keeps the original event intact.',
    appHref: '/app#evidence',
    appLink: 'Evidence Replay',
  },
  {
    word: 'DECIDE',
    title: 'Feasible options shift under safety, time and economics.',
    body: 'The engine re-scores every candidate against the mission\u2019s stated constraints \u2014 including doing nothing, waiting, or escalating \u2014 and shows refusals with their reasons, never a silent winner.',
    appHref: '/app#decisions',
    appLink: 'Decision Room',
  },
  {
    word: 'AUTHORIZE',
    title: 'Exact terms, protected reserves, separate approval.',
    body: 'Plans are proposed ID-only from recorded evaluations; a different human approves the identical amount, beneficiary, purpose and digest. Protected reserves are never spendable.',
    appHref: '/app#authority',
    appLink: 'Authority & Execution',
  },
  {
    word: 'PROVE',
    title: 'The whole chain is inspectable, months later.',
    body: 'Original event, decision, approval, reservation, provider status and receipt stay linked to the same mission identity \u2014 replayed from the journal, not reconstructed from memory.',
    appHref: '/app#evidence',
    appLink: 'Evidence Replay',
  },
] as const;
