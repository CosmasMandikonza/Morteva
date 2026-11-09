/**
 * Mandates: immutable, versioned spending authority for a mission (issue #7).
 *
 * Issuing a new version supersedes the previous one; history is never edited.
 * Each version now carries REAL cumulative authority:
 *   - per-operation maximum (maxAmountMinor)
 *   - lifetime cumulative envelope (totalBudgetMinor; -1 = per-op max, v1 semantics)
 *   - permitted provider rails (Metal blocked globally until issue #6)
 *   - beneficiary and purpose allowlists (empty = any, v1 semantics)
 *   - validity window + explicit revocation (revocation is a status/reason
 *     change on the version rows, never a term edit)
 *
 * Cumulative consumption counts every operation that is not proven
 * never-executed — including SETTLED/RECONCILED for the lifetime of the
 * mandate (an envelope bounds total authorized spending, not current float)
 * and STATUS_UNKNOWN/REQUIRES_HUMAN until independently resolved.
 */
import type { LedgerDatabase } from '../db/port.js';
import { nullableText, num, text } from '../db/port.js';
import { LedgerError } from '../errors.js';
import type { Clock } from '../clock.js';
import { newId } from './identity.js';
import { createMoney, currencyExponent } from '@moterva/domain';
import type { MandateView } from '@moterva/domain';
import type { EvidenceService } from './evidence.js';

export interface MandateTerms {
  readonly currency: string;
  readonly maxAmountMinor: number;
  /** Cumulative lifetime budget; defaults to maxAmountMinor (conservative v1-compatible). */
  readonly totalBudgetMinor?: number;
  readonly permittedOperationKinds: readonly string[];
  /** Provider rails; only 'airwallex' is available until issue #6 ships token-asset accounting. */
  readonly rails?: readonly string[];
  /** Empty/omitted = any beneficiary. Non-empty = exact-match allowlist. */
  readonly allowedBeneficiaries?: readonly string[];
  /** Empty/omitted = any purpose (info-purchase category). */
  readonly allowedPurposes?: readonly string[];
  readonly requireSeparateApprover?: boolean;
  readonly expiresAt: string;
}

/** Operation states that consume the cumulative mandate envelope. */
const CONSUMING_STATES_SQL =
  "('RESERVED','SUBMITTING','IN_FLIGHT','STATUS_UNKNOWN','SETTLED','RECONCILED','REQUIRES_HUMAN')";

export class MandateService {
  constructor(
    private readonly db: LedgerDatabase,
    private readonly clock: Clock,
    private readonly evidence: EvidenceService,
  ) {}

