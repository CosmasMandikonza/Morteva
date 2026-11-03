/**
 * Candidate plans and approvals.
 *
 * A plan version is immutable: its economic terms are hashed canonically and
 * the digest is the plan's financial identity. An approval binds exactly one
 * (plan id, version, digest) plus the same economic terms; changed terms
 * mean a new digest, which structurally cannot match an old approval.
 */
import type { LedgerDatabase } from '../db/port.js';
import { num, text } from '../db/port.js';
import { LedgerError } from '../errors.js';
import type { Clock } from '../clock.js';
import { newId } from './identity.js';
import { createMoney, termsDigest } from '@moterva/domain';
import type { ApprovalView, CandidatePlanView } from '@moterva/domain';

/** The economic fields every plan's terms must carry (minor units, no floats). */
export interface PlanEconomicTerms {
  readonly amountMinor: number;
  readonly currency: string;
  readonly beneficiary: string;
  readonly purpose: string;
  readonly [extra: string]: unknown;
}

/** Validates plan/approval economic terms at the service layer (DB CHECKs are the backstop). */
function requireValidTerms(
  terms: Readonly<Record<string, unknown>>,
): asserts terms is PlanEconomicTerms {
  if (
    typeof terms.amountMinor !== 'number' ||
    typeof terms.currency !== 'string' ||
    typeof terms.beneficiary !== 'string' ||
    typeof terms.purpose !== 'string' ||
    terms.beneficiary === '' ||
    terms.purpose === ''
  ) {
    throw new LedgerError(
      'INVALID_INPUT',
      'plan terms require amountMinor, currency, non-empty beneficiary and purpose',
    );
  }
  const money = createMoney(terms.currency, terms.amountMinor);
  if (money.minorUnits <= 0) {
    throw new LedgerError(
      'INVALID_AMOUNT',
      `amountMinor must be a positive integer of minor units (got ${String(terms.amountMinor)})`,
    );
  }
}

export class PlanService {
  constructor(
    private readonly db: LedgerDatabase,
    private readonly clock: Clock,
  ) {}

