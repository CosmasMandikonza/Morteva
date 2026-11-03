/**
 * Provider dispatch worker — the authority-gated seam for issues #5/#6.
 *
 * MTV-05 adds the TOCTOU-safe dispatch gate (issue #7 Phase 5): claiming an
 * outbox row, re-checking mandate authority, and transitioning the operation
 * RESERVED→SUBMITTING happen in ONE `BEGIN IMMEDIATE` transaction. That
 * transition is the *authoritative dispatch decision*:
 *
 *  - Authority revoked/expired/superseded/budget-shrunk BEFORE the gate →
 *    the row is abandoned, the operation CANCELLED (provably never
 *    submitted) and its funds released — the provider is never called.
 *  - Revocation AFTER the gate → the operation is already in the dispatch
 *    attempt; it is reconciled by its ORIGINAL requestId and retains its
 *    commitment until provider truth resolves it. Revocation never
 *    retroactively proves an in-flight payment did not execute.
 *
 * Semantics preserved from PR #23's reviewed contracts:
 *  - A dispatch response of submitted/processing is NOT settlement; the
 *    operation moves to IN_FLIGHT and finality comes only from verified
 *    provider readback (attestation source 'provider-readback').
 *  - SUBMITTING/IN_FLIGHT/STATUS_UNKNOWN claims always RECONCILE by original
 *    request id — never a blind resubmit.
 *  - A thrown error or status-unknown retains the commitment.
 *  - A synchronous provider 'failed' escalates to REQUIRES_HUMAN.
 */
import type { LedgerDatabase } from '../db/port.js';
import type { ProviderCallResult, ProviderSubmissionStatus } from '@moterva/providers';
import type { ProviderCallStatus } from '@moterva/providers';
import type { Clock } from '../clock.js';
import type { ReservationService } from './reservations.js';
import type { OutboxService } from './outbox.js';
import type { EvidenceService } from './evidence.js';
import type { MandateService } from './mandates.js';
import { newClaimToken } from '../db/sqlite.js';
import { text } from '../db/port.js';

export interface DispatchCommand {
  readonly operationId: string;
  readonly orgId: string;
  readonly missionId: string;
  readonly kind: string;
  readonly requestId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly beneficiary: string;
  readonly purpose: string;
}

export interface RailDispatcher {
  readonly rail: 'airwallex' | 'metal';
  /** Dispatch with the durable original requestId. Must not self-attest settlement. */
  dispatch(
    command: DispatchCommand,
  ): Promise<ProviderCallResult<unknown, ProviderSubmissionStatus>>;
  /**
   * Resolve an ambiguous earlier dispatch by original requestId. Unlike a
   * submission, a readback MAY return 'confirmed' — that is the only source
   * of provider-verified finality (or it may remain status-unknown).
   */
  reconcileByRequestId(requestId: string): Promise<ProviderCallResult<unknown, ProviderCallStatus>>;
}

export interface WorkerRunReport {
  readonly claimed: number;
  readonly dispatched: number;
  readonly reconciled: number;
  readonly markedUnknown: number;
  readonly escalated: number;
  readonly blocked: number;
  readonly skippedNoDispatcher: readonly ('airwallex' | 'metal')[];
}

type ClaimPhase = 'dispatch' | 'reconcile';

interface GatedClaim {
  readonly dispatchId: string;
  readonly claimToken: string;
  readonly attempts: number;
  readonly rail: 'airwallex' | 'metal';
  readonly requestId: string;
  readonly phase: ClaimPhase | 'blocked';
  readonly blockedReason?: string;
  readonly operation: {
    readonly id: string;
    readonly orgId: string;
    readonly missionId: string;
    readonly kind: string;
    readonly state: string;
    readonly amountMinor: number;
    readonly currency: string;
    readonly beneficiary: string;
    readonly purpose: string;
  };
}

export class DispatchWorker {
  private readonly dispatchers = new Map<'airwallex' | 'metal', RailDispatcher>();

  constructor(
    private readonly db: LedgerDatabase,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly reservations: ReservationService,
    private readonly mandates: MandateService,
    private readonly evidence: EvidenceService,
  ) {}

  register(dispatcher: RailDispatcher): void {
    this.dispatchers.set(dispatcher.rail, dispatcher);
  }

  registeredRails(): readonly ('airwallex' | 'metal')[] {
    return [...this.dispatchers.keys()];
  }

