/**
 * ReservationService — the transactional core of MTV-02.
 *
 * `reserve()` runs entirely inside one BEGIN IMMEDIATE transaction:
 *   idempotency lookup → mission/mandate/plan/approval validation →
 *   spendable computation → operation+commitment+outbox+evidence inserts.
 * The database write lock serializes competing workers, so two missions (or
 * two processes) can never both pass the spendable check for the same money.
 *
 * Persisted order matters (docs/01 §4): the economic identity and its
 * commitment are durable BEFORE any dispatch could happen — the outbox row
 * for the provider rail is created in the same transaction, and the dispatch
 * worker only ever reads what committed here.
 */
import type { LedgerDatabase } from '../db/port.js';
import { nullableText, num, text } from '../db/port.js';
import { LedgerError } from '../errors.js';
import type { Clock } from '../clock.js';
import { newId } from './identity.js';
import { type OrganizationService } from './organizations.js';
import { type SpendableService } from './spendable.js';
import { type EvidenceService } from './evidence.js';
import type { MandateService } from './mandates.js';
import { type ApprovalService, type PlanService, quoteDigestFor } from './plans.js';
import {
  canTransitionOperation,
  commitmentStateFor,
  createMoney,
  isOperationState,
  subMoney,
} from '@moterva/domain';
import type {
  CommitmentView,
  FinancialOperationView,
  OperationKind,
  OperationState,
} from '@moterva/domain';
import type { PlanEconomicTerms } from './plans.js';

const RAIL_FOR_KIND: Record<OperationKind, 'airwallex' | 'metal' | null> = {
  airwallex_transfer: 'airwallex',
  metal_order: 'metal',
  internal_hold: null,
};

export interface ReserveInput {
  readonly orgId: string;
  readonly missionId: string;
  readonly kind: OperationKind;
  readonly requestId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly approvalId: string;
  /** Required when the approval bound an evidence bundle digest. */
  readonly evidenceDigest?: string;
}

export interface ReserveResult {
  readonly duplicate: boolean;
  readonly operation: FinancialOperationView;
  readonly commitment: CommitmentView;
  readonly spendableBefore: number;
  readonly spendableAfter: number;
}

export interface TransitionAttestation {
  /** Where the resolution truth came from. Provider finality only via provider-readback (#5/#6). */
  readonly source: 'provider-readback' | 'operator-action' | 'test-harness';
  readonly note?: string;
}

export class ReservationService {
  constructor(
    private readonly db: LedgerDatabase,
    private readonly clock: Clock,
    private readonly orgs: OrganizationService,
    private readonly mandates: MandateService,
    private readonly plans: PlanService,
    private readonly approvals: ApprovalService,
    private readonly spendable: SpendableService,
    private readonly evidence: EvidenceService,
  ) {}

  /**
   * Material policy denials that must leave an audit trail even though the
   * reservation transaction itself rolled back (issue #7 acceptance).
   */
  private static readonly DENIAL_AUDIT_CODES: ReadonlySet<string> = new Set([
    'MANDATE_REVOKED',
    'MANDATE_SUPERSEDED',
    'MANDATE_EXPIRED',
    'MANDATE_BUDGET_EXCEEDED',
    'MANDATE_AMOUNT_EXCEEDS_MAX',
    'MANDATE_CURRENCY_MISMATCH',
    'MANDATE_KIND_FORBIDDEN',
    'APPROVAL_REVOKED',
    'APPROVAL_CONSUMED',
    'APPROVAL_EXPIRED',
    'APPROVAL_TERMS_MISMATCH',
    'APPROVAL_ALREADY_EXISTS',
    'BENEFICIARY_NOT_ALLOWED',
    'PURPOSE_NOT_ALLOWED',
    'RAIL_NOT_PERMITTED',
    'RAIL_ASSET_UNSUPPORTED',
    'INSUFFICIENT_SPENDABLE',
    'OVERCOMMITTED',
    'STALE_BALANCE',
    'AUTH_ROLE_FORBIDDEN',
    'AUTH_SELF_APPROVAL',
  ]);

