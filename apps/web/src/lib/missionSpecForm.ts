/**
 * Customer-authored mission specification — form model, exact conversion and
 * fail-closed validation (R-final product workflow, Agent B).
 *
 * Why this module exists as pure, tested code: the spec a customer types here
 * becomes the TRUST CONFIGURATION of a mission (assets, which sources may
 * report for which assets, the modeled safety thresholds, the supplier
 * catalogue, the economics the planner optimises). A silently wrong number
 * (a float cost, a mis-scaled currency, a probability of 90 instead of 0.9)
 * would corrupt every later financial decision, so:
 *
 *  - money is parsed with the SAME exact minor-unit contract the whole UI uses
 *    (BigInt/string arithmetic, domain exponent table, extra decimals REJECTED
 *    rather than rounded, unknown currency fails closed);
 *  - probabilities travel as whole basis points internally and are emitted as
 *    p = bps / 10_000 (the server stores float-free basis points);
 *  - every rule below mirrors `validateMissionSpec` (apps/api, Agent C) and
 *    reuses its machine codes, so a client-detected defect and a server 400
 *    read identically to the operator. The server remains the authority — the
 *    client check only spares a round trip and never replaces it;
 *  - ids are additionally constrained to the EVENT-ENVELOPE id grammar and the
 *    financial-authority vocabulary ban: an asset/source id the ingest layer
 *    would later refuse is refused here, at configuration time, not on the
 *    first field event.
 *
 * Nothing here holds, derives or displays a signing credential.
 */
import type { MissionSpecDraftWire, SpecIndustry } from './api';
import { money, parseMajorToMinor, SUPPORTED_CURRENCIES } from './format';

export type DomainKind = 'aerial' | 'ground' | 'surface';
export type SourceType =
  'asset_telemetry' | 'mission_control' | 'vessel_gateway' | 'warehouse_wms' | 'simulator';
export type OfferKind = 'inspection-service' | 'diagnostic-service';
export type GroundInterrupt = 'comms-offline' | 'aisle-obstructed' | 'charger-fault';

export const SOURCE_TYPES: readonly SourceType[] = [
  'asset_telemetry',
  'mission_control',
  'vessel_gateway',
  'warehouse_wms',
  'simulator',
];
export const INDUSTRIES: readonly SpecIndustry[] = [
  'general-operations',
  'maritime-uav',
  'warehouse-amr',
];
export const GROUND_INTERRUPTS: readonly GroundInterrupt[] = [
  'comms-offline',
  'aisle-obstructed',
  'charger-fault',
];

/**
 * Mirror of FINANCIAL_AUTHORITY_TERMS (apps/api/src/mission-events/src/
 * vocabulary.ts). The ingest layer rejects any event whose string fields
 * (ids included) contain these words; a drift test (apps/web/test) re-reads
 * the API source so this list cannot silently diverge.
 */
export const FINANCIAL_AUTHORITY_TERMS: readonly string[] = [
  'approve',
  'approval',
  'reserve',
  'reservation',
  'settle',
  'settlement',
  'dispatch',
  'payout',
  'payment',
  'refund',
  'transfer',
  'withdrawal',
  'disburse',
];

export function authorityTermIn(text: string): string | undefined {
  const folded = text.toLowerCase();
  return FINANCIAL_AUTHORITY_TERMS.find((term) => folded.includes(term));
}

// --------------------------------------------------------------- draft model

export interface AssetDraft {
  assetId: string;
  label: string;
  domainKind: DomainKind;
}

export interface SourceDraft {
  sourceId: string;
  sourceType: SourceType;
  /** Selected asset ids this source may report for. */
  assetIds: string[];
  trustedForRecovery: boolean;
  provenance: 'FIELD' | 'SYNTHETIC';
}

/** Offer as typed by a human: major-unit money strings, percent probability. */
export interface OfferDraft {
  id: string;
  kind: OfferKind;
  beneficiary: string;
  purpose: string;
  baseCost: string;
  fee: string;
  leadTimeMinutes: string;
  durationMinutes: string;
  /** 0 < p <= 100, up to two decimals (basis points). */
  probabilityPercent: string;
  availability: 'confirmed' | 'unconfirmed';
  requiresAssetId: string;
}

