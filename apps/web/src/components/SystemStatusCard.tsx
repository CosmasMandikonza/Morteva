import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { fetchSystemStatus, type SystemStatus } from '../lib/api';
import { Panel, SkeletonRows } from './Panel';

type State =
  { kind: 'loading' } | { kind: 'ok'; status: SystemStatus } | { kind: 'error'; message: string };

/**
 * Renders the API's system status verbatim. The API owns the honest labels
 * (OFFLINE / DEMO_SIMULATED); this component never upgrades them.
 */
export function SystemStatusCard(): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });

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
    <Panel
      title="System status"
      meta={<span className="mv-tag">read-only</span>}
      testId="system-status"
    >
      {state.kind === 'loading' && <SkeletonRows rows={2} />}
      {state.kind === 'error' && (
        <div role="alert" className="mv-alert" data-testid="system-status-error">
          <p className="mv-alert__title">API offline</p>
          <p className="mv-alert__body">
            Cannot reach <code>/api/system/status</code> — {state.message}. Start the API (
            <code>npm run dev</code>) and retry.
          </p>
          <button type="button" className="mv-btn" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {state.kind === 'ok' && (
        <div className="mv-status">
          <p className="mv-status__meta">
            API v{state.status.version} · provider mode{' '}
            <code className="mv-num">{state.status.providerMode}</code>
          </p>
          <ul className="mv-providers">
            {state.status.providers.map((provider) => (
              <li className="mv-provider" key={provider.id}>
                <div className="mv-provider__row">
                  <span className="mv-provider__name">{provider.id}</span>
                  <span className={`mv-badge mv-badge--${provider.label.toLowerCase()}`}>
                    {provider.label}
                  </span>
                </div>
                <p className="mv-provider__detail">{provider.detail}</p>
              </li>
            ))}
          </ul>
          <p className="mv-status__notice" data-testid="simulation-notice">
            {state.status.simulationNotice}
          </p>
        </div>
      )}
    </Panel>
  );
}
