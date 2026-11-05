/**
 * Runtime validation boundary (CTO review 6651660983).
 *
 * TypeScript interfaces do NOT protect the runtime boundary: model-proposed,
 * external and fixture-derived values are UNTRUSTED until proven safe here.
 * Every numeric check requires `typeof === 'number'` + `Number.isFinite`
 * (NaN bypasses range comparisons) and safe-integer semantics for money;
 * every string/enum/array field is shape-checked before use. Monetary sums
 * are range-checked TOGETHER (two individually safe integers can overflow).
 */
import type { FinancialFacts, FinancialPolicy, PlannerCandidate } from './contracts.js';

const MAX = Number.MAX_SAFE_INTEGER;
/** ECMAScript date range: |ms| beyond this is an invalid Date. */
const MAX_DATE_MS = 8.64e15;

export type Validated<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown, max: number): boolean {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function safeNonNegativeInteger(v: unknown): boolean {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** Finite number in [0, 1] — NaN/Infinity fail (NaN comparisons are false). */
function finiteUnit(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

function isoTimestamp(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 40) return false;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS;
}

function stringArray(v: unknown): v is readonly string[] {
  return (
    Array.isArray(v) &&
    v.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 200)
  );
}

const CANDIDATE_KINDS = new Set([
  'continue-supplier',
  'reschedule',
  'purchase-diagnostics',
  'hire-alternative',
  'no-action',
]);
const AVAILABILITIES = new Set(['confirmed', 'unconfirmed']);
const BALANCE_STATUSES = new Set(['ok', 'stale', 'no_snapshot']);

/**
 * Validate one candidate end-to-end. The returned value is the same object,
 * narrowed by proof; on failure the reason states the first violated rule.
 * `costMinor + feeMinor` is checked as a SUM so two individually safe
 * integers cannot overflow into an unsafe gross.
 */
export function validateCandidate(raw: unknown): Validated<PlannerCandidate> {
  if (!isObject(raw)) return { ok: false, reason: 'candidate must be a non-null object' };
  if (!nonEmptyString(raw.id, 200))
    return { ok: false, reason: 'id must be a non-empty string (<=200 chars)' };
  if (!nonEmptyString(raw.label, 300))
    return { ok: false, reason: 'label must be a non-empty string (<=300 chars)' };
  if (typeof raw.kind !== 'string' || !CANDIDATE_KINDS.has(raw.kind))
    return { ok: false, reason: `unknown candidate kind "${String(raw.kind)}"` };
  if (typeof raw.availability !== 'string' || !AVAILABILITIES.has(raw.availability))
    return { ok: false, reason: `unknown availability "${String(raw.availability)}"` };
  if (!nonEmptyString(raw.beneficiary, 200))
    return { ok: false, reason: 'beneficiary must be a non-empty string' };
  if (!nonEmptyString(raw.purpose, 300))
    return { ok: false, reason: 'purpose must be a non-empty string' };
  if (!nonEmptyString(raw.currency, 8))
    return { ok: false, reason: 'currency must be a non-empty string' };
  if (!safeNonNegativeInteger(raw.costMinor))
    return { ok: false, reason: 'costMinor must be a non-negative safe integer' };
  if (!safeNonNegativeInteger(raw.feeMinor))
    return { ok: false, reason: 'feeMinor must be a non-negative safe integer' };
  if ((raw.costMinor as number) + (raw.feeMinor as number) > MAX)
    return { ok: false, reason: 'costMinor + feeMinor exceeds the safe-integer money range' };
  if (
    typeof raw.durationMinutes !== 'number' ||
    !Number.isSafeInteger(raw.durationMinutes) ||
    raw.durationMinutes <= 0
  )
    return { ok: false, reason: 'durationMinutes must be a positive safe integer' };
  if (!isoTimestamp(raw.earliestStartAt))
    return { ok: false, reason: 'earliestStartAt must be a valid ISO timestamp' };
  if (!isoTimestamp(raw.deadlineAt))
    return { ok: false, reason: 'deadlineAt must be a valid ISO timestamp' };
  const finishMs = Date.parse(raw.earliestStartAt) + raw.durationMinutes * 60_000;
  if (!Number.isFinite(finishMs) || Math.abs(finishMs) > MAX_DATE_MS)
    return {
      ok: false,
      reason: 'impossible candidate timing: start + duration leaves the valid Date range',
    };
  if (!finiteUnit(raw.probabilityOfSuccess))
    return { ok: false, reason: 'probabilityOfSuccess must be a finite number in 0..1' };
  if (raw.kind === 'purchase-diagnostics') {
    if (!finiteUnit(raw.informationGain))
      return {
        ok: false,
        reason: 'purchase-diagnostics requires informationGain as a finite number in 0..1',
      };
  } else if (raw.informationGain !== undefined && !finiteUnit(raw.informationGain)) {
    return { ok: false, reason: 'informationGain, when present, must be a finite number in 0..1' };
  }
  if (!Array.isArray(raw.evidenceIds) || !stringArray(raw.evidenceIds))
    return { ok: false, reason: 'evidenceIds must be an array of non-empty strings' };
  if (typeof raw.rationale !== 'string') return { ok: false, reason: 'rationale must be a string' };
  if (raw.requiresAssetId !== undefined && !nonEmptyString(raw.requiresAssetId, 200))
    return { ok: false, reason: 'requiresAssetId must be a non-empty asset identifier when present' };
  if (raw.quoteExpiresAt !== undefined && !isoTimestamp(raw.quoteExpiresAt))
    return { ok: false, reason: 'quoteExpiresAt, when present, must be a valid ISO timestamp' };
  return { ok: true, value: raw as unknown as PlannerCandidate };
}

/** Validate the numeric policy at its trust boundary (issue #8 CTO review). */
export function validatePolicy(raw: unknown): Validated<FinancialPolicy> {
  if (!isObject(raw)) return { ok: false, reason: 'policy must be a non-null object' };
  if (raw.version !== 1) return { ok: false, reason: 'policy.version must be 1' };
  if (!nonEmptyString(raw.currency, 8))
    return { ok: false, reason: 'policy.currency must be a non-empty string' };
  if (!isoTimestamp(raw.missionDeadlineAt))
    return { ok: false, reason: 'policy.missionDeadlineAt must be a valid ISO timestamp' };
  for (const field of [
    'missionValueMinor',
    'failureCostMinor',
    'protectedReserveMinor',
    'escalationScoreGap',
  ] as const) {
    if (!safeNonNegativeInteger(raw[field]))
      return { ok: false, reason: `policy.${field} must be a non-negative safe integer` };
  }
  if (
    typeof raw.maxProbabilityAssumption !== 'number' ||
    !Number.isFinite(raw.maxProbabilityAssumption) ||
    raw.maxProbabilityAssumption <= 0 ||
    raw.maxProbabilityAssumption > 1
  )
    return {
      ok: false,
      reason: 'policy.maxProbabilityAssumption must be a finite number in (0, 1]',
    };
  if (
    typeof raw.unconfirmedAvailabilityFactor !== 'number' ||
    !Number.isFinite(raw.unconfirmedAvailabilityFactor) ||
    raw.unconfirmedAvailabilityFactor < 0 ||
    raw.unconfirmedAvailabilityFactor > 1
  )
    return {
      ok: false,
      reason: 'policy.unconfirmedAvailabilityFactor must be a finite number in [0, 1]',
    };
  if (
    typeof raw.diagnosticValueThreshold !== 'number' ||
    !Number.isFinite(raw.diagnosticValueThreshold) ||
    raw.diagnosticValueThreshold < 0
  )
    return { ok: false, reason: 'policy.diagnosticValueThreshold must be a finite number >= 0' };
  if (typeof raw.forbidUnconfirmedAvailability !== 'boolean')
    return { ok: false, reason: 'policy.forbidUnconfirmedAvailability must be a boolean' };
  return { ok: true, value: raw as unknown as FinancialPolicy };
}

/** Validate the financial-facts snapshot at its trust boundary. */
export function validateFacts(raw: unknown): Validated<FinancialFacts> {
  if (!isObject(raw)) return { ok: false, reason: 'facts must be a non-null object' };
  if (!nonEmptyString(raw.orgId, 200))
    return { ok: false, reason: 'facts.orgId must be a non-empty string' };
  if (!nonEmptyString(raw.missionId, 200))
    return { ok: false, reason: 'facts.missionId must be a non-empty string' };
  if (!nonEmptyString(raw.currency, 8))
    return { ok: false, reason: 'facts.currency must be a non-empty string' };
  if (typeof raw.balanceStatus !== 'string' || !BALANCE_STATUSES.has(raw.balanceStatus))
    return { ok: false, reason: `unknown facts.balanceStatus "${String(raw.balanceStatus)}"` };
  for (const field of ['balanceMinor', 'spendableMinor'] as const) {
    const v = raw[field];
    if (v !== null && !safeNonNegativeInteger(v))
      return { ok: false, reason: `facts.${field} must be null or a non-negative safe integer` };
  }
  if (raw.balanceStatus === 'ok' && typeof raw.spendableMinor !== 'number')
    return { ok: false, reason: 'facts.spendableMinor must be a number when balanceStatus is ok' };
  for (const field of [
    'outstandingCommittedMinor',
    'ambiguousCommittedMinor',
    'protectedFloorMinor',
  ] as const) {
    if (!safeNonNegativeInteger(raw[field]))
      return { ok: false, reason: `facts.${field} must be a non-negative safe integer` };
  }
  const mandate = raw.mandate;
  if (mandate !== null) {
    if (!isObject(mandate)) return { ok: false, reason: 'facts.mandate must be null or an object' };
    if (!nonEmptyString(mandate.id, 200))
      return { ok: false, reason: 'mandate.id must be a non-empty string' };
    if (!safeNonNegativeInteger(mandate.version))
      return { ok: false, reason: 'mandate.version must be a non-negative safe integer' };
    if (!isoTimestamp(mandate.expiresAt))
      return { ok: false, reason: 'mandate.expiresAt must be a valid ISO timestamp' };
    for (const field of ['maxPerPaymentMinor', 'remainingBudgetMinor'] as const) {
      if (!safeNonNegativeInteger(mandate[field]))
        return { ok: false, reason: `mandate.${field} must be a non-negative safe integer` };
    }
    if (!stringArray(mandate.permittedKinds))
      return { ok: false, reason: 'mandate.permittedKinds must be a string array' };
    if (!stringArray(mandate.allowedBeneficiaries))
      return { ok: false, reason: 'mandate.allowedBeneficiaries must be a string array' };
    if (!stringArray(mandate.allowedPurposes))
      return { ok: false, reason: 'mandate.allowedPurposes must be a string array' };
  }
  return { ok: true, value: raw as unknown as FinancialFacts };
}