export interface SpecDraft {
  specId: string;
  industry: SpecIndustry;
  title: string;
  objective: string;
  assets: AssetDraft[];
  sources: SourceDraft[];
  uavWindLimitKt: string;
  groundInterrupts: GroundInterrupt[];
  currency: string;
  missionValue: string;
  failureCost: string;
  protectedReserve: string;
  deadlineOffsetMinutes: string;
  incumbent: OfferDraft;
  alternatives: OfferDraft[];
  diagnostics: OfferDraft | null;
}

export function blankOffer(kind: OfferKind = 'inspection-service'): OfferDraft {
  return {
    id: '',
    kind,
    beneficiary: '',
    purpose: '',
    baseCost: '',
    fee: '0',
    leadTimeMinutes: '',
    durationMinutes: '',
    probabilityPercent: '',
    availability: 'confirmed',
    requiresAssetId: '',
  };
}

export function blankAsset(): AssetDraft {
  return { assetId: '', label: '', domainKind: 'ground' };
}

export function blankSource(): SourceDraft {
  return {
    sourceId: '',
    sourceType: 'asset_telemetry',
    assetIds: [],
    trustedForRecovery: false,
    provenance: 'FIELD',
  };
}

/** A genuinely EMPTY form — no seeded example values (a pre-filled demo would
 *  invite accepting someone else's numbers as the customer's own). */
export function emptyDraft(): SpecDraft {
  return {
    specId: '',
    industry: 'general-operations',
    title: '',
    objective: '',
    assets: [blankAsset()],
    sources: [blankSource()],
    uavWindLimitKt: '',
    groundInterrupts: ['comms-offline'],
    currency: 'USD',
    missionValue: '',
    failureCost: '',
    protectedReserve: '',
    deadlineOffsetMinutes: '',
    incumbent: blankOffer(),
    alternatives: [],
    diagnostics: null,
  };
}

// ---------------------------------------------------------------- validation

export interface FieldIssue {
  /** Stable dotted path, e.g. `assets.1.assetId` or `offers.alternatives.0.baseCost`. */
  readonly path: string;
  /** The SAME machine code the server would answer (SPEC_*), or CLIENT_* for
   *  checks the server does not make (event-id grammar, authority terms). */
  readonly code: string;
  readonly message: string;
}

const SPEC_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
/** Event-envelope id grammar (mission-events/schema.ts ID). */
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Credential-issuance source id grammar (mission-operations.ts SOURCE_ID_RE). */
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;

const MAX_TEXT = 400;

function parseMoney(
  currency: string,
  text: string,
): { ok: true; minor: number } | { ok: false; reason: string } {
  try {
    const minor = parseMajorToMinor(currency, text);
    if (minor === null) {
      return {
        ok: false,
        reason: `"${text}" is not an exact amount in ${currency} (no extra decimals, digits only)`,
      };
    }
    return { ok: true, minor };
  } catch {
    return {
      ok: false,
      reason: `${currency} has no registered minor-unit precision; choose a supported currency`,
    };
  }
}

function parseIntStrict(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/** Percent text (`84.25`) → whole basis points (8425), at most two decimals. */
export function parsePercentToBps(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (m === null) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? '').padEnd(2, '0'));
  const bps = whole * 100 + frac;
  return bps > 0 && bps <= 10_000 ? bps : null;
}

export type DraftResult =
  | { readonly ok: true; readonly wire: MissionSpecDraftWire }
  | { readonly ok: false; readonly issues: readonly FieldIssue[] };

/**
 * Validate the draft and, when clean, emit the exact wire spec. All issues are
 * collected (not first-failure) so the operator can fix a form in one pass.
 */
