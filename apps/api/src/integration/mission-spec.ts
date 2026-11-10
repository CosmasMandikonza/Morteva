/**
 * General mission specification contract v1 (C1 — general mission
 * orchestrator). A narrow, versioned, DURABLE statement of what one mission
 * IS, so the same planner/ledger/approval/provider machinery serves any
 * physical industry without harbor values living in shared integration
 * logic and without a general-purpose workflow language.
 *
 * WHAT A SPEC DECLARES (and nothing more):
 *  - identity/objective (org + mission + human-readable objective),
 *  - explicitly registered assets with their physical DOMAIN kind,
 *  - the trusted event sources (already validated by the SourceRegistry
 *    shape) and their provenance,
 *  - the domain safety-policy version and WHO may declare clearance
 *    (deterministic code over admitted events — NEVER a model, never text),
 *  - deadline and economic assumptions (value, failure cost, reserve),
 *  - configured supplier/service offers with quote validity and the
 *    beneficiary identity each payment would use,
 *  - the financial mandate shape the mission expects (currency + permitted
 *    beneficiaries/purposes) — authority itself still lives ONLY in the
 *    ledger's mandate records.
 *
 * DURABILITY + REPLAY LINEAGE: a registration is journaled ONCE per
 * (mission, specId) through the append-only evidence journal (float-free
 * payload, canonicalJson digest, idempotent event key), so every decision
 * snapshot can carry `specId + specDigest` and any restart replays the same
 * spec. Re-registering the SAME specId with a DIFFERENT payload is refused —
 * spec evolution means a NEW specId (specs are immutable history).
 *
 * TRUTH LABELS: a spec is SYNTHETIC demo configuration unless provenance
 * says otherwise; every field is an explicit operator assumption. Nothing
 * here grants spending, approval, reservation, provider or clearance
 * authority: the ledger disposes, deterministic policy code decides.
 */
import type { Ledger } from '@moterva/ledger';
import { isLedgerError } from '@moterva/ledger';
import { canonicalJson } from '@moterva/domain';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { SupplierOffer } from '@moterva/planner';
import { guard } from '../auth.js';
import type { ProvenanceLabel, SourceType } from '../mission-events/src/vocabulary.js';

export const MISSION_SPEC_TYPE = 'mission.spec.registered';
export const MISSION_SPEC_VERSION = 1;

/** Physical domain kind of a registered asset (drives which safety rules apply). */
export type AssetDomainKind = 'aerial' | 'ground' | 'surface';

/** A supplier offer bound to THIS mission's spec (asset requirement included). */
export type SpecOffer = SupplierOffer & {
  /** Asset whose operational clearance is required to use this offer. */
  readonly requiresAssetId?: string;
};

export interface MissionSpecification {
  readonly specVersion: 1;
  /** Immutable spec identity — evolution means a NEW specId, never a rewrite. */
  readonly specId: string;
  /** Industry discriminator for the product surface (Agent B), NOT a code branch. */
  readonly industry: 'maritime-uav' | 'warehouse-amr';
  readonly identity: {
    readonly orgId: string;
    readonly missionId: string;
    readonly title: string;
    readonly objective: string;
  };
  readonly assets: readonly {
    readonly assetId: string;
    readonly domainKind: AssetDomainKind;
    readonly label: string;
  }[];
  readonly sources: readonly {
    readonly sourceId: string;
    readonly sourceType: SourceType;
    /** Assets this source may report for (SourceRegistry law preserved). */
    readonly assetIds: readonly string[];
    readonly trustedForRecovery: boolean;
    readonly provenance: ProvenanceLabel;
  }[];
  readonly safetyPolicy: {
    readonly version: number;
    /**
     * WHO declares clearance: always deterministic code over admitted
     * journal events. This field is a LABEL of the authority, never a grant.
     */
    readonly clearanceAuthority: 'deterministic-domain-policy';
    /** AERIAL-only modeled limit. MUST be absent unless an aerial asset exists. */
    readonly uavWindLimitKt?: number;
    /** Ground interrupting conditions this spec admits. Ground rules NEVER
     *  inherit wind/hold semantics; comms stays domain-neutral. */
    readonly groundInterrupts?: readonly ('aisle-obstructed' | 'charger-fault')[];
  };
  readonly economics: {
    readonly currency: string;
    readonly missionValueMinor: number;
    readonly failureCostMinor: number;
    readonly protectedReserveMinor: number;
    /** Mission deadline = evaluation time + this offset (operator assumption). */
    readonly deadlineOffsetMinutes: number;
  };
  readonly offers: {
    readonly incumbent: SpecOffer;
    readonly alternatives: readonly SpecOffer[];
    readonly diagnostics?: SpecOffer;
  };
  /** Expected mandate shape — the ledger mandate remains the ONLY authority. */
  readonly financialMandateShape: {
    readonly currency: string;
    readonly allowedBeneficiaries: readonly string[];
    readonly allowedPurposes: readonly string[];
  };
  readonly truthLabel: string;
}

