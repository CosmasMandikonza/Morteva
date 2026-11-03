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
import type { ApprovalView, CandidatePlanView, OperationKind } from '@moterva/domain';
import type { AuthorityService } from './authority.js';
import type { EvidenceService } from './evidence.js';

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
    /** Persisted proposer actor id (agent/operator); used for separation of duties. */
    proposedBy?: string | null;
  }): CandidatePlanView {
    requireValidTerms(input.terms);
    const digest = termsDigest(input.terms as Record<string, unknown>);
    const owningMission = this.db
      .prepare('SELECT id FROM missions WHERE id = ? AND org_id = ?')
      .get(input.missionId, input.orgId);
    if (owningMission === undefined) {
      throw new LedgerError('CROSS_ORG_ACCESS', 'plan mission does not belong to organization');
    }
    if (input.proposedBy !== undefined && input.proposedBy !== null) {
      const proposer = this.db
        .prepare('SELECT id FROM actors WHERE id = ? AND org_id = ? AND revoked_at IS NULL')
        .get(input.proposedBy, input.orgId);
      if (proposer === undefined) {
        throw new LedgerError(
          'AUTH_ACTOR_NOT_FOUND',
          'plan proposer is not a live actor in this organization',
        );
      }
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
      proposedBy: input.proposedBy ?? null,
      createdAt: this.clock.iso(),
    };
    this.db
      .prepare(
        `INSERT INTO candidate_plans (id, org_id, mission_id, version, terms_json, digest, proposed_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.id,
        plan.orgId,
        plan.missionId,
        plan.version,
        JSON.stringify(input.terms),
        plan.digest,
        plan.proposedBy,
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
      proposedBy:
        r.proposed_by === null || r.proposed_by === undefined
          ? null
          : text(r.proposed_by, 'proposed_by'),
      createdAt: text(r.created_at, 'created_at'),
    };
  }
}

/** Canonical digest over a plan's quote block (or the explicit no-quote constant). */
export function quoteDigestFor(terms: PlanEconomicTerms): string {
  return termsDigest({ quote: terms.quote ?? null });
}

export class ApprovalService {
  constructor(
    private readonly db: LedgerDatabase,
    private readonly clock: Clock,
    private readonly authority: AuthorityService,
    private readonly evidence: EvidenceService,
  ) {}

  /**
   * Records an exact-term approval (issue #7 Phase 4).
   *
   * - `decidedBy` MUST be a persisted actor id; its role is verified against
   *   the authority service (approver+). A freeform string is not identity.
   * - The approval binds: plan id/version/digest (recomputed from persisted
   *   terms — never caller-supplied), operation kind, mandate id/version,
   *   amount, currency, beneficiary, purpose, quote digest, evidence digest.
   * - Separation of duties: the approver must differ from the plan proposer
   *   when the mandate requires it.
   * - One approval per immutable plan version: a double-click is idempotent
   *   for the same decider; anyone else is told it is already approved.
   */
  record(input: {
    orgId: string;
    plan: CandidatePlanView;
    decidedByActorId: string;
    kind: OperationKind;
    mandateId?: string;
    mandateVersion?: number;
    /** Digest of the evidence bundle the approver reviewed (optional but then binding). */
    evidenceDigest?: string;
    expiresAt: string;
  }): ApprovalView {
    // Never authorize a caller-constructed plan object or a plan from another
    // org. Its original persisted terms and digest are the authority boundary.
    if (input.plan.orgId !== input.orgId) {
      throw new LedgerError('CROSS_ORG_ACCESS', 'approval plan belongs to another organization');
    }
    const record = this.db
      .prepare(
        'SELECT mission_id, terms_json, digest, proposed_by FROM candidate_plans WHERE id = ? AND version = ? AND org_id = ?',
      )
      .get(input.plan.id, input.plan.version, input.orgId) as
      | { mission_id: string; terms_json: string; digest: string; proposed_by: string | null }
      | undefined;
    if (
      record === undefined ||
      record.mission_id !== input.plan.missionId ||
      record.digest !== input.plan.digest ||
      termsDigest(JSON.parse(record.terms_json) as Record<string, unknown>) !== record.digest ||
      termsDigest(input.plan.terms as Record<string, unknown>) !== record.digest
    ) {
      throw new LedgerError(
        'PLAN_DIGEST_MISMATCH',
        'approval requires exact persisted, untampered plan terms and organization scope',
      );
    }
    const approvalExpiry = Date.parse(input.expiresAt);
    if (!Number.isFinite(approvalExpiry) || approvalExpiry <= this.clock.now().getTime()) {
      throw new LedgerError('APPROVAL_EXPIRED', 'approval expiry must be a valid future date');
    }

    // Actor authenticity: a persisted, live, approver-capable human actor.
    const actor = this.authority.getActor(input.orgId, input.decidedByActorId);
    if (actor.revokedAt !== null) {
      throw new LedgerError('AUTH_ACTOR_NOT_FOUND', 'revoked actors cannot approve');
    }
    const roleDecision = this.authority.requireRole(actor, 'approve');
    if (roleDecision.outcome !== 'AUTHORIZED') {
      throw new LedgerError('AUTH_ROLE_FORBIDDEN', roleDecision.detail ?? 'actor may not approve');
    }
    if (actor.kind === 'service') {
      throw new LedgerError(
        'AUTH_ROLE_FORBIDDEN',
        'machine actors can never approve financial actions',
      );
    }

    // Separation of duties: the proposer cannot approve their own plan.
    const proposerId = record.proposed_by;
    if (proposerId !== null && proposerId === input.decidedByActorId) {
      throw new LedgerError(
        'AUTH_SELF_APPROVAL',
        'the actor who proposed this plan cannot approve it; separation of duties requires a different approver',
      );
    }

    requireValidTerms(input.plan.terms);
    const terms = input.plan.terms;

    // Idempotent double-click: an immutable plan version carries ONE approval.
    const existingRow = this.db
      .prepare(
        'SELECT id, decided_by, status FROM approvals WHERE plan_id = ? AND plan_version = ? AND org_id = ?',
      )
      .get(input.plan.id, input.plan.version, input.orgId) as
      { id: string; decided_by: string; status: string } | undefined;
    if (existingRow !== undefined) {
      if (existingRow.decided_by !== input.decidedByActorId) {
        throw new LedgerError(
          'APPROVAL_ALREADY_EXISTS',
          `plan ${input.plan.id} v${input.plan.version} is already approved by another actor; duplicate authority is refused`,
        );
      }
      const existing = this.get(input.orgId, existingRow.id);
      if (
        existing.status === 'revoked' ||
        existing.status === 'consumed' ||
        existing.status === 'invalidated'
      ) {
        throw new LedgerError(
          'APPROVAL_ALREADY_EXISTS',
          `the approval for plan ${input.plan.id} v${input.plan.version} is already ${existing.status}; re-approval requires a new plan version`,
        );
      }
      return existing;
    }

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
      kind: input.kind,
      mandateId: input.mandateId ?? null,
      mandateVersion: input.mandateVersion ?? null,
      quoteDigest: quoteDigestFor(terms),
      evidenceDigest: (input.evidenceDigest ?? '').trim(),
      authKey: newId('auth'),
      decidedBy: input.decidedByActorId,
      decidedAt: this.clock.iso(),
      expiresAt: input.expiresAt,
      status: 'valid',
      revokedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO approvals (id, org_id, plan_id, plan_version, plan_digest, mandate_id, mandate_version,
           kind, amount_minor, currency, beneficiary, purpose, quote_digest, evidence_digest, auth_key,
           decided_by, decided_at, expires_at, status, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', NULL)`,
      )
      .run(
        approval.id,
        approval.orgId,
        approval.planId,
        approval.planVersion,
        approval.planDigest,
        approval.mandateId,
        approval.mandateVersion,
        approval.kind,
        approval.amountMinor,
        approval.currency,
        approval.beneficiary,
        approval.purpose,
        approval.quoteDigest,
        approval.evidenceDigest,
        approval.authKey,
        approval.decidedBy,
        approval.decidedAt,
        approval.expiresAt,
      );
    this.evidence.append({
      orgId: input.orgId,
      missionId: input.plan.missionId,
      topic: 'financial',
      type: 'approval.granted',
      eventKey: `approval:${approval.id}:granted`,
      payload: {
        approvalId: approval.id,
        planId: approval.planId,
        planVersion: approval.planVersion,
        planDigest: approval.planDigest,
        decidedBy: approval.decidedBy,
        kind: approval.kind,
        mandateId: approval.mandateId,
        quoteDigest: approval.quoteDigest,
        evidenceDigest: approval.evidenceDigest || null,
        expiresAt: approval.expiresAt,
      },
    });
    return approval;
  }

  /** Explicit revocation by an authorized actor. Blocks any not-yet-consumed use. */
  revoke(orgId: string, approvalId: string, byActorId: string, reason: string): ApprovalView {
    const approval = this.get(orgId, approvalId);
    if (approval.status !== 'valid') {
      throw new LedgerError(
        'APPROVAL_INVALIDATED',
        `approval ${approvalId} is already ${approval.status}`,
      );
    }
    const actor = this.authority.getActor(orgId, byActorId);
    const roleDecision = this.authority.requireRole(actor, 'approve');
    if (roleDecision.outcome !== 'AUTHORIZED') {
      throw new LedgerError(
        'AUTH_ROLE_FORBIDDEN',
        roleDecision.detail ?? 'actor may not revoke approvals',
      );
    }
    const now = this.clock.iso();
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = 'revoked', revoked_at = ? WHERE id = ? AND org_id = ? AND status = 'valid'`,
      )
      .run(now, approvalId, orgId);
    if (result.changes !== 1) {
      throw new LedgerError(
        'APPROVAL_INVALIDATED',
        `approval ${approvalId} was consumed concurrently`,
      );
    }
    this.evidence.append({
      orgId,
      topic: 'financial',
      type: 'approval.revoked',
      eventKey: `approval:${approvalId}:revoked:${now}`,
      payload: { approvalId, by: byActorId, reason },
    });
    return this.get(orgId, approvalId);
  }

  get(orgId: string, approvalId: string): ApprovalView {
    const row = this.db
      .prepare(
        `SELECT id, org_id, plan_id, plan_version, plan_digest, mandate_id, mandate_version, kind, amount_minor,
           currency, beneficiary, purpose, quote_digest, evidence_digest, auth_key, decided_by, decided_at,
           expires_at, status, revoked_at
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
      mandateId:
        r.mandate_id === null || r.mandate_id === undefined
          ? null
          : text(r.mandate_id, 'mandate_id'),
      mandateVersion:
        r.mandate_version === null || r.mandate_version === undefined
          ? null
          : num(r.mandate_version, 'mandate_version'),
      kind: text(r.kind, 'kind') as OperationKind,
      amountMinor: num(r.amount_minor, 'amount_minor'),
      currency: text(r.currency, 'currency'),
      beneficiary: text(r.beneficiary, 'beneficiary'),
      purpose: text(r.purpose, 'purpose'),
      // '' is a legitimate value: "no quote/evidence bound" (also the v1 legacy default).
      quoteDigest: typeof r.quote_digest === 'string' ? r.quote_digest : '',
      evidenceDigest: typeof r.evidence_digest === 'string' ? r.evidence_digest : '',
      authKey: text(r.auth_key, 'auth_key'),
      decidedBy: text(r.decided_by, 'decided_by'),
      decidedAt: text(r.decided_at, 'decided_at'),
      expiresAt: text(r.expires_at, 'expires_at'),
      status: text(r.status, 'status') as ApprovalView['status'],
      revokedAt:
        r.revoked_at === null || r.revoked_at === undefined
          ? null
          : text(r.revoked_at, 'revoked_at'),
    };
  }
}
