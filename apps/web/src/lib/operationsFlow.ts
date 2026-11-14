/**
 * Which evaluation the operator can record NEXT, derived only from facts the
 * server reported (admitted-event count, which snapshots exist). Mirrors the
 * server's stage law (`recordProductionSnapshot`, Agent C):
 *
 *  - baseline  : only while EXACTLY ONE observation has been admitted;
 *  - incident  : needs a recorded baseline AND at least two observations.
 *
 * The consequence of that law is surfaced instead of hidden: if several
 * observations arrive before anyone records a baseline, the baseline window is
 * closed and the UI says so (a requested server-side improvement is tracked on
 * PR #64) — it never lets the operator click into a guaranteed refusal.
 */

export type NextEvaluation =
  | { readonly stage: 'baseline' | 'incident'; readonly again: boolean }
  | {
      readonly stage: null;
      readonly reason:
        'NO_OBSERVATIONS' | 'WAITING_FOR_NEW_OBSERVATION' | 'BASELINE_WINDOW_CLOSED' | 'UNKNOWN';
    };

export function nextEvaluation(input: {
  eventCount: number | null;
  hasBaseline: boolean;
  hasIncident: boolean;
}): NextEvaluation {
  const { eventCount, hasBaseline, hasIncident } = input;
  if (eventCount === null) return { stage: null, reason: 'UNKNOWN' };
  if (eventCount <= 0) return { stage: null, reason: 'NO_OBSERVATIONS' };
  if (!hasBaseline) {
    return eventCount === 1
      ? { stage: 'baseline', again: false }
      : { stage: null, reason: 'BASELINE_WINDOW_CLOSED' };
  }
  if (eventCount === 1) return { stage: null, reason: 'WAITING_FOR_NEW_OBSERVATION' };
  return { stage: 'incident', again: hasIncident };
}

export const NEXT_EVALUATION_COPY: Readonly<Record<string, string>> = {
  NO_OBSERVATIONS:
    'No authenticated observation has been admitted yet, so there is nothing to evaluate. A registered source must submit signed events.',
  WAITING_FOR_NEW_OBSERVATION:
    'The baseline is recorded. Waiting for a new authenticated observation before an incident evaluation can be recorded.',
  BASELINE_WINDOW_CLOSED:
    'Several observations were admitted before a baseline evaluation was recorded, so the baseline window is closed (the server derives the baseline from the first observation only while it is the only one). Contract change requested on PR #64; until then a fresh mission or an earlier evaluation is needed.',
  UNKNOWN: 'The journal could not be read, so the next evaluation cannot be determined.',
};

export function describeEvaluateError(code: string, status: number): string {
  switch (code) {
    case 'NO_PHYSICAL_EVENT_ADMITTED':
      return 'No authenticated observation has been admitted yet — nothing to evaluate.';
    case 'INCIDENT_PHYSICAL_EVENT_REQUIRED':
      return 'An incident evaluation needs a second admitted observation after the baseline.';
    case 'BASELINE_SNAPSHOT_BEFORE_INCIDENT_REQUIRED':
      return 'Record the baseline evaluation first — it can only be recorded while exactly one observation exists.';
    case 'BASELINE_WINDOW_CLOSED':
      return NEXT_EVALUATION_COPY.BASELINE_WINDOW_CLOSED ?? code;
    case 'EVALUATION_REJECTED':
      return 'The server could not record this evaluation. Nothing was stored.';
    case 'NOT_FOUND_OR_UNAVAILABLE':
      return 'The mission is not available to you.';
    default:
      break;
  }
  if (status === 403) return 'Your role cannot record evaluations (operator or above required).';
  if (status === 401) return 'Your session has expired.';
  return `${code} (HTTP ${String(status)})`;
}