export class MissionSpecError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MissionSpecError';
  }
}

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

type WireOffer = Omit<SpecOffer, 'probabilityOfSuccess'> & {
  readonly probabilityOfSuccessBps: number;
};

interface SpecWire extends Omit<MissionSpecification, 'offers'> {
  readonly offers: {
    readonly incumbent: WireOffer;
    readonly alternatives: readonly WireOffer[];
    readonly diagnostics?: WireOffer;
  };
}

/**
 * FLOAT-FREE wire encoding for the journal (canonicalJson forbids floats):
 * probabilities become integer basis points. The digest is computed over the
 * WIRE form, so journal integrity checks and `specDigest` lineage agree.
 */
function specToWire(spec: MissionSpecification): SpecWire {
  const toWireOffer = (o: SpecOffer): WireOffer => {
    const { probabilityOfSuccess, ...rest } = o;
    return {
      ...rest,
      probabilityOfSuccessBps: Math.round(probabilityOfSuccess * 10_000),
    };
  };
  return {
    ...spec,
    offers: {
      incumbent: toWireOffer(spec.offers.incumbent),
      alternatives: spec.offers.alternatives.map(toWireOffer),
      ...(spec.offers.diagnostics !== undefined
        ? { diagnostics: toWireOffer(spec.offers.diagnostics) }
        : {}),
    },
  };
}

function specFromWire(wire: SpecWire): MissionSpecification {
  const fromWireOffer = (o: WireOffer): SpecOffer => {
    const { probabilityOfSuccessBps, ...rest } = o;
    return { ...rest, probabilityOfSuccess: probabilityOfSuccessBps / 10_000 };
  };
  return {
    ...wire,
    offers: {
      incumbent: fromWireOffer(wire.offers.incumbent),
      alternatives: wire.offers.alternatives.map(fromWireOffer),
      ...(wire.offers.diagnostics !== undefined
        ? { diagnostics: fromWireOffer(wire.offers.diagnostics) }
        : {}),
    },
  };
}

/** Canonical digest of a spec (over its float-free wire encoding). */
export function missionSpecDigest(spec: MissionSpecification): string {
  return sha(canonicalJson(specToWire(spec) as unknown as Record<string, unknown>));
}

const SPEC_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

/**
 * Fail-closed structural validation. Every violation is an explicit machine
 * code — a half-valid spec is never registered or served.
 */
