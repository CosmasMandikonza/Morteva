import type { AppConfig } from '../config.js';
import { API_VERSION, SERVICE_NAME } from '../version.js';

export interface HealthView {
  readonly status: 'ok';
  readonly service: string;
  readonly version: string;
  readonly time: string;
  readonly providerMode: AppConfig['providerMode'];
  readonly gitSha?: string;
}

/** Liveness probe: process is up. Never claims provider integration state. */
export function healthView(config: AppConfig): HealthView {
  return {
    status: 'ok',
    service: SERVICE_NAME,
    version: API_VERSION,
    time: new Date().toISOString(),
    providerMode: config.providerMode,
    ...(config.gitSha !== undefined ? { gitSha: config.gitSha } : {}),
  };
}
