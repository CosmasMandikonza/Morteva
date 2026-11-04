/**
 * Server-only HTTP transport (Node fetch). Never imported by apps/web; the
 * package lives behind the API server. Handles:
 *  - per-request timeout via AbortController (ambiguous → TransportUnavailableError);
 *  - bounded exponential backoff for IDEMPOTENT READS on 429/5xx only
 *    (the builder guide: 20 rps global / 10 per endpoint in sandbox; 429 →
 *    backoff). Writes are NEVER retried here: an ambiguous write becomes
 *    status-unknown and reconciles by original request id.
 *
 * Credential exfiltration boundary (R3 review P0-1):
 *  - the resolved request URL's origin MUST equal `allowedOrigin` before any
 *    network call — the Authorization header can only ever be handed to the
 *    approved Airwallex origin;
 *  - redirects are set to 'error': a cross-origin (or any) redirect fails
 *    closed instead of silently re-sending credentials to another host.
 */
import type { AirwallexTransport, TransportRequest, TransportResponse } from './transport.js';
import { TransportUnavailableError } from './transport.js';

export interface HttpTransportOptions {
  readonly baseUrl: string;
  /** The only origin Authorization headers may be delivered to (from the adapter config). */
  readonly allowedOrigin: string;
  readonly requestTimeoutMs: number;
  readonly idempotentReadRetries: number;
  /** Injectable for tests (defaults to global fetch). */
  readonly fetchImpl?: typeof fetch;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpTransport implements AirwallexTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpTransportOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(
    authHeaders: Record<string, string>,
    request: TransportRequest,
  ): Promise<TransportResponse> {
    const url = new URL(this.options.baseUrl + request.path);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, value);
    }
    if (url.origin !== this.options.allowedOrigin) {
      // Never deliver credential-bearing headers to any other host.
      throw new TransportUnavailableError(
        `airwallex request ${request.method} ${request.path} resolves to ${url.origin}, which is not the approved origin ${this.options.allowedOrigin}; refusing to send credentials`,
      );
    }
    const attempts = request.idempotentRead === true ? this.options.idempotentReadRetries + 1 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
      try {
        const response = await this.fetchImpl(url.toString(), {
          method: request.method,
          headers: {
            ...authHeaders,
            ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
          signal: controller.signal,
          // Cross-origin redirect protection: fail closed rather than
          // following (and re-sending Authorization to the redirect target).
          redirect: 'error',
        });
        if (response.status >= 300 && response.status < 400 && response.type === 'opaqueredirect') {
          throw new Error(`redirect (${String(response.status)}) blocked`);
        }
        clearTimeout(timer);
        const text = await response.text();
        let body: unknown = null;
        if (text !== '') {
          try {
            body = JSON.parse(text);
          } catch {
            body = { raw: text.slice(0, 500) };
          }
        }
        const result: TransportResponse = { httpStatus: response.status, body };
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < attempts && request.idempotentRead === true) {
          await sleepMs(250 * 2 ** (attempt - 1));
          continue;
        }
        return result;
      } catch (error) {
        clearTimeout(timer);
        const message = error instanceof Error ? error.message : String(error);
        if (/redirect/i.test(message)) {
          // Redirects are never retried: ambiguous by policy, reported as such.
          throw new TransportUnavailableError(
            `airwallex request ${request.method} ${request.path} attempted a redirect; blocked to protect credentials`,
            error,
          );
        }
        lastError = error;
        if (request.idempotentRead === true && attempt < attempts) {
          await sleepMs(250 * 2 ** (attempt - 1));
          continue;
        }
        throw new TransportUnavailableError(
          `airwallex request ${request.method} ${request.path} failed: ${message}`,
          error,
        );
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new TransportUnavailableError(
          `airwallex request ${request.method} ${request.path} exhausted attempts`,
        );
  }
}
