/**
 * Evidence validation — the admission boundary between Agent C's typed
 * mission events and the planner's financial reasoning. Everything here is
 * deterministic and pure.
 */
import type {
  AcceptedEvidence,
  EvidenceRejectionCode,
  EvidenceReview,
  MissionEvidenceInput,
  RejectedEvidence,
} from './contracts.js';

/** Allowed clock skew between source observation and evaluation time. */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

function parseIso(value: unknown, what: string): number {
  if (typeof value !== 'string') throw new Error(`${what} must be an ISO string`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${what} is not a valid ISO timestamp`);
  return ms;
}

/**
 * Review a batch of mission-evidence inputs for ONE tenant/org+mission.
 * Deterministic: acceptance depends only on the batch and `now`.
 */
export function reviewEvidence(
  inputs: readonly MissionEvidenceInput[],
  now: Date,
  tenant: { orgId: string; missionId: string },
): EvidenceReview {
  const accepted: AcceptedEvidence[] = [];
  const rejected: RejectedEvidence[] = [];
  const lastSequenceByAsset = new Map<string, number>();
  const nowMs = now.getTime();

  const sorted = [...inputs].sort((a, b) =>
    a.event.sequence === b.event.sequence
      ? a.event.id.localeCompare(b.event.id)
      : a.event.sequence - b.event.sequence,
  );

  for (const input of sorted) {
    const reject = (code: EvidenceRejectionCode, reason: string): void => {
      rejected.push({ input, code, reason });
    };

    if (input.version !== 1) {
      reject('VERSION_MISMATCH', `evidence contract version ${String(input.version)} is not 1`);
      continue;
    }
    if (input.tenant.orgId !== tenant.orgId || input.tenant.missionId !== tenant.missionId) {
      reject('TENANT_MISMATCH', 'evidence tenant does not match the evaluating tenant');
      continue;
    }
    let observedMs: number;
    let ingestedMs: number;
    try {
      observedMs = parseIso(input.event.observedAt, 'event.observedAt');
      ingestedMs = parseIso(input.event.ingestedAt, 'event.ingestedAt');
    } catch (error) {
      reject('MALFORMED_TIMESTAMP', error instanceof Error ? error.message : String(error));
      continue;
    }
    if (ingestedMs < observedMs) {
      reject(
        'INGESTED_BEFORE_OBSERVED',
        `ingestedAt ${input.event.ingestedAt} precedes observedAt ${input.event.observedAt}`,
      );
      continue;
    }
    if (observedMs - nowMs > MAX_FUTURE_SKEW_MS) {
      reject(
        'FUTURE_OBSERVATION',
        `observedAt ${input.event.observedAt} is in the future beyond allowed skew`,
      );
      continue;
    }
    let notAfterMs: number;
    try {
      notAfterMs = parseIso(input.validity.notAfter, 'validity.notAfter');
    } catch (error) {
      reject('MALFORMED_TIMESTAMP', error instanceof Error ? error.message : String(error));
      continue;
    }
    if (notAfterMs <= nowMs) {
      reject(
        'STALE_VALIDITY',
        `validity expired at ${input.validity.notAfter} (now ${now.toISOString()})`,
      );
      continue;
    }
    const last = lastSequenceByAsset.get(input.asset.id);
    if (last !== undefined && input.event.sequence <= last) {
      reject(
        'SEQUENCE_REGRESSION',
        `sequence ${String(input.event.sequence)} does not advance past ${String(last)} for asset ${input.asset.id}`,
      );
      continue;
    }
    if (typeof input.source.digest !== 'string' || input.source.digest === '') {
      reject('EMPTY_DIGEST', 'source.digest must be a non-empty string');
      continue;
    }
    const range = constraintRangeError(input);
    if (range !== null) {
      reject('CONSTRAINT_OUT_OF_RANGE', range);
      continue;
    }
    lastSequenceByAsset.set(input.asset.id, input.event.sequence);
    accepted.push({ input, acceptedAt: now.toISOString() });
  }

  return {
    accepted,
    rejected,
    contradictions: detectContradictions(accepted),
  };
}

function constraintRangeError(input: MissionEvidenceInput): string | null {
  const c = input.constraint;
  switch (c.kind) {
    case 'weather-window': {
      const open = Date.parse(c.windowOpensAt);
      const close = Date.parse(c.windowClosesAt);
      if (!Number.isFinite(open) || !Number.isFinite(close))
        return 'weather window timestamps malformed';
      if (close <= open) return 'weather window closes before it opens';
      if (c.confidence < 0 || c.confidence > 1) return 'weather confidence outside 0..1';
      return null;
    }
    case 'contractor-delay':
      if (!Number.isFinite(c.delayMinutes) || c.delayMinutes <= 0)
        return 'delay must be positive minutes';
      return null;
    case 'diagnostic-finding':
      if (!['low', 'medium', 'high'].includes(c.severity))
        return 'severity must be low|medium|high';
      return null;
    case 'asset-safety': {
      if (!['clear', 'blocked', 'unknown'].includes(c.state))
        return 'asset safety state must be clear, blocked or unknown';
      if (
        ![
          'wind-limit',
          'weather-hold',
          'comms-offline',
          'insufficient-evidence',
          'nominal',
        ].includes(c.reason)
      )
        return 'unknown physical safety reason';
      if (
        c.observedWindKt !== undefined &&
        (!Number.isFinite(c.observedWindKt) || c.observedWindKt < 0)
      )
        return 'invalid observed wind';
      if (c.maxWindKt !== undefined && (!Number.isFinite(c.maxWindKt) || c.maxWindKt <= 0))
        return 'invalid modeled wind threshold';
      return null;
    }
    case 'deadline-change': {
      const d = Date.parse(c.newDeadline);
      if (!Number.isFinite(d)) return 'new deadline malformed';
      return null;
    }
    default:
      return 'unknown constraint kind';
  }
}

/**
 * Contradiction detection over ACCEPTED evidence: same-kind constraints that
 * cannot both hold. Detected contradictions never pick a side — they force
 * escalation upstream.
 */
export function detectContradictions(
  accepted: readonly AcceptedEvidence[],
): { a: string; b: string; reason: string }[] {
  const contradictions: { a: string; b: string; reason: string }[] = [];
  // deadline-change: two different accepted deadlines for the same asset.
  const deadlines = new Map<string, { eventId: string; newDeadline: string }[]>();
  for (const item of accepted) {
    if (item.input.constraint.kind !== 'deadline-change') continue;
    const list = deadlines.get(item.input.asset.id) ?? [];
    list.push({ eventId: item.input.event.id, newDeadline: item.input.constraint.newDeadline });
    deadlines.set(item.input.asset.id, list);
  }
  for (const [assetId, list] of deadlines) {
    for (let i = 1; i < list.length; i += 1) {
      if (list[i]!.newDeadline !== list[0]!.newDeadline) {
        contradictions.push({
          a: list[0]!.eventId,
          b: list[i]!.eventId,
          reason: `two different accepted deadlines for asset ${assetId} (${list[0]!.newDeadline} vs ${list[i]!.newDeadline})`,
        });
      }
    }
  }
  // weather-window: two windows for the same asset that overlap in time but
  // disagree on closure by more than the earlier close.
  const windows = accepted.filter((a) => a.input.constraint.kind === 'weather-window');
  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      const a = windows[i]!.input;
      const b = windows[j]!.input;
      if (a.asset.id !== b.asset.id) continue;
      const ca = a.constraint as { windowClosesAt: string };
      const cb = b.constraint as { windowClosesAt: string };
      const oa = a.constraint as { windowOpensAt: string };
      const ob = b.constraint as { windowOpensAt: string };
      const aStart = Date.parse(oa.windowOpensAt);
      const aEnd = Date.parse(ca.windowClosesAt);
      const bStart = Date.parse(ob.windowOpensAt);
      const bEnd = Date.parse(cb.windowClosesAt);
      const overlaps = aStart < bEnd && bStart < aEnd;
      const disagree =
        ca.windowClosesAt !== cb.windowClosesAt || oa.windowOpensAt !== ob.windowOpensAt;
      if (overlaps && disagree) {
        contradictions.push({
          a: a.event.id,
          b: b.event.id,
          reason: `overlapping weather windows for asset ${a.asset.id} disagree on bounds`,
        });
      }
    }
  }
  return contradictions;
}
