import { ApiError, fetchPhysicalView, type FieldObservationEvent } from './api';

/**
 * Field-journal read model. The sanitized admitted events come from
 * `GET /operations/decision` when the API offers them, otherwise from the
 * authenticated `physical-view` (same typed allowlist). Every value is parsed
 * defensively — a malformed entry is dropped, never repaired or invented.
 */

export interface ConstraintView {
  readonly assetId: string;
  readonly state: string;
  readonly reason: string;
  readonly basis: string;
}

export type FieldState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly events: readonly FieldObservationEvent[];
      readonly constraints: readonly ConstraintView[];
    }
  | { readonly kind: 'unavailable'; readonly code: string };

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function eventsFromPayload(payload: Record<string, unknown>): {
  events: FieldObservationEvent[];
  constraints: ConstraintView[];
} {
  const rawEvents = Array.isArray(payload.events) ? (payload.events as unknown[]) : [];
  const events: FieldObservationEvent[] = [];
  for (const raw of rawEvents) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (str(e.eventId) === '') continue;
    const observations = Array.isArray(e.observations)
      ? (e.observations as unknown[]).flatMap((o) => {
          if (typeof o !== 'object' || o === null) return [];
          const x = o as Record<string, unknown>;
          if (typeof x.kind !== 'string' || typeof x.unit !== 'string') return [];
          if (typeof x.value !== 'string' && typeof x.value !== 'number') return [];
          return [{ kind: x.kind, unit: x.unit, value: x.value }];
        })
      : [];
    events.push({
      eventId: str(e.eventId),
      journalSeq: typeof e.journalSeq === 'number' ? e.journalSeq : undefined,
      sequence: typeof e.sequence === 'number' ? e.sequence : 0,
      assetId: str(e.assetId),
      sourceId: str(e.sourceId),
      sourceType: str(e.sourceType),
      provenance: str(e.provenance),
      observedAt: str(e.observedAt),
      eventDigest: str(e.eventDigest),
      observations,
      freshnessAtSnapshot: str(e.freshnessAtSnapshot),
      planningValidAtSnapshot:
        typeof e.planningValidAtSnapshot === 'boolean' ? e.planningValidAtSnapshot : undefined,
    });
  }
  const rawConstraints = Array.isArray(payload.constraints)
    ? (payload.constraints as unknown[])
    : [];
  const constraints: ConstraintView[] = rawConstraints.flatMap((raw) => {
    if (typeof raw !== 'object' || raw === null) return [];
    const c = raw as Record<string, unknown>;
    return [
      { assetId: str(c.assetId), state: str(c.state), reason: str(c.reason), basis: str(c.basis) },
    ];
  });
  return { events, constraints };
}

/** Read the authenticated event list; 401 is rethrown for the session handler. */
export async function loadFieldEvents(missionId: string, signal: AbortSignal): Promise<FieldState> {
  try {
    const payload = await fetchPhysicalView(missionId, signal);
    const { events, constraints } = eventsFromPayload(payload);
    return { kind: 'ready', events, constraints };
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 401) throw reason;
    return { kind: 'unavailable', code: reason instanceof ApiError ? reason.code : 'NETWORK' };
  }
}

/** Newest admitted event (journal order) — used to seed viewer selection. */
export function newestEvent(
  events: readonly FieldObservationEvent[],
): FieldObservationEvent | null {
  let best: FieldObservationEvent | null = null;
  for (const e of events) {
    if (best === null || (e.journalSeq ?? e.sequence) > (best.journalSeq ?? best.sequence))
      best = e;
  }
  return best;
}
