import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { supportedCurrencies } from '@moterva/domain';
import {
  authorityTermIn,
  draftToWire,
  emptyDraft,
  FINANCIAL_AUTHORITY_TERMS,
  parsePercentToBps,
  reviewRows,
  SAMPLE_OBSERVATIONS,
  type SpecDraft,
} from '../src/lib/missionSpecForm';
import { SUPPORTED_CURRENCIES } from '../src/lib/format';
import { validateMissionSpec } from '../../api/src/integration/mission-spec';

/**
 * R-final customer workflow: the spec form is the TRUST CONFIGURATION of a
 * mission. These tests pin (1) exact conversion on values that appear in no
 * fixture, (2) the fail-closed validation matrix, and (3) PARITY with the
 * server: every spec the client emits must pass the real
 * `validateMissionSpec`, and the shared vocabularies must not drift.
 */

/** A mission with values absent from every shipped fixture (JPY: exponent 0). */
function unseenDraft(): SpecDraft {
  return {
    ...emptyDraft(),
    specId: 'quarry-blast-survey-q3',
    industry: 'general-operations',
    title: 'Quarry blast-zone photogrammetry, bench 7',
    objective:
      'Survey bench 7 after the scheduled blast and deliver the volumetric report before the haul-road reopens.',
    assets: [
      { assetId: 'survey-quad-q3', label: 'Survey quadcopter', domainKind: 'aerial' },
      { assetId: 'haul-gate-radio', label: 'Haul-road gate radio', domainKind: 'ground' },
    ],
    sources: [
      {
        sourceId: 'bench7-flight-link',
        sourceType: 'asset_telemetry',
        assetIds: ['survey-quad-q3'],
        trustedForRecovery: false,
        provenance: 'FIELD',
      },
      {
        sourceId: 'quarry-control-room',
        sourceType: 'mission_control',
        assetIds: ['survey-quad-q3', 'haul-gate-radio'],
        trustedForRecovery: true,
        provenance: 'FIELD',
      },
    ],
    uavWindLimitKt: '27',
    groundInterrupts: ['comms-offline'],
    currency: 'JPY',
    missionValue: '5,400,000',
    failureCost: '1,250,000',
    protectedReserve: '90000',
    deadlineOffsetMinutes: '480',
    incumbent: {
      id: 'inhouse-quad-flight',
      kind: 'inspection-service',
      beneficiary: 'bench-ops-crew',
      purpose: 'volumetric survey',
      baseCost: '310000',
      fee: '0',
      leadTimeMinutes: '15',
      durationMinutes: '95',
      probabilityPercent: '91.5',
      availability: 'confirmed',
      requiresAssetId: 'survey-quad-q3',
    },
    alternatives: [
      {
        id: 'ridge-lidar-contract',
        kind: 'inspection-service',
        beneficiary: 'ridgeline-lidar-kk',
        purpose: 'volumetric survey',
        baseCost: '742000',
        fee: '18500',
        leadTimeMinutes: '55',
        durationMinutes: '120',
        probabilityPercent: '86.25',
        availability: 'confirmed',
        requiresAssetId: '',
      },
    ],
    diagnostics: {
      id: 'blast-gas-readout',
      kind: 'diagnostic-service',
      beneficiary: 'ridgeline-lidar-kk',
      purpose: 'volumetric survey',
      baseCost: '48000',
      fee: '0',
      leadTimeMinutes: '10',
      durationMinutes: '20',
      probabilityPercent: '100',
      availability: 'confirmed',
      requiresAssetId: '',
    },
  };
}

