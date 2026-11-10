/**
 * Airwallex API client (server-only).
 *
 * Verified endpoints (official reference, API version 2026-08-21; checked
 * 2026-11-03 against airwallex.com/docs/api + airwallexdev.com/guide;
 * beneficiaries re-checked 2026-11-10 against airwallex.com/docs/api/payouts/beneficiaries):
 *   POST /api/v1/authentication/login   headers x-client-id / x-api-key
 *                                      → 201 { token, expires_at } (30 min)
 *   GET  /api/v1/balances/current       → { available_amount, currency, ... }
 *   GET  /api/v1/beneficiaries          → { has_more, items } (read-only proof;
 *                                         page_num/page_size query params)
 *   GET  /api/v1/beneficiaries/{id}     → { id, beneficiary, nickname,
 *                                         transfer_methods } (read-only proof)
 *   POST /api/v1/transfers/create       { request_id, beneficiary_id,
 *                                         transfer_currency, transfer_amount }
 *   GET  /api/v1/transfers/{id}         → transfer (status, failure, ...)
 *   GET  /api/v1/transfers?request_id=  → { items: [...] } (recovery path)
 *   POST /api/v1/fx/quotes/create       (buy/sell currency + amount)
 *
 * Token handling: cached with expiry; on 401 (credentials_invalid/expired per
 * docs) refresh ONCE and retry the original request. Login failures classify
 * as definitive only when the provider says the credentials are invalid.
 */
import type { AirwallexAdapterConfig } from './config.js';
import type { AirwallexTransport, TransportRequest, TransportResponse } from './transport.js';
import { TransportUnavailableError } from './transport.js';
import { majorUnitsToMoney, transferAmountMinorToMajor } from './money.js';
import type { Money } from '@moterva/domain';

export interface AirwallexBalance {
  readonly currency: string;
  readonly availableAmount: Money;
  readonly pendingAmount: Money;
  readonly reservedAmount: Money;
  readonly totalAmount: Money;
  readonly accountType: string;
}

export interface AirwallexTransferRecord {
  readonly id: string;
  readonly requestId: string | null;
  readonly status: string;
  readonly transferAmount: Money | null;
  readonly beneficiaryId: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly raw: unknown;
}

/**
 * BENEFICIARY READ PROJECTION — deliberately NOT the provider's beneficiary
 * object. Only identity/facilitation fields are surfaced (id, operator-set
 * nickname, payout transfer methods); bank details, card and digital-wallet
 * payloads are NEVER parsed or persisted by this adapter (read-only
 * connection proof A1; receipts stay minimized the same way).
 */
export interface AirwallexBeneficiary {
  readonly id: string;
  readonly nickname: string | null;
  readonly transferMethods: readonly string[];
}

export interface AirwallexBeneficiaryPage {
  readonly items: readonly AirwallexBeneficiary[];
  readonly hasMore: boolean;
}

export class AirwallexDefinitiveRejectionError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly providerCode: string,
    message: string,
    readonly responseBody: unknown,
  ) {
    super(message);
    this.name = 'AirwallexDefinitiveRejectionError';
  }
}

interface LoginResponse {
  token?: unknown;
  expires_at?: unknown;
}

function providerErrorCode(body: unknown): string {
  if (
    body !== null &&
    typeof body === 'object' &&
    typeof (body as { code?: unknown }).code === 'string'
  ) {
    return (body as { code: string }).code;
  }
  return 'unknown';
}

function providerErrorMessage(body: unknown): string {
  if (
    body !== null &&
    typeof body === 'object' &&
    typeof (body as { message?: unknown }).message === 'string'
  ) {
    return (body as { message: string }).message;
  }
  return 'no provider message';
}

export class AirwallexClient {
  private token: string | null = null;
  private tokenExpiresAtMs = 0;

  constructor(
    private readonly config: AirwallexAdapterConfig,
    private readonly transport: AirwallexTransport,
    private readonly clock: { now(): Date },
  ) {}

