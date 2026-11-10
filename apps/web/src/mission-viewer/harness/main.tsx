/**
 * Standalone harness for the mission physical viewer (MTV-09/12).
 *
 * Serves the viewer against COMMITTED, JOURNAL-DERIVED fixtures (see
 * apps/api/src/mission-events/fixtures/generate-viewer-fixture.ts — every
 * fixture is the real replay output of the real ingest pipeline, synthetic
 * and deterministic). URL parameters:
 *   ?fixture=primary|empty|stale|conflict|offline|recovered|warehouse|duplicate
 *   ?event=<eventId>       deep-linked selection (recreated after refresh)
 *   ?theme=dark|light      B-led theme mode
 *   ?mode=3d|2d|auto       display mode (default auto)
 *   ?webgl=off             force the WebGL-unavailable path (fallback test)
 *   ?reducedMotion=1       force reduced motion
 *
 * The harness is a PREVIEW SURFACE, not the product shell: no fetches, no
 * API calls, no financial state. Everything renders from the fixture.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { JSX } from 'react';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/geist-mono';
import '../../theme/tokens.css';
import '../mission-viewer.css';
import './harness.css';
import { MissionPhysicalViewer, snapshotFromServerPayload } from '../index.js';
import type { PhysicalViewSnapshot } from '../contract.js';
import { projectSceneState } from '../scene-state.js';

const FIXTURE_MODULES = import.meta.glob('../fixtures/*.physical-view.json', {
  eager: true,
}) as Record<string, { default: PhysicalViewSnapshot & { description?: string } }>;

const FIXTURES = new Map<string, { description: string; snapshot: PhysicalViewSnapshot }>();
for (const [path, mod] of Object.entries(FIXTURE_MODULES)) {
  const name = path.match(/([^/]+)\.physical-view\.json$/)?.[1] ?? path;
  // Every fixture passes the STRICT server-shape adapter on load — the
  // harness crashes otherwise, so shape compliance is continuously proven.
  const snapshot = snapshotFromServerPayload(mod.default);
  FIXTURES.set(name, { description: mod.default.description ?? name, snapshot });
}

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

function Harness(): JSX.Element {
  const p = params();
  const fixtureName = p.get('fixture') ?? 'primary';
  const loaded = FIXTURES.get(fixtureName);
  if (loaded === undefined) {
    return (
      <main className="mpvh">
        <p role="alert">
          Unknown fixture "{fixtureName}". Available: {[...FIXTURES.keys()].join(', ')}
        </p>
      </main>
    );
  }
  const snapshot = loaded.snapshot;
  const eventParam = p.get('event');
  const validSelection =
    eventParam !== null && snapshot.events.some((e) => e.eventId === eventParam)
      ? eventParam
      : null;
  const theme = p.get('theme') === 'light' ? 'light' : 'dark';
  const modeParam = p.get('mode');
  const displayMode = modeParam === '3d' || modeParam === '2d' ? modeParam : 'auto';
  if (p.get('webgl') === 'off') {
    (globalThis as { __MPV_FORCE_NO_WEBGL?: boolean }).__MPV_FORCE_NO_WEBGL = true;
  }
  const reducedMotion = p.get('reducedMotion') === '1' ? true : undefined;

  // Deep-linkable selection for tests/reviewers.
  const [selectedEventId, setSelected] = useState<string | null>(validSelection);
  const [selectedAssetId, setSelectedAsset] = useState<string | null>(
    p.get('asset') !== null && snapshot.assets.some((a) => a.assetId === p.get('asset'))
      ? p.get('asset')
      : null,
  );

  const state = projectSceneState(snapshot, {
    selectedEventId,
    selectedAssetId,
    decisionAvailable: true,
  });

  return (
    <main className="mpvh">
      <header className="mpvh__head">
        <h1>MOTERVA · Physical mission viewer</h1>
        <p className="mpvh__truth" data-testid="mpvh-truth">
          SIMULATED_OPERATION · SYNTHETIC evidence · fixture "{fixtureName}": {loaded.description}
        </p>
        <p className="mpvh__note">
          Scene placement is illustrative (the evidence contract carries no coordinates). The
          financial decision lives in the Decision Room; this viewer links to it, never decides it.
        </p>
        <nav className="mpvh__fixtures" aria-label="Fixture selection">
          {[...FIXTURES.keys()].map((name) => (
            <a
              key={name}
              href={`?fixture=${name}${eventParam !== null ? `&event=${eventParam}` : ''}${theme === 'light' ? '&theme=light' : ''}`}
              aria-current={name === fixtureName ? 'page' : undefined}
              data-testid={`mpvh-fixture-${name}`}
            >
              {name}
            </a>
          ))}
        </nav>
      </header>
      <MissionPhysicalViewer
        missionId={snapshot.tenant.missionId}
        snapshot={snapshot}
        selectedEventId={selectedEventId}
        onSelectEvent={(id) => {
          setSelected(id);
          const next = new URLSearchParams(window.location.search);
          if (id === null) next.delete('event');
          else next.set('event', id);
          window.history.replaceState(null, '', `?${next.toString()}`);
        }}
        selectedAssetId={selectedAssetId}
        onSelectAsset={setSelectedAsset}
        theme={theme}
        reducedMotion={reducedMotion}
        displayMode={displayMode}
        decisionAvailable
        decisionHref="#decision-room"
        decisionLabel="Inspect the financial decision in the Decision Room"
      />
      <section className="mpvh__panel" data-testid="mpvh-state">
        <h2>Deterministic scene state</h2>
        <pre>
          {JSON.stringify(
            {
              phase: state.phase,
              windBreached: state.windBreached,
              aerialWindKt: state.aerialWindKt,
              constraints: state.constraints,
              markers: state.markers.map((m) => m.eventId),
              selectedEventId: state.selected?.event.eventId ?? null,
              replay: state.selected?.isHistoricalReplay === true,
            },
            null,
            2,
          )}
        </pre>
      </section>
      <footer className="mpvh__foot">
        <p>
          3D models: "Drone" by NateGazzard, "Container Ship" by Alex Safayan — CC-BY 3.0 via
          poly.pizza (see assets/attribution.md). Harbor environment original.
        </p>
      </footer>
    </main>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('harness root missing');
createRoot(root).render(<Harness />);

// Debug surface for Playwright (read-only).
const RAW_FIXTURES: Record<string, Record<string, unknown>> = {};
for (const [path, mod] of Object.entries(FIXTURE_MODULES)) {
  const name = path.match(/([^/]+)\.physical-view\.json$/)?.[1] ?? path;
  RAW_FIXTURES[name] = mod.default as unknown as Record<string, unknown>;
}
(window as { __MPV_FIXTURES_RAW?: unknown }).__MPV_FIXTURES_RAW = RAW_FIXTURES;
(window as { __MPV_DEBUG?: unknown }).__MPV_DEBUG = {
  fixtures: [...FIXTURES.keys()],
  // Strict server-shape adapter exposed for adversarial e2e: positive cases
  // must pass, any mutated payload must fail closed with the reason.
  validateAdapter: (payload: unknown): { ok: boolean; reason?: string } => {
    try {
      snapshotFromServerPayload(payload);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
  engineDebug: () =>
    (window as { __MPV_ENGINE?: { debug(): unknown } }).__MPV_ENGINE?.debug() ?? null,
};