  /** Records the next immutable version of a plan; the digest is computed here, never accepted from callers. */
  recordVersion(input: {
    orgId: string;
    missionId: string;
    planId?: string;
    terms: PlanEconomicTerms;
  }): CandidatePlanView {
    requireValidTerms(input.terms);
    const digest = termsDigest(input.terms as Record<string, unknown>);
    const owningMission = this.db
      .prepare('SELECT id FROM missions WHERE id = ? AND org_id = ?')
      .get(input.missionId, input.orgId);
    if (owningMission === undefined) {
      throw new LedgerError('CROSS_ORG_ACCESS', 'plan mission does not belong to organization');
    }
    const planId = input.planId ?? newId('plan');
    const previous = this.db
      .prepare('SELECT mission_id FROM candidate_plans WHERE id = ? AND org_id = ? LIMIT 1')
      .get(planId, input.orgId) as { mission_id: string } | undefined;
    if (previous !== undefined && previous.mission_id !== input.missionId) {
      throw new LedgerError('CROSS_ORG_ACCESS', 'one plan identity cannot span missions');
    }
    const versionRow = this.db
      .prepare('SELECT MAX(version) AS v FROM candidate_plans WHERE id = ? AND org_id = ?')
      .get(planId, input.orgId) as { v: number | null };
    const nextVersion = (versionRow.v ?? 0) + 1;
    const plan: CandidatePlanView = {
      id: planId,
      orgId: input.orgId,
      missionId: input.missionId,
      version: nextVersion,
      terms: input.terms,
      digest,
      createdAt: this.clock.iso(),
    };
    this.db
      .prepare(
        `INSERT INTO candidate_plans (id, org_id, mission_id, version, terms_json, digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.id,
        plan.orgId,
        plan.missionId,
        plan.version,
        JSON.stringify(input.terms),
        plan.digest,
        plan.createdAt,
      );
    return plan;
  }

  getVersion(orgId: string, missionId: string, planId: string, version: number): CandidatePlanView {
    const row = this.db
      .prepare(
        'SELECT id, org_id, mission_id, version, terms_json, digest, created_at FROM candidate_plans WHERE id = ? AND org_id = ? AND mission_id = ? AND version = ?',
      )
      .get(planId, orgId, missionId, version);
    if (row === undefined) {
      throw new LedgerError(
        'PLAN_NOT_FOUND',
        `plan ${planId} v${version} not found for mission ${missionId} in organization ${orgId}`,
      );
    }
    return this.mapRow(row);
  }

  /** Detects tampering: the stored digest must still match the stored terms. */
  verifyIntegrity(plan: CandidatePlanView): void {
    const recomputed = termsDigest(plan.terms as Record<string, unknown>);
    if (recomputed !== plan.digest) {
      throw new LedgerError(
        'PLAN_DIGEST_MISMATCH',
        `plan ${plan.id} v${plan.version} terms do not match their digest; refusing to transact on tampered terms`,
        { stored: plan.digest, recomputed },
      );
    }
  }

  mapRow(row: unknown): CandidatePlanView {
    const r = row as Record<string, unknown>;
    return {
      id: text(r.id, 'id'),
      orgId: text(r.org_id, 'org_id'),
      missionId: text(r.mission_id, 'mission_id'),
      version: num(r.version, 'version'),
      terms: JSON.parse(text(r.terms_json, 'terms_json')) as PlanEconomicTerms,
      digest: text(r.digest, 'digest'),
      createdAt: text(r.created_at, 'created_at'),
    };
  }
}

export class ApprovalService {
  constructor(
    private readonly db: LedgerDatabase,
    private readonly clock: Clock,
  ) {}

  record(input: {
    orgId: string;
    plan: CandidatePlanView;
    decidedBy: string;
    expiresAt: string;
  }): ApprovalView {
    requireValidTerms(input.plan.terms);
    const terms = input.plan.terms;
    const approval: ApprovalView = {
      id: newId('apv'),
      orgId: input.orgId,
      planId: input.plan.id,
      planVersion: input.plan.version,
      planDigest: input.plan.digest,
      amountMinor: terms.amountMinor,
      currency: terms.currency,
      beneficiary: String(terms.beneficiary),
      purpose: String(terms.purpose),
      decidedBy: input.decidedBy,
      decidedAt: this.clock.iso(),
      expiresAt: input.expiresAt,
      status: 'valid',
    };
    this.db
      .prepare(
        `INSERT INTO approvals (id, org_id, plan_id, plan_version, plan_digest, amount_minor, currency, beneficiary, purpose, decided_by, decided_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid')`,
      )
      .run(
        approval.id,
        approval.orgId,
        approval.planId,
        approval.planVersion,
        approval.planDigest,
        approval.amountMinor,
        approval.currency,
        approval.beneficiary,
        approval.purpose,
        approval.decidedBy,
        approval.decidedAt,
        approval.expiresAt,
      );
    return approval;
  }

  get(orgId: string, approvalId: string): ApprovalView {
    const row = this.db
      .prepare(
        `SELECT id, org_id, plan_id, plan_version, plan_digest, amount_minor, currency, beneficiary, purpose, decided_by, decided_at, expires_at, status
         FROM approvals WHERE id = ? AND org_id = ?`,
      )
      .get(approvalId, orgId);
    if (row === undefined) {
      throw new LedgerError(
        'APPROVAL_NOT_FOUND',
        `approval ${approvalId} not found in organization ${orgId}`,
      );
    }
    return this.mapRow(row);
  }

  /** Marks an approval consumed; returns false when it was already used (race-safe via conditional UPDATE). */
  consume(orgId: string, approvalId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = 'consumed' WHERE id = ? AND org_id = ? AND status = 'valid'`,
      )
      .run(approvalId, orgId);
    return result.changes === 1;
  }

  private mapRow(row: unknown): ApprovalView {
    const r = row as Record<string, unknown>;
    return {
      id: text(r.id, 'id'),
      orgId: text(r.org_id, 'org_id'),
      planId: text(r.plan_id, 'plan_id'),
      planVersion: num(r.plan_version, 'plan_version'),
      planDigest: text(r.plan_digest, 'plan_digest'),
      amountMinor: num(r.amount_minor, 'amount_minor'),
      currency: text(r.currency, 'currency'),
      beneficiary: text(r.beneficiary, 'beneficiary'),
      purpose: text(r.purpose, 'purpose'),
      decidedBy: text(r.decided_by, 'decided_by'),
      decidedAt: text(r.decided_at, 'decided_at'),
      expiresAt: text(r.expires_at, 'expires_at'),
      status: text(r.status, 'status') as ApprovalView['status'],
    };
  }
}
