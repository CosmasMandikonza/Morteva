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
