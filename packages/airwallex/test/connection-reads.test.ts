/**
 * A1 connection-proof tests (issue #5): the READ-ONLY beneficiary/transfer
 * client reads and the connection-proof orchestration, all against the
 * deterministic offline fixture (never the live rail). Verifies:
 *  - exact endpoints and query params sent,
 *  - identity-only beneficiary projection (bank details never surface),
 *  - fail-closed responses (400/401/403 definitive; 429/5xx ambiguous;
 *    malformed bodies definitive),
 *  - the durable sandbox balance-read receipt and its redacted payload,
 *  - the honest BLOCKED posture when credentials are absent.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AirwallexClient,
  AirwallexDefinitiveRejectionError,
  FixtureTransport,
  TransportUnavailableError,
  httpError,
  ok,
} from '../src/index.js';
import { SANDBOX_BASE_URL } from '../src/config.js';
import type { AirwallexAdapterConfig } from '../src/config.js';
import { runConnectionProof } from '../src/smoke/connection-proof.js';
import { classifyConnectionFailure, payoutReadiness } from '../src/smoke/connection-proof.js';

const CONFIG: AirwallexAdapterConfig = {
  enabled: true,
  environment: 'sandbox',
  baseUrl: SANDBOX_BASE_URL,
  allowedOrigin: 'https://api.sandbox.airwallex.com',
  clientId: 'client-id-test',
  apiKey: 'api-key-test',
  requestTimeoutMs: 5_000,
  idempotentReadRetries: 0,
};

// Far-future expiry: the client's clock is the REAL wall clock in these
// tests, so a short-lived fixture token would force a re-login per request.
const LOGIN_OK = [
  {
    kind: 'respond' as const,
    httpStatus: 201,
    body: { token: 't', expires_at: '2030-01-01T00:00:00.000Z' },
  },
];

const BENEFICIARY_PAGE_OK = {
  has_more: true,
  items: [
    {
      id: 'bene_1',
      nickname: 'harbor supplier',
      transfer_methods: ['LOCAL', 'SWIFT'],
      beneficiary: {
        bank_details: { account_number: 'SECRET-123', bank_name: 'First Harbor Bank' },
      },
    },
    { id: 'bene_2', nickname: '', transfer_methods: [] },
  ],
};

const BENEFICIARY_GET_OK = {
  id: 'bene_1',
  nickname: 'harbor supplier',
  transfer_methods: ['LOCAL'],
  beneficiary: { bank_details: { account_number: 'SECRET-123' } },
};

function baseScript(extra: Partial<ConstructorParameters<typeof FixtureTransport>[0]> = {}) {
  return {
    login: LOGIN_OK,
    createTransfer: [],
    listTransfers: [],
    getTransfer: [],
    balances: [
      ok({
        items: [
          {
            currency: 'USD',
            available_amount: 5000,
            pending_amount: 0,
            reserved_amount: 0,
            total_amount: 5000,
            account_type: 'GLOBAL_ACCOUNT',
          },
        ],
      }),
    ],
    ...extra,
  };
}

describe('A1 — read-only beneficiary reads (client)', () => {
  it('lists a bounded page with page_size/page_num and projects identity fields ONLY', async () => {
    const transport = new FixtureTransport(
      baseScript({ beneficiaries: [ok(BENEFICIARY_PAGE_OK)] }),
    );
    const client = new AirwallexClient(CONFIG, transport, { now: () => new Date() });
    const page = await client.listBeneficiaries();
    const req = transport.performedRequests.find((r) => r.path === '/api/v1/beneficiaries');
    expect(req).toBeDefined();
    expect(req!.method).toBe('GET');
    expect(req!.query).toEqual({ page_size: '10', page_num: '1' });
    expect(page.hasMore).toBe(true);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toEqual({
      id: 'bene_1',
      nickname: 'harbor supplier',
      transferMethods: ['LOCAL', 'SWIFT'],
    });
    expect(page.items[1]).toEqual({ id: 'bene_2', nickname: null, transferMethods: [] });
    // The projection stringifies clean — bank details must not exist anywhere.
    const json = JSON.stringify(page);
    expect(json).not.toContain('SECRET-123');
    expect(json).not.toContain('bank_details');
    expect(json).not.toContain('First Harbor Bank');
  });

  it('gets a single beneficiary by id with an encoded path and identity projection', async () => {
    const transport = new FixtureTransport(baseScript({ beneficiary: [ok(BENEFICIARY_GET_OK)] }));
    const client = new AirwallexClient(CONFIG, transport, { now: () => new Date() });
    const b = await client.getBeneficiary('bene/1?x');
    expect(
      transport.performedRequests.find((r) => r.path === '/api/v1/beneficiaries/bene%2F1%3Fx'),
    ).toBeDefined();
    expect(b).toEqual({ id: 'bene_1', nickname: 'harbor supplier', transferMethods: ['LOCAL'] });
    expect(JSON.stringify(b)).not.toContain('SECRET-123');
  });

  it('fails closed: definitive on 400/401/403 and malformed bodies; ambiguous on 429/5xx', async () => {
    const client = (steps: ConstructorParameters<typeof FixtureTransport>[0]['beneficiaries']) =>
      new AirwallexClient(CONFIG, new FixtureTransport(baseScript({ beneficiaries: steps })), {
        now: () => new Date(),
      });
    await expect(
      client([httpError(400, 'bad_request', 'no')])!.listBeneficiaries(),
    ).rejects.toThrow(AirwallexDefinitiveRejectionError);
    await expect(client([httpError(403, 'forbidden', 'no')])!.listBeneficiaries()).rejects.toThrow(
      AirwallexDefinitiveRejectionError,
    );
    await expect(
      client([httpError(429, 'rate_limited', 'slow')])!.listBeneficiaries(),
    ).rejects.toThrow(TransportUnavailableError);
    await expect(client([httpError(503, 'upstream', 'down')])!.listBeneficiaries()).rejects.toThrow(
      TransportUnavailableError,
    );
    await expect(client([ok({ nope: true })])!.listBeneficiaries()).rejects.toThrow(
      /missing items array/,
    );
    await expect(client([ok({ has_more: 'yes', items: [] })])!.listBeneficiaries()).rejects.toThrow(
      /non-boolean has_more/,
    );
    await expect(
      client([ok({ has_more: false, items: [{ nickname: 'no id' }] })])!.listBeneficiaries(),
    ).rejects.toThrow(/missing id/);
  });

  it('rejects out-of-range paging before any request', async () => {
    const transport = new FixtureTransport(
      baseScript({ beneficiaries: [ok(BENEFICIARY_PAGE_OK)] }),
    );
    const client = new AirwallexClient(CONFIG, transport, { now: () => new Date() });
    await expect(client.listBeneficiaries({ pageSize: 0 })).rejects.toThrow(/page_size/);
    await expect(client.listBeneficiaries({ pageSize: 101 })).rejects.toThrow(/page_size/);
    await expect(client.listBeneficiaries({ pageNumber: 0 })).rejects.toThrow(/page_num/);
    expect(transport.performedRequests.every((r) => r.path !== '/api/v1/beneficiaries')).toBe(true);
  });
});

describe('A1 — connection proof orchestration (offline fixture; still zero writes)', () => {
  it('runs the full read-only proof and persists exactly one durable sandbox balance-read receipt with a redacted payload', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'awx-conn-')), 'state');
    try {
      const result = await runConnectionProof({
        config: CONFIG,
        transport: new FixtureTransport(
          baseScript({
            beneficiaries: [ok(BENEFICIARY_PAGE_OK)],
            beneficiary: [ok(BENEFICIARY_GET_OK)],
            getTransfer: [
              ok({
                id: 'trf_1',
                request_id: 'req-conn-proof-01',
                status: 'COMPLETED',
                transfer_amount: 100.5,
                transfer_currency: 'USD',
                beneficiary_id: 'bene_1',
                created_at: '2026-11-10T00:00:00.000Z',
                updated_at: '2026-11-10T00:01:00.000Z',
              }),
            ],
          }),
        ),
        stateDir: dir,
        beneficiaryId: 'bene_1',
        transferId: 'trf_1',
      });
      expect(result.authenticated).toBe(true);
      expect(result.balances[0]!.currency).toBe('USD');
      expect(result.beneficiaryPage!.items).toHaveLength(2);
      expect(result.beneficiary!.id).toBe('bene_1');
      // The transfer read is the MINIMIZED projection (provider timestamps kept).
      expect(result.transfer).toMatchObject({
        id: 'trf_1',
        status: 'COMPLETED',
        request_id: 'req-conn-proof-01',
        created_at: '2026-11-10T00:00:00.000Z',
        updated_at: '2026-11-10T00:01:00.000Z',
      });
      expect(result.balanceReceiptRecorded).toBe(true);

      // Receipt is durable in a real sqlite ledger, environment=sandbox,
      // kind=balance-read, and the payload carries currency aggregates only.
      const { openLedger } = await import('@moterva/ledger');
      const ledger = openLedger(join(dir, 'ledger.sqlite'));
      try {
        const rows = ledger.db
          .prepare('SELECT kind, environment, provider, payload_json FROM provider_receipts')
          .all() as { kind: string; environment: string; provider: string; payload_json: string }[];
        expect(rows).toHaveLength(1);
        expect(rows[0]!.kind).toBe('balance-read');
        expect(rows[0]!.environment).toBe('sandbox');
        expect(rows[0]!.provider).toBe('airwallex');
        expect(rows[0]!.payload_json).toBe(result.persistedReceiptPayload);
        expect(rows[0]!.payload_json).toContain('"currency":"USD"');
        expect(rows[0]!.payload_json).not.toContain('SECRET');
        expect(rows[0]!.payload_json).not.toContain('bene_1');
      } finally {
        ledger.close();
      }
    } finally {
      rmSync(join(dir, '..'), { recursive: true, force: true });
    }
  });

  it('reuses the same evidence org across runs (state dir is durable, not a throwaway)', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'awx-conn-')), 'state');
    try {
      const run = () =>
        runConnectionProof({
          config: CONFIG,
          transport: new FixtureTransport(
            baseScript({
              login: LOGIN_OK,
              beneficiaries: [ok({ has_more: false, items: [] })],
            }),
          ),
          stateDir: dir,
        });
      await run();
      await run();
      const { openLedger } = await import('@moterva/ledger');
      const ledger = openLedger(join(dir, 'ledger.sqlite'));
      try {
        const orgs = ledger.db.prepare('SELECT COUNT(*) AS c FROM organizations').get() as {
          c: number;
        };
        expect(orgs.c).toBe(1);
        const receipts = ledger.db.prepare('SELECT COUNT(*) AS c FROM provider_receipts').get() as {
          c: number;
        };
        expect(receipts.c).toBe(2);
      } finally {
        ledger.close();
      }
    } finally {
      rmSync(join(dir, '..'), { recursive: true, force: true });
    }
  });
});

describe('A1 — empty-resource vs scope/IP-block vs failure classification', () => {
  it('classifies 403 as scope-or-ip with an actionable, honest diagnostic', async () => {
    const client = new AirwallexClient(
      CONFIG,
      new FixtureTransport(baseScript({ balances: [httpError(403, 'unauthorized', 'denied')] })),
      { now: () => new Date() },
    );
    try {
      await client.balancesCurrent();
      expect.unreachable('403 must throw');
    } catch (error) {
      const c = classifyConnectionFailure(error);
      expect(c.kind).toBe('scope-or-ip');
      expect(c.detail).toContain('scope');
      expect(c.detail).toContain('IP');
      // Honest: not an empty-resource claim, not a success claim.
      expect(c.detail).not.toMatch(/no beneficiaries|zero beneficiaries|empty account/i);
    }
  });

  it('classifies 404 as a wrong-id configuration error and 429 as ambiguous', () => {
    const nf = classifyConnectionFailure(
      new AirwallexDefinitiveRejectionError(404, 'not_found', 'x', null),
    );
    expect(nf.kind).toBe('not-found');
    expect(nf.detail).toContain('does not exist');
    const amb = classifyConnectionFailure(new TransportUnavailableError('connection lost'));
    expect(amb.kind).toBe('ambiguous');
    expect(amb.detail).toContain('AMBIGUOUS');
    const other = classifyConnectionFailure(new Error('boom'));
    expect(other.kind).toBe('other');
  });

  it('payout readiness: USD balance + transfer-method split; empty page is empty, not an error', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'awx-conn-')), 'state');
    try {
      const result = await runConnectionProof({
        config: CONFIG,
        transport: new FixtureTransport(
          baseScript({
            login: LOGIN_OK,
            beneficiaries: [
              ok({
                has_more: false,
                items: [
                  { id: 'bene_ok', nickname: 'ready', transfer_methods: ['LOCAL'] },
                  { id: 'bene_stuck', nickname: 'incomplete', transfer_methods: [] },
                ],
              }),
            ],
          }),
        ),
        stateDir: dir,
      });
      const readiness = payoutReadiness(result);
      expect(readiness.usdAvailableMinor).toBe(500000);
      expect(readiness.payoutReadyBeneficiaries).toEqual(['bene_ok']);
      expect(readiness.nonPayoutReadyBeneficiaries).toEqual(['bene_stuck']);

      const empty = await runConnectionProof({
        config: CONFIG,
        transport: new FixtureTransport(
          baseScript({ login: LOGIN_OK, beneficiaries: [ok({ has_more: false, items: [] })] }),
        ),
        stateDir: join(dir, 'b'),
      });
      const emptyReadiness = payoutReadiness(empty);
      expect(emptyReadiness.payoutReadyBeneficiaries).toEqual([]);
      expect(emptyReadiness.nonPayoutReadyBeneficiaries).toEqual([]);
      expect(emptyReadiness.usdAvailableMinor).toBe(500000); // a real read, not a guess
    } finally {
      rmSync(join(dir, '..'), { recursive: true, force: true });
    }
  });
});

describe('credential header boundary (live 2026-11-11 proof: header-less POST is edge-rejected)', () => {
  it('login carries x-client-id/x-api-key; every OTHER request carries the bearer token ONLY', async () => {
    const transport = new FixtureTransport(
      baseScript({
        beneficiaries: [ok(BENEFICIARY_PAGE_OK)],
        beneficiary: [ok(BENEFICIARY_GET_OK)],
      }),
    );
    const client = new AirwallexClient(CONFIG, transport, { now: () => new Date() });
    await client.balancesCurrent();
    await client.listBeneficiaries();
    await client.getBeneficiary('bene_1');

    const login = transport.performedRequests.find((r) => r.path.endsWith('/authentication/login'));
    expect(login).toBeDefined();
    expect(login!.headers['x-client-id']).toBe('client-id-test');
    expect(login!.headers['x-api-key']).toBe('api-key-test');
    expect(login!.headers['content-type']).toBe('application/json');
    // The login request carries NO bearer token; resource calls carry NO raw credentials.
    expect(login!.headers['authorization']).toBeUndefined();
    const resourceCalls = transport.performedRequests.filter(
      (r) => !r.path.endsWith('/authentication/login'),
    );
    expect(resourceCalls.length).toBeGreaterThan(0);
    for (const call of resourceCalls) {
      expect(call.headers['x-client-id']).toBeUndefined();
      expect(call.headers['x-api-key']).toBeUndefined();
      expect(call.headers['authorization']).toBe('Bearer t');
    }
  });

  it('login refuses to fire without configured credentials (fail-closed, no header-less POST)', async () => {
    const brokenConfig = { ...CONFIG, clientId: null, apiKey: null };
    const transport = new FixtureTransport(baseScript({ balances: [ok({ items: [] })] }));
    const client = new AirwallexClient(brokenConfig, transport, { now: () => new Date() });
    await expect(client.balancesCurrent()).rejects.toThrow(/without configured client id/);
    // No request of any kind left the client.
    expect(transport.performedRequests).toHaveLength(0);
  });
});

describe('balance honesty for unsupported currencies (live 2026-11-11: real account holds ARS et al.)', () => {
  it('reports unsupported-currency rows with raw provider amounts, never guesses or fails the read', async () => {
    const transport = new FixtureTransport(
      baseScript({
        login: LOGIN_OK,
        balances: [
          ok({
            items: [
              {
                currency: 'USD',
                available_amount: 5000,
                pending_amount: 0,
                reserved_amount: 0,
                total_amount: 5000,
                account_type: 'cash',
              },
              {
                currency: 'ARS',
                available_amount: 12345.67,
                pending_amount: 0,
                reserved_amount: 0,
                total_amount: 12345.67,
                account_type: 'cash',
              },
              {
                currency: 'BDT',
                available_amount: 999,
                pending_amount: 0,
                reserved_amount: 0,
                total_amount: 999,
                account_type: 'cash',
              },
            ],
          }),
        ],
        beneficiaries: [ok({ has_more: false, items: [] })],
      }),
    );
    const client = new AirwallexClient(CONFIG, transport, { now: () => new Date() });
    const balances = await client.balancesCurrent();
    expect(balances).toHaveLength(3);
    // USD converts into internal Money.
    expect(balances[0]!.availableAmount!.minorUnits).toBe(500000);
    // ARS/BDT are NOT in the internal money table: Money is null (NOT a zero),
    // the RAW provider amount is preserved, and the read does NOT fail.
    expect(balances[1]!.availableAmount).toBeNull();
    expect(balances[1]!.providerAvailableMajor).toBe(12345.67);
    expect(balances[2]!.availableAmount).toBeNull();
    expect(balances[2]!.providerAvailableMajor).toBe(999);
    // The JSON projection carries no fabricated minor-unit figure for them.
    const json = JSON.stringify(balances);
    expect(json).not.toContain('"ARS":');
  });

  it('the durable receipt lists unsupported currencies by name with raw amounts', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'awx-conn-')), 'state');
    try {
      const result = await runConnectionProof({
        config: CONFIG,
        transport: new FixtureTransport(
          baseScript({
            login: LOGIN_OK,
            balances: [
              ok({
                items: [
                  {
                    currency: 'USD',
                    available_amount: 10000000,
                    pending_amount: 0,
                    reserved_amount: 0,
                    total_amount: 10000000,
                    account_type: 'cash',
                  },
                  {
                    currency: 'ARS',
                    available_amount: 42.5,
                    pending_amount: 0,
                    reserved_amount: 0,
                    total_amount: 42.5,
                    account_type: 'cash',
                  },
                ],
              }),
            ],
            beneficiaries: [ok({ has_more: false, items: [] })],
          }),
        ),
        stateDir: dir,
      });
      const payload = JSON.parse(result.persistedReceiptPayload!) as {
        supported: { currency: string; available: number }[];
        unsupported: { currency: string; providerAvailableMajor: number }[];
      };
      expect(payload.supported).toEqual([
        { currency: 'USD', available: 1000000000, pending: 0, reserved: 0 },
      ]);
      expect(payload.unsupported).toEqual([{ currency: 'ARS', providerAvailableMajor: 42.5 }]);
      // Payout readiness: USD present, ARS never fabricated into the USD figure.
      expect(payoutReadiness(result).usdAvailableMinor).toBe(1000000000);
    } finally {
      rmSync(join(dir, '..'), { recursive: true, force: true });
    }
  });
});