  /** Creates version 1 or the next version of the same mandate id, superseding prior versions. */
  issue(
    input: {
      orgId: string;
      missionId: string;
      mandateId?: string;
      byActorId?: string;
    } & MandateTerms,
  ): MandateView {
    const currency = this.normalize(input.currency);
    const money = createMoney(currency, input.maxAmountMinor);
    if (money.minorUnits <= 0) {
      throw new LedgerError('INVALID_AMOUNT', 'mandate maxAmountMinor must be positive');
    }
    if (input.permittedOperationKinds.length === 0) {
      throw new LedgerError('INVALID_INPUT', 'mandate must permit at least one operation kind');
    }
    const totalBudget = input.totalBudgetMinor ?? money.minorUnits;
    const envelope = createMoney(currency, totalBudget);
    if (envelope.minorUnits < money.minorUnits) {
      throw new LedgerError(
        'INVALID_INPUT',
        `totalBudgetMinor (${envelope.minorUnits}) must be >= maxAmountMinor (${money.minorUnits}); an envelope smaller than one operation authorizes nothing`,
      );
    }
    const rails = [...(input.rails ?? ['airwallex'])];
    if (rails.length === 0)
      throw new LedgerError('INVALID_INPUT', 'mandate must permit at least one rail');
    for (const rail of rails) {
      if (rail !== 'airwallex' && rail !== 'metal') {
        throw new LedgerError('RAIL_NOT_PERMITTED', `unknown rail "${rail}"`);
      }
    }
    // Rail/asset isolation (MTV-19 migration 0005): the metal rail is only
    // authorized for a currency that is a REGISTERED token asset of this
    // organization, and then EXCLUSIVELY — a token mandate can never carry
    // the airwallex rail, and a fiat mandate can never carry metal. The
    // mandate's permitted kinds must be metal_order only, so no token
    // envelope can authorize a fiat operation either.
    // Tolerate pre-migration databases (raw in-memory fixtures): without
    // the table there are no registered token assets — fiat-only world.
    const tokenCurrency =
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'token_assets'")
        .get() !== undefined &&
      this.db
        .prepare(
          'SELECT id FROM token_assets WHERE org_id = ? AND currency = ? AND revoked_at IS NULL',
        )
        .get(input.orgId, currency) !== undefined;
    if (rails.includes('metal') && !tokenCurrency) {
      throw new LedgerError(
        'RAIL_ASSET_UNSUPPORTED',
        'the metal rail requires a currency that is a registered token asset of this organization (chain/contract/decimals + token account); fiat envelopes can never authorize tokenized payments',
      );
    }
    if (!rails.includes('metal') && tokenCurrency) {
      throw new LedgerError(
        'RAIL_ASSET_UNSUPPORTED',
        'a token-asset currency can only be mandated on the metal rail',
      );
    }
    if (rails.includes('airwallex') && tokenCurrency) {
      throw new LedgerError(
        'RAIL_ASSET_UNSUPPORTED',
        'a token-asset mandate can never carry the airwallex rail; fiat rails and token rails are structurally disjoint',
      );
    }
    if (tokenCurrency && input.permittedOperationKinds.some((kind) => kind !== 'metal_order')) {
      throw new LedgerError(
        'RAIL_ASSET_UNSUPPORTED',
        'a token-asset mandate can only permit metal_order operations',
      );
    }
    const allowedBeneficiaries = (input.allowedBeneficiaries ?? [])
      .map((b) => b.trim())
      .filter((b) => b !== '');
    const allowedPurposes = (input.allowedPurposes ?? [])
      .map((p) => p.trim())
      .filter((p) => p !== '');
    const expiresMs = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= this.clock.now().getTime()) {
      throw new LedgerError(
        'MANDATE_EXPIRED',
        'mandate expiry must be in the future and a valid date',
      );
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
      totalBudgetMinor: envelope.minorUnits,
      permittedOperationKinds: [...input.permittedOperationKinds],
      rails,
      allowedBeneficiaries,
      allowedPurposes,
      requireSeparateApprover: input.requireSeparateApprover ?? true,
      expiresAt: input.expiresAt,
      revokedAt: null,
      createdAt: this.clock.iso(),
    };
    this.db.transaction(() => {
      // A mission/currency may have ONE active authority envelope. Replacing
      // its mandate ID must not leave an older active cap to fall back to.
      // Historical operations under *all* IDs continue consuming mission cap.
      this.db
        .prepare(
          "UPDATE mandates SET status = 'superseded' WHERE org_id = ? AND mission_id = ? AND currency = ? AND status = 'active'",
        )
        .run(input.orgId, input.missionId, currency);
      this.db
        .prepare(
          `INSERT INTO mandates (id, org_id, mission_id, version, status, currency, max_amount_minor, total_budget_minor,
             permitted_kinds_json, rails_json, allowed_beneficiaries_json, allowed_purposes_json,
             require_separate_approver, expires_at, revoked_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          mandate.id,
          mandate.orgId,
          mandate.missionId,
          mandate.version,
          mandate.status,
          mandate.currency,
          mandate.maxAmountMinor,
          mandate.totalBudgetMinor,
          JSON.stringify(mandate.permittedOperationKinds),
          JSON.stringify(mandate.rails),
          JSON.stringify(mandate.allowedBeneficiaries),
          JSON.stringify(mandate.allowedPurposes),
          mandate.requireSeparateApprover ? 1 : 0,
          mandate.expiresAt,
          mandate.createdAt,
        );
    });
    this.evidence.append({
      orgId: input.orgId,
      missionId: input.missionId,
      topic: 'financial',
      type: 'mandate.issued',
      eventKey: `mandate:${mandate.id}:v${mandate.version}:issued`,
      payload: {
        mandateId: mandate.id,
        version: mandate.version,
        currency: mandate.currency,
        maxAmountMinor: mandate.maxAmountMinor,
        totalBudgetMinor: mandate.totalBudgetMinor,
        rails: mandate.rails,
        by: input.byActorId ?? 'system',
      },
    });
    return mandate;
  }

  /**
   * Explicit revocation: blocks new reservations and undispatched outbox work
   * immediately. Already-submitted operations keep their commitments and are
   * resolved by provider readback — revocation never retroactively proves a
   * payment did not execute.
   */
  revoke(
    orgId: string,
    missionId: string,
    mandateId: string,
    byActorId: string,
    reason: string,
  ): MandateView {
    const latest = this.latest(orgId, missionId, mandateId);
    if (latest.status === 'revoked') {
      throw new LedgerError('MANDATE_ALREADY_REVOKED', `mandate ${mandateId} is already revoked`);
    }
    const now = this.clock.iso();
    this.db
      .prepare(
        "UPDATE mandates SET status = 'revoked', revoked_at = ? WHERE id = ? AND org_id = ? AND status IN ('active','superseded')",
      )
      .run(now, mandateId, orgId);
    this.evidence.append({
      orgId,
      missionId,
      topic: 'financial',
      type: 'mandate.revoked',
      eventKey: `mandate:${mandateId}:revoked:${now}`,
      payload: { mandateId, by: byActorId, reason },
    });
    return this.latest(orgId, missionId, mandateId);
  }

  /** Latest version of a mandate, org-scoped. */
  latest(orgId: string, missionId: string, mandateId: string): MandateView {
    const row = this.db
      .prepare(
        `SELECT id, org_id, mission_id, version, status, currency, max_amount_minor, total_budget_minor,
           permitted_kinds_json, rails_json, allowed_beneficiaries_json, allowed_purposes_json,
           require_separate_approver, expires_at, revoked_at, created_at
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
   * version that is active and unexpired at `now`, optionally restricted to
   * the operation's currency (a mission may hold one mandate per currency —
   * they never cross-fund). Revoked, superseded and expired mandates never
   * authorize a new reservation.
   */
  activeFor(orgId: string, missionId: string, now: Date, currency?: string): MandateView {
    const rows = this.db
      .prepare(
        `SELECT id, org_id, mission_id, version, status, currency, max_amount_minor, total_budget_minor,
           permitted_kinds_json, rails_json, allowed_beneficiaries_json, allowed_purposes_json,
           require_separate_approver, expires_at, revoked_at, created_at
         FROM mandates WHERE org_id = ? AND mission_id = ? ${currency !== undefined ? 'AND currency = ?' : ''}
         ORDER BY version DESC, created_at DESC, id DESC`,
      )
      .all(...(currency !== undefined ? [orgId, missionId, currency] : [orgId, missionId]));
    // One authoritative active mandate per mission/currency. Do not rely on
    // timestamp or lexicographic ID ordering: test clocks may share a timestamp
    // and a newly issued ID can sort before/after a superseded older ID.
    const activeRows = rows
      .map((row) => this.mapRow(row))
      .filter((m) => m.status === 'active' && m.revokedAt === null);
    if (activeRows.length > 1) {
      throw new LedgerError(
        'INVALID_INPUT',
        'ambiguous active mandates for one mission/currency; refusing financial authority',
      );
    }
    const active = activeRows[0];
    if (active !== undefined) {
      if (new Date(active.expiresAt) > now) return active;
      throw new LedgerError(
        'MANDATE_EXPIRED',
        `mandate ${active.id} v${active.version} expired at ${active.expiresAt}`,
      );
    }
    const newest = rows.length > 0 ? this.mapRow(rows[0] as unknown) : undefined;
    if (newest !== undefined) {
      if (newest.status === 'revoked') {
        throw new LedgerError(
          'MANDATE_REVOKED',
          `mandate ${newest.id} v${newest.version} was revoked at ${String(newest.revokedAt)}; it can no longer authorize anything`,
        );
      }
      if (newest.status === 'superseded') {
        throw new LedgerError(
          'MANDATE_SUPERSEDED',
          `mandate ${newest.id} v${newest.version} was superseded`,
        );
      }
      if (new Date(newest.expiresAt) <= now) {
        throw new LedgerError(
          'MANDATE_EXPIRED',
          `mandate ${newest.id} v${newest.version} expired at ${newest.expiresAt}`,
        );
      }
    }
    throw new LedgerError(
      'MANDATE_NOT_FOUND',
      `no active mandate for mission ${missionId} in organization ${orgId}`,
    );
  }

  /** Effective envelope: -1 (legacy) means the per-operation maximum. */
  effectiveTotalBudget(mandate: MandateView): number {
    return mandate.totalBudgetMinor === -1 ? mandate.maxAmountMinor : mandate.totalBudgetMinor;
  }

  /**
   * Cumulative consumption across the mandate identity (all versions), in
   * minor units. Must be called inside the same write transaction as any
   * reservation that relies on it.
   */
  consumedBudget(orgId: string, mandateId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM operations
         WHERE org_id = ? AND mandate_id = ? AND state IN ${CONSUMING_STATES_SQL}`,
      )
      .get(orgId, mandateId) as { total: number };
    return num(row.total, 'consumed');
  }

  /**
   * Mission-wide consumed budget across ALL mandate IDs/versions in one
   * currency. Reissuing under a new ID cannot silently reset money already
   * reserved, submitted or settled for the mission. Call in the same write
   * transaction as the reservation or dispatch gate.
   */
  consumedMissionBudget(orgId: string, missionId: string, currency: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM operations
         WHERE org_id = ? AND mission_id = ? AND currency = ? AND state IN ${CONSUMING_STATES_SQL}`,
      )
      .get(orgId, missionId, currency) as { total: number };
    return num(row.total, 'mission consumed');
  }

  /** Breakdown for UI/audit: envelope, consumed, remaining. */
  budgetStatus(
    orgId: string,
    missionId: string,
    mandateId: string,
  ): {
    mandate: MandateView;
    consumedMinor: number;
    remainingMinor: number;
  } {
    const mandate = this.latest(orgId, missionId, mandateId);
    const consumed = this.consumedMissionBudget(orgId, missionId, mandate.currency);
    const envelope = this.effectiveTotalBudget(mandate);
    return { mandate, consumedMinor: consumed, remainingMinor: Math.max(0, envelope - consumed) };
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
      totalBudgetMinor: num(r.total_budget_minor, 'total_budget_minor'),
      permittedOperationKinds: JSON.parse(
        text(r.permitted_kinds_json, 'permitted_kinds_json'),
      ) as string[],
      rails: JSON.parse(text(r.rails_json, 'rails_json')) as string[],
      allowedBeneficiaries: JSON.parse(
        (r.allowed_beneficiaries_json ?? '[]') as string,
      ) as string[],
      allowedPurposes: JSON.parse((r.allowed_purposes_json ?? '[]') as string) as string[],
      requireSeparateApprover: num(r.require_separate_approver, 'require_separate_approver') === 1,
      expiresAt: text(r.expires_at, 'expires_at'),
      revokedAt: nullableText(r.revoked_at),
      createdAt: text(r.created_at, 'created_at'),
    };
  }

  private normalize(currency: string): string {
    const normalized = currency.trim().toUpperCase();
    currencyExponent(normalized);
    return normalized;
  }
}
