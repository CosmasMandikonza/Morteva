/**
 * Append-only evidence journal (docs/01 evidence; docs/05 #10).
 *
 * Financial and operational evidence share one table guarded by UPDATE/DELETE
 * triggers. Duplicate suppression is by (org_id, event_key): replayed webhooks
 * or retried workers cannot append the same event twice. Payload digests make
 * the journal tamper-evident for later replay tooling.
 */
import { createHash } from 'node:crypto';
import type { LedgerDatabase } from '../db/port.js';
import { num, text } from '../db/port.js';
import { LedgerError } from '../errors.js';
import type { Clock } from '../clock.js';
import { newId } from './identity.js';
import { canonicalJson } from '@moterva/domain';
import type { EvidenceEventView } from '@moterva/domain';

export interface AppendEvidenceInput {
  readonly orgId: string;
  readonly missionId?: string;
  readonly topic: 'financial' | 'operational';
  readonly type: string;
  /** Unique within the org — duplicates are rejected (webhook/worker replay suppression). */
  readonly eventKey: string;
  readonly payload: Record<string, unknown>;
  /** ingestAt lets a caller model external event time separately from recording time. */
  readonly occurredAt?: string;
}

export class EvidenceService {
  constructor(
    private readonly db: LedgerDatabase,
    private readonly clock: Clock,
  ) {}

  append(input: AppendEvidenceInput): EvidenceEventView {
    // A caller must not attach an event to another organization's mission.
    // Bare foreign keys verify existence, not tenancy, so enforce here too.
    if (input.missionId !== undefined) {
      const row = this.db
        .prepare('SELECT id FROM missions WHERE id = ? AND org_id = ?')
        .get(input.missionId, input.orgId);
      if (row === undefined) {
        throw new LedgerError(
          'CROSS_ORG_ACCESS',
          'evidence mission does not belong to the stated organization',
        );
      }
    }
    const digest = createHash('sha256').update(canonicalJson(input.payload)).digest('hex');
    const recordedAt = this.clock.iso();
    try {
      this.db
        .prepare(
          `INSERT INTO evidence_events (id, org_id, mission_id, topic, type, event_key, payload_digest, payload_json, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId('evt'),
          input.orgId,
          input.missionId ?? null,
          input.topic,
          input.type,
          input.eventKey,
          digest,
          JSON.stringify(input.payload),
          recordedAt,
        );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/UNIQUE constraint failed: evidence_events/i.test(message)) {
        throw new LedgerError(
          'DUPLICATE_EVENT',
          `event key "${input.eventKey}" already exists for organization ${input.orgId}; replays are rejected`,
          { eventKey: input.eventKey },
        );
      }
      if (/append-only/i.test(message)) {
        throw new LedgerError(
          'JOURNAL_APPEND_ONLY',
          `evidence journal rejected a mutation: ${message}`,
        );
      }
      throw error;
    }
    return this.getByEventKey(input.orgId, input.eventKey);
  }

  list(
    orgId: string,
    options: { topic?: 'financial' | 'operational'; missionId?: string; limit?: number },
  ): EvidenceEventView[] {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (options.topic !== undefined) {
      clauses.push('topic = ?');
      params.push(options.topic);
    }
    if (options.missionId !== undefined) {
      clauses.push('mission_id = ?');
      params.push(options.missionId);
    }
    params.push(Math.min(options.limit ?? 100, 1000));
    const rows = this.db
      .prepare(
        `SELECT seq, id, org_id, mission_id, topic, type, event_key, payload_digest, recorded_at
         FROM evidence_events WHERE ${clauses.join(' AND ')} ORDER BY seq DESC LIMIT ?`,
      )
      .all(...params);
    return rows.map((row) => this.mapRow(row));
  }

  count(orgId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM evidence_events WHERE org_id = ?')
      .get(orgId) as { c: number };
    return num(row.c, 'count');
  }

  private getByEventKey(orgId: string, eventKey: string): EvidenceEventView {
    // Do not use "latest event by org": another writer may append after our
    // INSERT and before the SELECT, producing someone else's evidence receipt.
    const row = this.db
      .prepare(
        'SELECT seq, id, org_id, mission_id, topic, type, event_key, payload_digest, recorded_at FROM evidence_events WHERE org_id = ? AND event_key = ?',
      )
      .get(orgId, eventKey);
    if (row === undefined)
      throw new LedgerError('DB_CORRUPTED', 'evidence insert reported success but row is missing');
    return this.mapRow(row);
  }

  private mapRow(row: unknown): EvidenceEventView {
    const r = row as Record<string, unknown>;
    return {
      seq: num(r.seq, 'seq'),
      id: text(r.id, 'id'),
      orgId: text(r.org_id, 'org_id'),
      missionId: r.mission_id === null ? null : text(r.mission_id, 'mission_id'),
      topic: text(r.topic, 'topic') as 'financial' | 'operational',
      type: text(r.type, 'type'),
      eventKey: text(r.event_key, 'event_key'),
      payloadDigest: text(r.payload_digest, 'payload_digest'),
      recordedAt: text(r.recorded_at, 'recorded_at'),
    };
  }
}