export function validateMissionSpec(raw: unknown): MissionSpecification {
  const s = raw as MissionSpecification;
  const fail = (code: string, m: string): never => {
    throw new MissionSpecError(code, m);
  };
  if (typeof s !== 'object' || s === null) fail('SPEC_MALFORMED', 'spec must be an object');
  if (s.specVersion !== 1) fail('SPEC_VERSION_UNSUPPORTED', `specVersion ${String(s.specVersion)}`);
  if (typeof s.specId !== 'string' || !SPEC_ID_RE.test(s.specId)) {
    fail('SPEC_ID_INVALID', 'specId must be kebab-case (3-64 chars)');
  }
  if (s.industry !== 'maritime-uav' && s.industry !== 'warehouse-amr') {
    fail('SPEC_INDUSTRY_UNKNOWN', `industry "${String(s.industry)}"`);
  }
  const { identity, assets, sources, safetyPolicy, economics, offers, financialMandateShape } = s;
  if (
    typeof identity?.orgId !== 'string' ||
    identity.orgId === '' ||
    typeof identity?.missionId !== 'string' ||
    identity.missionId === '' ||
    typeof identity?.title !== 'string' ||
    identity.title === '' ||
    typeof identity?.objective !== 'string' ||
    identity.objective === ''
  ) {
    fail('SPEC_IDENTITY_INCOMPLETE', 'identity requires orgId, missionId, title, objective');
  }
  if (!Array.isArray(assets) || assets.length === 0 || assets.length > 20) {
    fail('SPEC_ASSETS_EMPTY', '1-20 assets required');
  }
  const assetIds = new Set<string>();
  let hasAerial = false;
  let hasGround = false;
  for (const a of assets) {
    if (typeof a?.assetId !== 'string' || a.assetId === '') {
      fail('SPEC_ASSET_ID_INVALID', 'every asset needs a non-empty assetId');
    }
    if (assetIds.has(a.assetId)) fail('SPEC_ASSET_DUPLICATE', `asset ${a.assetId} duplicated`);
    assetIds.add(a.assetId);
    if (!['aerial', 'ground', 'surface'].includes(a.domainKind)) {
      fail('SPEC_ASSET_DOMAIN_INVALID', `asset ${a.assetId} domainKind "${String(a.domainKind)}"`);
    }
    if (a.domainKind === 'aerial') hasAerial = true;
    if (a.domainKind === 'ground') hasGround = true;
    if (typeof a?.label !== 'string' || a.label === '') {
      fail('SPEC_ASSET_LABEL_INVALID', `asset ${a.assetId} needs a label`);
    }
  }
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > 20) {
    fail('SPEC_SOURCES_EMPTY', '1-20 trusted sources required');
  }
  for (const src of sources) {
    if (typeof src?.sourceId !== 'string' || src.sourceId === '') {
      fail('SPEC_SOURCE_ID_INVALID', 'every source needs a sourceId');
    }
    if (
      ![
        'asset_telemetry',
        'mission_control',
        'vessel_gateway',
        'warehouse_wms',
        'simulator',
      ].includes(src.sourceType)
    ) {
      fail('SPEC_SOURCE_TYPE_INVALID', `source ${src.sourceId} type "${String(src.sourceType)}"`);
    }
    if (
      !Array.isArray(src.assetIds) ||
      src.assetIds.length === 0 ||
      src.assetIds.some((id: string) => !assetIds.has(id))
    ) {
      fail('SPEC_SOURCE_ASSET_UNKNOWN', `source ${src.sourceId} references unregistered assets`);
    }
    if (src.sourceType === 'asset_telemetry' && src.assetIds.length !== 1) {
      fail('SPEC_TELEMETRY_SOURCE_NOT_SINGLE_ASSET', `source ${src.sourceId}`);
    }
    if (src.trustedForRecovery !== true && src.trustedForRecovery !== false) {
      fail('SPEC_SOURCE_RECOVERY_FLAG_INVALID', `source ${src.sourceId}`);
    }
    if (src.provenance !== 'SYNTHETIC' && src.provenance !== 'FIELD') {
      fail('SPEC_SOURCE_PROVENANCE_INVALID', `source ${src.sourceId}`);
    }
  }
  if (typeof safetyPolicy?.version !== 'number' || safetyPolicy.version < 1) {
    fail('SPEC_POLICY_VERSION_INVALID', 'safetyPolicy.version >= 1 required');
  }
  if (safetyPolicy.clearanceAuthority !== 'deterministic-domain-policy') {
    fail(
      'SPEC_CLEARANCE_AUTHORITY_INVALID',
      'clearance is declared by deterministic domain policy only',
    );
  }
  // Domain safety isolation, structurally enforced: a spec with NO aerial
  // asset must not carry a wind limit (ground policies never inherit UAV
  // rules); a spec WITH an aerial asset must declare one.
  if (hasAerial) {
    if (
      typeof safetyPolicy.uavWindLimitKt !== 'number' ||
      !Number.isFinite(safetyPolicy.uavWindLimitKt) ||
      safetyPolicy.uavWindLimitKt <= 0 ||
      safetyPolicy.uavWindLimitKt > 200
    ) {
      fail('SPEC_WIND_LIMIT_REQUIRED', 'aerial assets require a modeled uavWindLimitKt (0-200]');
    }
  } else if (safetyPolicy.uavWindLimitKt !== undefined) {
    fail('SPEC_WIND_LIMIT_FORBIDDEN', 'no aerial asset registered — a wind limit must not exist');
  }
  if (
    hasGround &&
    (safetyPolicy.groundInterrupts === undefined || safetyPolicy.groundInterrupts.length === 0)
  ) {
    fail(
      'SPEC_GROUND_INTERRUPTS_REQUIRED',
      'ground assets require declared interrupting conditions',
    );
  }
  if (!hasGround && safetyPolicy.groundInterrupts !== undefined) {
    fail(
      'SPEC_GROUND_INTERRUPTS_FORBIDDEN',
      'no ground asset registered — ground interrupts must not exist',
    );
  }
  if (
    typeof economics?.currency !== 'string' ||
    economics.currency.length !== 3 ||
    typeof economics?.missionValueMinor !== 'number' ||
    !Number.isSafeInteger(economics.missionValueMinor) ||
    economics.missionValueMinor <= 0 ||
    typeof economics?.failureCostMinor !== 'number' ||
    !Number.isSafeInteger(economics.failureCostMinor) ||
    economics.failureCostMinor < 0 ||
    typeof economics?.protectedReserveMinor !== 'number' ||
    !Number.isSafeInteger(economics.protectedReserveMinor) ||
    economics.protectedReserveMinor < 0 ||
    typeof economics?.deadlineOffsetMinutes !== 'number' ||
    !Number.isSafeInteger(economics.deadlineOffsetMinutes) ||
    economics.deadlineOffsetMinutes <= 0
  ) {
    fail(
      'SPEC_ECONOMICS_INVALID',
      'economics require integer minor units and a positive deadline offset',
    );
  }
  const checkOffer = (o: unknown, role: string): SpecOffer => {
    const offer = o as SpecOffer;
    if (typeof offer?.id !== 'string' || offer.id === '') fail('SPEC_OFFER_ID_INVALID', role);
    if (!['inspection-service', 'diagnostic-service'].includes(offer.kind)) {
      fail('SPEC_OFFER_KIND_INVALID', `${role} kind "${String(offer.kind)}"`);
    }
    if (typeof offer?.beneficiary !== 'string' || offer.beneficiary === '') {
      fail('SPEC_OFFER_BENEFICIARY_INVALID', role);
    }
    if (typeof offer?.purpose !== 'string' || offer.purpose === '')
      fail('SPEC_OFFER_PURPOSE_INVALID', role);
    if (offer?.currency !== economics.currency) fail('SPEC_OFFER_CURRENCY_MISMATCH', role);
    for (const k of ['baseCostMinor', 'feeMinor', 'leadTimeMinutes', 'durationMinutes'] as const) {
      if (
        typeof offer?.[k] !== 'number' ||
        !Number.isSafeInteger(offer[k]) ||
        (offer[k] as number) < 0
      ) {
        fail('SPEC_OFFER_NUMBER_INVALID', `${role} field ${k}`);
      }
    }
    if (
      typeof offer?.probabilityOfSuccess !== 'number' ||
      offer.probabilityOfSuccess <= 0 ||
      offer.probabilityOfSuccess > 1
    ) {
      fail('SPEC_OFFER_PROBABILITY_INVALID', role);
    }
    if (offer?.availability !== 'confirmed' && offer?.availability !== 'unconfirmed') {
      fail('SPEC_OFFER_AVAILABILITY_INVALID', role);
    }
    if (offer?.requiresAssetId !== undefined && !assetIds.has(offer.requiresAssetId)) {
      fail('SPEC_OFFER_ASSET_UNKNOWN', `${role} requiresAssetId ${String(offer.requiresAssetId)}`);
    }
    return offer;
  };
  if (typeof offers?.incumbent !== 'object') fail('SPEC_INCUMBENT_REQUIRED', 'offers.incumbent');
  checkOffer(offers.incumbent, 'incumbent');
  if (!Array.isArray(offers.alternatives) || offers.alternatives.length > 10) {
    fail('SPEC_ALTERNATIVES_INVALID', 'offers.alternatives must be an array (0-10)');
  }
  for (const alt of offers.alternatives) checkOffer(alt, 'alternative');
  if (offers.diagnostics !== undefined) {
    const diag = checkOffer(offers.diagnostics, 'diagnostics');
    if (diag.kind !== 'diagnostic-service') {
      fail('SPEC_DIAGNOSTIC_KIND_INVALID', 'offers.diagnostics must be a diagnostic-service');
    }
  }
  if (
    financialMandateShape?.currency !== economics.currency ||
    !Array.isArray(financialMandateShape?.allowedBeneficiaries) ||
    financialMandateShape.allowedBeneficiaries.length === 0 ||
    !Array.isArray(financialMandateShape?.allowedPurposes) ||
    financialMandateShape.allowedPurposes.length === 0
  ) {
    fail(
      'SPEC_MANDATE_SHAPE_INVALID',
      'financialMandateShape must match the spec currency with beneficiaries/purposes',
    );
  }
  // Every offer beneficiary/purpose must be inside the mandate shape — a
  // configured offer the mandate would never permit is a configuration lie.
  for (const o of [
    offers.incumbent,
    ...offers.alternatives,
    ...(offers.diagnostics ? [offers.diagnostics] : []),
  ]) {
    if (!financialMandateShape.allowedBeneficiaries.includes((o as SpecOffer).beneficiary)) {
      fail(
        'SPEC_OFFER_BENEFICIARY_OUTSIDE_MANDATE',
        `SPEC_OFFER_BENEFICIARY_OUTSIDE_MANDATE: offer ${(o as SpecOffer).id} beneficiary is not in the mandate shape`,
      );
    }
    if (!financialMandateShape.allowedPurposes.includes((o as SpecOffer).purpose)) {
      fail(
        'SPEC_OFFER_PURPOSE_OUTSIDE_MANDATE',
        `SPEC_OFFER_PURPOSE_OUTSIDE_MANDATE: offer ${(o as SpecOffer).id} purpose is not in the mandate shape`,
      );
    }
  }
  if (typeof s.truthLabel !== 'string' || s.truthLabel === '')
    fail('SPEC_TRUTH_LABEL_INVALID', 'truthLabel');
  return s;
}

