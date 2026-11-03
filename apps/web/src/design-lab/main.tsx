import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppA } from './a/AppA';
import { AppB } from './b/AppB';
import { FounderShell } from './shell';
import './base.css';
// Candidate styles are imported by the shell entry so every mode shares one
// CSS bundle; both scopes are inert unless their root class is mounted.
import './a/lab-a.css';
import './b/lab-b.css';
import './shell.css';

/**
 * Design-lab entry. Query modes:
 *   (no query)  → founder console (switch / compare both candidates)
 *   ?c=a        → Candidate A rendered standalone (screenshots, tests)
 *   ?c=b        → Candidate B standalone
 */
function readCandidate(): 'a' | 'b' | null {
  const c = new URLSearchParams(window.location.search).get('c');
  return c === 'a' || c === 'b' ? c : null;
}

const container = document.getElementById('root');
if (!container) throw new Error('root element missing in design-lab.html');

const candidate = readCandidate();
// Normalize ?screen=decision → #decision for the shared lab state.
const screenParam = new URLSearchParams(window.location.search).get('screen');
if (screenParam && !window.location.hash) {
  window.history.replaceState(null, '', `#${screenParam}`);
}

createRoot(container).render(
  <StrictMode>
    {candidate === 'a' ? <AppA /> : candidate === 'b' ? <AppB /> : <FounderShell />}
  </StrictMode>,
);
