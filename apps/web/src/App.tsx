import { useState } from 'react';
import type { JSX } from 'react';
import { SystemStatusCard } from './components/SystemStatusCard';
import { NAV_ITEMS, type NavItem, type SectionId } from './nav';

function readInitialSection(): SectionId {
  const hash = window.location.hash.replace('#', '');
  const match = NAV_ITEMS.find((item) => item.id === hash);
  return match ? match.id : 'missions';
}

export function App(): JSX.Element {
  const [section, setSection] = useState<SectionId>(readInitialSection);
  const active = NAV_ITEMS.find((item) => item.id === section) ?? NAV_ITEMS[0];
  if (!active) throw new Error('navigation table is empty');

  return (
    <div className="app">
      <header className="app__header">
        <p className="app__mark">MOTERVA</p>
        <h1 className="app__title">Mission Treasury</h1>
        <p className="app__subtitle">
          Operational finance console for physical missions. Hackathon build — no production money
          movement.
        </p>
      </header>

      <nav className="app__nav" aria-label="Primary">
        <ul>
          {NAV_ITEMS.map((item) => (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                aria-current={item.id === active.id ? 'page' : undefined}
                className={item.id === active.id ? 'is-active' : undefined}
                onClick={() => setSection(item.id)}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <main className="app__main" id="main">
        <PlannedSection item={active} />
        <SystemStatusCard />
      </main>

      <footer className="app__footer">
        <p>
          MOTERVA is a hackathon build. Provider integrations (Airwallex, Metal) are OFFLINE until
          independently verified — see{' '}
          <a href="https://github.com/CosmasMandikonza/Morteva/blob/main/docs/STATE.md">
            docs/STATE.md
          </a>{' '}
          for the current verified state.
        </p>
      </footer>
    </div>
  );
}

function PlannedSection({ item }: { item: NavItem }): JSX.Element {
  return (
    <section className="planned" aria-labelledby="planned-heading">
      <h2 id="planned-heading">{item.label}</h2>
      <p>{item.summary}</p>
      <p className="planned__status" data-testid="planned-status">
        Not implemented in MTV-01 — planned capability, tracking issue{' '}
        <a
          href={`https://github.com/CosmasMandikonza/Morteva/issues/${item.issue.replace('#', '')}`}
        >
          {item.issue}
        </a>
        . No mock data is shown here.
      </p>
    </section>
  );
}
