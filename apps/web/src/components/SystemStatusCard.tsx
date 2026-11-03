import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { fetchSystemStatus } from '../api';
import type { SystemStatusState } from '../api';

/**
 * Renders the API's system status verbatim. The API owns the honest labels
 * (OFFLINE / DEMO_SIMULATED); this component never upgrades them.
 */
export function SystemStatusCard(): JSX.Element {
  const [state, setState] = useState<SystemStatusState>({ kind: 'loading' });

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ kind: 'loading' });
    try {
      const status = await fetchSystemStatus(signal);
      setState({ kind: 'ok', status });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unknown error reaching the API.',
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <section className="status-card" aria-labelledby="system-status-heading" aria-live="polite">
      <div className="status-card__head">
        <h2 id="system-status-heading">System status</h2>
        <span className="chip">read-only</span>
      </div>
      {state.kind === 'loading' && <p className="status-card__loading">Checking MOTERVA API…</p>}
      {state.kind === 'error' && (
        <div role="alert" className="status-card__error">
          <p>
            <strong>API offline</strong> — cannot reach the MOTERVA API at{' '}
            <code>/api/system/status</code>.
          </p>
          <p className="status-card__detail">
            {state.message}. Start it with <code>npm run dev</code> (or check configuration) and
            retry.
          </p>
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {state.kind === 'ok' && (
        <div className="status-card__body">
          <p className="status-card__meta">
            API v{state.status.version} · provider mode <code>{state.status.providerMode}</code>
          </p>
          <ul className="provider-list">
            {state.status.providers.map((provider) => (
              <li key={provider.id} className="provider">
                <div className="provider__row">
                  <span className="provider__name">{provider.id}</span>
                  <span className={`badge badge--${provider.label.toLowerCase()}`}>
                    {provider.label}
                  </span>
                </div>
                <p className="provider__detail">{provider.detail}</p>
              </li>
            ))}
          </ul>
          <p className="status-card__notice" data-testid="simulation-notice">
            {state.status.simulationNotice}
          </p>
        </div>
      )}
    </section>
  );
}
