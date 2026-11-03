/**
 * Provider dispatch worker — the DISABLED seam for issues #5/#6 (handoff #4).
 *
 * MTV-02 ships the worker machinery but NO real dispatchers: with nothing
 * registered, `runOnce()` touches nothing. Airwallex and Metal adapters will
 * register side by side later; both rails run concurrently by design — there
 * is no global mode switch (CTO review addendum).
 *
 * Semantics encoded here (packages/providers contract):
 *  - A dispatch response of submitted/processing is NOT settlement; the
 *    operation stays SUBMITTING and settlement comes only from verified
 *    provider readback in #5/#6 (attestation source 'provider-readback').
 *  - A thrown error or status-unknown marks the operation STATUS_UNKNOWN and
 *    retains the commitment; the row replays later with the SAME requestId
 *    or resolves through reconcileByRequestId.
 *  - A synchronous provider 'failed' escalates to REQUIRES_HUMAN — an error
 *    response is never proof that money is free.
 */
import type { ProviderCallResult, ProviderSubmissionStatus } from '@moterva/providers';
import type { ProviderCallStatus } from '@moterva/providers';
import type { ReservationService } from './reservations.js';
import type { OutboxService } from './outbox.js';
import type { EvidenceService } from './evidence.js';

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
  readonly skippedNoDispatcher: readonly ('airwallex' | 'metal')[];
}

export class DispatchWorker {
  private readonly dispatchers = new Map<'airwallex' | 'metal', RailDispatcher>();