  private async login(): Promise<void> {
    const response = await this.transport.request(
      {},
      { method: 'POST', path: '/api/v1/authentication/login' },
    );
    if (response.httpStatus !== 200 && response.httpStatus !== 201) {
      throw new AirwallexDefinitiveRejectionError(
        response.httpStatus,
        providerErrorCode(response.body),
        `airwallex login failed (${response.httpStatus} ${providerErrorCode(response.body)}): ${providerErrorMessage(response.body)}`,
        response.body,
      );
    }
    const parsed = response.body as LoginResponse;
    if (typeof parsed?.token !== 'string' || parsed.token === '') {
      throw new AirwallexDefinitiveRejectionError(
        response.httpStatus,
        'malformed_login_response',
        'airwallex login response missing token',
        response.body,
      );
    }
    this.token = parsed.token;
    // expires_at is ISO8601 per docs; refresh 60s early, fall back to 25 min.
    const expiresRaw =
      typeof parsed.expires_at === 'string' ? Date.parse(parsed.expires_at) : Number.NaN;
    this.tokenExpiresAtMs = Number.isFinite(expiresRaw)
      ? expiresRaw - 60_000
      : this.clock.now().getTime() + 25 * 60_000;
  }

  private async authorizedRequest(request: TransportRequest): Promise<TransportResponse> {
    if (this.token === null || this.clock.now().getTime() >= this.tokenExpiresAtMs) {
      await this.login();
    }
    let response: TransportResponse;
    response = await this.transport.request({ authorization: `Bearer ${this.token}` }, request);
    if (response.httpStatus === 401) {
      // credentials_invalid / credentials_expired: refresh once, retry once.
      this.token = null;
      await this.login();
      const token = this.token;
      if (token === null) throw new TransportUnavailableError('airwallex token refresh failed');
      response = await this.transport.request({ authorization: `Bearer ${token}` }, request);
    }
    return response;
  }

  private static raiseIfDefinitiveHttpError(response: TransportResponse, context: string): void {
    // 400 with a provider code is a definitive request-level rejection.
    // 401 after a refresh retry, 403 forbidden: definitive configuration error.
    if (response.httpStatus === 400 || response.httpStatus === 401 || response.httpStatus === 403) {
      throw new AirwallexDefinitiveRejectionError(
        response.httpStatus,
        providerErrorCode(response.body),
        `airwallex ${context} rejected (${response.httpStatus} ${providerErrorCode(response.body)}): ${providerErrorMessage(response.body)}`,
        response.body,
      );
    }
    // 404 on transfer lookup is a definitive "no such transfer" (used by readback).
    if (response.httpStatus === 404) {
      throw new AirwallexDefinitiveRejectionError(
        404,
        providerErrorCode(response.body),
        `airwallex ${context}: not found (404 ${providerErrorCode(response.body)})`,
        response.body,
      );
    }
    // 429 / 5xx and anything else unexpected: NOT definitive — caller maps to
    // status-unknown and reconciliation resolves by request id.
  }

