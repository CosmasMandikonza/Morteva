import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { SystemStatusCard } from './components/SystemStatusCard';
import { Treasury } from './screens/Treasury';
import { EvidenceReplay } from './screens/Evidence';
import { PlannedSurface } from './screens/PlannedSurface';
import { AuthorityExecution } from './screens/AuthorityExecution';
import { DecisionRoom } from './screens/DecisionRoom';
import { MissionSetup } from './screens/MissionSetup';
import { NAV_ITEMS, type SectionId } from './nav';
import {
  ApiError,
  fetchSession,
  login,
  logout,
  type MissionRow,
  type SessionState,
} from './lib/api';

type Theme = 'dark' | 'light';

const CSRF_STORAGE_KEY = 'moterva-csrf';

const MISSION_STORAGE_KEY = 'moterva-selected-mission';

/**
 * The CSRF token ships with the login response; the session cookie survives
 * reloads, so the token must too — otherwise Sign out breaks (403) after a
 * page reload. Loopback demo gate only; not a credential.
 */
function readStoredCsrf(): string | null {
  try {
    // OIDC sign-in is a full-page redirect: its session-bound double-submit
    // CSRF companion is provided in a readable same-site cookie, not a JSON
    // login result. Never read the HttpOnly session credential here.
    const cookie = document.cookie.split('; ').find((part) => part.startsWith('moterva_csrf='));
    if (cookie !== undefined) {
      return decodeURIComponent(cookie.slice('moterva_csrf='.length));
    }
    return window.localStorage.getItem(CSRF_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeCsrf(token: string | null): void {
  try {
    if (token === null) window.localStorage.removeItem(CSRF_STORAGE_KEY);
    else window.localStorage.setItem(CSRF_STORAGE_KEY, token);
  } catch {
    /* storage unavailable — logout falls back to the in-memory token */
  }
}

function readInitialSection(): SectionId {
  const hash = window.location.hash.replace('#', '');
  const match = NAV_ITEMS.find((item) => item.id === hash);
  return match ? match.id : 'missions';
}

function readInitialTheme(): Theme {
  const stored = window.localStorage.getItem('moterva-theme');
  return stored === 'light' ? 'light' : 'dark';
}

export function App(): JSX.Element {
  const [section, setSection] = useState<SectionId>(readInitialSection);
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const [session, setSession] = useState<SessionState>({ kind: 'checking' });
  const [csrfToken, setCsrfToken] = useState<string | null>(readStoredCsrf);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [selectedMissionId, setSelectedMissionIdState] = useState<string | null>(() => {
    try {
      return window.sessionStorage.getItem(MISSION_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  // Mission context survives refresh (session-scoped): the operator returns
  // to the same mission; all data still comes from the server on reload.
  const setSelectedMissionId = useCallback((id: string | null) => {
    setSelectedMissionIdState(id);
    try {
      if (id === null) window.sessionStorage.removeItem(MISSION_STORAGE_KEY);
      else window.sessionStorage.setItem(MISSION_STORAGE_KEY, id);
    } catch {
      /* storage unavailable — selection simply will not persist */
    }
  }, []);
  const [evidenceOperationFilter, setEvidenceOperationFilter] = useState<string | null>(null);
  type MissionContext = Pick<MissionRow, 'id' | 'title' | 'status' | 'created_at'>;
  const [missionTitles, setMissionTitles] = useState<readonly MissionContext[]>([]);
  // Fail-closed mission context (R-final B1): when the operator has selected
  // a mission, surfaces NEVER fall back to another mission while the context
  // list is loading or the selection is absent — executing on the wrong
  // mission is worse than showing the honest selector.
  const missionsForContext =
    selectedMissionId !== null
      ? (missionTitles.find((m) => m.id === selectedMissionId) ?? null)
      : missionTitles.length > 0 && missionTitles[0] !== undefined
        ? missionTitles[0]
        : null;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('moterva-theme', theme);
  }, [theme]);

  useEffect(() => {
    const controller = new AbortController();
    fetchSession(controller.signal)
      .then((info) => {
        setSession(info === null ? { kind: 'signed-out' } : { kind: 'signed-in', session: info });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSession(
          error instanceof ApiError && error.status === 404
            ? { kind: 'unavailable' }
            : { kind: 'signed-out' },
        );
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const onHash = (): void => setSection(readInitialSection());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const handleLogin = (username: string, password: string): void => {
    setLoginBusy(true);
    setLoginError(null);
    setLogoutError(null);
    login(username, password)
      .then((result) => {
        setCsrfToken(result.csrfToken);
        storeCsrf(result.csrfToken);
        return fetchSession();
      })
      .then((info) => {
        setSession(info === null ? { kind: 'signed-out' } : { kind: 'signed-in', session: info });
        setLoginBusy(false);
      })
      .catch((error: unknown) => {
        setLoginError(error instanceof Error ? error.message : 'Sign-in failed');
        setLoginBusy(false);
      });
  };

  const handleLogout = (): void => {
    if (csrfToken === null) return;
    setLogoutError(null);
    logout(csrfToken)
      .then(() => {
        setCsrfToken(null);
        storeCsrf(null);
        setSelectedMissionId(null);
        setSession({ kind: 'signed-out' });
      })
      .catch((error: unknown) => {
        // Server-side session stays valid — never fake a signed-out state.
        setLogoutError(
          `Sign out failed (${error instanceof Error ? error.message : 'unknown error'}) — the session remains active.`,
        );
      });
  };

  /**
   * An authenticated read returned 401 (expired/revoked session): drop the
   * local authenticated state so no financial content remains exposed. The
   * stale CSRF token is cleared with it — it is a session-bound demo detail,
   * not an independent credential (the HttpOnly cookie is the real session).
   */
  const handleSessionExpired = useCallback(() => {
    setCsrfToken(null);
    storeCsrf(null);
    setSelectedMissionId(null);
    setSession({ kind: 'signed-out' });
  }, []);

  // Keep a light mission context for surfaces beyond the Treasury
  // (Evidence Replay) without duplicating the Treasury
  // —s data loading. Refetchable: mission creation must refresh
  // this list, or missionsForContext silently falls back to the FIRST mission
  // and subsequent journeys execute against the WRONG mission (R-final B1
  // acceptance defect).
  const refreshMissionTitles = useCallback((signal?: AbortSignal): void => {
    import('./lib/api')
      .then(({ fetchMissions }) => fetchMissions(signal))
      .then((rows) => setMissionTitles(rows))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (session.kind !== 'signed-in') {
      setMissionTitles([]);
      return;
    }
    const controller = new AbortController();
    refreshMissionTitles(controller.signal);
    return () => controller.abort();
  }, [
    session.kind,
    session.kind === 'signed-in' ? session.session.actor.id : null,
    refreshMissionTitles,
  ]);

  const active = NAV_ITEMS.find((item) => item.id === section) ?? NAV_ITEMS[0];
  if (!active) throw new Error('navigation table is empty');
  const actor = session.kind === 'signed-in' ? session.session.actor : null;

  return (
    <div className="mv-app">
      <a className="mv-skip" href="#main">
        Skip to content
      </a>
      <header className="mv-topbar">
        <div className="mv-topbar__brand">
          <span className="mv-mark" aria-hidden="true">
            ▚
          </span>
          <span className="mv-brand">MOTERVA</span>
          <span className="mv-brand__sub mv-hud">mission financial control</span>
        </div>

        <nav className="mv-nav" aria-label="Primary">
          <ul>
            {NAV_ITEMS.map((item) => (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  aria-current={item.id === active.id ? 'page' : undefined}
                  className={item.id === active.id ? 'is-active' : undefined}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mv-topbar__ops">
          {actor !== null && session.kind === 'signed-in' && session.session.demoAuth && (
            <span
              className="mv-tag mv-tag--demo mv-provenance-chip"
              data-testid="provenance-chip"
              title="This session authenticates against the server's loopback-only DEMO_AUTH gate. Figures are genuine internal ledger records, but the ledger itself is locally seeded demonstration data — not Airwallex funds."
            >
              DEMO_AUTH · seeded internal ledger — not Airwallex funds
            </span>
          )}
          {actor !== null && (
            <span className="mv-actor" data-testid="actor-chip">
              <span className="mv-actor__name">{actor.displayName}</span>
              <span className="mv-actor__role mv-hud">{actor.role}</span>
              <button type="button" className="mv-btn mv-btn--ghost" onClick={handleLogout}>
                Sign out
              </button>
            </span>
          )}
          {logoutError !== null && actor !== null && (
            <span className="mv-actor__error" role="alert">
              {logoutError}
            </span>
          )}
          <button
            type="button"
            className="mv-btn mv-btn--ghost mv-theme-toggle"
            aria-pressed={theme === 'light'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
      </header>

      <nav className="mv-crumb" aria-label="Breadcrumb">
        <ol>
          <li>MOTERVA</li>
          <li aria-current="page">{active.label}</li>
        </ol>
      </nav>

      {/* Mobile provenance banner: same honest copy as the top-bar chip,
          composed for narrow screens instead of a cramped pill. Rendered
          only while the demo gate session is active. */}
      {actor !== null && session.kind === 'signed-in' && session.session.demoAuth && (
        <p className="mv-provenance-banner" data-testid="provenance-banner">
          <span className="mv-provenance-banner__glyph" aria-hidden="true">
            ▚
          </span>
          DEMO_AUTH · seeded internal ledger — not Airwallex funds
        </p>
      )}

      <main className="mv-main" id="main">
        <h1 className="mv-h1">{active.label}</h1>
        {section === 'missions' ? (
          <Treasury
            session={session}
            selectedMissionId={selectedMissionId}
            onSelectMission={setSelectedMissionId}
            onLogin={handleLogin}
            onSessionExpired={handleSessionExpired}
            onInspectEvidence={(operationId, missionId) => {
              setSelectedMissionId(missionId);
              setEvidenceOperationFilter(operationId);
              setSection('evidence');
            }}
            csrfToken={csrfToken}
            onMissionsChanged={refreshMissionTitles}
            loginBusy={loginBusy}
            loginError={loginError}
          />
        ) : section === 'evidence' ? (
          <EvidenceReplay
            session={session}
            mission={missionsForContext}
            operationFilter={evidenceOperationFilter}
            onClearOperationFilter={() => setEvidenceOperationFilter(null)}
          />
        ) : section === 'setup' ? (
          <MissionSetup
            session={session}
            mission={missionsForContext}
            csrfToken={csrfToken}
            onSessionExpired={handleSessionExpired}
          />
        ) : section === 'decisions' ? (
          <DecisionRoom
            session={session}
            mission={missionsForContext}
            csrfToken={csrfToken}
            onSessionExpired={handleSessionExpired}
            onReviewerMissionReady={(missionId) => {
              setSelectedMissionId(missionId);
              refreshMissionTitles();
            }}
          />
        ) : active.id === 'authority' ? (
          <AuthorityExecution
            session={session}
            mission={missionsForContext}
            csrfToken={csrfToken}
            onSessionExpired={handleSessionExpired}
          />
        ) : (
          <PlannedSurface item={active} />
        )}
        <SystemStatusCard />
      </main>

      <footer className="mv-footer">
        <p>
          Read-only operator console · provider integrations are OFFLINE until independently
          verified · hackathon build, no production money movement. Verified state:{' '}
          <a href="https://github.com/CosmasMandikonza/Morteva/blob/main/docs/STATE.md">
            docs/STATE.md
          </a>
          .
        </p>
      </footer>
    </div>
  );
}