  reserve(input: ReserveInput): ReserveResult {
    if (input.requestId.trim() === '') {
      throw new LedgerError('INVALID_INPUT', 'requestId must not be empty');
    }
    try {
      return this.db.transaction(() => this.reserveLocked(input));
    } catch (error) {
      if (error instanceof LedgerError && ReservationService.DENIAL_AUDIT_CODES.has(error.code)) {
        // The reservation transaction rolled back; journal the denial in its
        // own transaction so the audit trail survives the refusal.
        try {
          this.evidence.append({
            orgId: input.orgId,
            missionId: input.missionId,
            topic: 'financial',
            type: 'reservation.denied',
            eventKey: `denial:${input.orgId}:${input.requestId}:${error.code}`,
            payload: {
              requestId: input.requestId,
              code: error.code,
              message: error.message,
            },
          });
        } catch {
          // Auditing must never mask the original denial.
        }
      }
      throw error;
    }
  }

  private reserveLocked(input: ReserveInput): ReserveResult {
    // 1. Idempotency first: the durable economic identity is (orgId, requestId).
    const existing = this.findOperationByRequestId(input.orgId, input.requestId);
    if (existing !== undefined) {
      const same =
        existing.missionId === input.missionId &&
        existing.kind === input.kind &&
        existing.planId === input.planId &&
        existing.planVersion === input.planVersion &&
        existing.approvalId === input.approvalId;
      if (!same) {
        throw new LedgerError(
          'IDEMPOTENCY_CONFLICT',
          `requestId "${input.requestId}" already exists as a DIFFERENT economic operation ${existing.id}; a new intent needs a new requestId`,
          { existingOperationId: existing.id },
        );
      }
      const commitment = this.getCommitment(input.orgId, existing.id);
      return {
        duplicate: true,
        operation: existing,
        commitment,
        spendableBefore: 0,
        spendableAfter: 0,
      };
    }

    // 2. Mission must belong to this org and be active.
    this.orgs.requireActiveMission(input.orgId, input.missionId);

    // 3. Plan version: org+mission scoped, terms not tampered.
    const plan = this.plans.getVersion(
      input.orgId,
      input.missionId,
      input.planId,
      input.planVersion,
    );
    this.plans.verifyIntegrity(plan);
    const terms = plan.terms;
    if (
      typeof terms.amountMinor !== 'number' ||
      typeof terms.currency !== 'string' ||
      typeof terms.beneficiary !== 'string' ||
      typeof terms.purpose !== 'string'
    ) {
      throw new LedgerError(
        'INVALID_INPUT',
        `plan ${plan.id} v${plan.version} terms missing required economic fields`,
      );
    }
    const money = createMoney(terms.currency, terms.amountMinor);
    if (money.minorUnits <= 0) {
      throw new LedgerError('INVALID_AMOUNT', 'plan amountMinor must be positive minor units');
    }

    // 4. Approval binds the exact digest AND identical economic terms, the
    //    operation kind, the authorizing mandate version, the quote block and
    //    the reviewed evidence bundle. Any difference = stale approval.
    const approval = this.approvals.get(input.orgId, input.approvalId);
    const mismatches: string[] = [];
    if (approval.planId !== plan.id || approval.planVersion !== plan.version)
      mismatch(mismatches, 'plan id/version');
    if (approval.planDigest !== plan.digest) mismatch(mismatches, 'plan digest');
    if (approval.amountMinor !== money.minorUnits) mismatch(mismatches, 'amountMinor');
    if (approval.currency !== money.currency) mismatch(mismatches, 'currency');
    if (approval.beneficiary !== terms.beneficiary) mismatch(mismatches, 'beneficiary');
    if (approval.purpose !== terms.purpose) mismatch(mismatches, 'purpose');
    if (approval.kind !== input.kind) mismatch(mismatches, 'operation kind');
    if (approval.quoteDigest !== quoteDigestFor(plan.terms as PlanEconomicTerms))
      mismatch(mismatches, 'quote');
    if (mismatches.length > 0) {
      throw new LedgerError(
        'APPROVAL_TERMS_MISMATCH',
        `approval ${approval.id} does not bind the exact terms of plan ${plan.id} v${plan.version}: ${mismatches.join(', ')} differ; changed terms require a new approval`,
        { mismatches },
      );
    }
    if (
      approval.evidenceDigest !== '' &&
      approval.evidenceDigest !== (input.evidenceDigest ?? '')
    ) {
      throw new LedgerError(
        'APPROVAL_TERMS_MISMATCH',
        `approval ${approval.id} was granted against a different evidence bundle; the reviewed evidence digest does not match this request`,
        { mismatches: ['evidence digest'] },
      );
    }
    const now = this.clock.now();
    if (new Date(approval.expiresAt) <= now) {
      throw new LedgerError(
        'APPROVAL_EXPIRED',
        `approval ${approval.id} expired at ${approval.expiresAt}`,
      );
    }
    if (approval.status === 'consumed') {
      throw new LedgerError(
        'APPROVAL_CONSUMED',
        `approval ${approval.id} was already consumed by another operation`,
      );
    }
    if (approval.status === 'invalidated') {
      throw new LedgerError('APPROVAL_INVALIDATED', `approval ${approval.id} was invalidated`);
    }
    if (approval.status === 'revoked') {
      throw new LedgerError(
        'APPROVAL_REVOKED',
        `approval ${approval.id} was revoked at ${String(approval.revokedAt)} and can no longer authorize anything`,
      );
    }

    // 5. Mandate: the active version for this mission and CURRENCY governs
    //    now (one mandate per currency — no cross-currency mandate ever
    //    authorizes a plan in another currency). If no mandate exists for the
    //    plan's currency but one exists in another currency, say so
    //    explicitly: no implicit conversion ever happens.
    let mandate;
    try {
      mandate = this.mandates.activeFor(input.orgId, input.missionId, now, money.currency);
    } catch (error) {
      if (error instanceof LedgerError && error.code === 'MANDATE_NOT_FOUND') {
        const anyCurrency = this.mandates.activeFor(input.orgId, input.missionId, now);
        throw new LedgerError(
          'MANDATE_CURRENCY_MISMATCH',
          `mandate ${anyCurrency.id} v${anyCurrency.version} authorizes ${anyCurrency.currency} only; plan terms are ${money.currency}. No implicit currency conversion exists.`,
        );
      }
      throw error;
    }
    if (approval.mandateId !== null && approval.mandateId !== mandate.id) {
      throw new LedgerError(
        'APPROVAL_TERMS_MISMATCH',
        `approval ${approval.id} authorizes mandate ${approval.mandateId} but the active mandate for this mission is ${mandate.id} v${mandate.version}; the approval is stale`,
        { mismatches: ['mandate'] },
      );
    }
    if (approval.mandateVersion !== null && approval.mandateVersion !== mandate.version) {
      throw new LedgerError(
        'APPROVAL_TERMS_MISMATCH',
        `approval ${approval.id} authorizes mandate ${mandate.id} v${approval.mandateVersion} but v${mandate.version} is active; the approval is stale`,
        { mismatches: ['mandate version'] },
      );
    }
    if (mandate.currency !== money.currency) {
      throw new LedgerError(
        'MANDATE_CURRENCY_MISMATCH',
        `mandate ${mandate.id} v${mandate.version} authorizes ${mandate.currency} only; plan terms are ${money.currency}. No implicit currency conversion exists.`,
      );
    }
    if (money.minorUnits > mandate.maxAmountMinor) {
      throw new LedgerError(
        'MANDATE_AMOUNT_EXCEEDS_MAX',
        `plan amount ${money.minorUnits} exceeds mandate ${mandate.id} v${mandate.version} max ${mandate.maxAmountMinor}`,
      );
    }
    if (!mandate.permittedOperationKinds.includes(input.kind)) {
      throw new LedgerError(
        'MANDATE_KIND_FORBIDDEN',
        `mandate ${mandate.id} v${mandate.version} does not permit operation kind "${input.kind}"`,
      );
    }
    // A tokenized Metal testnet payment cannot be funded out of an ISO USD
    // bank account merely because the token's price is USD-denominated.
    // Separate provider/asset balances (USDC decimals, chain, token contract)
    // must exist before MTV-04/#6 may enable this rail. No fake fiat bridge.
    // Checked before the rail allowlist so the asset-accounting invariant is
    // always the primary, unambiguous failure for Metal orders.
    if (input.kind === 'metal_order') {
      throw new LedgerError(
        'RAIL_ASSET_UNSUPPORTED',
        'Metal token orders require a separate, verified token-asset account and mandate. Fiat USD treasury snapshots cannot fund a tokenized payment; implement the rail/asset ledger in issue #6 before enabling this kind.',
      );
    }

    const opRail = RAIL_FOR_KIND[input.kind];
    if (opRail !== null && !mandate.rails.includes(opRail)) {
      throw new LedgerError(
        'RAIL_NOT_PERMITTED',
        `mandate ${mandate.id} v${mandate.version} does not permit the ${opRail} rail`,
      );
    }
    if (
      mandate.allowedBeneficiaries.length > 0 &&
      !mandate.allowedBeneficiaries.includes(terms.beneficiary)
    ) {
      throw new LedgerError(
        'BENEFICIARY_NOT_ALLOWED',
        `beneficiary "${terms.beneficiary}" is not on the allowlist of mandate ${mandate.id} v${mandate.version}`,
      );
    }
    if (mandate.allowedPurposes.length > 0 && !mandate.allowedPurposes.includes(terms.purpose)) {
      throw new LedgerError(
        'PURPOSE_NOT_ALLOWED',
        `purpose "${terms.purpose}" is not on the allowlist of mandate ${mandate.id} v${mandate.version}`,
      );
    }

    // 5b. CUMULATIVE mandate budget — same transaction, same write lock as
    //     the inserts below (issue #7: N under-cap payments must never bypass
    //     the total envelope). Settled payments consume for the lifetime of
    //     the mandate; unknown/escalated consume until resolved.
    const envelope = this.mandates.effectiveTotalBudget(mandate);
    const consumedSoFar = this.mandates.consumedBudget(input.orgId, mandate.id);
    if (consumedSoFar + money.minorUnits > envelope) {
      throw new LedgerError(
        'MANDATE_BUDGET_EXCEEDED',
        `cumulative mission budget exceeded for mandate ${mandate.id}: consumed ${consumedSoFar} + requested ${money.minorUnits} > envelope ${envelope} ${money.currency}`,
        {
          mandateId: mandate.id,
          consumedMinor: consumedSoFar,
          requestedMinor: money.minorUnits,
          envelopeMinor: envelope,
        },
      );
    }

    // 6. Spendable check — same transaction, same write lock as the inserts below.
    const spendableBefore = this.spendable.compute(input.orgId, money.currency);
    if (spendableBefore.overcommitted) {
      throw new LedgerError(
        'OVERCOMMITTED',
        `organization ${input.orgId} commitments already exceed ${money.currency} balance+floor; autonomous spending is halted until reconciled`,
        spendableBefore,
      );
    }
    if (money.minorUnits > spendableBefore.spendableMinor) {
      throw new LedgerError(
        'INSUFFICIENT_SPENDABLE',
        `requested ${money.minorUnits} ${money.currency} but spendable is ${spendableBefore.spendableMinor} (balance ${spendableBefore.balanceMinor} − floor ${spendableBefore.protectedFloorMinor} − outstanding ${spendableBefore.outstandingCommittedMinor})`,
        { spendable: spendableBefore },
      );
    }

    // 7. Consume the approval atomically (conditional update defeats a race with a second reserve).
    if (!this.approvals.consume(input.orgId, approval.id)) {
      throw new LedgerError(
        'APPROVAL_CONSUMED',
        `approval ${approval.id} was consumed concurrently`,
      );
    }

    // 8. Durable economic intent: operation + commitment (+ outbox for rail kinds) in this transaction.
    const operationId = newId('op');
    const now2 = this.clock.iso();
    this.db
      .prepare(
        `INSERT INTO operations (id, org_id, mission_id, kind, request_id, state, plan_id, plan_version, plan_digest,
           approval_id, mandate_id, mandate_version, amount_minor, currency, beneficiary, purpose, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operationId,
        input.orgId,
        input.missionId,
        input.kind,
        input.requestId,
        plan.id,
        plan.version,
        plan.digest,
        approval.id,
        mandate.id,
        mandate.version,
        money.minorUnits,
        money.currency,
        terms.beneficiary,
        terms.purpose,
        now2,
        now2,
      );
    this.db
      .prepare(
        `INSERT INTO commitments (id, org_id, mission_id, operation_id, currency, amount_minor, state, finalized_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'reserved', NULL, ?, ?)`,
      )
      .run(
        newId('cmt'),
        input.orgId,
        input.missionId,
        operationId,
        money.currency,
        money.minorUnits,
        now2,
        now2,
      );

    const rail = RAIL_FOR_KIND[input.kind];
    if (rail !== null) {
      this.db
        .prepare(
          `INSERT INTO outbox_dispatches (id, operation_id, org_id, rail, request_id, status, attempts, claim_token, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`,
        )
        .run(newId('obx'), operationId, input.orgId, rail, input.requestId, now2, now2);
    }

    this.evidence.append({
      orgId: input.orgId,
      missionId: input.missionId,
      topic: 'financial',
      type: 'operation.reserved',
      eventKey: `operation:${operationId}:reserved`,
      payload: {
        operationId,
        requestId: input.requestId,
        kind: input.kind,
        amountMinor: money.minorUnits,
        currency: money.currency,
        beneficiary: terms.beneficiary,
        planDigest: plan.digest,
        approvalId: approval.id,
        mandateId: mandate.id,
        mandateVersion: mandate.version,
        mandateConsumedAfterMinor: consumedSoFar + money.minorUnits,
        mandateEnvelopeMinor: envelope,
        balanceObservedAt: spendableBefore.balanceObservedAt,
        spendableBefore: spendableBefore.spendableMinor,
      },
    });

    const operation = this.getOperation(input.orgId, operationId);
    const commitment = this.getCommitment(input.orgId, operationId);
    return {
      duplicate: false,
      operation,
      commitment,
      spendableBefore: spendableBefore.spendableMinor,
      spendableAfter: subMoney(createMoney(money.currency, spendableBefore.spendableMinor), money)
        .minorUnits,
    };
  }

  /** Org-scoped operation read by id. */
  getOperation(orgId: string, operationId: string): FinancialOperationView {
    const row = this.db
      .prepare(
        `SELECT id, org_id, mission_id, kind, request_id, state, plan_id, plan_version, plan_digest, approval_id,
           mandate_id, mandate_version, amount_minor, currency, beneficiary, purpose, created_at, updated_at
         FROM operations WHERE id = ? AND org_id = ?`,
      )
      .get(operationId, orgId);
    if (row === undefined) {
      throw new LedgerError(
        'OPERATION_NOT_FOUND',
        `operation ${operationId} not found in organization ${orgId}`,
      );
    }
    return this.mapOperation(row);
  }

  findOperationByRequestId(orgId: string, requestId: string): FinancialOperationView | undefined {
    const row = this.db
      .prepare(
        `SELECT id, org_id, mission_id, kind, request_id, state, plan_id, plan_version, plan_digest, approval_id,
           mandate_id, mandate_version, amount_minor, currency, beneficiary, purpose, created_at, updated_at
         FROM operations WHERE org_id = ? AND request_id = ?`,
      )
      .get(orgId, requestId);
    return row === undefined ? undefined : this.mapOperation(row);
  }

  getCommitment(orgId: string, operationId: string): CommitmentView {
    const row = this.db
      .prepare(
        `SELECT id, org_id, mission_id, operation_id, currency, amount_minor, state, finalized_at, created_at, updated_at
         FROM commitments WHERE operation_id = ? AND org_id = ?`,
      )
      .get(operationId, orgId);
    if (row === undefined) {
      throw new LedgerError(
        'OPERATION_NOT_FOUND',
        `commitment for operation ${operationId} not found in organization ${orgId}`,
      );
    }
    return this.mapCommitment(row);
  }

  /**
   * Lifecycle transition with commitment co-update. Resolving an operation
   * out of STATUS_UNKNOWN REQUIRES an attestation naming the verified source
   * — a timeout alone can never move money state (docs/05 #5/#6).
   */
  transition(input: {
    orgId: string;
    operationId: string;
    to: OperationState;
    attestation?: TransitionAttestation;
    reason?: string;
  }): { operation: FinancialOperationView; commitment: CommitmentView } {
    return this.db.transaction(() => {
      const operation = this.getOperation(input.orgId, input.operationId);
      if (!isOperationState(input.to)) {
        throw new LedgerError('INVALID_TRANSITION', `unknown target state "${String(input.to)}"`);
      }
      if (operation.state === 'STATUS_UNKNOWN' && input.attestation === undefined) {
        throw new LedgerError(
          'INVALID_TRANSITION',
          `operation ${operation.id} is STATUS_UNKNOWN; resolving it requires an attestation of the verified source (provider readback, operator action) — never a timeout`,
        );
      }
      // No test harness/operator assertion can make a provider payment 'settled'.
      // Once any dispatch may have begun, cancellation/rejection must be
      // supported by an actual provider readback, otherwise funds stay held.
      const mightHaveReachedProvider =
        operation.state === 'SUBMITTING' ||
        operation.state === 'IN_FLIGHT' ||
        operation.state === 'STATUS_UNKNOWN' ||
        operation.state === 'REQUIRES_HUMAN';
      const releasesFunds =
        input.to === 'CANCELLED' || input.to === 'REJECTED' || input.to === 'EXPIRED';
      if (
        (operation.kind !== 'internal_hold' && input.to === 'SETTLED') ||
        (mightHaveReachedProvider && releasesFunds)
      ) {
        if (input.attestation?.source !== 'provider-readback') {
          throw new LedgerError(
            'INVALID_TRANSITION',
            `operation ${operation.id} cannot move ${operation.state} -> ${input.to} without independently verified provider-readback; retaining financial exposure`,
          );
        }
      }
      if (!canTransitionOperation(operation.state, input.to)) {
        throw new LedgerError(
          'INVALID_TRANSITION',
          `illegal transition ${operation.state} -> ${input.to} for operation ${operation.id}`,
          { from: operation.state, to: input.to },
        );
      }
      const now = this.clock.iso();
      this.db
        .prepare('UPDATE operations SET state = ?, updated_at = ? WHERE id = ? AND org_id = ?')
        .run(input.to, now, operation.id, input.orgId);

      const commitmentState = commitmentStateFor(input.to);
      const finalizedAt = commitmentState === 'settled' ? now : null;
      const current = this.getCommitment(input.orgId, operation.id);
      this.db
        .prepare(
          'UPDATE commitments SET state = ?, finalized_at = ?, updated_at = ? WHERE operation_id = ? AND org_id = ?',
        )
        .run(
          commitmentState,
          commitmentState === 'settled' ? (current.finalizedAt ?? finalizedAt) : finalizedAt,
          now,
          operation.id,
          input.orgId,
        );

      this.evidence.append({
        orgId: input.orgId,
        missionId: operation.missionId,
        topic: 'financial',
        type: `operation.${input.to.toLowerCase()}`,
        eventKey: `operation:${operation.id}:${input.to.toLowerCase()}`,
        payload: {
          operationId: operation.id,
          from: operation.state,
          to: input.to,
          reason: input.reason,
          attestation: input.attestation,
        },
      });
      return {
        operation: this.getOperation(input.orgId, operation.id),
        commitment: this.getCommitment(input.orgId, operation.id),
      };
    });
  }

  private mapOperation(row: unknown): FinancialOperationView {
    const r = row as Record<string, unknown>;
    return {
      id: text(r.id, 'id'),
      orgId: text(r.org_id, 'org_id'),
      missionId: text(r.mission_id, 'mission_id'),
      kind: text(r.kind, 'kind') as OperationKind,
      requestId: text(r.request_id, 'request_id'),
      state: text(r.state, 'state') as OperationState,
      planId: text(r.plan_id, 'plan_id'),
      planVersion: num(r.plan_version, 'plan_version'),
      planDigest: text(r.plan_digest, 'plan_digest'),
      approvalId: text(r.approval_id, 'approval_id'),
      mandateId: text(r.mandate_id, 'mandate_id'),
      mandateVersion: num(r.mandate_version, 'mandate_version'),
      amountMinor: num(r.amount_minor, 'amount_minor'),
      currency: text(r.currency, 'currency'),
      beneficiary: text(r.beneficiary, 'beneficiary'),
      purpose: text(r.purpose, 'purpose'),
      createdAt: text(r.created_at, 'created_at'),
      updatedAt: text(r.updated_at, 'updated_at'),
    };
  }

  private mapCommitment(row: unknown): CommitmentView {
    const r = row as Record<string, unknown>;
    return {
      id: text(r.id, 'id'),
      orgId: text(r.org_id, 'org_id'),
      missionId: text(r.mission_id, 'mission_id'),
      operationId: text(r.operation_id, 'operation_id'),
      currency: text(r.currency, 'currency'),
      amountMinor: num(r.amount_minor, 'amount_minor'),
      state: text(r.state, 'state') as CommitmentView['state'],
      finalizedAt: nullableText(r.finalized_at),
      createdAt: text(r.created_at, 'created_at'),
      updatedAt: text(r.updated_at, 'updated_at'),
    };
  }
}

function mismatch(list: string[], what: string): void {
  list.push(what);
}