  async balancesCurrent(): Promise<AirwallexBalance[]> {
    const response = await this.authorizedRequest({
      method: 'GET',
      path: '/api/v1/balances/current',
      idempotentRead: true,
    });
    if (response.httpStatus !== 200) {
      AirwallexClient.raiseIfDefinitiveHttpError(response, 'balances/current');
      throw new TransportUnavailableError(
        `airwallex balances/current non-success ${response.httpStatus}; treating as ambiguous`,
      );
    }
    const body = response.body as { items?: unknown } | Array<unknown> | null;
    const items: unknown[] = Array.isArray(body)
      ? (body as unknown[])
      : Array.isArray((body as { items?: unknown } | null)?.items)
        ? (body as { items: unknown[] }).items
        : [body];
    return items
      .map((item) =>
        item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : null,
      )
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item.currency === 'string',
      )
      .map((item) => ({
        currency: String(item.currency).toUpperCase(),
        availableAmount: majorUnitsToMoney(String(item.currency), item.available_amount ?? 0),
        pendingAmount: majorUnitsToMoney(String(item.currency), item.pending_amount ?? 0),
        reservedAmount: majorUnitsToMoney(String(item.currency), item.reserved_amount ?? 0),
        totalAmount: majorUnitsToMoney(String(item.currency), item.total_amount ?? 0),
        accountType: typeof item.account_type === 'string' ? item.account_type : 'unknown',
      }));
  }

  /**
   * Creates a transfer. NEVER auto-retried: any non-2xx/definitive outcome is
   * returned/thrown as-is; ambiguous outcomes (429/5xx/timeout) surface as
   * TransportUnavailableError so the caller marks status-unknown and later
   * reconciles by the SAME request id (Airwallex dedupes request_id for 7
   * days; duplicates return code request_id_duplicate and are not processed).
   */
  async createTransfer(input: {
    requestId: string;
    beneficiaryId: string;
    currency: string;
    amountMinor: number;
    reason: string;
  }): Promise<AirwallexTransferRecord> {
    const body = {
      request_id: input.requestId,
      beneficiary_id: input.beneficiaryId,
      transfer_currency: input.currency,
      transfer_amount: transferAmountMinorToMajor(input.currency, input.amountMinor),
      reason: input.reason,
      reference: input.requestId,
    };
    const response = await this.authorizedRequest({
      method: 'POST',
      path: '/api/v1/transfers/create',
      body,
    });
    if (response.httpStatus !== 200 && response.httpStatus !== 201) {
      AirwallexClient.raiseIfDefinitiveHttpError(response, 'transfers/create');
      throw new TransportUnavailableError(
        `airwallex transfers/create non-success ${response.httpStatus}; the request may or may not have been accepted — treating as ambiguous`,
      );
    }
    return parseTransferRecord(response.body);
  }

  async getTransfer(transferId: string): Promise<AirwallexTransferRecord> {
    const response = await this.authorizedRequest({
      method: 'GET',
      path: `/api/v1/transfers/${encodeURIComponent(transferId)}`,
      idempotentRead: true,
    });
    if (response.httpStatus !== 200) {
      AirwallexClient.raiseIfDefinitiveHttpError(response, `transfers/${transferId}`);
      throw new TransportUnavailableError(
        `airwallex transfers/${transferId} non-success ${response.httpStatus}; treating as ambiguous`,
      );
    }
    return parseTransferRecord(response.body);
  }

  /**
   * READ-ONLY beneficiary list (connection proof A1): the first bounded page
   * of the account's beneficiaries. Pagination is intentionally single-page —
   * this is a connection/identity proof, not a synchronization job — and
   * `hasMore` is reported honestly so the caller knows the account holds
   * more than the page returned. Malformed bodies fail closed (definitive
   * rejection), matching the readback law that ambiguity is never invented.
   */
  async listBeneficiaries(
    input: {
      pageSize?: number;
      pageNumber?: number;
    } = {},
  ): Promise<AirwallexBeneficiaryPage> {
    const pageSize = input.pageSize ?? 10;
    const pageNumber = input.pageNumber ?? 1;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new AirwallexDefinitiveRejectionError(
        0,
        'invalid_page_size',
        `beneficiary page_size must be an integer in [1,100] (got ${String(pageSize)})`,
        null,
      );
    }
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      throw new AirwallexDefinitiveRejectionError(
        0,
        'invalid_page_number',
        `beneficiary page_num must be an integer >= 1 (got ${String(pageNumber)})`,
        null,
      );
    }
    const response = await this.authorizedRequest({
      method: 'GET',
      path: '/api/v1/beneficiaries',
      query: { page_size: String(pageSize), page_num: String(pageNumber) },
      idempotentRead: true,
    });
    if (response.httpStatus !== 200) {
      AirwallexClient.raiseIfDefinitiveHttpError(response, 'beneficiaries');
      throw new TransportUnavailableError(
        `airwallex beneficiaries non-success ${response.httpStatus}; treating as ambiguous`,
      );
    }
    if (
      response.body === null ||
      typeof response.body !== 'object' ||
      Array.isArray(response.body)
    ) {
      throw new AirwallexDefinitiveRejectionError(
        response.httpStatus,
        'malformed_beneficiaries_response',
        'airwallex beneficiaries response is not an object with items',
        response.body,
      );
    }
    const body = response.body as { items?: unknown; has_more?: unknown };
    if (!Array.isArray(body.items)) {
      throw new AirwallexDefinitiveRejectionError(
        response.httpStatus,
        'malformed_beneficiaries_response',
        'airwallex beneficiaries response missing items array',
        response.body,
      );
    }
    if (body.has_more !== undefined && typeof body.has_more !== 'boolean') {
      throw new AirwallexDefinitiveRejectionError(
        response.httpStatus,
        'malformed_beneficiaries_response',
        'airwallex beneficiaries response has a non-boolean has_more',
        response.body,
      );
    }
    return {
      items: body.items.map((item) => parseBeneficiaryRecord(item)),
      hasMore: body.has_more === true,
    };
  }

  /** READ-ONLY single beneficiary by id (connection proof A1). */
  async getBeneficiary(beneficiaryId: string): Promise<AirwallexBeneficiary> {
    if (typeof beneficiaryId !== 'string' || beneficiaryId.trim() === '') {
      throw new AirwallexDefinitiveRejectionError(
        0,
        'invalid_beneficiary_id',
        'beneficiary id must be a non-empty string',
        null,
      );
    }
    const response = await this.authorizedRequest({
      method: 'GET',
      path: `/api/v1/beneficiaries/${encodeURIComponent(beneficiaryId)}`,
      idempotentRead: true,
    });
    if (response.httpStatus !== 200) {
      AirwallexClient.raiseIfDefinitiveHttpError(response, `beneficiaries/${beneficiaryId}`);
      throw new TransportUnavailableError(
        `airwallex beneficiaries/${beneficiaryId} non-success ${response.httpStatus}; treating as ambiguous`,
      );
    }
    return parseBeneficiaryRecord(response.body);
  }

  /**
   * The documented recovery path for a lost create response: list transfers
   * filtered by OUR original request_id (R3 P1-6 + final-round P1: malformed
   * responses fail closed as AMBIGUOUS — a missing/invalid `items` array is
   * never treated as an authoritative empty result, because the caller reads
   * "empty" as definitive non-execution).
   *
   * PAGINATION is fail-closed: when the provider says `has_more`, the cursor
   * (`page_after`) is followed up to a hard bound; a missing/repeated cursor
   * or an over-long traversal throws TransportUnavailableError so the readback
   * stays INCOMPLETE. An empty result is only returned after a complete,
   * well-formed traversal — never from a truncated page.
   */
  async listTransfersByRequestId(requestId: string): Promise<AirwallexTransferRecord[]> {
    const MAX_LIST_PAGES = 10;
    const records: AirwallexTransferRecord[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; ; page += 1) {
      const response = await this.authorizedRequest({
        method: 'GET',
        path: '/api/v1/transfers',
        query:
          cursor === null
            ? { request_id: requestId }
            : { request_id: requestId, page_after: cursor },
        idempotentRead: true,
      });
      if (response.httpStatus !== 200) {
        AirwallexClient.raiseIfDefinitiveHttpError(response, 'transfers?request_id');
        throw new TransportUnavailableError(
          `airwallex transfers?request_id non-success ${response.httpStatus}; treating as ambiguous`,
        );
      }
      if (
        response.body === null ||
        typeof response.body !== 'object' ||
        Array.isArray(response.body)
      ) {
        throw new TransportUnavailableError(
          'airwallex transfers?request_id returned a malformed body (expected object with items); treating readback as incomplete, not empty',
        );
      }
      const body = response.body as { items?: unknown; has_more?: unknown; page_after?: unknown };
      const items = body.items;
      if (!Array.isArray(items)) {
        throw new TransportUnavailableError(
          'airwallex transfers?request_id response missing items array; treating readback as incomplete, not empty',
        );
      }
      if (body.has_more !== undefined && typeof body.has_more !== 'boolean') {
        throw new TransportUnavailableError(
          'airwallex transfers?request_id response has a non-boolean has_more; treating readback as incomplete, not empty',
        );
      }
      records.push(...items.map((item) => parseTransferRecord(item)));
      const hasMore = body.has_more === true;
      const next =
        typeof body.page_after === 'string' && body.page_after !== '' ? body.page_after : null;
      if (!hasMore) {
        if (next !== null) {
          // Contradictory pagination metadata: incomplete, never authoritative.
          throw new TransportUnavailableError(
            'airwallex transfers?request_id returned page_after while has_more is false; treating readback as incomplete, not empty',
          );
        }
        return records; // complete traversal — only now may "empty" mean empty
      }
      if (next === null) {
        throw new TransportUnavailableError(
          'airwallex transfers?request_id has_more=true without a page_after cursor; treating readback as incomplete, not empty',
        );
      }
      if (seenCursors.has(next)) {
        throw new TransportUnavailableError(
          `airwallex transfers?request_id repeated pagination cursor "${next.slice(0, 12)}…"; treating readback as incomplete, not empty`,
        );
      }
      seenCursors.add(next);
      if (page + 1 >= MAX_LIST_PAGES) {
        throw new TransportUnavailableError(
          `airwallex transfers?request_id pagination exceeded the ${String(MAX_LIST_PAGES)}-page bound; treating readback as incomplete, not empty`,
        );
      }
      cursor = next;
    }
  }
}

