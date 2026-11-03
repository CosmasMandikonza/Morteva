import type { SystemStatusView } from '@moterva/domain';

export type SystemStatusState =
  | { kind: 'loading' }
  | { kind: 'ok'; status: SystemStatusView }
  | { kind: 'error'; message: string };

export async function fetchSystemStatus(signal?: AbortSignal): Promise<SystemStatusView> {
  const response = await fetch('/api/system/status', {
    signal,
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`API responded with HTTP ${String(response.status)}`);
  }
  return (await response.json()) as SystemStatusView;
}
