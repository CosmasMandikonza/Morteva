/**
 * Restart recovery & integrity verification.
 *
 * Because reservation+commitment+outbox+evidence commit in ONE transaction,
 * a crash can never leave a half-reserved intent. Recovery therefore:
 *   1. verifies persisted invariants (1:1 links, state mapping, no duplicate
 *      economic identities, no missing dispatch rows, no finalized-at drift),
 *   2. reports pending dispatches that will replay with their original ids.
 *
 * It deliberately does NOT mutate anything: a violation is surfaced for an
 * operator/human decision, never auto-"repaired" — silently rewriting money
 * state is exactly what this system must not do.
 */
import type { LedgerDatabase } from '../db/port.js';
import { commitmentStateFor } from '@moterva/domain';
import type { Clock } from '../clock.js';
import type { OutboxService } from './outbox.js';

export interface IntegrityReport {
  readonly integrity: 'ok' | 'violations';
  readonly violations: readonly string[];
  readonly counts: {
    readonly operations: number;
    readonly commitments: number;
    readonly evidence: number;
    readonly pendingDispatches: number;
  };
}

export class RecoveryService {
  constructor(
    private readonly db: LedgerDatabase,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
  ) {}

  verify(): IntegrityReport {
    const violations: string[] = [];

    const orphanCommitments = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM commitments c LEFT JOIN operations o ON o.id = c.operation_id WHERE o.id IS NULL`,
      )
      .get() as { c: number };
    if (orphanCommitments.c > 0)
      violations.push(`${orphanCommitments.c} commitment(s) reference missing operations`);

    const missingCommitments = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM operations o LEFT JOIN commitments c ON c.operation_id = o.id WHERE c.id IS NULL`,
      )
      .get() as { c: number };
    if (missingCommitments.c > 0)
      violations.push(`${missingCommitments.c} operation(s) have no commitment row`);

    const duplicateIdentities = this.db
      .prepare(
        `SELECT org_id, request_id, COUNT(*) AS c FROM operations GROUP BY org_id, request_id HAVING COUNT(*) > 1`,
      )
      .all() as Array<{ org_id: string; request_id: string; c: number }>;
    for (const row of duplicateIdentities) {
      violations.push(
        `duplicate economic identity org=${row.org_id} request_id=${row.request_id} ×${row.c}`,
      );
    }

    const drifted = this.db
      .prepare(
        `SELECT c.id AS commitment_id, c.state AS commitment_state, o.state AS operation_state, c.finalized_at
         FROM commitments c JOIN operations o ON o.id = c.operation_id`,
      )
      .all() as Array<{
      commitment_id: string;
      commitment_state: string;
      operation_state: string;
      finalized_at: string | null;
    }>;
    for (const row of drifted) {
      const expected = commitmentStateFor(row.operation_state as never);
      if (expected !== row.commitment_state) {
        violations.push(
          `commitment ${row.commitment_id} state "${row.commitment_state}" does not match operation state "${row.operation_state}" (expected "${expected}")`,
        );
      }
      if (row.commitment_state === 'settled' && row.finalized_at === null) {
        violations.push(`settled commitment ${row.commitment_id} is missing finalized_at`);
      }
      if (row.commitment_state !== 'settled' && row.finalized_at !== null) {
        violations.push(
          `non-settled commitment ${row.commitment_id} unexpectedly has finalized_at`,
        );
      }
    }

    const missingDispatch = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM operations o
         LEFT JOIN outbox_dispatches x ON x.operation_id = o.id
         WHERE o.kind IN ('airwallex_transfer','metal_order')
           AND o.state IN ('RESERVED','SUBMITTING','IN_FLIGHT','STATUS_UNKNOWN')
           AND x.id IS NULL`,
      )
      .get() as { c: number };
    if (missingDispatch.c > 0)
      violations.push(
        `${missingDispatch.c} in-flight rail operation(s) missing an outbox dispatch row`,
      );

    const counts = {
      operations: (this.db.prepare('SELECT COUNT(*) AS c FROM operations').get() as { c: number })
        .c,
      commitments: (this.db.prepare('SELECT COUNT(*) AS c FROM commitments').get() as { c: number })
        .c,
      evidence: (
        this.db.prepare('SELECT COUNT(*) AS c FROM evidence_events').get() as { c: number }
      ).c,
      pendingDispatches: this.outbox.pendingCount(),
    };

    return { integrity: violations.length === 0 ? 'ok' : 'violations', violations, counts };
  }

  /** What a restart would replay right now: pending dispatches with their original request ids. */
  replayPlan(): readonly {
    dispatchId: string;
    operationId: string;
    requestId: string;
    rail: string;
    status: string;
  }[] {
    interface ReplayRow {
      dispatch_id: string;
      operation_id: string;
      request_id: string;
      rail: string | null;
      status: string;
    }
    const rows = this.db
      .prepare(
        `SELECT x.id AS dispatch_id, x.operation_id, x.request_id, x.rail, x.status
         FROM outbox_dispatches x WHERE x.status IN ('pending','claimed') ORDER BY x.created_at`,
      )
      .all() as ReplayRow[];
    return rows.map((row) => ({
      dispatchId: row.dispatch_id,
      operationId: row.operation_id,
      requestId: row.request_id,
      rail: row.rail ?? 'none',
      status: row.status,
    }));
  }

  now(): string {
    return this.clock.iso();
  }
}
