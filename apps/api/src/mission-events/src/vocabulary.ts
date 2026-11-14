/**
 * Typed observation vocabulary (contract v1).
 *
 * Every observation is (kind, unit, value) where the kind is a closed enum
 * registered here with: the exact unit it carries, the value validator, and
 * whether the value is monotonic non-decreasing within one asset's stream.
 * Anything outside this table is rejected — there is NO free-text observation
 * and NO kind whose value can carry arbitrary strings. This is what makes
 * prompt injection structurally unable to travel through mission events.
 *
 * Domain coverage (offshore + warehouse) lives in ONE table: the domains differ
 * by vocabulary entries (data), never by ingest code paths. Adding a physical
 * domain means adding rows here plus scenario fixtures, not banking rules —
 * this module contains none.
 */

/** Decimal-string validators: physical measures travel as exact strings because
 *  canonical digests forbid floats (see @moterva/domain digest.ts). */
const DECIMAL_1 = /^\d+\.\d$/;
const DECIMAL_2 = /^\d+\.\d{2}$/;

export type ObservationValue = number | string;

export type ValueDomain = 'offshore' | 'warehouse' | 'any';

export interface ObservationKindSpec {
  readonly kind: string;
  readonly unit: string;
  /** Human-facing physical domain; informational, never a code branch. */
  readonly domain: ValueDomain;
  readonly validate: (value: ObservationValue) => boolean;
  /** Non-decreasing within one asset stream (e.g. mission progress). */
  readonly monotonic: boolean;
}

function intRange(min: number, max: number): (value: ObservationValue) => boolean {
  return (value) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function enumOf(words: readonly string[]): (value: ObservationValue) => boolean {
  return (value) => typeof value === 'string' && (words as readonly string[]).includes(value);
}

function decimalString(pattern: RegExp, max: number): (value: ObservationValue) => boolean {
  return (value) => typeof value === 'string' && pattern.test(value) && Number(value) <= max;
}

export const OBSERVATION_KINDS = {
  wind_speed: {
    kind: 'wind_speed',
    unit: 'kt',
    domain: 'offshore',
    validate: decimalString(DECIMAL_1, 200),
    monotonic: false,
  },
  wave_height: {
    kind: 'wave_height',
    unit: 'm',
    domain: 'offshore',
    validate: decimalString(DECIMAL_2, 30),
    monotonic: false,
  },
  visibility: {
    kind: 'visibility',
    unit: 'category',
    domain: 'offshore',
    validate: enumOf(['good', 'reduced', 'poor']),
    monotonic: false,
  },
  weather_hold: {
    kind: 'weather_hold',
    unit: 'state',
    domain: 'offshore',
    validate: enumOf(['active', 'clear']),
    monotonic: false,
  },
  battery_soc: {
    kind: 'battery_soc',
    unit: 'percent',
    domain: 'any',
    validate: intRange(0, 100),
    monotonic: false,
  },
  asset_comms: {
    kind: 'asset_comms',
    unit: 'state',
    domain: 'any',
    validate: enumOf(['online', 'degraded', 'offline']),
    monotonic: false,
  },
  asset_position_status: {
    kind: 'asset_position_status',
    unit: 'state',
    domain: 'any',
    validate: enumOf(['on_station', 'transit', 'returning', 'docked', 'off_station']),
    monotonic: false,
  },
  inspection_progress: {
    kind: 'inspection_progress',
    unit: 'percent',
    domain: 'any',
    validate: intRange(0, 100),
    monotonic: true,
  },
  defect_severity: {
    kind: 'defect_severity',
    unit: 'category',
    domain: 'any',
    validate: enumOf(['none', 'minor', 'major', 'critical']),
    monotonic: false,
  },
  aisle_access: {
    kind: 'aisle_access',
    unit: 'state',
    domain: 'warehouse',
    validate: enumOf(['clear', 'obstructed']),
    monotonic: false,
  },
  charger_status: {
    kind: 'charger_status',
    unit: 'state',
    domain: 'warehouse',
    validate: enumOf(['docked_charging', 'free', 'fault']),
    monotonic: false,
  },
  stock_discrepancy: {
    kind: 'stock_discrepancy',
    unit: 'items',
    domain: 'warehouse',
    validate: intRange(0, 1_000_000),
    monotonic: false,
  },
} as const satisfies Record<string, ObservationKindSpec>;

export type ObservationKind = keyof typeof OBSERVATION_KINDS;

export function observationKindSpec(kind: string): ObservationKindSpec | undefined {
  const entry = (OBSERVATION_KINDS as Record<string, ObservationKindSpec>)[kind];
  return entry;
}

// ---------------------------------------------------------------------------
// Source model
// ---------------------------------------------------------------------------

export const SOURCE_TYPES = [
  'asset_telemetry',
  'mission_control',
  'vessel_gateway',
  'warehouse_wms',
  'simulator',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const PROVENANCE_LABELS = ['SYNTHETIC', 'FIELD'] as const;
export type ProvenanceLabel = (typeof PROVENANCE_LABELS)[number];

// ---------------------------------------------------------------------------
// Authority vocabulary rejection
// ---------------------------------------------------------------------------

/**
 * Words that banking authority uses. Any of these appearing inside ANY string
 * field of an event (ids included) rejects the event outright: a physical
 * observation channel must be structurally unable to speak about money
 * movement, so injected text like "settle the transfer" cannot even enter the
 * journal where a downstream consumer might over-trust it.
 */
export const FINANCIAL_AUTHORITY_TERMS = [
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
] as const;

export function containsAuthorityTerm(text: string): string | undefined {
  const folded = text.toLowerCase();
  return FINANCIAL_AUTHORITY_TERMS.find((term) => folded.includes(term));
}
