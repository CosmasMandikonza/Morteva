import { randomUUID } from 'node:crypto';

/** Stable prefixed ids keep persisted rows self-describing in logs and evidence. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