  /**
   * One processing pass. Rows on rails without a registered dispatcher are
   * never claimed — the seam stays visibly disabled, nothing is faked.
   */
  async runOnce(options: { limit?: number; claimTtlMs?: number } = {}): Promise<WorkerRunReport> {
    const rails = [...this.dispatchers.keys()];
    if (rails.length === 0) {
      return {
        claimed: 0,
        dispatched: 0,
        reconciled: 0,
        markedUnknown: 0,
        escalated: 0,
        blocked: 0,
        skippedNoDispatcher: [],
      };
    }
    const candidates = this.outbox.listClaimable({
      rails,
      limit: options.limit,
      claimTtlMs: options.claimTtlMs,
    });
    let dispatched = 0;
    let reconciled = 0;
    let markedUnknown = 0;
    let escalated = 0;
    let blocked = 0;
    let claimedCount = 0;

    for (const candidate of candidates) {
      const gated = this.claimWithAuthorityGate(candidate.id, options.claimTtlMs);
      if (gated === undefined) continue; // another worker won the row
      claimedCount += 1;
      if (gated.phase === 'blocked') {
        blocked += 1;
        continue;
      }

      const dispatcher = this.dispatchers.get(gated.rail);
      if (dispatcher === undefined) continue;

      this.evidence.append({
        orgId: gated.operation.orgId,
        missionId: gated.operation.missionId,
        topic: 'financial',
        type: 'dispatch.attempt',
        eventKey: `dispatch:${gated.dispatchId}:attempt:${gated.attempts}`,
        payload: {
          dispatchId: gated.dispatchId,
          requestId: gated.requestId,
          attempt: gated.attempts,
        },
      });

      try {
        if (gated.phase === 'reconcile') {
          // A claimed operation already entered the dispatch attempt before a
          // possible crash, or is ambiguous. Reconcile by its ORIGINAL request
          // id; NEVER submit it again just because a worker restarted.
          const reconciledResult = await dispatcher.reconcileByRequestId(gated.requestId);
          this.evidence.append({
            orgId: gated.operation.orgId,
            missionId: gated.operation.missionId,
            topic: 'financial',
            type: 'dispatch.reconcile',
            eventKey: `dispatch:${gated.dispatchId}:reconcile:${gated.attempts}`,
            payload: {
              dispatchId: gated.dispatchId,
              requestId: gated.requestId,
              providerStatus: reconciledResult.status,
              providerState: reconciledResult.providerState ?? null,
              verifiedAt: reconciledResult.verifiedAt ?? null,
            },
          });
          if (reconciledResult.status === 'confirmed') {
            // Verified provider readback — the only path that may finalize money state.
            this.reservations.transition({
              orgId: gated.operation.orgId,
              operationId: gated.operation.id,
              to: 'SETTLED',
              attestation: { source: 'provider-readback', note: 'reconcileByRequestId' },
            });
            this.outbox.completeDispatch(gated.operation.orgId, gated.dispatchId, gated.claimToken);
            reconciled += 1;
          } else if (reconciledResult.status === 'failed') {
            this.reservations.transition({
              orgId: gated.operation.orgId,
              operationId: gated.operation.id,
              to: 'REQUIRES_HUMAN',
              attestation: {
                source: 'provider-readback',
                note: 'reconcile says definitively not executed',
              },
              reason: 'reconcileByRequestId reported definitive failure',
            });
            this.outbox.abandon(gated.operation.orgId, gated.dispatchId, gated.claimToken);
            escalated += 1;
          } else {
            // No verified finality: keep the lease eligible for future readback.
            if (
              reconciledResult.status === 'status-unknown' &&
              gated.operation.state !== 'STATUS_UNKNOWN'
            ) {
              this.reservations.transition({
                orgId: gated.operation.orgId,
                operationId: gated.operation.id,
                to: 'STATUS_UNKNOWN',
                reason: 'provider reconciliation could not establish finality',
              });
            }
            markedUnknown += 1;
          }
          continue;
        }

        // phase === 'dispatch': the atomic gate just transitioned RESERVED→SUBMITTING.
        const result = await dispatcher.dispatch({
          operationId: gated.operation.id,
          orgId: gated.operation.orgId,
          missionId: gated.operation.missionId,
          kind: gated.operation.kind,
          requestId: gated.requestId,
          amountMinor: gated.operation.amountMinor,
          currency: gated.operation.currency,
          beneficiary: gated.operation.beneficiary,
          purpose: gated.operation.purpose,
        });

        this.evidence.append({
          orgId: gated.operation.orgId,
          missionId: gated.operation.missionId,
          topic: 'financial',
          type: 'dispatch.result',
          eventKey: `dispatch:${gated.dispatchId}:result:${gated.attempts}`,
          payload: {
            dispatchId: gated.dispatchId,
            requestId: gated.requestId,
            providerStatus: result.status,
            providerState: result.providerState ?? null,
            // Submission is not settlement; verifiedAt is absent by construction here.
            verifiedAt: result.verifiedAt ?? null,
          },
        });

        if (result.status === 'failed') {
          this.reservations.transition({
            orgId: gated.operation.orgId,
            operationId: gated.operation.id,
            to: 'REQUIRES_HUMAN',
            reason: `provider reported synchronous failure: ${result.providerState ?? 'failed'}`,
          });
          this.outbox.abandon(gated.operation.orgId, gated.dispatchId, gated.claimToken);
          escalated += 1;
          continue;
        }

        if (result.status === 'status-unknown') {
          this.reservations.transition({
            orgId: gated.operation.orgId,
            operationId: gated.operation.id,
            to: 'STATUS_UNKNOWN',
            reason: 'dispatch outcome ambiguous (provider status-unknown)',
          });
          markedUnknown += 1;
          continue; // claim goes stale and replays via reconcile path above
        }

        // Submitted/processing is NOT terminal. Keep the original claimed
        // dispatch eligible for future reconciliation after claim TTL.
        this.reservations.transition({
          orgId: gated.operation.orgId,
          operationId: gated.operation.id,
          to: 'IN_FLIGHT',
          reason: 'provider accepted submission; finality remains unverified',
        });
        dispatched += 1;
      } catch (error) {
        // Thrown (timeout/network): ambiguous by definition — retain the
        // commitment, mark unknown, replay later with the SAME request id.
        try {
          this.reservations.transition({
            orgId: gated.operation.orgId,
            operationId: gated.operation.id,
            to: 'STATUS_UNKNOWN',
            reason: `dispatch raised: ${error instanceof Error ? error.message : String(error)}`,
          });
        } catch {
          // The operation was resolved concurrently; evidence below records the attempt.
        }
        this.evidence.append({
          orgId: gated.operation.orgId,
          missionId: gated.operation.missionId,
          topic: 'financial',
          type: 'dispatch.unknown',
          eventKey: `dispatch:${gated.dispatchId}:unknown:${gated.attempts}`,
          payload: {
            dispatchId: gated.dispatchId,
            requestId: gated.requestId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        markedUnknown += 1;
      }
    }

    return {
      claimed: claimedCount,
      dispatched,
      reconciled,
      markedUnknown,
      escalated,
      blocked,
      skippedNoDispatcher: [],
    };
  }

  /**
   * THE TOCTOU-SAFE GATE (issue #7 Phase 5). One BEGIN IMMEDIATE transaction:
   * claim the outbox row → load the operation → if still RESERVED, re-verify
   * mandate authority and cumulative budget → either transition SUBMITTING
   * (the authoritative dispatch decision; returns phase 'dispatch') or cancel
   * + abandon + evidence (returns 'blocked'). Operations already past the
   * gate (SUBMITTING/IN_FLIGHT/STATUS_UNKNOWN) claim for RECONCILIATION only.
   */
  private claimWithAuthorityGate(dispatchId: string, claimTtlMs?: number): GatedClaim | undefined {
    const ttl = claimTtlMs ?? 60_000;
    const nowMs = this.clock.now().getTime();
    const staleBeforeIso = new Date(nowMs - ttl).toISOString();
    return this.db.transaction(() => {
      const claimToken = newClaimToken('gate');
      const claim = this.db
        .prepare(
          `UPDATE outbox_dispatches
           SET status = 'claimed', claim_token = ?, attempts = attempts + 1, updated_at = ?
           WHERE id = ? AND (status = 'pending' OR (status = 'claimed' AND updated_at < ?))`,
        )
        .run(claimToken, this.clock.iso(), dispatchId, staleBeforeIso);
      if (claim.changes !== 1) return undefined;

      const joined = this.db
        .prepare(
          `SELECT o.id AS op_id, o.org_id, o.mission_id, o.kind, o.state, o.request_id, o.mandate_id, o.mandate_version,
                  o.amount_minor, o.currency, o.beneficiary, o.purpose, o.approval_id,
                  x.id AS dispatch_id, x.rail, x.attempts
           FROM operations o JOIN outbox_dispatches x ON x.operation_id = o.id
           WHERE x.id = ?`,
        )
        .get(dispatchId) as Record<string, unknown>;
      const operation = {
        id: text(joined.op_id, 'op_id'),
        orgId: text(joined.org_id, 'org_id'),
        missionId: text(joined.mission_id, 'mission_id'),
        kind: text(joined.kind, 'kind'),
        state: text(joined.state, 'state'),
        amountMinor: joined.amount_minor as number,
        currency: text(joined.currency, 'currency'),
        beneficiary: text(joined.beneficiary, 'beneficiary'),
        purpose: text(joined.purpose, 'purpose'),
        mandateVersion: joined.mandate_version as number,
        approvalId: text(joined.approval_id, 'approval_id'),
      };
      const base = {
        dispatchId,
        claimToken,
        attempts: joined.attempts as number,
        rail: text(joined.rail, 'rail') as 'airwallex' | 'metal',
        requestId: text(joined.request_id, 'request_id'),
        operation,
      };

      if (operation.state !== 'RESERVED') {
        return { ...base, phase: 'reconcile' as ClaimPhase };
      }

      const mandateId = text(joined.mandate_id, 'mandate_id');
      const gateError =
        this.authorityGateDecision(operation, mandateId) ?? this.approvalGateDecision(operation);
      if (gateError !== undefined) {
        // Never dispatched → provably safe internal cancellation + release.
        this.reservations.transition({
          orgId: operation.orgId,
          operationId: operation.id,
          to: 'CANCELLED',
          reason: `dispatch blocked before provider call: ${gateError}`,
        });
        this.db
          .prepare(
            `UPDATE outbox_dispatches SET status = 'abandoned', updated_at = ? WHERE id = ? AND claim_token = ? AND status = 'claimed'`,
          )
          .run(this.clock.iso(), dispatchId, claimToken);
        this.evidence.append({
          orgId: operation.orgId,
          missionId: operation.missionId,
          topic: 'financial',
          type: 'dispatch.blocked',
          eventKey: `dispatch:${dispatchId}:blocked`,
          payload: {
            dispatchId,
            requestId: base.requestId,
            reason: gateError,
            operationId: operation.id,
          },
        });
        return { ...base, phase: 'blocked', blockedReason: gateError };
      }

      this.reservations.transition({
        orgId: operation.orgId,
        operationId: operation.id,
        to: 'SUBMITTING',
        reason: 'authority verified at dispatch gate',
      });
      return { ...base, phase: 'dispatch' as ClaimPhase };
    });
  }

  /**
   * Authority re-check for a still-RESERVED operation: mandate must be the
   * live active version (not revoked/expired/superseded) and its cumulative
   * envelope must still cover all consuming operations including this one.
   * Returns undefined when authority holds, or a stable denial reason.
   */
  /**
   * A consumed approval is still authoritative for its ONE reserved operation,
   * until explicit revocation, expiry or approver revocation. Check inside the
   * same write transaction as the final dispatch decision: revoking a queued
   * approval must prevent dispatch, but never release an attempted payment.
   */
  private approvalGateDecision(operation: {
    orgId: string;
    approvalId: string;
    mandateVersion: number;
  }): string | undefined {
    const row = this.db
      .prepare(
        `SELECT a.status, a.revoked_at, a.expires_at, a.mandate_version, a.mandate_id,
                u.revoked_at AS approver_revoked
         FROM approvals a LEFT JOIN actors u ON u.id = a.decided_by AND u.org_id = a.org_id
         WHERE a.id = ? AND a.org_id = ?`,
      )
      .get(operation.approvalId, operation.orgId) as
      | {
          status: string;
          revoked_at: string | null;
          expires_at: string;
          mandate_version: number | null;
          mandate_id: string | null;
          approver_revoked: string | null;
        }
      | undefined;
    if (row === undefined || row.status !== 'consumed') return 'APPROVAL_NOT_VALID';
    if (row.revoked_at !== null) return 'APPROVAL_REVOKED';
    if (row.approver_revoked !== null) return 'APPROVER_REVOKED';
    if (row.mandate_version === null || row.mandate_version !== operation.mandateVersion)
      return 'APPROVAL_STALE_MANDATE';
    if (row.mandate_id === null) return 'APPROVAL_UNBOUND_MANDATE';
    if (Date.parse(row.expires_at) <= this.clock.now().getTime()) return 'APPROVAL_EXPIRED';
    return undefined;
  }

  private authorityGateDecision(
    operation: {
      orgId: string;
      missionId: string;
      currency: string;
      amountMinor: number;
      mandateVersion: number;
    },
    mandateId: string,
  ): string | undefined {
    const now = this.clock.now();
    let latest;
    try {
      latest = this.mandates.latest(operation.orgId, operation.missionId, mandateId);
    } catch {
      return 'MANDATE_NOT_FOUND';
    }
    if (latest.status === 'revoked') return 'MANDATE_REVOKED';
    if (latest.status === 'superseded') return 'MANDATE_SUPERSEDED';
    if (latest.version !== operation.mandateVersion)
      return 'MANDATE_SUPERSEDED (authority re-issued)';
    if (new Date(latest.expiresAt) <= now) return 'MANDATE_EXPIRED';
    const envelope = this.mandates.effectiveTotalBudget(latest);
    const consumed = this.mandates.consumedMissionBudget(
      operation.orgId,
      operation.missionId,
      operation.currency,
    );
    if (consumed > envelope) {
      return `MANDATE_BUDGET_EXCEEDED (consumed ${consumed} > envelope ${envelope})`;
    }
    return undefined;
  }
}