const specEventKey = (missionId: string, specId: string): string =>
  `mission-spec:v1:${missionId}:${specId}`;

/**
 * Journal the spec ONCE per (mission, specId). Re-registering the identical
 * spec is an idempotent no-op; the same specId with a DIFFERENT payload is a
 * hard refusal (specs are immutable history — evolve by new specId).
 */
export function registerMissionSpec(
  ledger: Ledger,
  spec: MissionSpecification,
): { spec: MissionSpecification; digest: string; replayed: boolean } {
  const validated = validateMissionSpec(spec);
  const digest = missionSpecDigest(validated);
  const eventKey = specEventKey(validated.identity.missionId, validated.specId);
  try {
    ledger.evidence.append({
      orgId: validated.identity.orgId,
      missionId: validated.identity.missionId,
      topic: 'operational',
      type: MISSION_SPEC_TYPE,
      eventKey,
      payload: specToWire(validated) as unknown as Record<string, unknown>,
    });
    return { spec: validated, digest, replayed: false };
  } catch (error) {
    if (isLedgerError(error) && error.code === 'DUPLICATE_EVENT') {
      // Verify the journaled payload is byte-identical — a specId collision
      // with different content is never silently accepted.
      const existing = loadRegisteredSpecs(
        ledger,
        validated.identity.orgId,
        validated.identity.missionId,
      ).find((s) => s.spec.specId === validated.specId);
      if (existing !== undefined && existing.digest === digest) {
        return { spec: existing.spec, digest, replayed: true };
      }
      throw new MissionSpecError(
        'SPEC_ID_COLLISION',
        `SPEC_ID_COLLISION: specId ${validated.specId} is already journaled with a different payload`,
      );
    }
    throw error;
  }
}

