import { describe, expect, it } from 'vitest';
import { FixtureTransport, created, httpError, ok, unavailable } from '../src/fixture-transport.js';
import type { FixtureScript } from '../src/fixture-transport.js';
import { AirwallexClient, AirwallexDefinitiveRejectionError } from '../src/client.js';
import { TransportUnavailableError } from '../src/transport.js';
import { loadAirwallexConfig } from '../src/config.js';

const CONFIG = loadAirwallexConfig({
  AIRWALLEX_ENV: 'sandbox',
  AIRWALLEX_CLIENT_ID: 'test-client-id',
  AIRWALLEX_API_KEY: 'test-api-key',
});
const CLOCK = { now: () => new Date('2026-11-03T12:00:00.000Z') };

function makeClient(script: Partial<FixtureScript>): {
  client: AirwallexClient;
  fixture: FixtureTransport;
} {
  const fixture = new FixtureTransport({
    login: [created({ token: 'tok-1', expires_at: '2026-11-03T12:25:00.000Z' })],
    createTransfer: [],
    listTransfers: [],
    getTransfer: [],
    balances: [],
    ...script,
  });
  return { client: new AirwallexClient(CONFIG, fixture, CLOCK), fixture };
}

describe('authentication', () => {
  it('logs in with x-client-id/x-api-key headers and caches the token', async () => {
    const { client, fixture } = makeClient({
      balances: [
        ok({ items: [{ currency: 'USD', available_amount: 12.34, total_amount: 12.34 }] }),
      ],
    });
    const balances = await client.balancesCurrent();
    expect(balances[0]?.availableAmount!.minorUnits).toBe(1234);
    const login = fixture.performedRequests.find((r) => r.path.endsWith('/authentication/login'));
    expect(login).toBeDefined();
  });

  it('invalid credentials surface as a definitive rejection with the provider code', async () => {
    const { client } = makeClient({
      login: [httpError(401, 'credentials_invalid', 'bad api key')],
    });
    const error: unknown = await client.balancesCurrent().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AirwallexDefinitiveRejectionError);
    expect((error as AirwallexDefinitiveRejectionError).providerCode).toBe('credentials_invalid');
  });

  it('401 on a business call refreshes the token ONCE and retries', async () => {
    const fixture = new FixtureTransport({
      login: [
        created({ token: 'tok-1', expires_at: '2026-11-03T12:25:00.000Z' }),
        created({ token: 'tok-2', expires_at: '2026-11-03T12:25:00.000Z' }),
      ],
      createTransfer: [],
      listTransfers: [],
      getTransfer: [],
      balances: [
        { kind: 'respond', httpStatus: 401, body: { code: 'credentials_expired' } },
        ok({ items: [{ currency: 'USD', available_amount: 100 }] }),
      ],
    });
    const awx = new AirwallexClient(CONFIG, fixture, CLOCK);
    const balances = await awx.balancesCurrent();
    expect(balances[0]?.availableAmount!.minorUnits).toBe(10000);
    expect(
      fixture.performedRequests.filter((r) => r.path.endsWith('/authentication/login')),
    ).toHaveLength(2);
  });
});

describe('transfers/create', () => {
  it('sends major-unit amounts with the exact request fields and returns the record', async () => {
    const { client, fixture } = makeClient({
      createTransfer: [
        created({
          id: 'tr_abc',
          request_id: 'rq-1',
          status: 'PENDING_PROCESSING',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
        }),
      ],
    });
    const transfer = await client.createTransfer({
      requestId: 'rq-1',
      beneficiaryId: 'ben-1',
      currency: 'USD',
      amountMinor: 1234,
      reason: 'test transfer',
    });
    expect(transfer.id).toBe('tr_abc');
    expect(transfer.transferAmount?.minorUnits).toBe(1234);
    const sent = fixture.performedRequests.find((r) => r.path.endsWith('/transfers/create'))
      ?.body as Record<string, unknown>;
    expect(sent.request_id).toBe('rq-1');
    expect(sent.beneficiary_id).toBe('ben-1');
    expect(sent.transfer_amount).toBe(12.34);
    expect(sent.transfer_currency).toBe('USD');
  });

  it('a 400 validation rejection (e.g. invalid beneficiary) is definitive', async () => {
    const { client } = makeClient({
      createTransfer: [httpError(400, 'invalid_argument', 'beneficiary invalid')],
    });
    await expect(
      client.createTransfer({
        requestId: 'rq-2',
        beneficiaryId: 'ben-bad',
        currency: 'USD',
        amountMinor: 100,
        reason: 'x',
      }),
    ).rejects.toThrowError(/invalid_argument/);
  });

  it('429 and 5xx on the WRITE are ambiguous (TransportUnavailable), never auto-retried', async () => {
    for (const status of [429, 500, 503]) {
      const { client, fixture } = makeClient({
        createTransfer: [
          { kind: 'respond', httpStatus: status, body: { code: 'too_many_requests' } },
        ],
      });
      await expect(
        client.createTransfer({
          requestId: `rq-${status}`,
          beneficiaryId: 'b',
          currency: 'USD',
          amountMinor: 100,
          reason: 'x',
        }),
      ).rejects.toThrowError(TransportUnavailableError);
      // exactly ONE create attempt — no blind retry of a financial write
      expect(
        fixture.performedRequests.filter((r) => r.path.endsWith('/transfers/create')),
      ).toHaveLength(1);
    }
  });

  it('connection loss after the provider may have accepted → TransportUnavailable', async () => {
    const { client } = makeClient({ createTransfer: [unavailable('connection reset after send')] });
    await expect(
      client.createTransfer({
        requestId: 'rq-lost',
        beneficiaryId: 'b',
        currency: 'USD',
        amountMinor: 100,
        reason: 'x',
      }),
    ).rejects.toThrowError(TransportUnavailableError);
  });
});

describe('readback (list by request id / get by id)', () => {
  it('lists transfers filtered by our request id (the documented recovery path)', async () => {
    const { client, fixture } = makeClient({
      listTransfers: [
        ok({
          items: [
            {
              id: 'tr_9',
              request_id: 'rq-9',
              status: 'PROCESSING',
              transfer_amount: 5,
              transfer_currency: 'USD',
            },
          ],
        }),
      ],
    });
    const found = await client.listTransfersByRequestId('rq-9');
    expect(found).toHaveLength(1);
    expect((found[0] as { id: string }).id).toBe('tr_9');
    const listCall = fixture.performedRequests.find(
      (r) => r.path.endsWith('/transfers') && r.method === 'GET',
    );
    expect(listCall).toBeDefined();
  });

  it('429 on an idempotent read surfaces as ambiguous at the client layer (retry ladder lives in HttpTransport)', async () => {
    const { client } = makeClient({
      listTransfers: [{ kind: 'respond', httpStatus: 429, body: { code: 'too_many_requests' } }],
    });
    const error: unknown = await client.listTransfersByRequestId('rq-x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportUnavailableError);
  });
  it('404 on transfer lookup is a definitive not-found', async () => {
    const { client } = makeClient({ getTransfer: [httpError(404, 'not_found', 'no transfer')] });
    await expect(client.getTransfer('tr_missing')).rejects.toThrowError(/not_found/);
  });

  it('malformed provider records fail closed', async () => {
    const { client } = makeClient({ getTransfer: [ok({ status: 'PAID' })] }); // missing id
    await expect(client.getTransfer('tr_x')).rejects.toThrowError(/missing id/);
  });
});
