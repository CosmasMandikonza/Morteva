/**
 * AirwallexDispatcher — the RailDispatcher implementation wiring the real
 * (or offline-fixture) client into the ledger's atomic dispatch gate.
 *
 * Invariants preserved (PRs #23/#26 review law + R3 CTO review):
 *  - dispatch() NEVER returns 'confirmed' (type-level guarantee via
 *    ProviderSubmissionStatus). A create accepted by the provider maps to
 *    'submitted'; the ledger moves the operation to IN_FLIGHT and
 *    reconciliation owns finality.
 *  - reconcileByRequestId() is the ONLY path returning 'confirmed', and only
 *    when ALL of the following hold (final-round P0-2/P0-3):
 *      (a) the list-by-request-id record carries the exact namespaced
 *          provider request id (missing/foreign ids are ambiguous);
 *      (b) an INDEPENDENT get-by-id succeeds and shows terminal success,
 *          with the SAME transfer id and the same namespaced request id;
 *      (c) a COMPLETE settlement scope (org + operation + amount + currency
 *          + beneficiary, worker-bound from the durable authorization) is
 *          present and consistent with the server-side beneficiary mapping;
 *      (d) the record matches every authorized term EXACTLY (minor-unit
 *          amount, currency, beneficiary id) — missing provider identity
 *          fields are EVIDENCE_INCOMPLETE, wrong values EVIDENCE_MISMATCH,
 *          and neither can ever confirm. A failed get-by-id NEVER degrades
 *          to the listed record for confirmation.
 *    Webhook/diagnostic/unscoped callers may observe provider state but can
 *    never produce a settlement-authorizing 'confirmed'.
 *  - Provider request identities are NAMESPACED per organization
 *    (provider-request-id.ts), so identical local request ids in two orgs
 *    can never collide at Airwallex or in reconciliation.
 *  - Ambiguity (429/5xx/timeout/lost response) → 'status-unknown'; recovery
 *    ALWAYS reuses the original request id (list-by-request_id), never a new
 *    economic identity. Airwallex dedupes request_id for 7 days.
 *  - Terminal-failed readbacks (CANCELLED/FAILED) map to 'failed' with the
 *    provider state — the ledger escalates to REQUIRES_HUMAN and retains
 *    exposure; it never auto-releases potentially executed money.
 *  - Receipts store ONLY allowlisted minimized fields (minimize.ts); raw
 *    provider payloads, beneficiary details and nested objects never persist.
 */
import type {
  ProviderCallResult,
  ProviderCallStatus,
  ProviderSubmissionStatus,
} from '@moterva/providers';
import type { DispatchCommand, RailDispatcher } from '@moterva/ledger';
import { AirwallexClient, AirwallexDefinitiveRejectionError } from './client.js';
import type { AirwallexTransferRecord } from './client.js';
import { normalizeTransferStatus } from './status.js';
import type { ProviderReceiptStore } from '@moterva/providers';
import type { AirwallexTransport } from './transport.js';
import { TransportUnavailableError } from './transport.js';
import type { AirwallexAdapterConfig } from './config.js';
import { providerRequestIdFor } from './provider-request-id.js';
import { minimizeError, minimizeTransfer } from './minimize.js';

