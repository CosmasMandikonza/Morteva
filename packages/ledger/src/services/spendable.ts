/**
 * Spendable capacity — the issue #4 formula:
 *
 *   spendable = verified available balance
 *             - protected floor
 *             - outstanding commitments
 *
 * "Outstanding commitments" conservatively includes every reservation that is
 * pending or ambiguous (reserved/unknown) AND settlements finalized after the
 * balance snapshot was observed (their money has left the bank but the
 * snapshot does not know yet). Released commitments never consume capacity.
 *
 * If commitments exceed balance+floor (an external actor spent from the same
 * wallet — docs/01 "Reserved budget vs provider funds"), spendable clamps to
 * zero and the breakdown reports `overcommitted` so callers escalate instead
 * of lending phantom capacity.
 */
import type { LedgerDatabase } from '../db/port.js';
import { num } from '../db/port.js';
import { LedgerError } from '../errors.js';
import type { Clock } from '../clock.js';
import { type AccountService } from './accounts.js';
import { addMoney, createMoney, subMoney } from '@moterva/domain';
import type { BalanceSource, SpendableView } from '@moterva/domain';

/**
 * Maximum age of a verified metal-testnet chain read that may back a
 * reservation (CTO R3 P0-3): the freshness window is enforced THROUGH
 * reservation time, not only at snapshot insertion — an old chain read with
 * a future expiry can never satisfy spendable math.
 */
const CHAIN_READ_MAX_AGE_MS = 15 * 60_000;

function isStaleChainRead(chainReadAt: string | null | undefined, nowMs: number): boolean {
  if (chainReadAt === null || chainReadAt === undefined) return true;
  const ms = Date.parse(chainReadAt);
  if (!Number.isFinite(ms)) return true;
  return nowMs - ms > CHAIN_READ_MAX_AGE_MS;
}

const OUTSTANDING_SQL = `
  SELECT COALESCE(SUM(amount_minor), 0) AS total
  FROM commitments
  WHERE org_id = ? AND currency = ?
    AND (
      state IN ('reserved','unknown')
      OR (state = 'settled' AND finalized_at IS NOT NULL AND finalized_at >= ?)
    )`;

export class SpendableService {
  constructor(
    private readonly db: LedgerDatabase,
    private readonly clock: Clock,
    private readonly accounts: AccountService,
  ) {}

  /**
   * Computes spendable for an org+currency. Must be called inside the same
   * write transaction as any reservation that consumes it — the write lock is
   * what makes the read-modify-write atomic across workers.
   */
  compute(orgId: string, currency: string): SpendableView {
    const now = this.clock.now();
    const account = this.accounts.getAccountForCurrency(orgId, currency);
    const latest = this.accounts.latestSnapshot(orgId, currency, now);
    if (latest === undefined) {
      throw new LedgerError(
        'NO_BALANCE_SNAPSHOT',
        `no balance snapshot for ${currency} in organization ${orgId}; refusing to reserve against unknown funds`,
      );
    }
    if (!latest.fresh) {
      throw new LedgerError(
        'STALE_BALANCE',
        `balance snapshot for ${currency} expired at ${latest.snapshot.expiresAt} (observed ${latest.snapshot.observedAt}); a fresh provider/seed observation is required before committing funds`,
        {
          observedAt: latest.snapshot.observedAt,
          expiresAt: latest.snapshot.expiresAt,
          source: latest.snapshot.source,
        },
      );
    }
    // Token chain-read freshness THROUGH reservation (CTO R3 P0-3): a
    // metal-testnet snapshot whose underlying chain read has aged past the
    // token freshness window is stale evidence even if its expiresAt is
    // still in the future (the "old read + future expiry" counterexample:
    // chainReadAt 11:46, observedAt 12:00, expiresAt 12:30 would otherwise
    // authorize at 12:29 with a 43-minute-old read).
    if (latest.snapshot.source === 'metal-testnet') {
      const chainReadAt = (
        this.db
          .prepare('SELECT chain_read_at FROM balance_snapshots WHERE id = ?')
          .get(latest.snapshot.id) as { chain_read_at: string | null } | undefined
      )?.chain_read_at;
      if (isStaleChainRead(chainReadAt, now.getTime())) {
        throw new LedgerError(
          'CHAIN_READ_STALE',
          `metal-testnet chain read for ${currency} is older than ${CHAIN_READ_MAX_AGE_MS} ms — a fresh verified read is required before the balance can authorize spending (read at ${chainReadAt ?? 'unknown'})`,
          { chainReadAt: chainReadAt },
        );
      }
    }
    const snapshot = latest.snapshot;

    const outstandingRow = this.db
      .prepare(OUTSTANDING_SQL)
      .get(orgId, currency, snapshot.observedAt) as {
      total: number;
    };
    const outstanding = num(outstandingRow.total, 'outstanding');

    const balance = createMoney(currency, snapshot.minorUnits);
    const afterFloor = subMoney(balance, createMoney(currency, account.protectedFloorMinor));
    const spendableRaw = subMoney(afterFloor, createMoney(currency, outstanding)); // throws OVERFLOW if absurd
    const overcommitted = spendableRaw.minorUnits < 0;
    const spendable = overcommitted ? 0 : spendableRaw.minorUnits;

    return {
      orgId,
      currency,
      balanceMinor: balance.minorUnits,
      balanceSource: snapshot.source as BalanceSource,
      balanceObservedAt: snapshot.observedAt,
      balanceExpiresAt: snapshot.expiresAt,
      protectedFloorMinor: account.protectedFloorMinor,
      outstandingCommittedMinor: outstanding,
      spendableMinor: spendable,
      overcommitted,
    };
  }

  /** Non-throwing variant for dashboards/read models: overcommitted shows 0 + flag, stale shows stale flag. */
  inspect(
    orgId: string,
    currency: string,
  ):
    | { kind: 'ok'; view: SpendableView }
    | { kind: 'stale'; message: string }
    | { kind: 'no_snapshot'; message: string } {
    try {
      return { kind: 'ok', view: this.compute(orgId, currency) };
    } catch (error) {
      if (error instanceof LedgerError && error.code === 'STALE_BALANCE') {
        return { kind: 'stale', message: error.message };
      }
      if (error instanceof LedgerError && error.code === 'NO_BALANCE_SNAPSHOT') {
        return { kind: 'no_snapshot', message: error.message };
      }
      throw error;
    }
  }

  /** Sums two minor-unit amounts with the domain guard (overflow-safe). */
  static guardedSum(currency: string, a: number, b: number): number {
    return addMoney(createMoney(currency, a), createMoney(currency, b)).minorUnits;
  }
}