  constructor(
    private readonly outbox: OutboxService,
    private readonly reservations: ReservationService,
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
        skippedNoDispatcher: [],
      };
    }
    const claimed = this.outbox.claimPending({
      rails,
      limit: options.limit,
      claimTtlMs: options.claimTtlMs,
    });
    let dispatched = 0;
    let reconciled = 0;
    let markedUnknown = 0;
    let escalated = 0;

    for (const item of claimed) {
      const dispatcher = this.dispatchers.get(item.dispatch.rail);
      if (dispatcher === undefined) continue;

      this.evidence.append({
        orgId: item.operation.orgId,
        missionId: item.operation.missionId,
        topic: 'financial',
        type: 'dispatch.attempt',
        eventKey: `dispatch:${item.dispatch.id}:attempt:${item.dispatch.attempts}`,
        payload: {
          dispatchId: item.dispatch.id,
          requestId: item.dispatch.requestId,
          attempt: item.dispatch.attempts,
        },
      });

      try {
        if (item.operation.state === 'STATUS_UNKNOWN') {
          // Replay of an ambiguous dispatch: reconcile by the ORIGINAL request id;
          // never submit a new economic instruction for it.
          const reconciledResult = await dispatcher.reconcileByRequestId(item.dispatch.requestId);
          this.evidence.append({
            orgId: item.operation.orgId,
            missionId: item.operation.missionId,
            topic: 'financial',
            type: 'dispatch.reconcile',
            eventKey: `dispatch:${item.dispatch.id}:reconcile:${item.dispatch.attempts}`,
            payload: {
              dispatchId: item.dispatch.id,
              requestId: item.dispatch.requestId,
              providerStatus: reconciledResult.status,
              providerState: reconciledResult.providerState ?? null,
              verifiedAt: reconciledResult.verifiedAt ?? null,
            },
          });
          if (reconciledResult.status === 'confirmed') {
            // Verified provider readback — the only path that may finalize money state.
            this.reservations.transition({
              orgId: item.operation.orgId,
              operationId: item.operation.id,
              to: 'SETTLED',
              attestation: { source: 'provider-readback', note: 'reconcileByRequestId' },
            });
            this.outbox.completeDispatch(
              item.operation.orgId,
              item.dispatch.id,
              item.dispatch.claimToken ?? '',
            );
            reconciled += 1;
          } else if (reconciledResult.status === 'failed') {
            this.reservations.transition({
              orgId: item.operation.orgId,
              operationId: item.operation.id,
              to: 'REQUIRES_HUMAN',
              attestation: {
                source: 'provider-readback',
                note: 'reconcile says definitively not executed',
              },
              reason: 'reconcileByRequestId reported definitive failure',
            });
            this.outbox.abandon(
              item.operation.orgId,
              item.dispatch.id,
              item.dispatch.claimToken ?? '',
            );
            escalated += 1;
          } else {
            // Still ambiguous: retain the commitment; the stale claim replays after TTL.
            markedUnknown += 1;
          }
          continue;
        }

        if (item.operation.state === 'RESERVED') {
          this.reservations.transition({
            orgId: item.operation.orgId,
            operationId: item.operation.id,
            to: 'SUBMITTING',
          });
        }

        const result = await dispatcher.dispatch({
          operationId: item.operation.id,
          orgId: item.operation.orgId,
          missionId: item.operation.missionId,
          kind: item.operation.kind,
          requestId: item.dispatch.requestId,
          amountMinor: item.operation.amountMinor,
          currency: item.operation.currency,
          beneficiary: item.operation.beneficiary,
          purpose: item.operation.purpose,
        });

        this.evidence.append({
          orgId: item.operation.orgId,
          missionId: item.operation.missionId,
          topic: 'financial',
          type: 'dispatch.result',
          eventKey: `dispatch:${item.dispatch.id}:result:${item.dispatch.attempts}`,
          payload: {
            dispatchId: item.dispatch.id,
            requestId: item.dispatch.requestId,
            providerStatus: result.status,
            providerState: result.providerState ?? null,
            // Submission is not settlement; verifiedAt is absent by construction here.
            verifiedAt: result.verifiedAt ?? null,
          },
        });

        if (result.status === 'failed') {
          this.reservations.transition({
            orgId: item.operation.orgId,
            operationId: item.operation.id,
            to: 'REQUIRES_HUMAN',
            reason: `provider reported synchronous failure: ${result.providerState ?? 'failed'}`,
          });
          this.outbox.abandon(
            item.operation.orgId,
            item.dispatch.id,
            item.dispatch.claimToken ?? '',
          );
          escalated += 1;
          continue;
        }

        if (result.status === 'status-unknown') {
          this.reservations.transition({
            orgId: item.operation.orgId,
            operationId: item.operation.id,
            to: 'STATUS_UNKNOWN',
            reason: 'dispatch outcome ambiguous (provider status-unknown)',
          });
          markedUnknown += 1;
          continue; // claim goes stale and replays via reconcile path above
        }

        // submitted | processing: dispatch happened; settlement is NOT implied.
        this.outbox.completeDispatch(
          item.operation.orgId,
          item.dispatch.id,
          item.dispatch.claimToken ?? '',
        );
        dispatched += 1;
      } catch (error) {
        // Thrown (timeout/network): ambiguous by definition — retain the
        // commitment, mark unknown, replay later with the SAME request id.
        // If the operation was resolved concurrently (e.g. an operator cancelled
        // it while claimed), record evidence instead of fighting the lifecycle.
        try {
          this.reservations.transition({
            orgId: item.operation.orgId,
            operationId: item.operation.id,
            to: 'STATUS_UNKNOWN',
            reason: `dispatch raised: ${error instanceof Error ? error.message : String(error)}`,
          });
        } catch (transitionError) {
          this.evidence.append({
            orgId: item.operation.orgId,
            missionId: item.operation.missionId,
            topic: 'financial',
            type: 'dispatch.unknown_transition_skipped',
            eventKey: `dispatch:${item.dispatch.id}:unknown-skipped:${item.dispatch.attempts}`,
            payload: {
              dispatchId: item.dispatch.id,
              requestId: item.dispatch.requestId,
              reason:
                transitionError instanceof Error
                  ? transitionError.message
                  : String(transitionError),
            },
          });
        }
        this.evidence.append({
          orgId: item.operation.orgId,
          missionId: item.operation.missionId,
          topic: 'financial',
          type: 'dispatch.unknown',
          eventKey: `dispatch:${item.dispatch.id}:unknown:${item.dispatch.attempts}`,
          payload: {
            dispatchId: item.dispatch.id,
            requestId: item.dispatch.requestId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        markedUnknown += 1;
      }
    }

    return {
      claimed: claimed.length,
      dispatched,
      reconciled,
      markedUnknown,
      escalated,
      skippedNoDispatcher: [],
    };
  }
}
