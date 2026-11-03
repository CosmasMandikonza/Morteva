import { useState } from 'react';
import type { JSX } from 'react';

/**
 * Founder console: the default view of /design-lab.html. It frames the two
 * candidates in iframes so A and B can be viewed full, toggled, or compared
 * side-by-side at a chosen width — one honest apparatus for the decision.
 */
type Mode = 'a' | 'b' | 'compare';

const WIDTHS: Array<{ id: string; label: string; width: number }> = [
  { id: 'w320', label: '320', width: 320 },
  { id: 'w390', label: '390', width: 390 },
  { id: 'w768', label: '768', width: 768 },
  { id: 'w1024', label: '1024', width: 1024 },
  { id: 'w1440', label: '1440', width: 1440 },
  { id: 'wfull', label: 'full', width: 0 },
];

const SCREEN_LINKS: Array<{ hash: string; label: string }> = [
  { hash: 'treasury', label: 'Treasury' },
  { hash: 'decision', label: 'Decision Room' },
  { hash: 'authority', label: 'Authority' },
  { hash: 'replay', label: 'Replay' },
];

export function FounderShell(): JSX.Element {
  const [mode, setMode] = useState<Mode>('compare');
  const [width, setWidth] = useState('wfull');
  const [screenHash, setScreenHash] = useState('treasury');

  const px = WIDTHS.find((w) => w.id === width)?.width ?? 0;
  const frameW = px || '100%';
  const src = (c: 'a' | 'b') => `?c=${c}&screen=${screenHash}&frame=1`;

  return (
    <div className="shell">
      <header className="shell__bar">
        <span className="shell__mark">MOTERVA · DESIGN LAB</span>
        <div className="shell__switch" role="tablist" aria-label="Candidate">
          {(['a', 'compare', 'b'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? 'is-on' : undefined}
              onClick={() => setMode(m)}
            >
              {m === 'a' ? 'A · Harbour Watch' : m === 'b' ? 'B · Night Sortie' : 'Compare A|B'}
            </button>
          ))}
        </div>
        <div className="shell__tools">
          <div className="shell__seg" role="group" aria-label="Viewport width">
            {WIDTHS.map((w) => (
              <button
                key={w.id}
                type="button"
                aria-pressed={width === w.id}
                className={width === w.id ? 'is-on' : undefined}
                onClick={() => setWidth(w.id)}
              >
                {w.label}
              </button>
            ))}
          </div>
          <div className="shell__seg" role="group" aria-label="Screen">
            {SCREEN_LINKS.map((s) => (
              <button
                key={s.hash}
                type="button"
                aria-pressed={screenHash === s.hash}
                className={screenHash === s.hash ? 'is-on' : undefined}
                onClick={() => setScreenHash(s.hash)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className={`shell__stage shell__stage--${mode}`}>
        {mode !== 'b' && (
          <section className="shell__framebox" aria-label="Candidate A preview">
            <h2 className="shell__frameh">
              A · Harbour Watch <span>light institutional · IBM Plex</span>
            </h2>
            <div className="shell__frame" style={{ width: frameW }}>
              <iframe
                key={`a-${screenHash}-${width}`}
                src={src('a')}
                title="Candidate A — Harbour Watch"
              />
            </div>
          </section>
        )}
        {mode !== 'a' && (
          <section className="shell__framebox" aria-label="Candidate B preview">
            <h2 className="shell__frameh">
              B · Night Sortie <span>dark cinematic · Space Grotesk/Geist Mono</span>
            </h2>
            <div className="shell__frame" style={{ width: frameW }}>
              <iframe
                key={`b-${screenHash}-${width}`}
                src={src('b')}
                title="Candidate B — Night Sortie"
              />
            </div>
          </section>
        )}
      </div>

      <footer className="shell__foot">
        <p>
          Both candidates render the <strong>same synthetic scenario</strong> and the same status
          semantics (SUBMITTED is never SETTLED; currencies always explicit). Interact inside each
          frame: navigate screens, compare plans, run the approval flow, open the state laboratory.
        </p>
        <p>
          UNAPPROVED — founder review for issue #10. Direct links: <a href="?c=a">Candidate A</a> ·{' '}
          <a href="?c=b">Candidate B</a>
        </p>
      </footer>
    </div>
  );
}
