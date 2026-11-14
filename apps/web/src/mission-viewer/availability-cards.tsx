/**
 * Availability cards (MTV-09/12, C2) — THREE-FREE host components.
 *
 * The Decision Room renders these directly while the physical-view read is
 * unavailable: importing the full `MissionPhysicalViewer` here would pull
 * three.js into the main shell bundle for a state that shows no scene at
 * all. When Agent A ships the read endpoint, the host switches to
 * `MissionPhysicalViewerLazy` (dynamic chunk) with
 * `availability="ready"`.
 *
 * Also hosts `useDocumentTheme`: the shell's theme lives on
 * `document.documentElement.dataset.theme`; this hook observes it so an
 * embedded viewer tracks the app mode without new props threading through
 * the host's component tree.
 */
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { SnapshotAvailability } from './MissionPhysicalViewer.js';
import './mission-viewer.css';

export function useDocumentTheme(): 'dark' | 'light' {
  const read = (): 'dark' | 'light' =>
    document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark';
  const [theme, setTheme] = useState<'dark' | 'light'>(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export function MissionViewerLoadingCard(props: { className?: string }): JSX.Element {
  return (
    <section
      className={['mpv', 'mpv--loading', props.className ?? ''].join(' ')}
      data-testid="mission-viewer"
      data-availability="loading"
      aria-label="Physical mission viewer — loading evidence"
    >
      <div className="mpv-unavailable" data-testid="mpv-loading" role="status">
        <span className="mpv-chip mpv-chip--truth">SIMULATED_OPERATION</span>
        <h4 className="mpv-unavailable__title">Loading admitted physical evidence…</h4>
      </div>
    </section>
  );
}

export function MissionViewerUnavailableCard(props: {
  reason: string;
  className?: string;
}): JSX.Element {
  return (
    <section
      className={['mpv', 'mpv--unavailable', props.className ?? ''].join(' ')}
      data-testid="mission-viewer"
      data-availability="unavailable"
      aria-label="Physical mission viewer — currently unavailable"
    >
      <div className="mpv-unavailable" data-testid="mpv-unavailable">
        <span className="mpv-chip mpv-chip--truth">SIMULATED_OPERATION</span>
        <h4 className="mpv-unavailable__title">Physical evidence read-out unavailable</h4>
        <p className="mpv-unavailable__reason" data-testid="mpv-unavailable-reason">
          {props.reason}
        </p>
        <p className="mpv-note">
          The viewer renders only admitted, authenticated journal evidence — no demo data is
          substituted while the read is down.
        </p>
      </div>
    </section>
  );
}

/** Re-exported so hosts can type the availability prop without deep imports. */
export type { SnapshotAvailability };
