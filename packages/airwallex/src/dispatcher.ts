/**
 * AirwallexDispatcher — the RailDispatcher implementation wiring the real
 * (or offline-fixture) client into the ledger's atomic dispatch gate.
 *
 * Invariants preserved (PRs #23/#26 review law):
 *  - dispatch() NEVER returns 'confirmed' (type-level guarantee via
 *    ProviderSubmissionStatus). A create accepted by the provider maps to
 *    'submitted'; the ledger moves the operation to IN_FLIGHT and
 *    reconciliation owns finality.
 *  - reconcileByRequestId() is the ONLY path returning 'confirmed', and only
 *    when an INDEPENDENT provider readback shows a terminal-success status
 *    (PAID/COMPLETED), with verifiedAt set. The ledger then settles with a
 *    provider-readback attestation.
 *  - Ambiguity (429/5xx/timeout/lost response) → 'status-unknown'; recovery
 *    ALWAYS reuses the original request id (list-by-request_id), never a new
 *    economic identity. Airwallex dedupes request_id for 7 days.
 *  - Terminal-failed readbacks (CANCELLED/FAILED/REJECTED) map to 'failed'
 *    with the provider state — the ledger escalates to REQUIRES_HUMAN and
 *    retains exposure; it never auto-releases potentially executed money.
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

/** Strips anything credential-shaped before persisting a payload snapshot. */
export function redactProviderPayload(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  if (json === undefined) return 'null';
  return json.replace(/("(?:api[_-]?key|token|authorization)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
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
  /** request id → org id, remembered from dispatch for later receipt scoping. */
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

    let transfer: AirwallexTransferRecord;
    try {
      transfer = await this.client.createTransfer({
        requestId: command.requestId,
        beneficiaryId,
        currency: command.currency,
        amountMinor: command.amountMinor,
        reason: command.purpose.slice(0, 140),
      });
    } catch (error) {
      return this.dispatchFailure(command, error);
    }

    this.append({
      orgId: command.orgId,
      operationId: command.operationId,
      requestId: command.requestId,
      transferId: transfer.id,
      kind: 'dispatch-create',
      httpStatus: 201,
      providerStatus: transfer.status,
      payload: transfer.raw,
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
  ): Promise<ProviderCallResult<unknown, ProviderCallStatus>> {
    const orgId =
      this.orgByRequestId.get(requestId) ?? this.deps.store.orgIdForRequestId(requestId) ?? '';
    if (orgId === '') {
      // No tenant scope exists for this request id (never dispatched and no
      // durable operation). Still answer from provider truth, but receipts
      // are only persisted under a real organization.
      const result = await this.reconcileInternal(requestId, null);
      return result;
    }
    return this.reconcileInternal(requestId, orgId);
  }

  private async reconcileInternal(
    requestId: string,
    orgId: string | null,
  ): Promise<ProviderCallResult<unknown, ProviderCallStatus>> {
    let found: AirwallexTransferRecord[];
    try {
      found = await this.client.listTransfersByRequestId(requestId);
    } catch (error) {
      if (error instanceof AirwallexDefinitiveRejectionError && error.httpStatus === 404) {
        // Provider says no such transfer for this request id.
        return {
          status: 'failed',
          environment: this.env(),
          providerState: 'NOT_FOUND_BY_REQUEST_ID',
        };
      }
      this.append({
        orgId,
        operationId: null,
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
      // No transfer exists for this request id. Airwallex dedupes request_id
      // for 7 days, so a previously accepted create WOULD be listed. Absence
      // means it never reached the provider. Reported as definitive
      // non-execution; the ledger escalates (REQUIRES_HUMAN) rather than
      // silently releasing — a human confirms before any re-instruction.
      this.append({
        orgId,
        operationId: null,
        requestId,
        transferId: null,
        kind: 'readback-by-request-id',
        httpStatus: 200,
        providerStatus: null,
        payload: { items: [] },
      });
      return {
        status: 'failed',
        environment: this.env(),
        providerState: 'NO_TRANSFER_FOR_REQUEST_ID',
      };
    }

    const listed = found[0] as AirwallexTransferRecord;
    let record = listed;
    try {
      record = await this.client.getTransfer(listed.id);
    } catch (error) {
      if (error instanceof AirwallexDefinitiveRejectionError && error.httpStatus === 404) {
        // Listed but gone (data retention edge): treat the listed state.
      } else {
        this.append({
          orgId,
          operationId: null,
          requestId,
          transferId: listed.id,
          kind: 'ambiguous-failure',
          httpStatus: null,
          providerStatus: listed.status,
          payload: { error: describe(error) },
        });
        // Fall through with the listed record — still an honest readback.
      }
    }

    const normalized = normalizeTransferStatus(record.status);
    this.append({
      orgId,
      operationId: null,
      requestId,
      transferId: record.id,
      kind: 'readback-by-id',
      httpStatus: 200,
      providerStatus: record.status,
      payload: record.raw,
    });

    if (normalized === 'terminal-success') {
      // THE ONLY 'confirmed' in this adapter: an independently read back
      // terminal-success state, timestamped.
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
      payload: input.payload ?? { name: input.name },
    });
    if (input.requestId !== undefined) {
      await this.reconcileByRequestId(input.requestId);
      return { deduped: false, reconciled: true };
    }
    return { deduped: false, reconciled: false };
  }

  private dispatchFailure(
    command: DispatchCommand,
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
        payload: error.responseBody,
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
      payload: { error: describe(error) },
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
      payloadJson: redactProviderPayload(input.payload),
      recordedAt: this.deps.clock.iso(),
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
