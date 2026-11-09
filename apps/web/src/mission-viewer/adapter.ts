/**
 * Server read-model adapter (MTV-09/12, C2).
 *
 * Maps the EXACT server physical-view payload (Agent A's read endpoint per
 * `contract/planner-endpoint-request.v1.md`; the field set mirrors
 * `MissionTimelineView`'s accepted-event view, which the fixtures are
 * generated from) into the viewer snapshot — with strict validation that
 * FAILS CLOSED: any missing field, wrong type, or unknown provenance throws
 * `PhysicalViewShapeError` so the host can render an honest unavailable
 * state instead of a half-trusted scene. No coercion, no defaults for
 * evidence fields.
 *
 * This module performs NO fetching. The host calls its own API and passes
 * the parsed JSON here.
 */
import type {
  PhysicalFreshness,
  PhysicalProvenance,
  PhysicalViewAsset,
  PhysicalViewEvent,
  PhysicalViewSnapshot,
} from './contract.js';

export class PhysicalViewShapeError extends Error {
  constructor(message: string) {
    super(`physical-view payload rejected: ${message}`);
    this.name = 'PhysicalViewShapeError';
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX64 = /^[0-9a-f]{64}$/;
const FRESHNESS: readonly PhysicalFreshness[] = ['fresh', 'stale', 'expired'];
const PROVENANCE: readonly PhysicalProvenance[] = ['SYNTHETIC', 'FIELD'];
const KINDS: readonly string[] = ['aerial', 'surface', 'ground'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reqString(obj: Record<string, unknown>, field: string, where: string): string {
  const v = obj[field];
  if (typeof v !== 'string' || v === '') {
    throw new PhysicalViewShapeError(`${where}.${field} must be a non-empty string`);
  }
  return v;
}

function reqIso(obj: Record<string, unknown>, field: string, where: string): string {
  const v = reqString(obj, field, where);
  if (!ISO.test(v)) {
    throw new PhysicalViewShapeError(`${where}.${field} is not an ISO-8601 UTC timestamp`);
  }
  return v;
}

function reqInt(obj: Record<string, unknown>, field: string, where: string): number {
  const v = obj[field];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new PhysicalViewShapeError(`${where}.${field} must be a non-negative safe integer`);
  }
  return v;
}

function reqEnum<T extends string>(
  obj: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  where: string,
): T {
  const v = obj[field];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new PhysicalViewShapeError(
      `${where}.${field} must be one of ${allowed.join(', ')} (got ${String(v)})`,
    );
  }
  return v as T;
}

/**
 * Validate one observation pair. `value` may be a number (integer kinds) or
 * a string (decimal-string kinds per the ingest contract) — both travel the
 * wire exactly as admitted.
 */
function obsOf(
  raw: unknown,
  where: string,
): { kind: string; unit: string; value: number | string } {
  if (!isRecord(raw)) throw new PhysicalViewShapeError(`${where} must be an object`);
  const kind = reqString(raw, 'kind', where);
  const unit = reqString(raw, 'unit', where);
  const value = raw['value'];
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new PhysicalViewShapeError(`${where}.value must be a number or string`);
  }
  return { kind, unit, value };
}

/**
 * Strictly map a server payload to the viewer snapshot. Throws
 * `PhysicalViewShapeError` on any deviation — the caller renders an honest
 * unavailable state; a partially-trusted scene is never shown.
 */