export function parseTransferRecord(raw: unknown): AirwallexTransferRecord {
  if (raw === null || typeof raw !== 'object') {
    throw new AirwallexDefinitiveRejectionError(
      0,
      'malformed_transfer',
      'provider transfer record is not an object',
      raw,
    );
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  if (id === '') {
    throw new AirwallexDefinitiveRejectionError(
      0,
      'malformed_transfer',
      'provider transfer record missing id',
      raw,
    );
  }
  const currency =
    typeof record.transfer_currency === 'string' ? record.transfer_currency.toUpperCase() : '';
  const amount =
    currency !== '' && typeof record.transfer_amount === 'number'
      ? majorUnitsToMoney(currency, record.transfer_amount)
      : null;
  const failure = (record.failure ?? null) as { code?: unknown; message?: unknown } | null;
  return {
    id,
    requestId: typeof record.request_id === 'string' ? record.request_id : null,
    status: typeof record.status === 'string' ? record.status : 'UNKNOWN',
    transferAmount: amount,
    beneficiaryId: typeof record.beneficiary_id === 'string' ? record.beneficiary_id : null,
    failureCode: failure !== null && typeof failure.code === 'string' ? failure.code : null,
    failureMessage:
      failure !== null && typeof failure.message === 'string' ? failure.message : null,
    createdAt: typeof record.created_at === 'string' ? record.created_at : null,
    updatedAt: typeof record.updated_at === 'string' ? record.updated_at : null,
    raw,
  };
}

/**
 * Beneficiary parse — identity fields ONLY (see AirwallexBeneficiary). The
 * provider's `beneficiary` sub-object (bank_details/card/digital_wallet) is
 * deliberately dropped here: it never reaches a receipt, a log line or a
 * caller. A missing id fails closed as a definitive malformed response.
 */
export function parseBeneficiaryRecord(raw: unknown): AirwallexBeneficiary {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AirwallexDefinitiveRejectionError(
      0,
      'malformed_beneficiary',
      'provider beneficiary record is not an object',
      raw,
    );
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' && record.id !== '' ? record.id : null;
  if (id === null) {
    throw new AirwallexDefinitiveRejectionError(
      0,
      'malformed_beneficiary',
      'provider beneficiary record missing id',
      raw,
    );
  }
  const transferMethods = Array.isArray(record.transfer_methods)
    ? record.transfer_methods.filter((m): m is string => typeof m === 'string' && m !== '')
    : [];
  return {
    id,
    nickname:
      typeof record.nickname === 'string' && record.nickname !== '' ? record.nickname : null,
    transferMethods,
  };
}
