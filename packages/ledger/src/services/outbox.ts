/**
 * Transactional outbox (docs/01 "Outbox and crash window").
 *
 * A dispatch row is created in the SAME transaction as the reservation, so a
 * committed economic intent always has exactly one durable dispatch record
 * carrying the original request id. Workers claim rows with a conditional
 * UPDATE (atomic), complete them by claim token (at-most-once status change),
 * and stale claims — a worker that died mid-dispatch — are requeued after a
 * TTL and replayed WITH THE SAME request id, never a new economic identity.
 */
import type { LedgerDatabase } from '../db/port.js';
import { nullableText, num, text } from '../db/port.js';
import { LedgerError } from '../errors.js';
import type { Clock } from '../clock.js';
import { newClaimToken } from '../db/sqlite.js';
import type { OutboxDispatchView, OutboxStatus } from '@moterva/domain';

export interface ClaimedDispatch {
  readonly dispatch: OutboxDispatchView;
  readonly operation: {
    readonly id: string;
    readonly orgId: string;
    readonly missionId: string;
    readonly kind: string;
    readonly state: string;
    readonly requestId: string;
    readonly amountMinor: number;
    readonly currency: string;
    readonly beneficiary: string;
    readonly purpose: string;
  };
}

export const DEFAULT_CLAIM_TTL_MS = 60_000;

export class OutboxService {
  constructor(
    private readonly db: LedgerDatabase,
    private readonly clock: Clock,
  ) {}

