import { describe, expect, it } from 'vitest';
import { loadAirwallexConfig } from '../src/config.js';
import { normalizeTransferStatus, isTerminalStatus } from '../src/status.js';
import { majorUnitsToMinor, minorToMajorUnits } from '../src/money.js';
import { MoneyError } from '@moterva/domain';

describe('adapter configuration gate', () => {
  it('is disabled by default (no env) and never half-configured', () => {
    const config = loadAirwallexConfig({});
    expect(config.enabled).toBe(false);
    expect(config.environment).toBe('disabled');
    expect(config.baseUrl).toBe('https://api.sandbox.airwallex.com');
  });

  it('sandbox env without credentials fails closed at load time', () => {
    expect(() => loadAirwallexConfig({ AIRWALLEX_ENV: 'sandbox' })).toThrowError(
      /requires AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY/,
    );
    expect(() =>
      loadAirwallexConfig({ AIRWALLEX_ENV: 'sandbox', AIRWALLEX_CLIENT_ID: 'x' }),
    ).toThrowError(/never half-configured/);
  });

  it('enables only with sandbox tag AND both credentials', () => {
    const config = loadAirwallexConfig({
      AIRWALLEX_ENV: 'sandbox',
      AIRWALLEX_CLIENT_ID: 'cid',
      AIRWALLEX_API_KEY: 'key',
    });
    expect(config.enabled).toBe(true);
    expect(config.environment).toBe('sandbox');
  });

  it('rejects unsupported environment tags (production/anything else)', () => {
    expect(() =>
      loadAirwallexConfig({
        AIRWALLEX_ENV: 'production',
        AIRWALLEX_CLIENT_ID: 'c',
        AIRWALLEX_API_KEY: 'k',
      }),
    ).toThrowError(/implements the SANDBOX environment only/);
    expect(() => loadAirwallexConfig({ AIRWALLEX_ENV: 'testnet' })).toThrowError(
      /SANDBOX environment only/,
    );
  });
});

describe('transfer status normalization (verified against provider docs, API version 2025-06-30+)', () => {
  it('PAID is terminal success AT VERIFICATION TIME (not irreversible delivery)', () => {
    expect(normalizeTransferStatus('PAID')).toBe('terminal-success');
  });

  it('CANCELLED/FAILED are terminal failed (funds-returned states)', () => {
    expect(normalizeTransferStatus('CANCELLED')).toBe('terminal-failed');
    expect(normalizeTransferStatus('FAILED')).toBe('terminal-failed');
  });

  it('COMPLETED is NOT a transfer status in this API — unknown, never guessed', () => {
    expect(normalizeTransferStatus('COMPLETED')).toBe('unknown');
  });

  it('approval-flow states are non-final', () => {
    for (const status of [
      'APPROVAL_REJECTED',
      'APPROVAL_RECALLED',
      'APPROVAL_BLOCKED',
      'OVERDUE',
    ]) {
      expect(normalizeTransferStatus(status)).toBe('pending');
    }
  });

  it('SENT/PROCESSING and pending states are NEVER final', () => {
    for (const status of [
      'SENT',
      'PROCESSING',
      'SCHEDULED',
      'PENDING_PROCESSING',
      'AWAITING_FUNDS',
    ]) {
      expect(normalizeTransferStatus(status)).toBe('pending');
      expect(isTerminalStatus(normalizeTransferStatus(status) as never)).toBe(false);
    }
  });

  it('undocumented/absent statuses map to unknown — never guessed', () => {
    expect(normalizeTransferStatus('SOME_NEW_STATE')).toBe('unknown');
    expect(normalizeTransferStatus(undefined)).toBe('unknown');
    expect(normalizeTransferStatus('')).toBe('unknown');
  });
});

describe('major/minor unit conversion (Airwallex amounts are MAJOR units)', () => {
  it('converts minor units to exact provider major values', () => {
    expect(minorToMajorUnits('USD', 1234)).toBe(12.34);
    expect(minorToMajorUnits('USD', 5)).toBe(0.05);
    expect(minorToMajorUnits('JPY', 123456)).toBe(123456);
    expect(minorToMajorUnits('BHD', 1234)).toBe(1.234);
  });

  it('converts provider major values back to exact minor units', () => {
    expect(majorUnitsToMinor('USD', 12.34)).toBe(1234);
    expect(majorUnitsToMinor('USD', 0.05)).toBe(5);
    expect(majorUnitsToMinor('JPY', 123456)).toBe(123456);
    expect(majorUnitsToMinor('BHD', 1.234)).toBe(1234);
  });

  it('fails closed on float drift and wrong decimals from the provider', () => {
    // 0.30000000000000004 is the classic binary-float artifact; String() keeps
    // it, and fromMajorString rejects it as more decimals than USD allows.
    expect(() => majorUnitsToMinor('USD', 0.30000000000000004)).toThrowError(MoneyError);
    expect(() => majorUnitsToMinor('USD', 12.345)).toThrowError(/at most 2 decimal/);
    expect(() => majorUnitsToMinor('JPY', 12.5)).toThrowError(/at most 0 decimal/);
    expect(() => majorUnitsToMinor('USD', Number.NaN)).toThrowError();
    expect(() => majorUnitsToMinor('USD', '12.34' as unknown)).toThrowError();
  });

  it('round-trips every sample exactly (no drift in either direction)', () => {
    for (const [currency, minor] of [
      ['USD', 123456789],
      ['EUR', 990000],
      ['JPY', 42],
      ['BHD', 120034],
    ] as const) {
      expect(majorUnitsToMinor(currency, minorToMajorUnits(currency, minor))).toBe(minor);
    }
  });
});