/** Strips anything credential-shaped from a payload we constructed ourselves. */
export function redactProviderPayload(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  if (json === undefined) return 'null';
  return json.replace(/("(?:api[_-]?key|token|authorization)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
}

/** Scope the ledger worker binds to every reconciliation (tenant-safe, P0-2/P0-3). A COMPLETE scope (all economic terms present) is REQUIRED before a readback may return 'confirmed'; webhook/diagnostic callers bind only the tenant and can never authorize settlement. */
export interface ReconcileScope {
  readonly orgId: string;
  readonly operationId: string | null;
  /** Authorized amount in minor units — validated against the provider record when present. */
  readonly amountMinor?: number;
  readonly currency?: string;
  readonly beneficiary?: string;
}

/**
 * A settlement-capable scope (final-round P0-3): every economic term the
 * authorization carries must be present. Anything less may observe provider
 * state ('failed'/'processing'/'status-unknown') but can NEVER confirm.
 */
export interface SettlementScope {
  readonly orgId: string;
  readonly operationId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly beneficiary: string;
}

export function asSettlementScope(scope: ReconcileScope | undefined): SettlementScope | null {
  if (scope === undefined) return null;
  if (
    scope.orgId === '' ||
    scope.operationId === null ||
    scope.operationId === '' ||
    typeof scope.amountMinor !== 'number' ||
    !Number.isFinite(scope.amountMinor) ||
    typeof scope.currency !== 'string' ||
    scope.currency === '' ||
    typeof scope.beneficiary !== 'string' ||
    scope.beneficiary === ''
  ) {
    return null;
  }
  return {
    orgId: scope.orgId,
    operationId: scope.operationId,
    amountMinor: scope.amountMinor,
    currency: scope.currency,
    beneficiary: scope.beneficiary,
  };
}

export interface AirwallexDispatcherDeps {
  readonly config: AirwallexAdapterConfig;
  readonly transport: AirwallexTransport;
  readonly store: ProviderReceiptStore;
  /**
   * Durable webhook-event sink (wired to the ledger's append-only evidence
   * journal in production). Throwing on a duplicate event id implements
   * at-least-once delivery dedupe; webhook events NEVER mutate operations
   * directly — they only persist evidence and schedule reconciliation.
   */
  readonly webhookSink?: (event: {
    eventId: string;
    name: string;
    transferId?: string;
    requestId?: string;
    payload: unknown;
  }) => void;
  readonly clock: { now(): Date; iso(): string };
  /** Server-side beneficiary mapping per org (sandbox configuration, never client-supplied). */
  readonly beneficiaryIdForOrg: (orgId: string) => string | undefined;
  readonly environment: 'sandbox' | 'offline-fixture';
}

export class AirwallexDispatcher implements RailDispatcher {
  readonly rail = 'airwallex' as const;
  private readonly client: AirwallexClient;
  /** ledger request id → org id, remembered from dispatch for receipt scoping. */
  private readonly orgByRequestId = new Map<string, string>();

  constructor(private readonly deps: AirwallexDispatcherDeps) {
    this.client = new AirwallexClient(deps.config, deps.transport, deps.clock);
  }

  private env(): 'sandbox' | 'simulated' {
    return this.deps.environment === 'sandbox' ? 'sandbox' : 'simulated';
  }

  async dispatch(
    command: DispatchCommand,
  ): Promise<ProviderCallResult<unknown, ProviderSubmissionStatus>> {
    this.orgByRequestId.set(command.requestId, command.orgId);
    const beneficiaryId = this.deps.beneficiaryIdForOrg(command.orgId);
    if (beneficiaryId === undefined || beneficiaryId.trim() === '') {
      // Configuration gap BEFORE any provider call: definitively not submitted.
      this.append({
        orgId: command.orgId,
        operationId: command.operationId,
        requestId: command.requestId,
        transferId: null,
        kind: 'definitive-rejection',
        httpStatus: null,
        providerStatus: null,
        payload: { error: 'no beneficiary configured for organization' },
      });
      return {
        status: 'failed',
        environment: this.env(),
        providerState: 'NO_BENEFICIARY_CONFIGURED',
      };
    }

    // Namespaced provider identity (P0-2): deterministic per (org, ledger id).
    let providerRequestId: string;
    try {
      providerRequestId = providerRequestIdFor(command.orgId, command.requestId);
    } catch (error) {
      // Invalid/too-long local id: definitively not submitted.
      this.append({
        orgId: command.orgId,
        operationId: command.operationId,
        requestId: command.requestId,
        transferId: null,
        kind: 'definitive-rejection',
        httpStatus: null,
        providerStatus: 'INVALID_REQUEST_ID',
        payload: { error: describe(error) },
      });
      return {
        status: 'failed',
        environment: this.env(),
        providerState: 'INVALID_REQUEST_ID',
      };
    }

    let transfer: AirwallexTransferRecord;
    try {
      transfer = await this.client.createTransfer({
        requestId: providerRequestId,
        beneficiaryId,
        currency: command.currency,
        amountMinor: command.amountMinor,
        reason: command.purpose.slice(0, 140),
      });
    } catch (error) {
      return this.dispatchFailure(command, providerRequestId, error);
    }

    this.append({
      orgId: command.orgId,
      operationId: command.operationId,
      requestId: command.requestId,
      transferId: transfer.id,
      kind: 'dispatch-create',
      httpStatus: 201,
      providerStatus: transfer.status,
      payload: { provider_request_id: providerRequestId, transfer: minimizeTransfer(transfer.raw) },
    });

    // Submission accepted — NEVER 'confirmed'. The provider's pending states
    // (PENDING_*, PROCESSING, SENT...) all mean accepted-and-not-final.
    return {
      status: 'submitted',
      environment: this.env(),
      providerState: transfer.status,
      receiptRef: `airwallex:${transfer.id}`,
    };
  }

  async reconcileByRequestId(
    requestId: string,
    scope?: ReconcileScope,
  ): Promise<ProviderCallResult<unknown, ProviderCallStatus>> {
    const orgId = scope?.orgId ?? this.orgByRequestId.get(requestId) ?? null;
    if (orgId === null) {
      // No tenant scope (never dispatched here, no durable scope from the
      // worker). Without an organization we cannot build the namespaced
      // provider identity — reconciliation is impossible, not "empty".
      return {
        status: 'status-unknown',
        environment: this.env(),
        providerState: 'NO_TENANT_SCOPE',
      };
    }
    const providerRequestId = providerRequestIdFor(orgId, requestId);
    const operationId = scope?.operationId ?? null;

    let found: AirwallexTransferRecord[];
    try {
      found = await this.client.listTransfersByRequestId(providerRequestId);
    } catch (error) {
      // Malformed bodies already fail closed in the client (P1-6); here we
      // cover transport/HTTP ambiguity. 404 on the listing is definitive
      // "no transfer for this request id" at the provider.
      if (error instanceof AirwallexDefinitiveRejectionError && error.httpStatus === 404) {
        return {
          status: 'failed',
          environment: this.env(),
          providerState: 'NOT_FOUND_BY_REQUEST_ID',
        };
      }
      this.append({
        orgId,
        operationId,
        requestId,
        transferId: null,
        kind: 'ambiguous-failure',
        httpStatus: null,
        providerStatus: null,
        payload: { error: describe(error) },
      });
      return { status: 'status-unknown', environment: this.env() };
    }

    if (found.length === 0) {
      // Authoritative empty response (client guarantees well-formedness):
      // Airwallex dedupes request_id for 7 days, so a previously accepted
      // create WOULD be listed. Absence means it never reached the provider.
      // Definitive non-execution — the ledger escalates (REQUIRES_HUMAN),
      // never auto-resubmits or releases without a human.
      this.append({
        orgId,
        operationId,
        requestId,
        transferId: null,
        kind: 'readback-by-request-id',
        httpStatus: 200,
        providerStatus: null,
        payload: { provider_request_id: providerRequestId, items: [] },
      });
      return {
        status: 'failed',
        environment: this.env(),
        providerState: 'NO_TRANSFER_FOR_REQUEST_ID',
      };
    }

    if (found.length > 1) {
      // Duplicate matches under one request id: ambiguous provider state —
      // NEVER pick one and confirm. Human investigation.
      this.append({
        orgId,
        operationId,
        requestId,
        transferId: null,
        kind: 'ambiguous-failure',
        httpStatus: 200,
        providerStatus: 'DUPLICATE_MATCHES',
        payload: {
          provider_request_id: providerRequestId,
          matched: found.map((record) => minimizeTransfer(record.raw)),
        },
      });
      return {
        status: 'status-unknown',
        environment: this.env(),
        providerState: 'DUPLICATE_MATCHES',
      };
    }

    const listed = found[0] as AirwallexTransferRecord;
    if (listed.requestId === null) {
      // Final-round P0-2: a listed record WITHOUT a request id is not
      // attributable to our intent — missing identity fields are ambiguous,
      // never a basis for confirmation or definitive failure attribution.
      this.append({
        orgId,
        operationId,
        requestId,
        transferId: listed.id,
        kind: 'ambiguous-failure',
        httpStatus: 200,
        providerStatus: 'EVIDENCE_INCOMPLETE',
        payload: { provider_request_id: providerRequestId, listed: minimizeTransfer(listed.raw) },
      });
      return {
        status: 'status-unknown',
        environment: this.env(),
        providerState: 'EVIDENCE_INCOMPLETE',
      };
    }
    if (listed.requestId !== providerRequestId) {
      // Foreign record under our namespaced id — provider state is not ours
      // to interpret. Fail closed.
      this.append({
        orgId,
        operationId,
        requestId,
        transferId: listed.id,
        kind: 'ambiguous-failure',
        httpStatus: 200,
        providerStatus: 'REQUEST_ID_MISMATCH',
        payload: { provider_request_id: providerRequestId, listed: minimizeTransfer(listed.raw) },
      });
      return {
        status: 'status-unknown',
        environment: this.env(),
        providerState: 'REQUEST_ID_MISMATCH',
      };
    }

    // Authoritative per-id readback (P0-3): confirmation may ONLY come from a
    // SUCCESSFUL get-by-id. A failed lookup degrades to status-unknown —
    // the listed record is never used as settlement evidence.
    let record: AirwallexTransferRecord;
    try {
      record = await this.client.getTransfer(listed.id);
    } catch (error) {
      this.append({
        orgId,
        operationId,
        requestId,
        transferId: listed.id,
        kind: 'ambiguous-failure',
        httpStatus: error instanceof AirwallexDefinitiveRejectionError ? error.httpStatus : null,
        providerStatus: 'READBACK_INCOMPLETE',
        payload: {
          error:
            error instanceof AirwallexDefinitiveRejectionError
              ? minimizeError(error.responseBody)
              : { message: describe(error) },
        },
      });
      return {
        status: 'status-unknown',
        environment: this.env(),
        providerState: 'READBACK_INCOMPLETE',
      };
    }

    const normalized = normalizeTransferStatus(record.status);

    // Final-round P0-2: the independent get-by-ID record must itself carry a
    // complete, consistent identity — same transfer id as the listing, same
    // namespaced request id. Missing or contradictory identity fields make
    // the readback ambiguous, no matter how plausible the amount looks.
    if (record.id !== listed.id) {
      this.append({
        orgId,
        operationId,
        requestId,
        transferId: record.id,
        kind: 'ambiguous-failure',
        httpStatus: 200,
        providerStatus: 'EVIDENCE_INCOMPLETE',
        payload: {
          provider_request_id: providerRequestId,
          listed_transfer_id: listed.id,
          transfer: minimizeTransfer(record.raw),
        },
      });
      return {
        status: 'status-unknown',
        environment: this.env(),
        providerState: 'EVIDENCE_INCOMPLETE',
      };
    }
    if (record.requestId === null || record.requestId !== providerRequestId) {
      this.append({
        orgId,
        operationId,
        requestId,
        transferId: record.id,
        kind: 'ambiguous-failure',
        httpStatus: 200,
        providerStatus: record.requestId === null ? 'EVIDENCE_INCOMPLETE' : 'REQUEST_ID_MISMATCH',
        payload: { provider_request_id: providerRequestId, transfer: minimizeTransfer(record.raw) },
      });
      return {
        status: 'status-unknown',
        environment: this.env(),
        providerState: record.requestId === null ? 'EVIDENCE_INCOMPLETE' : 'REQUEST_ID_MISMATCH',
      };
    }

    this.append({
      orgId,
      operationId,
      requestId,
      transferId: record.id,
      kind: 'readback-by-id',
      httpStatus: 200,
      providerStatus: record.status,
      payload: { provider_request_id: providerRequestId, transfer: minimizeTransfer(record.raw) },
    });

    if (normalized === 'terminal-success') {
      // Verified PAID at readback time. Final-round P0-3: confirmation is
      // settlement authorization — it requires a COMPLETE trusted scope
      // (worker-bound operation + every authorized economic term). Webhook
      // triggers, diagnostic calls and partially-scoped callers may observe
      // provider state but can NEVER produce 'confirmed'.
      const settlement = asSettlementScope(scope);
      if (settlement === null) {
        this.append({
          orgId,
          operationId,
          requestId,
          transferId: record.id,
          kind: 'ambiguous-failure',
          httpStatus: 200,
          providerStatus: 'SCOPE_INCOMPLETE',
          payload: {
            note: 'terminal-success readback without a complete settlement scope; observing only',
          },
        });
        return {
          status: 'status-unknown',
          environment: this.env(),
          providerState: 'SCOPE_INCOMPLETE',
        };
      }
      const configuredBeneficiary = this.deps.beneficiaryIdForOrg(settlement.orgId);
      if (configuredBeneficiary !== undefined && configuredBeneficiary !== settlement.beneficiary) {
        // The trusted server-side org mapping disagrees with the operation's
        // authorized beneficiary — inconsistent trusted inputs, never confirm.
        this.append({
          orgId,
          operationId,
          requestId,
          transferId: record.id,
          kind: 'ambiguous-failure',
          httpStatus: 200,
          providerStatus: 'SCOPE_INCONSISTENT',
          payload: {
            note: 'configured org beneficiary differs from the authorized operation beneficiary',
          },
        });
        return {
          status: 'status-unknown',
          environment: this.env(),
          providerState: 'SCOPE_INCONSISTENT',
        };
      }
      const verdict = validateAgainstSettlementScope(record, settlement);
      if (verdict !== null) {
        this.append({
          orgId,
          operationId,
          requestId,
          transferId: record.id,
          kind: 'ambiguous-failure',
          httpStatus: 200,
          providerStatus: verdict.state,
          payload: { mismatches: verdict.mismatches, transfer: minimizeTransfer(record.raw) },
        });
        return {
          status: 'status-unknown',
          environment: this.env(),
          providerState: verdict.state,
        };
      }
      // THE ONLY 'confirmed' in this adapter: independent readback of terminal
      // success on a record matching the authorized terms, timestamped.
      // NOTE: PAID is verified-at-readback-time finality, not irreversible
      // delivery — post-PAID FAILED transitions exist (see status.ts); the
      // ledger keeps monitoring until a human RECONCILES.
      return {
        status: 'confirmed',
        environment: this.env(),
        providerState: record.status,
        verifiedAt: this.deps.clock.iso(),
        receiptRef: `airwallex:${record.id}`,
      };
    }
    if (normalized === 'terminal-failed') {
      return {
        status: 'failed',
        environment: this.env(),
        providerState: record.status,
        receiptRef: `airwallex:${record.id}`,
      };
    }
    // pending or undocumented status: keep reconciling.
    return {
      status: 'processing',
      environment: this.env(),
      providerState: record.status,
      receiptRef: `airwallex:${record.id}`,
    };
  }

  /** Balance read with per-currency Money conversion (issue #5 criterion 2). */
  async readBalances(): Promise<
    | {
        ok: true;
        balances: Awaited<ReturnType<AirwallexClient['balancesCurrent']>>;
        readAt: string;
      }
    | { ok: false; providerCode: string | null }
  > {
    try {
      const balances = await this.client.balancesCurrent();
      return { ok: true, balances, readAt: this.deps.clock.iso() };
    } catch (error) {
      return {
        ok: false,
        providerCode:
          error instanceof AirwallexDefinitiveRejectionError ? error.providerCode : null,
      };
    }
  }

  /**
   * Webhook ingestion (at-least-once delivery; out-of-order safe).
   *
   * A webhook NEVER mutates operation state directly: the event is persisted
   * (dedupe by event id via the sink) and, when it carries a request id, it
   * only triggers an independent reconciliation. Stale/out-of-order events
   * therefore cannot regress anything — reconciliation reads the provider's
   * CURRENT state, and the ledger's state machine rejects regressions anyway.
   */
  async ingestTransferWebhook(input: {
    readonly orgId: string;
    readonly eventId: string;
    readonly name: string;
    readonly transferId?: string;
    readonly requestId?: string;
    readonly payload?: unknown;
  }): Promise<{ deduped: boolean; reconciled: boolean }> {
    let deduped = false;
    if (this.deps.webhookSink !== undefined) {
      try {
        this.deps.webhookSink({
          eventId: input.eventId,
          name: input.name,
          transferId: input.transferId,
          requestId: input.requestId,
          payload: redactProviderPayload(input.payload ?? null),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/duplicate/i.test(message)) {
          deduped = true;
        } else {
          throw error;
        }
      }
    }
    if (deduped) return { deduped: true, reconciled: false };
    this.append({
      orgId: input.orgId,
      operationId: null,
      requestId: input.requestId ?? `webhook:${input.eventId}`,
      transferId: input.transferId ?? null,
      kind: 'webhook',
      httpStatus: null,
      providerStatus: input.name,
      payload: input.payload !== undefined ? minimizeTransfer(input.payload) : { name: input.name },
    });
    if (input.requestId !== undefined) {
      // Tenant-only scope: this reconciliation can never return 'confirmed'
      // (final-round P0-3) — it observes state and records evidence; the
      // worker's next fully-scoped pass owns any settlement decision.
      await this.reconcileByRequestId(input.requestId, { orgId: input.orgId, operationId: null });
      return { deduped: false, reconciled: true };
    }
    return { deduped: false, reconciled: false };
  }

  private dispatchFailure(
    command: DispatchCommand,
    providerRequestId: string,
    error: unknown,
  ): ProviderCallResult<unknown, ProviderSubmissionStatus> {
    if (error instanceof AirwallexDefinitiveRejectionError) {
      this.append({
        orgId: command.orgId,
        operationId: command.operationId,
        requestId: command.requestId,
        transferId: null,
        kind: 'definitive-rejection',
        httpStatus: error.httpStatus,
        providerStatus: error.providerCode,
        payload: {
          provider_request_id: providerRequestId,
          error: minimizeError(error.responseBody),
        },
      });
      // Synchronous provider rejection (invalid beneficiary, validation
      // error...): the transfer was NOT created. 'failed' — the ledger
      // escalates to REQUIRES_HUMAN and retains exposure (no auto-release).
      return { status: 'failed', environment: this.env(), providerState: error.providerCode };
    }
    this.append({
      orgId: command.orgId,
      operationId: command.operationId,
      requestId: command.requestId,
      transferId: null,
      kind: 'ambiguous-failure',
      httpStatus: null,
      providerStatus: null,
      payload: { provider_request_id: providerRequestId, error: { message: describe(error) } },
    });
    // Timeout / connection loss / 429 / 5xx: the request MAY have been
    // accepted — status-unknown, retain exposure, reconcile by request id.
    return { status: 'status-unknown', environment: this.env() };
  }

  private append(input: {
    orgId: string | null;
    operationId: string | null;
    requestId: string;
    transferId: string | null;
    kind:
      | 'dispatch-create'
      | 'readback-by-id'
      | 'readback-by-request-id'
      | 'definitive-rejection'
      | 'ambiguous-failure'
      | 'webhook';
    httpStatus: number | null;
    providerStatus: string | null;
    payload: unknown;
  }): void {
    if (input.orgId === null || input.orgId === '') {
      // Receipts are tenant-scoped evidence; without an owning organization
      // there is no honest scope to persist under. Skip rather than guess.
      return;
    }
    this.deps.store.append({
      orgId: input.orgId,
      operationId: input.operationId,
      requestId: input.requestId,
      providerResourceId: input.transferId,
      kind: input.kind,
      environment: this.deps.environment,
      httpStatus: input.httpStatus,
      providerStatus: input.providerStatus,
      // Payloads arriving here are ALREADY minimized at every call site;
      // the regex pass remains as defense in depth, not the boundary.
      payloadJson: redactProviderPayload(input.payload),
      recordedAt: this.deps.clock.iso(),
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Exact-term validation of a provider readback against the authorized
 * operation (final-round P0-2/P0-3). Missing provider identity fields are
 * EVIDENCE_INCOMPLETE (ambiguous); wrong values are EVIDENCE_MISMATCH. Any
 * non-null verdict blocks confirmation.
 */
function validateAgainstSettlementScope(
  record: AirwallexTransferRecord,
  scope: SettlementScope,
): { state: 'EVIDENCE_INCOMPLETE' | 'EVIDENCE_MISMATCH'; mismatches: string[] } | null {
  const mismatches: string[] = [];
  let sawValueMismatch = false;
  if (record.transferAmount === null) {
    mismatches.push(
      'amount/currency: provider record is missing transfer_amount or transfer_currency',
    );
  } else {
    if (record.transferAmount.minorUnits !== scope.amountMinor) {
      sawValueMismatch = true;
      mismatches.push(
        `amount: authorized ${String(scope.amountMinor)} minor, provider record shows ${String(record.transferAmount.minorUnits)} minor`,
      );
    }
    if (record.transferAmount.currency !== scope.currency) {
      sawValueMismatch = true;
      mismatches.push(
        `currency: authorized ${scope.currency}, provider record shows ${record.transferAmount.currency}`,
      );
    }
  }
  if (record.beneficiaryId === null) {
    mismatches.push('beneficiary: provider record is missing beneficiary_id');
  } else if (record.beneficiaryId !== scope.beneficiary) {
    sawValueMismatch = true;
    mismatches.push(
      'beneficiary: provider record names a different beneficiary than the authorized operation',
    );
  }
  if (mismatches.length === 0) return null;
  return {
    state: sawValueMismatch ? 'EVIDENCE_MISMATCH' : 'EVIDENCE_INCOMPLETE',
    mismatches,
  };
}

/** Builds the LIVE (sandbox) dispatcher; refuses fixture transports. */
export function buildSandboxDispatcher(
  config: AirwallexAdapterConfig,
  transport: AirwallexTransport,
  store: ProviderReceiptStore,
  clock: { now(): Date; iso(): string },
  beneficiaryIdForOrg: (orgId: string) => string | undefined,
): AirwallexDispatcher {
  if (!config.enabled || config.clientId === null || config.apiKey === null) {
    throw new Error(
      'buildSandboxDispatcher requires an enabled sandbox configuration with credentials',
    );
  }
  if ((transport as { __offlineFixture?: boolean }).__offlineFixture === true) {
    throw new Error('buildSandboxDispatcher must not be wired to the offline fixture transport');
  }
  return new AirwallexDispatcher({
    config,
    transport,
    store,
    clock,
    beneficiaryIdForOrg,
    environment: 'sandbox',
  });
}

/** Builds the OFFLINE FIXTURE dispatcher (tests only; reports 'simulated'). */
export function buildOfflineFixtureDispatcher(
  config: AirwallexAdapterConfig,
  transport: AirwallexTransport,
  store: ProviderReceiptStore,
  clock: { now(): Date; iso(): string },
  beneficiaryIdForOrg: (orgId: string) => string | undefined,
): AirwallexDispatcher {
  return new AirwallexDispatcher({
    // Fixture runs regardless of credentials; config used for timeouts only.
    config,
    transport,
    store,
    clock,
    beneficiaryIdForOrg,
    environment: 'offline-fixture',
  });
}

export { TransportUnavailableError };