  /**
   * NON-claiming candidate listing for the worker's authority gate: rows on
   * the given rails that are pending or whose claim went stale. The worker
   * then claims+gates each row atomically (see DispatchWorker).
   */
  listClaimable(options: {
    rails: readonly ('airwallex' | 'metal')[];
    limit?: number;
    claimTtlMs?: number;
  }): Array<{ id: string }> {
    const limit = Math.min(options.limit ?? 10, 100);
    const ttl = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    if (options.rails.length === 0) return [];
    const staleBeforeIso = new Date(this.clock.now().getTime() - ttl).toISOString();
    const railPlaceholders = options.rails.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT id FROM outbox_dispatches
         WHERE rail IN (${railPlaceholders})
           AND (status = 'pending' OR (status = 'claimed' AND updated_at < ?))
         ORDER BY created_at
         LIMIT ?`,
      )
      .all(...options.rails, staleBeforeIso, limit) as Array<{ id: string }>;
  }

  /**
   * Atomically claims up to `limit` dispatchable rows for the given rails.
   * Stale claims (dead worker) become claimable again after `claimTtlMs`.
   */
  claimPending(options: {
    rails: readonly ('airwallex' | 'metal')[];
    limit?: number;
    claimTtlMs?: number;
  }): ClaimedDispatch[] {
    const limit = Math.min(options.limit ?? 10, 100);
    const ttl = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    if (options.rails.length === 0) return [];
    const now = this.clock.now();
    const staleBeforeIso = new Date(now.getTime() - ttl).toISOString();
    const nowIso = this.clock.iso();
    const railPlaceholders = options.rails.map(() => '?').join(', ');

    const candidates = this.db
      .prepare(
        `SELECT id FROM outbox_dispatches
         WHERE rail IN (${railPlaceholders})
           AND (status = 'pending' OR (status = 'claimed' AND updated_at < ?))
         ORDER BY created_at
         LIMIT ?`,
      )
      .all(...options.rails, staleBeforeIso, limit) as Array<{ id: string }>;

    const claimed: ClaimedDispatch[] = [];
    for (const candidate of candidates) {
      const token = newClaimToken('claim');
      const result = this.db
        .prepare(
          `UPDATE outbox_dispatches
           SET status = 'claimed', claim_token = ?, attempts = attempts + 1, updated_at = ?
           WHERE id = ? AND (status = 'pending' OR (status = 'claimed' AND updated_at < ?))`,
        )
        .run(token, nowIso, candidate.id, staleBeforeIso);
      if (result.changes !== 1) continue; // another worker won this row
      const join = this.db
        .prepare(
          `SELECT o.id, o.org_id, o.mission_id, o.kind, o.state, o.request_id, o.amount_minor, o.currency, o.beneficiary, o.purpose,
                  x.id AS dispatch_id, x.rail, x.status AS dispatch_status, x.attempts, x.claim_token, x.created_at AS dispatch_created_at, x.updated_at AS dispatch_updated_at
           FROM operations o JOIN outbox_dispatches x ON x.operation_id = o.id
           WHERE x.id = ?`,
        )
        .get(candidate.id) as Record<string, unknown>;
      claimed.push({
        dispatch: {
          id: text(join.dispatch_id, 'dispatch_id'),
          operationId: text(join.id, 'id'),
          orgId: text(join.org_id, 'org_id'),
          rail: text(join.rail, 'rail') as 'airwallex' | 'metal',
          requestId: text(join.request_id, 'request_id'),
          status: 'claimed',
          attempts: num(join.attempts, 'attempts'),
          claimToken: nullableText(join.claim_token),
          createdAt: text(join.dispatch_created_at, 'created_at'),
          updatedAt: text(join.dispatch_updated_at, 'updated_at'),
        },
        operation: {
          id: text(join.id, 'id'),
          orgId: text(join.org_id, 'org_id'),
          missionId: text(join.mission_id, 'mission_id'),
          kind: text(join.kind, 'kind'),
          state: text(join.state, 'state'),
          requestId: text(join.request_id, 'request_id'),
          amountMinor: num(join.amount_minor, 'amount_minor'),
          currency: text(join.currency, 'currency'),
          beneficiary: text(join.beneficiary, 'beneficiary'),
          purpose: text(join.purpose, 'purpose'),
        },
      });
    }
    return claimed;
  }

  /** Marks a claim dispatched; only the org-scoped claim holder can do this. */
  completeDispatch(orgId: string, dispatchId: string, claimToken: string): OutboxDispatchView {
    const result = this.db
      .prepare(
        `UPDATE outbox_dispatches SET status = 'dispatched', updated_at = ?
         WHERE id = ? AND org_id = ? AND claim_token = ? AND status = 'claimed'`,
      )
      .run(this.clock.iso(), dispatchId, orgId, claimToken);
    if (result.changes !== 1) {
      throw new LedgerError(
        'CLAIM_MISMATCH',
        `dispatch ${dispatchId} is not held by this claim (token mismatch or not claimed)`,
      );
    }
    return this.get(orgId, dispatchId);
  }

  /** Dead-letters a claim after explicit operator/decision — money state must already reflect reality. */
  abandon(orgId: string, dispatchId: string, claimToken: string): OutboxDispatchView {
    const result = this.db
      .prepare(
        `UPDATE outbox_dispatches SET status = 'abandoned', updated_at = ?
         WHERE id = ? AND org_id = ? AND claim_token = ? AND status = 'claimed'`,
      )
      .run(this.clock.iso(), dispatchId, orgId, claimToken);
    if (result.changes !== 1) {
      throw new LedgerError('CLAIM_MISMATCH', `dispatch ${dispatchId} is not held by this claim`);
    }
    return this.get(orgId, dispatchId);
  }

  /** Returns a stale claim to pending without dispatching (crash recovery helper). */
  requeueStaleClaim(dispatchId: string, staleBeforeIso: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox_dispatches SET status = 'pending', claim_token = NULL, updated_at = ? WHERE id = ? AND status = 'claimed' AND updated_at < ?`,
      )
      .run(this.clock.iso(), dispatchId, staleBeforeIso);
    return result.changes === 1;
  }

  get(orgId: string, dispatchId: string): OutboxDispatchView {
    const row = this.db
      .prepare(
        `SELECT id, operation_id, org_id, rail, request_id, status, attempts, claim_token, created_at, updated_at
         FROM outbox_dispatches WHERE id = ? AND org_id = ?`,
      )
      .get(dispatchId, orgId);
    if (row === undefined)
      throw new LedgerError('OUTBOX_NOT_FOUND', `dispatch ${dispatchId} not found`);
    const r = row as Record<string, unknown>;
    return {
      id: text(r.id, 'id'),
      operationId: text(r.operation_id, 'operation_id'),
      orgId: text(r.org_id, 'org_id'),
      rail: nullableText(r.rail) as 'airwallex' | 'metal',
      requestId: text(r.request_id, 'request_id'),
      status: text(r.status, 'status') as OutboxStatus,
      attempts: num(r.attempts, 'attempts'),
      claimToken: nullableText(r.claim_token),
      createdAt: text(r.created_at, 'created_at'),
      updatedAt: text(r.updated_at, 'updated_at'),
    };
  }

  listByOperation(orgId: string, operationId: string): OutboxDispatchView[] {
    const rows = this.db
      .prepare(
        `SELECT id, operation_id, org_id, rail, request_id, status, attempts, claim_token, created_at, updated_at
         FROM outbox_dispatches WHERE operation_id = ? AND org_id = ?`,
      )
      .all(operationId, orgId);
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: text(r.id, 'id'),
        operationId: text(r.operation_id, 'operation_id'),
        orgId: text(r.org_id, 'org_id'),
        rail: nullableText(r.rail) as 'airwallex' | 'metal',
        requestId: text(r.request_id, 'request_id'),
        status: text(r.status, 'status') as OutboxStatus,
        attempts: num(r.attempts, 'attempts'),
        claimToken: nullableText(r.claim_token),
        createdAt: text(r.created_at, 'created_at'),
        updatedAt: text(r.updated_at, 'updated_at'),
      };
    });
  }

  pendingCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM outbox_dispatches WHERE status IN ('pending','claimed')`)
      .get() as { c: number };
    return num(row.c, 'count');
  }
}