export function snapshotFromServerPayload(payload: unknown): PhysicalViewSnapshot {
  if (!isRecord(payload)) throw new PhysicalViewShapeError('payload must be an object');
  if (payload['contractVersion'] !== 1) {
    throw new PhysicalViewShapeError('contractVersion must be 1');
  }
  const tenant = payload['tenant'];
  if (!isRecord(tenant)) throw new PhysicalViewShapeError('tenant must be an object');
  const orgId = reqString(tenant, 'orgId', 'tenant');
  const missionId = reqString(tenant, 'missionId', 'tenant');

  const policyRaw = payload['policy'];
  if (!isRecord(policyRaw)) throw new PhysicalViewShapeError('policy must be an object');
  const policy = {
    maxAgeMs: reqInt(policyRaw, 'maxAgeMs', 'policy'),
    expiredMs: reqInt(policyRaw, 'expiredMs', 'policy'),
    uavAssetId: reqString(policyRaw, 'uavAssetId', 'policy'),
    uavWindLimitKt: (() => {
      const v = policyRaw['uavWindLimitKt'];
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new PhysicalViewShapeError('policy.uavWindLimitKt must be a positive finite number');
      }
      return v;
    })(),
  };
  if (policy.expiredMs < policy.maxAgeMs) {
    throw new PhysicalViewShapeError('policy.expiredMs must be >= policy.maxAgeMs');
  }

  const assetsRaw = payload['assets'];
  if (!Array.isArray(assetsRaw) || assetsRaw.length === 0) {
    throw new PhysicalViewShapeError('assets must be a non-empty array');
  }
  const assetIds = new Set<string>();
  const assets: PhysicalViewAsset[] = assetsRaw.map((raw, i) => {
    const where = `assets[${i}]`;
    if (!isRecord(raw)) throw new PhysicalViewShapeError(`${where} must be an object`);
    const assetId = reqString(raw, 'assetId', where);
    if (assetIds.has(assetId)) throw new PhysicalViewShapeError(`duplicate assetId "${assetId}"`);
    assetIds.add(assetId);
    const kind = reqEnum(
      raw,
      'kind',
      KINDS as readonly (typeof KINDS)[number][] as readonly string[],
      where,
    );
    const out: { assetId: string; kind: PhysicalViewAsset['kind']; label?: string } = {
      assetId,
      kind: kind as PhysicalViewAsset['kind'],
    };
    if (raw['label'] !== undefined) out.label = reqString(raw, 'label', where);
    return out;
  });
  if (!assetIds.has(policy.uavAssetId)) {
    throw new PhysicalViewShapeError('policy.uavAssetId is not present in assets');
  }

  // v1.1 wire: the server bounds the payload to the 50 most recent events
  // (recentEvents) — the journal remains the full durable history.
  const eventsRaw = payload['recentEvents'];
  if (!Array.isArray(eventsRaw)) throw new PhysicalViewShapeError('recentEvents must be an array');
  const events: PhysicalViewEvent[] = eventsRaw.map((raw, i) => {
    const where = `events[${i}]`;
    if (!isRecord(raw)) throw new PhysicalViewShapeError(`${where} must be an object`);
    const eventId = reqString(raw, 'eventId', where);
    const assetId = reqString(raw, 'assetId', where);
    if (!assetIds.has(assetId)) {
      throw new PhysicalViewShapeError(`${where}.assetId "${assetId}" is not a registered asset`);
    }
    const observationsRaw = raw['observations'];
    if (!Array.isArray(observationsRaw) || observationsRaw.length === 0) {
      throw new PhysicalViewShapeError(`${where}.observations must be a non-empty array`);
    }
    return {
      eventId,
      journalSeq: reqInt(raw, 'journalSeq', where),
      sequence: reqInt(raw, 'sequence', where),
      assetId,
      sourceId: reqString(raw, 'sourceId', where),
      sourceType: reqString(raw, 'sourceType', where),
      provenance: reqEnum(raw, 'provenance', PROVENANCE, where),
      observedAt: reqIso(raw, 'observedAt', where),
      ingestedAt: reqIso(raw, 'ingestedAt', where),
      recordedAt: reqIso(raw, 'recordedAt', where),
      eventDigest: (() => {
        const v = reqString(raw, 'eventDigest', where);
        if (!HEX64.test(v)) {
          throw new PhysicalViewShapeError(`${where}.eventDigest must be 64-hex (sha256)`);
        }
        return v;
      })(),
      observations: observationsRaw.map((o, j) => obsOf(o, `${where}.observations[${j}]`)),
      freshness: reqEnum(raw, 'freshness', FRESHNESS, where),
      planningValid: (() => {
        const v = raw['planningValid'];
        if (typeof v !== 'boolean') {
          throw new PhysicalViewShapeError(`${where}.planningValid must be boolean`);
        }
        return v;
      })(),
    };
  });

  const asOf = reqIso(payload, 'asOf', 'payload');
  const truthLabel = reqString(payload, 'truthLabel', 'payload');

  return {
    contractVersion: 1,
    tenant: { orgId, missionId },
    asOf,
    truthLabel,
    policy,
    assets,
    recentEvents: events,
  };
}

/**
 * Convenience for hosts that already hold a trusted in-process view
 * (compiled module or fixture loader): validate then return. Never used to
 * synthesize data — input must already be real replay output.
 */
export function isPhysicalViewSnapshot(value: unknown): value is PhysicalViewSnapshot {
  try {
    snapshotFromServerPayload(value);
    return true;
  } catch {
    return false;
  }
}
