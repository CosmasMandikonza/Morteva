/**
 * JSON-RPC transport for the Metal Tahoe C-Chain (EVM), mirroring the
 * Airwallex transport separation: a production HTTP transport with a bounded
 * retry ladder for IDEMPOTENT READS ONLY, and a deterministic scripted
 * fixture transport for offline tests that is structurally barred from ever
 * posing as the live rail (`__offlineFixture` marker, refused by
 * buildTestnetDispatcher).
 *
 * Semantics that shape the dispatcher (issue #6):
 *  - `eth_sendRawTransaction` is a WRITE: never retried. An RPC error object
 *    in the response means the node REFUSED the transaction (no propagation)
 *    — that is definitive; a timeout/lost connection after the request was
 *    sent is ambiguous (the transaction may still have propagated).
 *  - Reads (`eth_*` queries) may be retried on transport failure; RPC error
 *    objects on reads are surfaced as-is (callers fail closed).
 */
export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcCall {
  readonly method: string;
  readonly params: readonly unknown[];
  /** Only read methods may be retried; writes are always single-attempt. */
  readonly idempotentRead?: boolean;
}

export class JsonRpcUnavailableError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'JsonRpcUnavailableError';
    this.cause = cause;
  }
}

/** The node answered with a JSON-RPC error (the call REACHED the chain). */
export class JsonRpcRejectionError extends Error {
  constructor(
    readonly method: string,
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'JsonRpcRejectionError';
  }
}

export interface JsonRpcTransport {
  call<T = unknown>(call: JsonRpcCall): Promise<T>;
}

let nextRequestId = 1;

export class HttpJsonRpcTransport implements JsonRpcTransport {
  constructor(
    private readonly options: {
      readonly rpcUrl: string;
      /** The ONLY origin signed transactions may ever be delivered to. */
      readonly allowedOrigin: string;
      readonly requestTimeoutMs: number;
      readonly idempotentReadRetries: number;
    },
  ) {}

  async call<T = unknown>(call: JsonRpcCall): Promise<T> {
    const maxAttempts = call.idempotentRead === true ? this.options.idempotentReadRetries + 1 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        // Bounded backoff for idempotent reads only (429-style friendliness).
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 2_000)),
        );
      }
      try {
        return await this.callOnce<T>(call);
      } catch (error) {
        if (error instanceof JsonRpcRejectionError) throw error; // reached the node — definitive
        lastError = error;
      }
    }
    throw lastError instanceof JsonRpcUnavailableError
      ? lastError
      : new JsonRpcUnavailableError(
          `json-rpc ${call.method} failed after ${String(maxAttempts)} attempt(s)`,
          lastError,
        );
  }

  private async callOnce<T>(call: JsonRpcCall): Promise<T> {
    // Exfiltration boundary (Airwallex P0-1 pattern): assert the destination
    // origin before every call, block cross-origin redirects.
    const origin = new URL(this.options.rpcUrl).origin;
    if (origin !== this.options.allowedOrigin) {
      throw new JsonRpcUnavailableError(
        `refusing to call ${origin}: not the approved RPC origin ${this.options.allowedOrigin}`,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    try {
      const response = await fetch(this.options.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: nextRequestId++,
          method: call.method,
          params: call.params,
        }),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        throw new JsonRpcUnavailableError(
          `json-rpc ${call.method} non-success http ${String(response.status)}`,
        );
      }
      const body = (await response.json()) as JsonRpcResponse;
      if (body === null || typeof body !== 'object') {
        throw new JsonRpcUnavailableError(`json-rpc ${call.method} returned a malformed body`);
      }
      if (body.error !== undefined && body.error !== null) {
        // The node RECEIVED and rejected the call — definitive, not unavailable.
        throw new JsonRpcRejectionError(
          call.method,
          body.error.code,
          `json-rpc ${call.method} error ${String(body.error.code)}: ${body.error.message}`,
        );
      }
      return body.result as T;
    } catch (error) {
      if (error instanceof JsonRpcRejectionError) throw error;
      if (error instanceof JsonRpcUnavailableError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new JsonRpcUnavailableError(
        `json-rpc ${call.method} transport failure: ${message}`,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * A single scripted JSON-RPC response for the offline fixture transport.
 * `ok` answers the call with `result`; `rpcError` answers with a JSON-RPC
 * error object (the node refused); `unavailable` simulates a lost connection
 * (no response at all — ambiguous for writes, retryable for reads).
 */
export type FixtureRpcStep =
  | { kind: 'ok'; result: unknown }
  | { kind: 'rpcError'; code: number; message: string }
  | { kind: 'unavailable'; message?: string };

export interface FixtureRpcScript {
  /** Scripted responses per method, consumed FIFO. */
  readonly lanes: Partial<Record<string, FixtureRpcStep[]>>;
  /**
   * Live fixture state the test can inspect and mutate between steps (e.g.
   * mine a receipt, empty the mempool, move the head block). Methods not
   * scripted are answered by this callback when provided.
   */
  readonly dynamic?: (method: string, params: readonly unknown[]) => unknown;
}

export class FixtureJsonRpcTransport implements JsonRpcTransport {
  /** Structural marker: `buildTestnetDispatcher` refuses fixture transports. */
  readonly __offlineFixture = true as const;
  readonly performedCalls: Array<{ method: string; params: readonly unknown[] }> = [];

  constructor(private readonly script: FixtureRpcScript) {}

  async call<T = unknown>(call: JsonRpcCall): Promise<T> {
    this.performedCalls.push({ method: call.method, params: call.params });
    const lane = this.script.lanes[call.method];
    const step = lane?.shift();
    if (step === undefined) {
      if (this.script.dynamic !== undefined) {
        return this.script.dynamic(call.method, call.params) as T;
      }
      throw new Error(
        `offline fixture lane "${call.method}" exhausted with no dynamic handler (test bug — never silently loop)`,
      );
    }
    if (step.kind === 'unavailable') {
      throw new JsonRpcUnavailableError(step.message ?? 'simulated connection loss');
    }
    if (step.kind === 'rpcError') {
      throw new JsonRpcRejectionError(call.method, step.code, step.message);
    }
    return step.result as T;
  }
}