export function draftToWire(draft: SpecDraft): DraftResult {
  const issues: FieldIssue[] = [];
  const bad = (path: string, code: string, message: string): void => {
    issues.push({ path, code, message });
  };

  const specId = draft.specId.trim();
  if (!SPEC_ID_RE.test(specId)) {
    bad('specId', 'SPEC_ID_INVALID', 'specId must be lowercase kebab-case, 3-64 characters');
  }
  const title = draft.title.trim();
  const objective = draft.objective.trim();
  if (title === '' || title.length > MAX_TEXT) {
    bad('title', 'SPEC_IDENTITY_INCOMPLETE', 'a mission title is required');
  }
  if (objective === '' || objective.length > MAX_TEXT * 4) {
    bad('objective', 'SPEC_IDENTITY_INCOMPLETE', 'a mission objective is required');
  }

  // ---- assets
  const assetIds = new Set<string>();
  let hasAerial = false;
  let hasGround = false;
  if (draft.assets.length === 0 || draft.assets.length > 20) {
    bad('assets', 'SPEC_ASSETS_EMPTY', '1-20 assets are required');
  }
  draft.assets.forEach((a, i) => {
    const id = a.assetId.trim();
    const p = `assets.${String(i)}`;
    if (!EVENT_ID_RE.test(id)) {
      bad(
        `${p}.assetId`,
        'SPEC_ASSET_ID_INVALID',
        'asset id: letters, digits, "_" and "-" only (1-64) — it appears in every field event',
      );
    } else if (authorityTermIn(id) !== undefined) {
      bad(
        `${p}.assetId`,
        'CLIENT_AUTHORITY_TERM',
        `asset id contains the banking term "${authorityTermIn(id)}" — field events carrying it are refused by design`,
      );
    } else if (assetIds.has(id)) {
      bad(`${p}.assetId`, 'SPEC_ASSET_DUPLICATE', `asset ${id} is listed twice`);
    }
    assetIds.add(id);
    if (a.label.trim() === '' || a.label.length > MAX_TEXT) {
      bad(`${p}.label`, 'SPEC_ASSET_LABEL_INVALID', 'every asset needs a label');
    }
    if (a.domainKind === 'aerial') hasAerial = true;
    if (a.domainKind === 'ground') hasGround = true;
  });

  // ---- sources
  if (draft.sources.length === 0 || draft.sources.length > 20) {
    bad('sources', 'SPEC_SOURCES_EMPTY', '1-20 trusted sources are required');
  }
  const sourceIds = new Set<string>();
  draft.sources.forEach((s, i) => {
    const id = s.sourceId.trim();
    const p = `sources.${String(i)}`;
    if (!SOURCE_ID_RE.test(id)) {
      bad(
        `${p}.sourceId`,
        'SPEC_SOURCE_ID_INVALID',
        'source id: lowercase letters, digits, ".", "_" and "-" (3-64, starting alphanumeric)',
      );
    } else if (authorityTermIn(id) !== undefined) {
      bad(
        `${p}.sourceId`,
        'CLIENT_AUTHORITY_TERM',
        `source id contains the banking term "${authorityTermIn(id)}" — its events would be refused`,
      );
    } else if (sourceIds.has(id)) {
      bad(`${p}.sourceId`, 'SPEC_SOURCE_ID_INVALID', `source ${id} is listed twice`);
    }
    sourceIds.add(id);
    if (s.assetIds.length === 0 || s.assetIds.some((a) => !assetIds.has(a))) {
      bad(
        `${p}.assetIds`,
        'SPEC_SOURCE_ASSET_UNKNOWN',
        'select at least one declared asset this source may report for',
      );
    }
    if (s.sourceType === 'asset_telemetry' && s.assetIds.length !== 1) {
      bad(
        `${p}.assetIds`,
        'SPEC_TELEMETRY_SOURCE_NOT_SINGLE_ASSET',
        'an asset-telemetry source belongs to exactly ONE asset',
      );
    }
  });

  // ---- safety policy (domain isolation, mirrored from the server)
  let windLimit: number | undefined;
  if (hasAerial) {
    const w = Number(draft.uavWindLimitKt.trim());
    if (draft.uavWindLimitKt.trim() === '' || !Number.isFinite(w) || w <= 0 || w > 200) {
      bad(
        'uavWindLimitKt',
        'SPEC_WIND_LIMIT_REQUIRED',
        'aerial assets require a modeled wind limit in kt, greater than 0 and at most 200',
      );
    } else {
      windLimit = w;
    }
  }
  const interrupts: GroundInterrupt[] = hasGround
    ? GROUND_INTERRUPTS.filter((g) => g === 'comms-offline' || draft.groundInterrupts.includes(g))
    : [];

  // ---- economics
  const currency = draft.currency.trim().toUpperCase();
  if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) {
    bad(
      'currency',
      'SPEC_ECONOMICS_INVALID',
      `${currency || '(none)'} is not a supported currency`,
    );
  }
  const econ = {
    missionValue: parseMoney(currency, draft.missionValue),
    failureCost: parseMoney(currency, draft.failureCost),
    protectedReserve: parseMoney(currency, draft.protectedReserve),
  };
  if (!econ.missionValue.ok || econ.missionValue.minor <= 0) {
    bad(
      'missionValue',
      'SPEC_ECONOMICS_INVALID',
      econ.missionValue.ok ? 'mission value must be greater than zero' : econ.missionValue.reason,
    );
  }
  if (!econ.failureCost.ok || econ.failureCost.minor < 0) {
    bad(
      'failureCost',
      'SPEC_ECONOMICS_INVALID',
      econ.failureCost.ok ? 'failure cost cannot be negative' : econ.failureCost.reason,
    );
  }
  if (!econ.protectedReserve.ok || econ.protectedReserve.minor < 0) {
    bad(
      'protectedReserve',
      'SPEC_ECONOMICS_INVALID',
      econ.protectedReserve.ok
        ? 'protected reserve cannot be negative'
        : econ.protectedReserve.reason,
    );
  }
  const deadline = parseIntStrict(draft.deadlineOffsetMinutes);
  if (deadline === null || deadline <= 0) {
    bad(
      'deadlineOffsetMinutes',
      'SPEC_ECONOMICS_INVALID',
      'the deadline is a whole number of minutes after evaluation time, greater than zero',
    );
  }

  // ---- offers
  const offerIds = new Set<string>();
  const wireOffer = (
    o: OfferDraft,
    path: string,
    requiredKind: OfferKind | null,
  ): MissionSpecDraftWire['offers']['incumbent'] | null => {
    let ok = true;
    const fail = (field: string, code: string, message: string): void => {
      ok = false;
      bad(`${path}.${field}`, code, message);
    };
    const id = o.id.trim();
    if (!EVENT_ID_RE.test(id)) {
      fail('id', 'SPEC_OFFER_ID_INVALID', 'offer id: letters, digits, "_" and "-" (1-64)');
    } else if (offerIds.has(id)) {
      fail(
        'id',
        'SPEC_OFFER_ID_INVALID',
        `offer id ${id} is used twice — candidate ids derive from it`,
      );
    }
    offerIds.add(id);
    if (requiredKind !== null && o.kind !== requiredKind) {
      fail('kind', 'SPEC_DIAGNOSTIC_KIND_INVALID', `this offer must be a ${requiredKind}`);
    }
    const beneficiary = o.beneficiary.trim();
    const purpose = o.purpose.trim();
    if (beneficiary === '' || beneficiary.length > 120 || beneficiary.includes(',')) {
      fail(
        'beneficiary',
        'SPEC_OFFER_BENEFICIARY_INVALID',
        'beneficiary: required, no commas (the mandate wizard splits on commas)',
      );
    }
    if (purpose === '' || purpose.length > 120 || purpose.includes(',')) {
      fail(
        'purpose',
        'SPEC_OFFER_PURPOSE_INVALID',
        'purpose: required, no commas (the mandate wizard splits on commas)',
      );
    }
    const base = parseMoney(currency, o.baseCost);
    const fee = parseMoney(currency, o.fee === '' ? '0' : o.fee);
    if (!base.ok || base.minor < 0) {
      fail(
        'baseCost',
        'SPEC_OFFER_NUMBER_INVALID',
        base.ok ? 'cost cannot be negative' : base.reason,
      );
    }
    if (!fee.ok || fee.minor < 0) {
      fail('fee', 'SPEC_OFFER_NUMBER_INVALID', fee.ok ? 'fee cannot be negative' : fee.reason);
    }
    const lead = parseIntStrict(o.leadTimeMinutes);
    const dur = parseIntStrict(o.durationMinutes);
    if (lead === null) {
      fail('leadTimeMinutes', 'SPEC_OFFER_NUMBER_INVALID', 'lead time: whole minutes');
    }
    if (dur === null) {
      fail('durationMinutes', 'SPEC_OFFER_NUMBER_INVALID', 'duration: whole minutes');
    }
    const bps = parsePercentToBps(o.probabilityPercent);
    if (bps === null) {
      fail(
        'probabilityPercent',
        'SPEC_OFFER_PROBABILITY_INVALID',
        'success probability: a percentage above 0 and at most 100 (two decimals max)',
      );
    }
    const req = o.requiresAssetId.trim();
    if (req !== '' && !assetIds.has(req)) {
      fail('requiresAssetId', 'SPEC_OFFER_ASSET_UNKNOWN', `${req} is not a declared asset`);
    }
    if (!ok || !base.ok || !fee.ok || lead === null || dur === null || bps === null) return null;
    return {
      id,
      kind: o.kind,
      currency,
      baseCostMinor: base.minor,
      feeMinor: fee.minor,
      leadTimeMinutes: lead,
      durationMinutes: dur,
      probabilityOfSuccess: bps / 10_000,
      availability: o.availability,
      beneficiary,
      purpose,
      ...(req !== '' ? { requiresAssetId: req } : {}),
    };
  };

  const incumbent = wireOffer(draft.incumbent, 'offers.incumbent', null);
  if (draft.alternatives.length > 10) {
    bad('offers.alternatives', 'SPEC_ALTERNATIVES_INVALID', 'at most 10 alternative suppliers');
  }
  const alternatives = draft.alternatives.map((a, i) =>
    wireOffer(a, `offers.alternatives.${String(i)}`, null),
  );
  const diagnostics =
    draft.diagnostics === null
      ? undefined
      : wireOffer(draft.diagnostics, 'offers.diagnostics', 'diagnostic-service');

  if (issues.length > 0) return { ok: false, issues };
  if (
    incumbent === null ||
    alternatives.some((a) => a === null) ||
    diagnostics === null ||
    !econ.missionValue.ok ||
    !econ.failureCost.ok ||
    !econ.protectedReserve.ok ||
    deadline === null
  ) {
    return { ok: false, issues: [{ path: '', code: 'CLIENT_INCOMPLETE', message: 'incomplete' }] };
  }
  const all = [
    incumbent,
    ...(alternatives as (typeof incumbent)[]),
    ...(diagnostics ? [diagnostics] : []),
  ];
  const unique = (xs: string[]): string[] => [...new Set(xs)];
  const wire: MissionSpecDraftWire = {
    specVersion: 1,
    specId,
    industry: draft.industry,
    identity: { title, objective },
    assets: draft.assets.map((a) => ({
      assetId: a.assetId.trim(),
      label: a.label.trim(),
      domainKind: a.domainKind,
    })),
    sources: draft.sources.map((s) => ({
      sourceId: s.sourceId.trim(),
      sourceType: s.sourceType,
      assetIds: [...s.assetIds],
      trustedForRecovery: s.trustedForRecovery,
      provenance: s.provenance,
    })),
    safetyPolicy: {
      version: 1,
      clearanceAuthority: 'deterministic-domain-policy',
      ...(windLimit !== undefined ? { uavWindLimitKt: windLimit } : {}),
      ...(hasGround ? { groundInterrupts: interrupts } : {}),
    },
    economics: {
      currency,
      missionValueMinor: econ.missionValue.minor,
      failureCostMinor: econ.failureCost.minor,
      protectedReserveMinor: econ.protectedReserve.minor,
      deadlineOffsetMinutes: deadline,
    },
    offers: {
      incumbent,
      alternatives: alternatives as (typeof incumbent)[],
      ...(diagnostics ? { diagnostics } : {}),
    },
    // The mandate SHAPE is derived — never typed separately — so "a configured
    // offer the mandate would never permit" cannot be authored by accident.
    // It is only an EXPECTATION: authority itself exists only as a ledger
    // mandate a human grants separately.
    financialMandateShape: {
      currency,
      allowedBeneficiaries: unique(all.map((o) => o.beneficiary)),
      allowedPurposes: unique(all.map((o) => o.purpose)),
    },
    truthLabel: 'CUSTOMER_CONFIGURED_OPERATION — POLICY-ONLY',
  };
  return { ok: true, wire };
}

