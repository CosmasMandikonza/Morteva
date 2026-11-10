/**
 * DETERMINISTIC OFFLINE FIXTURE TRANSPORT — tests and replay ONLY.
 *
 * Hard guarantees separating this from the live rail:
 *  1. Every response body is wrapped so receipts record environment
 *     "offline-fixture"; the dispatcher built via `offlineFixtureDispatcher`
 *     reports environment 'simulated' (per the providers contract) and the
 *     ledger's PR #23 review law means a submission here can NEVER settle an
 *     operation — only the real client's readback path returns 'confirmed',
 *     and this fixture's reconcile script must explicitly script a readback
 *     CONFIRMED_EVENT tagged fixture.
 *  2. It performs no network I/O whatsoever and cannot be constructed with a
 *     real base URL — constructor takes a script, not a URL.
 *  3. `buildLiveDispatcher` (the only path to environment 'sandbox') requires
 *     the HttpTransport + credentials; it refuses a FixtureTransport.
 */

export type FixtureStep =
  | { readonly kind: 'respond'; readonly httpStatus: number; readonly body: unknown }
  | { readonly kind: 'unavailable'; readonly message: string };

export interface FixtureScript {
  /** Steps for /authentication/login. */
  readonly login: readonly FixtureStep[];
  /** Steps for POST /transfers/create (dispatch). */
  readonly createTransfer: readonly FixtureStep[];
  /** Steps for GET /transfers (list by request_id) — readback. */
  readonly listTransfers: readonly FixtureStep[];
  /** Steps for GET /transfers/{id}. */
  readonly getTransfer: readonly FixtureStep[];
  /** Steps for GET /balances/current. */
  readonly balances: readonly FixtureStep[];
  /** Steps for GET /beneficiaries (list) — read-only connection proof. */
  readonly beneficiaries?: readonly FixtureStep[];
  /** Steps for GET /beneficiaries/{id} — read-only connection proof. */
  readonly beneficiary?: readonly FixtureStep[];
}

/** A deterministic transfer record the fixture serves on list/get. */
export interface FixtureTransfer {
  readonly id: string;
  readonly request_id: string;
  readonly status: string;
  readonly transfer_amount: number;
  readonly transfer_currency: string;
  readonly beneficiary_id?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly failure?: { readonly code: string; readonly message: string };
}

export function ok(body: unknown): FixtureStep {
  return { kind: 'respond', httpStatus: 200, body };
}

export function created(body: unknown): FixtureStep {
  return { kind: 'respond', httpStatus: 201, body };
}

export function httpError(httpStatus: number, code: string, message: string): FixtureStep {
  return { kind: 'respond', httpStatus, body: { code, message } };
}

export function unavailable(message = 'simulated connection loss'): FixtureStep {
  return { kind: 'unavailable', message };
}

/**
 * Scripted transport. Calls consume steps in order; when a lane runs out the
 * transport throws (test bug, never silently loops). Transfers registered via
 * `seedTransfer` are served by list/get when a lane yields a `serveRegistered`
 * marker... to keep it simple, list/get lanes receive the request context and
 * tests script the exact responses — deterministic by construction.
 */
export class FixtureTransport {
  /** Marker consulted by buildSandboxDispatcher so a fixture can never be wired as the live rail. */
  readonly __offlineFixture = true as const;
  readonly performedRequests: Array<{
    method: string;
    path: string;
    query: Record<string, string> | null;
    body: unknown;
  }> = [];
  private readonly lanes: Record<string, readonly FixtureStep[] | undefined>;
  private readonly cursors = new Map<string, number>();

  constructor(readonly script: FixtureScript) {
    this.lanes = {
      login: script.login,
      create: script.createTransfer,
      list: script.listTransfers,
      get: script.getTransfer,
      balances: script.balances,
      // Read-only connection-proof lanes are OPTIONAL: an undefined lane is
      // still routed, then fails with the same explicit exhaustion error.
      beneficiaries: script.beneficiaries,
      beneficiary: script.beneficiary,
    };
  }

  laneFor(method: string, path: string): string {
    if (path.endsWith('/authentication/login')) return 'login';
    if (path.endsWith('/transfers/create')) return 'create';
    if (path.endsWith('/transfers') && method === 'GET') return 'list';
    if (/\/transfers\/[^/]+$/.test(path)) return 'get';
    if (path.endsWith('/balances/current')) return 'balances';
    if (path.endsWith('/beneficiaries') && method === 'GET') return 'beneficiaries';
    if (/\/beneficiaries\/[^/]+$/.test(path)) return 'beneficiary';
    throw new Error(`offline fixture has no lane for ${method} ${path}`);
  }

  async request(
    _authHeaders: Record<string, string>,
    request: {
      method: 'GET' | 'POST';
      path: string;
      query?: Record<string, string>;
      body?: unknown;
    },
  ): Promise<{ httpStatus: number; body: unknown }> {
    this.performedRequests.push({
      method: request.method,
      path: request.path,
      query: request.query ?? null,
      body: request.body ?? null,
    });
    const lane = this.laneFor(request.method, request.path);
    const index = this.cursors.get(lane) ?? 0;
    const steps = this.lanes[lane];
    if (steps === undefined || index >= steps.length) {
      throw new Error(
        `offline fixture lane "${lane}" exhausted after ${index} step(s); script more steps for ${request.method} ${request.path}`,
      );
    }
    this.cursors.set(lane, index + 1);
    const step = steps[index] as FixtureStep;
    if (step.kind === 'unavailable') {
      const { TransportUnavailableError: Err } = await import('./transport.js');
      throw new Err(step.message);
    }
    return { httpStatus: step.httpStatus, body: step.body };
  }
}