/** Digest-verified load of every registered spec for a mission (oldest first). */
export function loadRegisteredSpecs(
  ledger: Ledger,
  orgId: string,
  missionId: string,
): { spec: MissionSpecification; digest: string; seq: number }[] {
  const rows = ledger.db
    .prepare(
      `SELECT seq, payload_digest, payload_json FROM evidence_events
        WHERE org_id = ? AND mission_id = ? AND type = ?
        ORDER BY seq ASC`,
    )
    .all(orgId, missionId, MISSION_SPEC_TYPE) as {
    seq: number;
    payload_digest: string;
    payload_json: string;
  }[];
  const out: { spec: MissionSpecification; digest: string; seq: number }[] = [];
  for (const row of rows) {
    const payload: unknown = JSON.parse(row.payload_json);
    const digest = sha(canonicalJson(payload as Record<string, unknown>));
    if (digest !== row.payload_digest) {
      throw new MissionSpecError('SPEC_INTEGRITY_VIOLATION', `journal row seq ${String(row.seq)}`);
    }
    out.push({
      spec: validateMissionSpec(specFromWire(payload as SpecWire)),
      digest,
      seq: row.seq,
    });
  }
  return out;
}

/**
 * The CURRENT spec for a mission (latest registration). `null` when the
 * mission has no journaled spec — callers decide the default (pre-spec
 * missions keep the harbor demo default so the accepted experience is
 * preserved bit-for-bit).
 */