// ------------------------------------------------------------------- review

export interface ReviewRow {
  readonly label: string;
  readonly value: string;
}

/** Exact, human-readable review of what will be registered (money via the
 *  shared formatter) — shown BEFORE submission, like the mandate wizard. */
export function reviewRows(wire: MissionSpecDraftWire): readonly ReviewRow[] {
  const c = wire.economics.currency;
  const offerLine = (o: MissionSpecDraftWire['offers']['incumbent']): string =>
    `${o.id} → ${o.beneficiary} · ${o.purpose} · ${money(c, o.baseCostMinor + o.feeMinor)} ` +
    `(base ${money(c, o.baseCostMinor)} + fee ${money(c, o.feeMinor)}) · ` +
    `p=${(o.probabilityOfSuccess * 100).toFixed(2)}% · lead ${String(o.leadTimeMinutes)} min · ` +
    `${o.availability}` +
    (o.requiresAssetId !== undefined ? ` · needs ${o.requiresAssetId} cleared` : '');
  return [
    { label: 'Spec id (immutable once registered)', value: wire.specId },
    { label: 'Industry label', value: wire.industry },
    { label: 'Mission', value: wire.identity.title },
    { label: 'Objective', value: wire.identity.objective },
    {
      label: 'Assets',
      value: wire.assets.map((a) => `${a.label} (${a.domainKind}, ${a.assetId})`).join(' · '),
    },
    {
      label: 'Trusted sources',
      value: wire.sources
        .map(
          (s) =>
            `${s.sourceId} [${s.sourceType}, ${s.provenance}${s.trustedForRecovery ? ', recovery-trusted' : ''}] → ${s.assetIds.join(', ')}`,
        )
        .join(' · '),
    },
    {
      label: 'Safety policy',
      value:
        [
          wire.safetyPolicy.uavWindLimitKt !== undefined
            ? `modeled wind limit ${String(wire.safetyPolicy.uavWindLimitKt)} kt (operator rule, not a measurement)`
            : null,
          wire.safetyPolicy.groundInterrupts !== undefined
            ? `ground interrupts: ${wire.safetyPolicy.groundInterrupts.join(', ')}`
            : null,
        ]
          .filter((x): x is string => x !== null)
          .join(' · ') || 'no domain thresholds declared',
    },
    { label: 'Mission value', value: money(c, wire.economics.missionValueMinor) },
    { label: 'Cost of failure', value: money(c, wire.economics.failureCostMinor) },
    { label: 'Protected reserve', value: money(c, wire.economics.protectedReserveMinor) },
    {
      label: 'Deadline',
      value: `${String(wire.economics.deadlineOffsetMinutes)} minutes after evaluation`,
    },
    { label: 'Incumbent supplier', value: offerLine(wire.offers.incumbent) },
    ...wire.offers.alternatives.map((o, i) => ({
      label: `Alternative ${String(i + 1)}`,
      value: offerLine(o),
    })),
    ...(wire.offers.diagnostics !== undefined
      ? [{ label: 'Diagnostics', value: offerLine(wire.offers.diagnostics) }]
      : []),
    {
      label: 'Derived mandate shape (expectation only)',
      value: `${wire.financialMandateShape.currency} · beneficiaries ${wire.financialMandateShape.allowedBeneficiaries.join(', ')} · purposes ${wire.financialMandateShape.allowedPurposes.join(', ')}`,
    },
  ];
}

