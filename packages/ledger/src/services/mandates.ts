/**
 * Mandates: immutable, versioned spending authority for a mission.
 * Issuing a new version supersedes the previous one; history is never edited.
 */
import type { LedgerDatabase } from '../db/port.js';
import { num, text } from '../db/port.js';
import { LedgerError } from '../errors.js';
import type { Clock } from '../clock.js';
import { newId } from './identity.js';
import { createMoney, currencyExponent } from '@moterva/domain';
import type { MandateView } from '@moterva/domain';

export interface MandateTerms {
  readonly currency: string;
  readonly maxAmountMinor: number;
  readonly permittedOperationKinds: readonly string[];
  readonly expiresAt: string;
}

export class MandateService {
  constructor(
    private readonly db: LedgerDatabase,
    private readonly clock: Clock,
  ) {}

  /** Creates version 1 or the next version of the same mandate id, superseding prior versions. */
  issue(
    input: { orgId: string; missionId: string; mandateId?: string } & MandateTerms,
  ): MandateView {
    const currency = this.normalize(input.currency);
    const money = createMoney(currency, input.maxAmountMinor);
    if (money.minorUnits <= 0) {
      throw new LedgerError('INVALID_AMOUNT', 'mandate maxAmountMinor must be positive');
    }
    if (input.permittedOperationKinds.length === 0) {
      throw new LedgerError('INVALID_INPUT', 'mandate must permit at least one operation kind');
    }
    const expiresMs = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= this.clock.now().getTime()) {
      throw new LedgerError('MANDATE_EXPIRED', 'mandate expiry must be a valid future date');
    }
    const owningMission = this.db
      .prepare('SELECT id FROM missions WHERE id = ? AND org_id = ?')
      .get(input.missionId, input.orgId);
    if (owningMission === undefined) {
      throw new LedgerError('CROSS_ORG_ACCESS', 'mandate mission does not belong to organization');
    }
    const mandateId = input.mandateId ?? newId('mnd');
    const previous = this.db
      .prepare('SELECT mission_id FROM mandates WHERE id = ? AND org_id = ? LIMIT 1')
      .get(mandateId, input.orgId) as { mission_id: string } | undefined;
    if (previous !== undefined && previous.mission_id !== input.missionId) {
      throw new LedgerError('CROSS_ORG_ACCESS', 'one mandate identity cannot span missions');
    }
    const versionRow = this.db
      .prepare('SELECT MAX(version) AS v FROM mandates WHERE id = ? AND org_id = ?')
      .get(mandateId, input.orgId) as { v: number | null };
    const nextVersion = (versionRow.v ?? 0) + 1;
    const mandate: MandateView = {
      id: mandateId,
      orgId: input.orgId,
      missionId: input.missionId,
      version: nextVersion,
      status: 'active',
      currency,
      maxAmountMinor: money.minorUnits,
      permittedOperationKinds: [...input.permittedOperationKinds],
      expiresAt: input.expiresAt,
      createdAt: this.clock.iso(),
    };
    this.db.transaction(() => {
      if (nextVersion > 1) {
        this.db
          .prepare(
            "UPDATE mandates SET status = 'superseded' WHERE id = ? AND org_id = ? AND version < ?",
          )
          .run(mandateId, input.orgId, nextVersion);
      }
      this.db
        .prepare(
          `INSERT INTO mandates (id, org_id, mission_id, version, status, currency, max_amount_minor, permitted_kinds_json, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          mandate.id,
          mandate.orgId,
          mandate.missionId,
          mandate.version,
          mandate.status,
          mandate.currency,
          mandate.maxAmountMinor,
          JSON.stringify(mandate.permittedOperationKinds),
          mandate.expiresAt,
          mandate.createdAt,
        );
    });
    return mandate;
  }

  /** Latest version of a mandate, org-scoped. */
  latest(orgId: string, missionId: string, mandateId: string): MandateView {
    const row = this.db
      .prepare(
        `SELECT id, org_id, mission_id, version, status, currency, max_amount_minor, permitted_kinds_json, expires_at, created_at
         FROM mandates WHERE id = ? AND org_id = ? AND mission_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(mandateId, orgId, missionId);
    if (row === undefined) {
      throw new LedgerError(
        'MANDATE_NOT_FOUND',
        `mandate ${mandateId} not found for mission ${missionId} in organization ${orgId}`,
      );
    }
    return this.mapRow(row);
  }

  /**
   * The single authoritative mandate for a mission right now: the latest
   * version that is active and unexpired at `now`. Superseded/expired
   * mandates never authorize a new reservation.
   */
  activeFor(orgId: string, missionId: string, now: Date): MandateView {
    const rows = this.db
      .prepare(
        `SELECT id, org_id, mission_id, version, status, currency, max_amount_minor, permitted_kinds_json, expires_at, created_at
         FROM mandates WHERE org_id = ? AND mission_id = ? ORDER BY version DESC`,
      )
      .all(orgId, missionId);
    for (const row of rows) {
      const mandate = this.mapRow(row);
      if (mandate.status === 'active' && new Date(mandate.expiresAt) > now) return mandate;
    }
    const newest = rows.length > 0 ? this.mapRow(rows[0] as unknown) : undefined;
    if (newest && new Date(newest.expiresAt) <= now) {
      throw new LedgerError(
        'MANDATE_EXPIRED',
        `mandate ${newest.id} v${newest.version} expired at ${newest.expiresAt}`,
      );
    }
    throw new LedgerError(
      'MANDATE_NOT_FOUND',
      `no active mandate for mission ${missionId} in organization ${orgId}`,
    );
  }

  private mapRow(row: unknown): MandateView {
    const r = row as Record<string, unknown>;
    return {
      id: text(r.id, 'id'),
      orgId: text(r.org_id, 'org_id'),
      missionId: text(r.mission_id, 'mission_id'),
      version: num(r.version, 'version'),
      status: text(r.status, 'status') as MandateView['status'],
      currency: text(r.currency, 'currency'),
      maxAmountMinor: num(r.max_amount_minor, 'max_amount_minor'),
      permittedOperationKinds: JSON.parse(
        text(r.permitted_kinds_json, 'permitted_kinds_json'),
      ) as string[],
      expiresAt: text(r.expires_at, 'expires_at'),
      createdAt: text(r.created_at, 'created_at'),
    };
  }

  private normalize(currency: string): string {
    const normalized = currency.trim().toUpperCase();
    currencyExponent(normalized);
    return normalized;
  }
}
