import { describe, expect, it } from 'vitest';
import { HttpTransport } from '../src/http-transport.js';
import { TransportUnavailableError } from '../src/transport.js';

describe('HttpTransport retry ladder (verified sandbox rate-limit guidance)', () => {
  function fakeFetch(sequence: Array<{ status: number; body?: string }>) {
    let call = 0;
    const impl = (async () => {
      const step = sequence[Math.min(call, sequence.length - 1)] as {
        status: number;
        body?: string;
      };
      call += 1;
      return new Response(step.body ?? '{}', { status: step.status });
    }) as unknown as typeof fetch;
    return { impl, calls: () => call };
  }

  it('retries an idempotent GET on 429 with backoff, then succeeds', async () => {
    const fake = fakeFetch([
      { status: 429 },
      { status: 429 },
      { status: 200, body: '{"items":[]}' },
    ]);
    const transport = new HttpTransport({
      baseUrl: 'https://api.sandbox.airwallex.com',
      requestTimeoutMs: 2000,
      idempotentReadRetries: 3,
      fetchImpl: fake.impl,
    });
    const response = await transport.request(
      {},
      {
        method: 'GET',
        path: '/api/v1/transfers',
        idempotentRead: true,
      },
    );
    expect(response.httpStatus).toBe(200);
    expect(fake.calls()).toBe(3);
  });

  it('NEVER retries a write (single attempt even on 5xx)', async () => {
    const fake = fakeFetch([{ status: 500 }]);
    const transport = new HttpTransport({
      baseUrl: 'https://api.sandbox.airwallex.com',
      requestTimeoutMs: 2000,
      idempotentReadRetries: 3,
      fetchImpl: fake.impl,
    });
    const response = await transport.request(
      {},
      {
        method: 'POST',
        path: '/api/v1/transfers/create',
        body: {},
      },
    );
    expect(response.httpStatus).toBe(500);
    expect(fake.calls()).toBe(1);
  });

  it('surfaces connection loss as TransportUnavailableError', async () => {
    const impl = (async () => {
      throw new Error('connection reset');
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({
      baseUrl: 'https://api.sandbox.airwallex.com',
      requestTimeoutMs: 1000,
      idempotentReadRetries: 0,
      fetchImpl: impl,
    });
    await expect(
      transport.request({}, { method: 'POST', path: '/api/v1/transfers/create', body: {} }),
    ).rejects.toThrowError(TransportUnavailableError);
  });
});
