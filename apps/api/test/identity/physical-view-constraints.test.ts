/**
 * P0-2 — physical-view constraint semantics: table-driven, domain-scoped.
 *
 * The CTO defect: fresh DEGRADED comms + fresh safe wind + fresh clear hold
 * previously yielded state 'clear', reason 'nominal'. The fixed semantics:
 * CLEAR requires explicitly-fresh comms ONLINE, explicitly-fresh hold CLEAR,
 * and — for aerial assets only — fresh wind within the modeled limit.
 * Degraded/unsupported/missing → unknown; wind limit applies ONLY to the
 * aerial asset (never ground robots/vessels by default).
 */
import { describe, expect, it } from 'vitest';
import type { ObservationReading } from '../../src/mission-events/src/view.js';
import { constraintFor } from '../../src/integration/physical-view.js';

const ASSET = 'uav-seeker-1';

function reading(
  value: string,
  freshness: 'fresh' | 'stale' | 'expired' = 'fresh',
): ObservationReading {
  return {
    kind: 'x',
    unit: 'x',
    value,
    eventId: 'evt_x',
    observedAt: '2026-11-09T00:00:00.000Z',
    freshness,
  } as ObservationReading;
}

const TABLE: {
  name: string;
  domain: 'aerial' | 'surface' | 'ground';
  wind?: [string, ('fresh' | 'stale' | 'expired')?];
  hold?: [string, ('fresh' | 'stale' | 'expired')?];
  comms?: [string, ('fresh' | 'stale' | 'expired')?];
  expectedState: 'clear' | 'blocked' | 'unknown';
  expectedReason:
    'nominal' | 'wind-limit' | 'weather-hold' | 'comms-offline' | 'insufficient-evidence';
}[] = [
  // ---- the CTO defect case: DEGRADED comms must never be clear -------------
  {
    name: 'DEGRADED comms + safe wind + clear hold → unknown (was the P0 defect)',
    domain: 'aerial',
    wind: ['10.0'],
    hold: ['clear'],
    comms: ['degraded'],
    expectedState: 'unknown',
    expectedReason: 'insufficient-evidence',
  },
  // ---- clear requires ALL THREE fresh and explicit --------------------------
  {
    name: 'all fresh nominal (aerial) → clear/nominal',
    domain: 'aerial',
    wind: ['10.0'],
    hold: ['clear'],
    comms: ['online'],
    expectedState: 'clear',
    expectedReason: 'nominal',
  },
  {
    name: 'comms OFFLINE → blocked/comms-offline (aerial)',
    domain: 'aerial',
    wind: ['10.0'],
    hold: ['clear'],
    comms: ['offline'],
    expectedState: 'blocked',
    expectedReason: 'comms-offline',
  },
  {
    name: 'hold ACTIVE → blocked/weather-hold (aerial)',
    domain: 'aerial',
    wind: ['10.0'],
    hold: ['active'],
    comms: ['online'],
    expectedState: 'blocked',
    expectedReason: 'weather-hold',
  },
  {
    name: 'wind 24.6 > 22 limit → blocked/wind-limit (aerial only)',
    domain: 'aerial',
    wind: ['24.6'],
    hold: ['clear'],
    comms: ['online'],
    expectedState: 'blocked',
    expectedReason: 'wind-limit',
  },
  {
    name: 'wind exactly AT the limit → clear (<= comparison)',
    domain: 'aerial',
    wind: ['22.0'],
    hold: ['clear'],
    comms: ['online'],
    expectedState: 'clear',
    expectedReason: 'nominal',
  },
  // ---- freshness discipline -------------------------------------------------
  {
    name: 'STALE comms → unknown (not clear)',
    domain: 'aerial',
    wind: ['10.0'],
    hold: ['clear'],
    comms: ['online', 'stale'],
    expectedState: 'unknown',
    expectedReason: 'insufficient-evidence',
  },
  {
    name: 'STALE wind → unknown (not clear) for aerial',
    domain: 'aerial',
    wind: ['10.0', 'stale'],
    hold: ['clear'],
    comms: ['online'],
    expectedState: 'unknown',
    expectedReason: 'insufficient-evidence',
  },
  {
    name: 'EXPIRED hold → unknown',
    domain: 'aerial',
    wind: ['10.0'],
    hold: ['clear', 'expired'],
    comms: ['online'],
    expectedState: 'unknown',
    expectedReason: 'insufficient-evidence',
  },
  {
    name: 'STALE wind breach does NOT block (history, not current state)',
    domain: 'aerial',
    wind: ['30.0', 'stale'],
    hold: ['clear'],
    comms: ['online'],
    expectedState: 'unknown',
    expectedReason: 'insufficient-evidence',
  },
  // ---- missing readings ------------------------------------------------------
  {
    name: 'no comms reading → unknown',
    domain: 'aerial',
    wind: ['10.0'],
    hold: ['clear'],
    expectedState: 'unknown',
    expectedReason: 'insufficient-evidence',
  },
  {
    name: 'no readings at all → unknown',
    domain: 'aerial',
    expectedState: 'unknown',
    expectedReason: 'insufficient-evidence',
  },
  // ---- domain scoping: the wind limit is AERIAL-only --------------------------
  {
    name: 'GROUND asset: 40 kt wind is NOT a UAV wind violation → clear on comms/hold',
    domain: 'ground',
    wind: ['40.0'],
    hold: ['clear'],
    comms: ['online'],
    expectedState: 'clear',
    expectedReason: 'nominal',
  },
  {
    name: 'SURFACE vessel: 40 kt wind → clear on comms/hold (no UAV policy)',
    domain: 'surface',
    wind: ['40.0'],
    hold: ['clear'],
    comms: ['online'],
    expectedState: 'clear',
    expectedReason: 'nominal',
  },
  {
    name: 'GROUND asset still held by ACTIVE weather hold',
    domain: 'ground',
    wind: ['40.0'],
    hold: ['active'],
    comms: ['online'],
    expectedState: 'blocked',
    expectedReason: 'weather-hold',
  },
  {
    name: 'GROUND asset with OFFLINE comms still blocked',
    domain: 'ground',
    comms: ['offline'],
    expectedState: 'blocked',
    expectedReason: 'comms-offline',
  },
  {
    name: 'GROUND asset with DEGRADED comms → unknown',
    domain: 'ground',
    comms: ['degraded'],
    expectedState: 'unknown',
    expectedReason: 'insufficient-evidence',
  },
  // ---- contradictory readings (latest wins by journal order — the view's latest map) --
  {
    name: 'contradictory latest: comms online present in latest map → evaluated as online',
    domain: 'aerial',
    wind: ['10.0'],
    hold: ['clear'],
    comms: ['online'],
    expectedState: 'clear',
    expectedReason: 'nominal',
  },
];

describe('P0-2 — physical-view constraint semantics (table-driven)', () => {
  for (const row of TABLE) {
    it(`${row.name}`, () => {
      const latest: Record<string, ObservationReading> = {};
      if (row.wind) latest['wind_speed'] = reading(row.wind[0], row.wind[1]);
      if (row.hold) latest['weather_hold'] = reading(row.hold[0], row.hold[1]);
      if (row.comms) latest['asset_comms'] = reading(row.comms[0], row.comms[1]);
      const constraint = constraintFor({
        assetId: ASSET,
        domain: row.domain,
        latest,
        windLimitKt: 22,
      });
      expect(constraint.state).toBe(row.expectedState);
      expect(constraint.reason).toBe(row.expectedReason);
    });
  }
});