describe('customer spec form — exact conversion', () => {
  it('converts an unseen JPY mission to the exact wire spec', () => {
    const r = draftToWire(unseenDraft());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.wire;
    // JPY has exponent 0: 5,400,000 yen is 5_400_000 minor — never x100.
    expect(w.economics).toEqual({
      currency: 'JPY',
      missionValueMinor: 5_400_000,
      failureCostMinor: 1_250_000,
      protectedReserveMinor: 90_000,
      deadlineOffsetMinutes: 480,
    });
    expect(w.offers.incumbent.baseCostMinor).toBe(310_000);
    expect(w.offers.alternatives[0]!.feeMinor).toBe(18_500);
    // probabilities travel as p = bps / 10_000 exactly
    expect(w.offers.incumbent.probabilityOfSuccess).toBe(0.915);
    expect(w.offers.alternatives[0]!.probabilityOfSuccess).toBe(0.8625);
    expect(w.offers.diagnostics!.probabilityOfSuccess).toBe(1);
    expect(w.safetyPolicy).toEqual({
      version: 1,
      clearanceAuthority: 'deterministic-domain-policy',
      uavWindLimitKt: 27,
      groundInterrupts: ['comms-offline'],
    });
  });

  it('never sends tenant identity and derives the mandate shape from the offers', () => {
    const r = draftToWire(unseenDraft());
    if (!r.ok) throw new Error('expected ok');
    expect(Object.keys(r.wire.identity).sort()).toEqual(['objective', 'title']);
    expect(r.wire.financialMandateShape).toEqual({
      currency: 'JPY',
      allowedBeneficiaries: ['bench-ops-crew', 'ridgeline-lidar-kk'],
      allowedPurposes: ['volumetric survey'],
    });
    expect(JSON.stringify(r.wire.identity)).not.toMatch(/orgId|missionId/);
    expect(JSON.stringify(r.wire.offers)).not.toContain('label');
  });

  it('every emitted spec passes the REAL server validator (client/server parity)', () => {
    const r = draftToWire(unseenDraft());
    if (!r.ok) throw new Error('expected ok');
    expect(() =>
      validateMissionSpec({
        ...r.wire,
        identity: { ...r.wire.identity, orgId: 'org_x', missionId: 'msn_x' },
      }),
    ).not.toThrow();
  });

  it('review rows show exact amounts with currency precision', () => {
    const r = draftToWire(unseenDraft());
    if (!r.ok) throw new Error('expected ok');
    const rows = Object.fromEntries(reviewRows(r.wire).map((x) => [x.label, x.value]));
    expect(rows['Mission value']).toBe('JPY 5,400,000');
    expect(rows['Alternative 1']).toContain('JPY 760,500');
    expect(rows['Alternative 1']).toContain('p=86.25%');
  });

  it('USD and KWD precision: 3-decimal currencies accept 3 places, 2-decimal reject 3', () => {
    const d = unseenDraft();
    d.currency = 'KWD';
    d.missionValue = '1250.250';
    d.failureCost = '10.5';
    d.protectedReserve = '0';
    for (const o of [d.incumbent, ...d.alternatives, d.diagnostics!]) {
      o.baseCost = '4.125';
      o.fee = '0';
    }
    const kwd = draftToWire(d);
    expect(kwd.ok).toBe(true);
    if (kwd.ok) expect(kwd.wire.economics.missionValueMinor).toBe(1_250_250);
    d.currency = 'USD';
    const usd = draftToWire(d);
    expect(usd.ok).toBe(false);
    if (!usd.ok) {
      expect(usd.issues.some((i) => i.path === 'missionValue')).toBe(true);
    }
  });
});

