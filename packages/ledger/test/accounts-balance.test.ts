import { describe, expect, it } from 'vitest';
import { LedgerError } from '../src/index.js';
import { makeLedger } from './helpers.js';

describe('accounts and balance snapshots', () => {
  it('creates one treasury account per org+currency and returns it deterministically', () => {
    const { ledger } = makeLedger();
    const org = ledger.organizations.createOrganization('OrgA');
    const a1 = ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'usd',
      label: 'USD treasury',
      protectedFloorMinor: 5_000,
    });
    const a2 = ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'USD',
      label: 'ignored duplicate label',
      protectedFloorMinor: 9_999,
    });
    expect(a1.id).toBe(a2.id);
    expect(a1.currency).toBe('USD');
    expect(a2.protectedFloorMinor).toBe(5_000); // ensure does not silently move the floor
    ledger.close();
  });

  it('rejects unsupported currencies fail-closed', () => {
    const { ledger } = makeLedger();
    const org = ledger.organizations.createOrganization('OrgB');
    expect(() =>
      ledger.accounts.ensureTreasuryAccount({
        orgId: org.id,
        currency: 'XXX',
        label: 'x',
        protectedFloorMinor: 0,
      }),
    ).toThrowError(/not in the supported table/);
    expect(() =>
      ledger.accounts.recordBalanceSnapshot({
        orgId: org.id,
        currency: 'ZZZ',
        minorUnits: 1,
        source: 'manual-seed',
      }),
    ).toThrowError(/UNSUPPORTED|supported table/);
    ledger.close();
  });

  it('rejects negative balances and non-integer amounts', () => {
    const { ledger } = makeLedger();
    const org = ledger.organizations.createOrganization('OrgC');
    ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'EUR',
      label: 'EUR',
      protectedFloorMinor: 0,
    });
    expect(() =>
      ledger.accounts.recordBalanceSnapshot({
        orgId: org.id,
        currency: 'EUR',
        minorUnits: -1,
        source: 'manual-seed',
      }),
    ).toThrowError(/cannot be negative|must be an integer/);
    expect(() =>
      ledger.accounts.recordBalanceSnapshot({
        orgId: org.id,
        currency: 'EUR',
        minorUnits: 12.5,
        source: 'manual-seed',
      }),
    ).toThrowError(/must be an integer/);
    ledger.close();
  });

  it('rejects future-dated or malformed balance observations before they can fund commitments', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('ClockSkewOrg');
    ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'USD',
      label: 'USD',
      protectedFloorMinor: 0,
    });
    const base = {
      orgId: org.id,
      currency: 'USD',
      minorUnits: 100_000,
      source: 'manual-seed' as const,
    };
    expect(() =>
      ledger.accounts.recordBalanceSnapshot({
        ...base,
        observedAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
        expiresAt: new Date(clock.now().getTime() + 7_200_000).toISOString(),
      }),
    ).toThrowError(/future-dated balance/);
    expect(() =>
      ledger.accounts.recordBalanceSnapshot({
        ...base,
        observedAt: 'not-a-date',
        expiresAt: 'also-not-a-date',
      }),
    ).toThrowError(/timestamps must be valid/);
    expect(ledger.accounts.latestSnapshot(org.id, 'USD', clock.now())).toBeUndefined();
    ledger.close();
  });

  it('spendable fails closed with no snapshot, then works when one exists', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('OrgD');
    ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'USD',
      label: 'USD',
      protectedFloorMinor: 1_000,
    });
    expect(() => ledger.spendable.compute(org.id, 'USD')).toThrowError(LedgerError);
    expect(() => ledger.spendable.compute(org.id, 'USD')).toThrowError(/no balance snapshot/);

    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 10_000,
      source: 'manual-seed',
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    });
    const view = ledger.spendable.compute(org.id, 'USD');
    expect(view.spendableMinor).toBe(9_000);
    expect(view.balanceSource).toBe('manual-seed');
    ledger.close();
  });

  it('a snapshot past its expiry makes spendable fail with STALE_BALANCE', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('OrgE');
    ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'USD',
      label: 'USD',
      protectedFloorMinor: 0,
    });
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 10_000,
      source: 'airwallex-sandbox',
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    });

    clock.advance(61_000);
    try {
      ledger.spendable.compute(org.id, 'USD');
      expect.unreachable('stale snapshot must fail');
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).code).toBe('STALE_BALANCE');
      expect((error as LedgerError).message).toMatch(/expired at/);
    }

    // A fresh observation unblocks spending.
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 10_000,
      source: 'airwallex-sandbox',
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    });
    expect(ledger.spendable.compute(org.id, 'USD').spendableMinor).toBe(10_000);
    ledger.close();
  });

  it('uses the newest observation when several snapshots exist', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('OrgF');
    ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'USD',
      label: 'USD',
      protectedFloorMinor: 0,
    });
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 50_000,
      source: 'manual-seed',
      observedAt: '2026-11-03T10:00:00.000Z',
      expiresAt: '2026-11-03T20:00:00.000Z',
    });
    clock.advance(5_000);
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 42_000,
      source: 'airwallex-sandbox',
      observedAt: '2026-11-03T10:05:00.000Z',
      expiresAt: '2026-11-03T20:00:00.000Z',
    });
    expect(ledger.spendable.compute(org.id, 'USD').balanceMinor).toBe(42_000);
    ledger.close();
  });

  it('keeps currencies fully separate (no implicit conversion)', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('OrgG');
    ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'USD',
      label: 'USD',
      protectedFloorMinor: 0,
    });
    ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'JPY',
      label: 'JPY',
      protectedFloorMinor: 0,
    });
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 100,
      source: 'manual-seed',
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    });
    expect(() => ledger.spendable.compute(org.id, 'JPY')).toThrowError(/no balance snapshot/);
    expect(ledger.spendable.compute(org.id, 'USD').balanceMinor).toBe(100);
    ledger.close();
  });
});