export function currentMissionSpec(
  ledger: Ledger,
  orgId: string,
  missionId: string,
): { spec: MissionSpecification; digest: string } | null {
  const all = loadRegisteredSpecs(ledger, orgId, missionId);
  const last = all.at(-1);
  return last === undefined ? null : { spec: last.spec, digest: last.digest };
}

/**
 * C5 — product read contract for Agent B's Decision Room: which industry is
 * this mission, what assets/offers/policy does it run under, and what is the
 * latest decision-case lineage (`caseId`) that Agents A/D/F can attach
 * receipts to. Read-only; role-gated like every other mission read.
 */
export function registerMissionSpecRoutes(
  app: FastifyInstance,
  ledger: Ledger,
  resolveSpec: (orgId: string, missionId: string) => { spec: MissionSpecification; digest: string },
): void {
  app.get('/api/missions/:missionId/mission-spec', async (request, reply) => {
    const g = guard(request, reply, 'read');
    if ('blocked' in g) return reply;
    const missionId = (request.params as { missionId: string }).missionId;
    try {
      ledger.organizations.getMission(g.actor.orgId, missionId);
    } catch {
      return reply.code(404).send({ error: { code: 'NOT_FOUND_OR_UNAVAILABLE' } });
    }
    const { spec, digest } = resolveSpec(g.actor.orgId, missionId);
    const registered = currentMissionSpec(ledger, g.actor.orgId, missionId) !== null;
    // Latest decision-case lineage (C5): the newest journaled snapshot's
    // caseId + evaluationId, so receipts attach to a STABLE identity.
    const latest = ledger.db
      .prepare(
        `SELECT payload_json FROM evidence_events
          WHERE org_id = ? AND mission_id = ? AND type = 'planner.decision.snapshot'
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(g.actor.orgId, missionId) as { payload_json: string } | undefined;
    const latestPayload =
      latest === undefined
        ? null
        : (JSON.parse(latest.payload_json) as { caseId?: string; evaluationId?: string });
    return {
      missionId,
      registered,
      specId: spec.specId,
      specDigest: digest.slice(0, 32),
      industry: spec.industry,
      objective: spec.identity.objective,
      truthLabel: spec.truthLabel,
      assets: spec.assets,
      safetyPolicy: spec.safetyPolicy,
      economics: spec.economics,
      offers: spec.offers,
      financialMandateShape: spec.financialMandateShape,
      caseLineage:
        latestPayload !== null &&
        typeof latestPayload.caseId === 'string' &&
        typeof latestPayload.evaluationId === 'string'
          ? { caseId: latestPayload.caseId, evaluationId: latestPayload.evaluationId }
          : null,
      authorization: 'READ-ONLY mission configuration — authority lives only in ledger mandates',
    };
  });
}
