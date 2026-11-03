/**
 * Treasury accounts and provider-derived balance snapshots.
 *
 * A balance number is only as good as its provenance and freshness: every
 * snapshot records its source environment and an expiry. Reservations fail
 * closed on stale data (issue #4: "stale provider snapshot").
 */
import type { LedgerDatabase } from '../db/port.js';
import { num, text } from '../db/port.js';
import { LedgerError } from '../errors.js';
import type { Clock } from '../clock.js';
import { newId } from './identity.js';
import { createMoney, currencyExponent } from '@moterva/domain';
import type { AccountView, BalanceSnapshotView, BalanceSource } from '@moterva/domain';

export interface LatestSnapshot {
  readonly snapshot: BalanceSnapshotView;
  readonly fresh: boolean;
}

export class AccountService {
  constructor(
    private readonly db: LedgerDatabase,
    private readonly clock: Clock,
  ) {}

  /** One treasury account per org+currency; protected floor is set here and can only be raised/lowered explicitly. */
  ensureTreasuryAccount(input: {
    orgId: string;
    currency: string;
    label: string;
    protectedFloorMinor: number;
  }): AccountView {
    const currency = this.normalizeCurrency(input.currency);
    const floor = createMoney(currency, input.protectedFloorMinor);
    if (floor.minorUnits < 0) {
      throw new LedgerError('INVALID_AMOUNT', 'protectedFloorMinor must be a non-negative safe integer');
    }
    const existing = this.db
      .prepare(
        "SELECT id, org_id, currency, kind, label, protected_floor_minor, created_at FROM accounts WHERE org_id = ? AND currency = ? AND kind = 'treasury'",
      )
      .get(input.orgId, currency);
    if (existing !== undefined) {
      const r = existing as Record<string, unknown>;
      return {
        id: text(r.id, 'id'),
        orgId: text(r.org_id, 'org_id'),
        currency: text(r.currency, 'currency'),
        kind: 'treasury',
        label: text(r.label, 'label'),
        protectedFloorMinor: num(r.protected_floor_minor, 'protected_floor_minor'),
        createdAt: text(r.created_at, 'created_at'),
      };
    }
    const account: AccountView = {
      id: newId('acct'),
      orgId: input.orgId,
      currency,
      kind: 'treasury',
      label: input.label.trim(),
      protectedFloorMinor: floor.minorUnits,
      createdAt: this.clock.iso(),
    };
    this.db
      .prepare(
        'INSERT INTO accounts (id, org_id, currency, kind, label, protected_floor_minor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        account.id,
        account.orgId,
        account.currency,
        account.kind,
        account.label,
        account.protectedFloorMinor,
        account.createdAt,
      );
    return account;
  }

  getTreasuryAccount(orgId: string, currency: string): AccountView {
    const row = this.db
      .prepare(
        "SELECT id, org_id, currency, kind, label, protected_floor_minor, created_at FROM accounts WHERE org_id = ? AND currency = ? AND kind = 'treasury'",
      )
      .get(orgId, this.normalizeCurrency(currency));
    if (row === undefined) {
      throw new LedgerError(
        'ACCOUNT_NOT_FOUND',
        `no treasury account for ${currency} in organization ${orgId}`,
      );
    }
    const r = row as Record<string, unknown>;
    return {
      id: text(r.id, 'id'),
      orgId: text(r.org_id, 'org_id'),
      currency: text(r.currency, 'currency'),
      kind: 'treasury',
      label: text(r.label, 'label'),
      protectedFloorMinor: num(r.protected_floor_minor, 'protected_floor_minor'),
      createdAt: text(r.created_at, 'created_at'),
    };
  }

  /**
   * Append a balance observation. `observedAt`/`expiresAt` let callers model
   * provider read times and quote windows; the source label keeps provider
   * truth (sandbox/testnet) visibly separate from seeded demo data.
   */
  recordBalanceSnapshot(input: {
    orgId: string;
    currency: string;
    minorUnits: number;
    source: BalanceSource;
    observedAt?: string;
    expiresAt?: string;
  }): BalanceSnapshotView {
    const currency = this.normalizeCurrency(input.currency);
    const account = this.getTreasuryAccount(input.orgId, currency);
    const money = createMoney(currency, input.minorUnits); // rejects unsupported currency / non-integer / unsafe
    if (money.minorUnits < 0) {
      throw new LedgerError('INVALID_AMOUNT', 'balance snapshots cannot be negative');
    }
    const observedAt = input.observedAt ?? this.clock.iso();
    const expiresAt =
      input.expiresAt ?? new Date(new Date(observedAt).getTime() + 5 * 60_000).toISOString();
    const observedMs = Date.parse(observedAt);
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(observedMs) || !Number.isFinite(expiresMs) || observedMs > expiresMs) {
      throw new LedgerError('INVALID_INPUT', 'balance observation timestamps must be valid and ordered');
    }
    // A future-dated balance must never make a stale/fabricated account look
    // spendable. Allow only a small clock-skew window for provider timestamps.
    if (observedMs > this.clock.now().getTime() + 30_000) {
      throw new LedgerError('INVALID_INPUT', 'future-dated balance observations cannot authorize spending');
    }
    const snapshot: BalanceSnapshotView = {
      id: newId('bal'),
      accountId: account.id,
      orgId: input.orgId,
      currency,
      minorUnits: money.minorUnits,
      source: input.source,
      observedAt,
      expiresAt,
      recordedAt: this.clock.iso(),
    };
    this.db
      .prepare(
        `INSERT INTO balance_snapshots (id, account_id, org_id, currency, minor_units, source, observed_at, expires_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.accountId,
        snapshot.orgId,
        snapshot.currency,
        snapshot.minorUnits,
        snapshot.source,
        snapshot.observedAt,
        snapshot.expiresAt,
        snapshot.recordedAt,
      );
    return snapshot;
  }

  /** Latest snapshot by observation time (ties broken by recording time), flagged for freshness. */
  latestSnapshot(orgId: string, currency: string, now: Date): LatestSnapshot | undefined {
    const row = this.db
      .prepare(
        `SELECT id, account_id, org_id, currency, minor_units, source, observed_at, expires_at, recorded_at
         FROM balance_snapshots WHERE org_id = ? AND currency = ?
         ORDER BY observed_at DESC, recorded_at DESC LIMIT 1`,
      )
      .get(orgId, this.normalizeCurrency(currency));
    if (row === undefined) return undefined;
    const r = row as Record<string, unknown>;
    const snapshot: BalanceSnapshotView = {
      id: text(r.id, 'id'),
      accountId: text(r.account_id, 'account_id'),
      orgId: text(r.org_id, 'org_id'),
      currency: text(r.currency, 'currency'),
      minorUnits: num(r.minor_units, 'minor_units'),
      source: text(r.source, 'source') as BalanceSource,
      observedAt: text(r.observed_at, 'observed_at'),
      expiresAt: text(r.expires_at, 'expires_at'),
      recordedAt: text(r.recorded_at, 'recorded_at'),
    };
    return { snapshot, fresh: new Date(snapshot.expiresAt) > now };
  }

  private normalizeCurrency(currency: string): string {
    const normalized = currency.trim().toUpperCase();
    currencyExponent(normalized); // fail closed on unsupported currency codes
    return normalized;
  }
}