describe('customer spec form — fail-closed validation matrix', () => {
  const codes = (d: SpecDraft): string[] => {
    const r = draftToWire(d);
    return r.ok ? [] : r.issues.map((i) => i.code);
  };

  it('an empty form is invalid on every required section (no seeded demo values)', () => {
    const r = draftToWire(emptyDraft());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const c = r.issues.map((i) => i.code);
      expect(c).toContain('SPEC_ID_INVALID');
      expect(c).toContain('SPEC_IDENTITY_INCOMPLETE');
      expect(c).toContain('SPEC_ASSET_ID_INVALID');
      expect(c).toContain('SPEC_SOURCE_ID_INVALID');
      expect(c).toContain('SPEC_ECONOMICS_INVALID');
      expect(c).toContain('SPEC_OFFER_ID_INVALID');
    }
  });

  it('domain isolation mirrors the server: aerial needs a wind limit; none → none allowed', () => {
    const d = unseenDraft();
    d.uavWindLimitKt = '';
    expect(codes(d)).toContain('SPEC_WIND_LIMIT_REQUIRED');
    d.uavWindLimitKt = '250';
    expect(codes(d)).toContain('SPEC_WIND_LIMIT_REQUIRED');
    // ground-only: the wind limit is NOT emitted even if text remains in the box
    const g = unseenDraft();
    g.assets = [{ assetId: 'dock-agv-2', label: 'Dock AGV', domainKind: 'ground' }];
    g.sources = [
      {
        sourceId: 'dock-fleet-gw',
        sourceType: 'vessel_gateway',
        assetIds: ['dock-agv-2'],
        trustedForRecovery: true,
        provenance: 'FIELD',
      },
    ];
    g.incumbent.requiresAssetId = 'dock-agv-2';
    g.uavWindLimitKt = '40';
    const r = draftToWire(g);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.wire.safetyPolicy.uavWindLimitKt).toBeUndefined();
  });

  it('comms-offline is always declared for ground assets (server rule), extras optional', () => {
    const d = unseenDraft();
    d.groundInterrupts = ['charger-fault'];
    const r = draftToWire(d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.wire.safetyPolicy.groundInterrupts).toEqual(['comms-offline', 'charger-fault']);
    }
  });

  it('rejects ids the ingest layer would refuse (grammar + banking terms)', () => {
    const d = unseenDraft();
    d.assets[0]!.assetId = 'quad transfer 1';
    expect(codes(d)).toContain('SPEC_ASSET_ID_INVALID');
    d.assets[0]!.assetId = 'quad-transfer-1';
    expect(codes(d)).toContain('CLIENT_AUTHORITY_TERM');
    const s = unseenDraft();
    s.sources[0]!.sourceId = 'payment-gateway';
    expect(codes(s)).toContain('CLIENT_AUTHORITY_TERM');
  });

  it('telemetry sources are single-asset; unknown assets refused; duplicate ids refused', () => {
    const d = unseenDraft();
    d.sources[0]!.assetIds = ['survey-quad-q3', 'haul-gate-radio'];
    expect(codes(d)).toContain('SPEC_TELEMETRY_SOURCE_NOT_SINGLE_ASSET');
    const u = unseenDraft();
    u.sources[1]!.assetIds = ['ghost-asset'];
    expect(codes(u)).toContain('SPEC_SOURCE_ASSET_UNKNOWN');
    const x = unseenDraft();
    x.assets[1]!.assetId = 'survey-quad-q3';
    expect(codes(x)).toContain('SPEC_ASSET_DUPLICATE');
  });

  it('money: extra decimals are REJECTED not rounded; unknown currency fails closed', () => {
    const d = unseenDraft();
    d.missionValue = '5400000.5'; // JPY has no minor unit
    expect(codes(d)).toContain('SPEC_ECONOMICS_INVALID');
    const f = unseenDraft();
    f.currency = 'ZZZ';
    expect(codes(f)).toContain('SPEC_ECONOMICS_INVALID');
    const n = unseenDraft();
    n.incumbent.baseCost = '-5';
    expect(codes(n)).toContain('SPEC_OFFER_NUMBER_INVALID');
    const z = unseenDraft();
    z.missionValue = '0';
    expect(codes(z)).toContain('SPEC_ECONOMICS_INVALID');
  });

  it('probability, deadline, availability and requires-asset are checked', () => {
    expect(parsePercentToBps('100')).toBe(10_000);
    expect(parsePercentToBps('0.01')).toBe(1);
    expect(parsePercentToBps('0')).toBeNull();
    expect(parsePercentToBps('100.01')).toBeNull();
    expect(parsePercentToBps('90.123')).toBeNull();
    expect(parsePercentToBps('abc')).toBeNull();
    const d = unseenDraft();
    d.incumbent.probabilityPercent = '101';
    d.deadlineOffsetMinutes = '0';
    d.incumbent.requiresAssetId = 'nope';
    const c = codes(d);
    expect(c).toContain('SPEC_OFFER_PROBABILITY_INVALID');
    expect(c).toContain('SPEC_ECONOMICS_INVALID');
    expect(c).toContain('SPEC_OFFER_ASSET_UNKNOWN');
  });

  it('offer ids are unique; diagnostics must be a diagnostic service; commas banned', () => {
    const d = unseenDraft();
    d.alternatives[0]!.id = d.incumbent.id;
    expect(codes(d)).toContain('SPEC_OFFER_ID_INVALID');
    const k = unseenDraft();
    k.diagnostics!.kind = 'inspection-service';
    expect(codes(k)).toContain('SPEC_DIAGNOSTIC_KIND_INVALID');
    const c = unseenDraft();
    c.incumbent.beneficiary = 'Ops, Crew';
    expect(codes(c)).toContain('SPEC_OFFER_BENEFICIARY_INVALID');
  });
});

describe('vocabulary parity with the API (drift fails CI)', () => {
  const vocab = readFileSync(
    new URL('../../api/src/mission-events/src/vocabulary.ts', import.meta.url),
    'utf8',
  );

  it('financial-authority terms are identical to the ingest layer', () => {
    const block = /FINANCIAL_AUTHORITY_TERMS = \[([\s\S]*?)\] as const/.exec(vocab)?.[1] ?? '';
    const api = [...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect([...FINANCIAL_AUTHORITY_TERMS].sort()).toEqual([...api].sort());
    expect(authorityTermIn('quad-settle-1')).toBe('settle');
    expect(authorityTermIn('survey-quad-q3')).toBeUndefined();
  });

  it('sample observation kinds/units exist with those exact units in the vocabulary', () => {
    for (const list of Object.values(SAMPLE_OBSERVATIONS)) {
      for (const o of list) {
        const re = new RegExp(`kind: '${o.kind}',\\s*unit: '${o.unit}'`);
        expect(re.test(vocab), `${o.kind}/${o.unit}`).toBe(true);
      }
    }
  });

  it('currency list equals the domain-supported set', () => {
    expect([...SUPPORTED_CURRENCIES].sort()).toEqual([...supportedCurrencies()].sort());
  });
});