// ----------------------------------------------------- headless sender guide

/**
 * Observation kinds/units used in the SAMPLE envelope (mirror of the typed
 * vocabulary in apps/api/src/mission-events/src/vocabulary.ts; parity is
 * asserted by apps/web/test/missionSpecForm.test.ts).
 */
export const SAMPLE_OBSERVATIONS = {
  aerial: [
    { kind: 'wind_speed', unit: 'kt', value: '0.0' },
    { kind: 'weather_hold', unit: 'state', value: 'clear' },
  ],
  ground: [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
  surface: [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
} as const;

/**
 * A SHAPE example for the operator's integration team — contains NO secret
 * and a literal placeholder signature. `sequence` is per (asset, source)
 * stream, strictly increasing from 1; `orgId`/`missionId` must be the
 * mission's own ids.
 */
export function sampleEnvelope(args: {
  orgId: string | null;
  missionId: string;
  source: { sourceId: string; sourceType: string; provenance: string; assetIds: readonly string[] };
  assetDomain: DomainKind;
  keyId: string;
}): Record<string, unknown> {
  const assetId = args.source.assetIds[0] ?? '<assetId>';
  return {
    contractVersion: 1,
    eventId: '<unique id, 1-64 of A-Z a-z 0-9 _ ->',
    sequence: 1,
    orgId: args.orgId ?? '<your organisation id>',
    missionId: args.missionId,
    assetId,
    observedAt: '<ISO-8601 UTC with milliseconds, when it was observed>',
    ingestedAt: '<ISO-8601 UTC with milliseconds, when your system sent it>',
    source: {
      sourceId: args.source.sourceId,
      sourceType: args.source.sourceType,
      keyId: args.keyId,
      provenance: args.source.provenance,
      signature: '<64 hex chars: HMAC-SHA256, see below>',
    },
    observations: SAMPLE_OBSERVATIONS[args.assetDomain].map((o) => ({ ...o })),
  };
}
