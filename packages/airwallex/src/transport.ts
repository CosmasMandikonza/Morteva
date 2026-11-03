/**
 * HTTP transport abstraction.
 *
 * Production: `HttpTransport` (server-only fetch with timeout, one bounded
 * retry ladder for idempotent GETs). Tests: `FixtureTransport` — a fully
 * deterministic, SCRIPTED fake that is structurally barred from ever posing
 * as the live rail: every result it produces is tagged OFFLINE_FIXTURE, and
 * the dispatcher refuses to run against it in 'sandbox' mode.
 */

export interface TransportRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly query?: Record<string, string>;
  readonly body?: unknown;
  /** Idempotent reads may be retried on 429/5xx; writes never are. */
  readonly idempotentRead?: boolean;
}

export interface TransportResponse {
  readonly httpStatus: number;
  readonly body: unknown;
}

/** Thrown when the transport cannot deliver a response (timeout, DNS, reset). */
export class TransportUnavailableError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'TransportUnavailableError';
    this.cause = cause;
  }
}

export interface AirwallexTransport {
  request(
    authHeaders: Record<string, string>,
    request: TransportRequest,
  ): Promise<TransportResponse>;
}
