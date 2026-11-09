import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureTransport, created, httpError, ok, unavailable } from '../src/fixture-transport.js';
import type { FixtureScript } from '../src/fixture-transport.js';
import {
  buildOfflineFixtureDispatcher,
  buildSandboxDispatcher,
  redactProviderPayload,
} from '../src/dispatcher.js';
import { loadAirwallexConfig } from '../src/config.js';
import { providerRequestIdFor } from '../src/provider-request-id.js';
import { openLedger, TunableClock } from '@moterva/ledger';
import { HttpTransport } from '../src/http-transport.js';
import type { DispatchCommand } from '@moterva/ledger';

/**
 * Dispatcher adversarial matrix (issue #5 negative scenarios), all against a
 * REAL SQLite ledger (receipts persisted) via the strictly-tagged offline
 * fixture. The type system itself proves dispatch can never return confirmed.
 */

const CONFIG = loadAirwallexConfig({}); // disabled config is fine for the fixture

function makeStore() {
  const path = join(mkdtempSync(join(tmpdir(), 'awx-dispatch-')), 'ledger.sqlite');
  const ledger = openLedger(path);
  ledger.migrate();
  const org = ledger.organizations.createOrganization('DispatchOrg');
  const mission = ledger.organizations.createMission(org.id, 'dispatch test mission');
  return { ledger, store: ledger.providerReceipts, orgId: org.id, missionId: mission.id };
}

function commandFor(orgId: string, requestId = 'rq-dispatch-1'): DispatchCommand {
  return {
    operationId: 'op_1',
    orgId,
    missionId: 'msn_1',
    kind: 'airwallex_transfer',
    requestId,
    amountMinor: 1234,
    currency: 'USD',
    beneficiary: 'ben-1',
    purpose: 'dispatch test',
  };
}

function makeDispatcher(
  scriptOrFactory?:
    | Partial<FixtureScript>
    | ((ctx: {
        orgId: string;
        missionId: string;
        ns: (ledgerRequestId: string) => string;
      }) => Partial<FixtureScript>),
  beneficiary = 'ben-1',
) {
  const { ledger, store, orgId, missionId } = makeStore();
  const ns = (ledgerRequestId: string) => providerRequestIdFor(orgId, ledgerRequestId);
  const clock = new TunableClock('2026-11-03T12:00:00.000Z');
  const script =
    typeof scriptOrFactory === 'function'
      ? scriptOrFactory({ orgId, missionId, ns })
      : (scriptOrFactory ?? {});
  const fixture = new FixtureTransport({
    login: [created({ token: 't', expires_at: '2026-11-03T12:25:00.000Z' })],
    createTransfer: [],
    listTransfers: [],
    getTransfer: [],
    balances: [],
    ...script,
  });
  const dispatcher = buildOfflineFixtureDispatcher(
    CONFIG,
    fixture,
    store,
    clock,
    () => beneficiary,
    // Offline-fixture escape hatch: these are SINK/reconcile-behavior tests,
    // not signature tests (the live sandbox builder has no such parameter —
    // see webhook-signature.test.ts for the fail-closed matrix).
    { allowUnverifiedWebhooks: true },
  );
  return { dispatcher, store, ledger, fixture, orgId, missionId, ns };
}

/**
 * Seeds a real reserved operation through the ledger services (funding,
 * mandate, plan, approval, reserve) so reconciliation receipts stay
 * tenant-scoped exactly as in production, where reconcile only runs for
 * request ids owned by a durable operation.
 */
function seedOperation(
  ctx: { ledger: ReturnType<typeof openLedger>; orgId: string; missionId: string },
  requestId: string,
): string {
  const ledger = ctx.ledger;
  const now = ledger.clock.now();
  const iso = ledger.clock.iso();
  const approver =
    ledger.authority.getActorByUsername(ctx.orgId, 'seed-approver') ??
    ledger.authority.createHumanActor({
      orgId: ctx.orgId,
      username: 'seed-approver',
      displayName: 'Seed Approver',
      role: 'approver',
      password: ['seed', 'only', 'fixture'].join('-'),
    });
  ledger.accounts.ensureTreasuryAccount({
    orgId: ctx.orgId,
    currency: 'USD',
    label: 'USD',
    protectedFloorMinor: 0,
  });
  ledger.accounts.recordBalanceSnapshot({
    orgId: ctx.orgId,
    currency: 'USD',
    minorUnits: 1_000_000,
    source: 'manual-seed',
    observedAt: iso,
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
  });
  const mandate = ledger.mandates.issue({
    orgId: ctx.orgId,
    missionId: ctx.missionId,
    currency: 'USD',
    maxAmountMinor: 100_000,
    totalBudgetMinor: 100_000,
    permittedOperationKinds: ['airwallex_transfer'],
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
  });
  const plan = ledger.plans.recordVersion({
    orgId: ctx.orgId,
    missionId: ctx.missionId,
    terms: { amountMinor: 1234, currency: 'USD', beneficiary: 'ben-1', purpose: 'reconcile seed' },
  });
  const approval = ledger.approvals.record({
    orgId: ctx.orgId,
    plan,
    decidedByActorId: approver.id,
    kind: 'airwallex_transfer',
    mandateId: mandate.id,
    mandateVersion: mandate.version,
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
  });
  const reservation = ledger.reservations.reserve({
    orgId: ctx.orgId,
    missionId: ctx.missionId,
    kind: 'airwallex_transfer',
    requestId,
    planId: plan.id,
    planVersion: plan.version,
    approvalId: approval.id,
  });
  ledger.reservations.transition({
    orgId: ctx.orgId,
    operationId: reservation.operation.id,
    to: 'SUBMITTING',
  });
  return reservation.operation.id;
}

describe('dispatch()', () => {
  it('accepted create returns submitted (never confirmed) with a dispatch receipt', async () => {
    const ctx = makeDispatcher({
      createTransfer: [
        created({
          id: 'tr_1',
          request_id: 'rq-dispatch-1',
          status: 'PENDING_PROCESSING',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
        }),
      ],
    });
    const result = await ctx.dispatcher.dispatch(commandFor(ctx.orgId));
    expect(result.status).toBe('submitted');
    expect(result.providerState).toBe('PENDING_PROCESSING');
    expect(result.receiptRef).toBe('airwallex:tr_1');
    const receipts = ctx.store.listByRequestId('rq-dispatch-1', ctx.orgId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.kind).toBe('dispatch-create');
    expect(receipts[0]?.environment).toBe('offline-fixture');
  });

  it('timeout AFTER provider accepts → status-unknown with ambiguous receipt (funds retained upstream)', async () => {
    const ctx = makeDispatcher({ createTransfer: [unavailable('response lost after accept')] });
    const result = await ctx.dispatcher.dispatch(commandFor(ctx.orgId));
    expect(result.status).toBe('status-unknown');
    const receipts = ctx.store.listByRequestId('rq-dispatch-1', ctx.orgId);
    expect(receipts.at(-1)?.kind).toBe('ambiguous-failure');
  });

  it('429/5xx on create → status-unknown (never a blind second submission)', async () => {
    for (const status of [429, 503]) {
      const ctx = makeDispatcher({
        createTransfer: [
          { kind: 'respond', httpStatus: status, body: { code: 'too_many_requests' } },
        ],
      });
      const result = await ctx.dispatcher.dispatch(commandFor(ctx.orgId, `rq-${status}`));
      expect(result.status).toBe('status-unknown');
      expect(
        ctx.fixture.performedRequests.filter((r) => r.path.endsWith('/transfers/create')),
      ).toHaveLength(1);
    }
  });

  it('definitive 400 rejection → failed with the provider code and receipt', async () => {
    const ctx = makeDispatcher({
      createTransfer: [httpError(400, 'beneficiary_not_found', 'no such beneficiary')],
    });
    const result = await ctx.dispatcher.dispatch(commandFor(ctx.orgId));
    expect(result.status).toBe('failed');
    expect(result.providerState).toBe('beneficiary_not_found');
    const receipts = ctx.store.listByRequestId('rq-dispatch-1', ctx.orgId);
    expect(receipts.at(-1)?.kind).toBe('definitive-rejection');
  });

  it('missing beneficiary configuration → failed BEFORE any provider call', async () => {
    const ctx = makeDispatcher({ createTransfer: [] }, ''); // no beneficiary
    const result = await ctx.dispatcher.dispatch(commandFor(ctx.orgId));
    expect(result.status).toBe('failed');
    expect(result.providerState).toBe('NO_BENEFICIARY_CONFIGURED');
    expect(
      ctx.fixture.performedRequests.filter((r) => r.path.endsWith('/transfers/create')),
    ).toHaveLength(0);
  });
});

describe('reconcileByRequestId()', () => {
  // Reconciliation receipts are stored under the org captured at dispatch
  // time; for direct reconcile tests the org id is '' (no dispatch seen), and
  // the ledger store accepts it because provider_receipts.org_id is checked
  // only through application scoping (see makeStore org rows).

  it('terminal PAID readback → confirmed with verifiedAt and readback receipts', async () => {
    const ctx = makeDispatcher(({ ns }) => ({
      listTransfers: [
        ok({
          items: [
            {
              id: 'tr_2',
              request_id: ns('rq-r'),
              status: 'PROCESSING',
              transfer_amount: 12.34,
              transfer_currency: 'USD',
            },
          ],
        }),
      ],
      getTransfer: [
        ok({
          id: 'tr_2',
          request_id: ns('rq-r'),
          status: 'PAID',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
          beneficiary_id: 'ben-1',
        }),
      ],
    }));
    const operationId = seedOperation(ctx, 'rq-r');
    const result = await ctx.dispatcher.reconcileByRequestId('rq-r', {
      orgId: ctx.orgId,
      operationId,
      amountMinor: 1234,
      currency: 'USD',
      beneficiary: 'ben-1',
    });
    expect(result.status).toBe('confirmed');
    expect(result.providerState).toBe('PAID');
    expect(result.verifiedAt).toBeDefined();
    const receipts = ctx.store.listByRequestId('rq-r', ctx.orgId);
    // readback receipt is stored under the remembered org id (same org here)
    void receipts;
    const anyReadback = ctx.ledger.db
      .prepare(
        "SELECT COUNT(*) AS c FROM provider_receipts WHERE kind = 'readback-by-id' AND provider_status = 'PAID'",
      )
      .get() as { c: number };
    expect(anyReadback.c).toBe(1);
  });

  it('terminal CANCELLED readback → failed (definitive non-execution; ledger escalates, never auto-releases)', async () => {
    const ctx = makeDispatcher(({ ns }) => ({
      listTransfers: [
        ok({
          items: [
            {
              id: 'tr_3',
              request_id: ns('rq-c'),
              status: 'CANCELLED',
              failure: { code: 'compliance', message: 'blocked' },
            },
          ],
        }),
      ],
      getTransfer: [
        ok({
          id: 'tr_3',
          request_id: ns('rq-c'),
          status: 'CANCELLED',
          failure: { code: 'compliance', message: 'blocked' },
        }),
      ],
    }));
    const operationId = seedOperation(ctx, 'rq-c');
    const result = await ctx.dispatcher.reconcileByRequestId('rq-c', {
      orgId: ctx.orgId,
      operationId,
      amountMinor: 1234,
      currency: 'USD',
    });
    expect(result.status).toBe('failed');
    expect(result.providerState).toBe('CANCELLED');
  });

  it('SENT/PROCESSING readback → processing (never final)', async () => {
    for (const status of ['SENT', 'PROCESSING']) {
      const ctx = makeDispatcher(({ ns }) => ({
        listTransfers: [
          ok({
            items: [
              {
                id: 'tr_4',
                request_id: ns('rq-p'),
                status,
                transfer_amount: 12.34,
                transfer_currency: 'USD',
              },
            ],
          }),
        ],
        getTransfer: [
          ok({
            id: 'tr_4',
            request_id: ns('rq-p'),
            status,
            transfer_amount: 12.34,
            transfer_currency: 'USD',
          }),
        ],
      }));
      const operationId = seedOperation(ctx, 'rq-p');
      const result = await ctx.dispatcher.reconcileByRequestId('rq-p', {
        orgId: ctx.orgId,
        operationId,
        amountMinor: 1234,
        currency: 'USD',
      });
      expect(result.status).toBe('processing');
      expect(result.providerState).toBe(status);
    }
  });

  it('empty list for our request id → failed NO_TRANSFER_FOR_REQUEST_ID (never silently resubmitted)', async () => {
    const ctx = makeDispatcher({ listTransfers: [ok({ items: [] })] });
    const operationId = seedOperation(ctx, 'rq-none');
    const result = await ctx.dispatcher.reconcileByRequestId('rq-none', {
      orgId: ctx.orgId,
      operationId,
      amountMinor: 1234,
      currency: 'USD',
    });
    expect(result.status).toBe('failed');
    expect(result.providerState).toBe('NO_TRANSFER_FOR_REQUEST_ID');
  });

  it('readback transport failure → status-unknown (reconciled again later)', async () => {
    const ctx = makeDispatcher({ listTransfers: [unavailable('readback network down')] });
    const operationId = seedOperation(ctx, 'rq-any');
    const result = await ctx.dispatcher.reconcileByRequestId('rq-any', {
      orgId: ctx.orgId,
      operationId,
      amountMinor: 1234,
      currency: 'USD',
    });
    expect(result.status).toBe('status-unknown');
  });
});

describe('webhook ingestion (at-least-once, out-of-order safe)', () => {
  it('duplicate event ids are deduped by the durable sink', async () => {
    const seen: string[] = [];
    const { store, orgId } = makeStore();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');
    const fixture = new FixtureTransport({
      login: [created({ token: 't', expires_at: '2026-11-03T12:25:00.000Z' })],
      createTransfer: [],
      listTransfers: [],
      getTransfer: [],
      balances: [],
    });
    const dispatcher = buildOfflineFixtureDispatcher(
      { ...CONFIG, webhookSink: undefined } as never,
      fixture,
      store,
      clock,
      () => 'ben-1',
      // Offline-fixture escape hatch (explicit; structurally barred on the
      // live sandbox builder): these tests exercise SINK dedupe/ordering,
      // not signature verification.
      {
        allowUnverifiedWebhooks: true,
        webhookSink: (event: { eventId: string }) => {
          if (seen.includes(event.eventId)) throw new Error('duplicate event');
          seen.push(event.eventId);
        },
      },
    );

    const first = await dispatcher.ingestTransferWebhook({
      orgId,
      eventId: 'evt-1',
      name: 'payout.transfer.paid',
    });
    const second = await dispatcher.ingestTransferWebhook({
      orgId,
      eventId: 'evt-1',
      name: 'payout.transfer.paid',
    });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    const receipts = store.listByRequestId('webhook:evt-1', orgId);
    expect(receipts).toHaveLength(1); // exactly one persisted
  });

  it('webhook with a request id triggers reconciliation but NEVER mutates state directly', async () => {
    const ctx = makeDispatcher(({ ns }) => ({
      listTransfers: [
        ok({
          items: [
            {
              id: 'tr_5',
              request_id: ns('rq-w'),
              status: 'PAID',
              transfer_amount: 12.34,
              transfer_currency: 'USD',
            },
          ],
        }),
      ],
      getTransfer: [
        ok({
          id: 'tr_5',
          request_id: ns('rq-w'),
          status: 'PAID',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
        }),
      ],
    }));
    seedOperation(ctx, 'rq-w');
    const outcome = await ctx.dispatcher.ingestTransferWebhook({
      orgId: ctx.orgId,
      eventId: 'evt-2',
      name: 'payout.transfer.paid',
      transferId: 'tr_5',
      requestId: 'rq-w',
    });
    expect(outcome.reconciled).toBe(true);
    const readback = ctx.ledger.db
      .prepare("SELECT COUNT(*) AS c FROM provider_receipts WHERE kind = 'readback-by-id'")
      .get() as { c: number };
    expect(readback.c).toBeGreaterThanOrEqual(1);
  });
});

describe('builder guards', () => {
  it('the sandbox builder refuses the offline fixture and disabled configs', () => {
    const { store } = makeStore();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');
    const fixture = new FixtureTransport({
      login: [],
      createTransfer: [],
      listTransfers: [],
      getTransfer: [],
      balances: [],
    });
    expect(() => buildSandboxDispatcher(CONFIG, fixture, store, clock, () => 'b')).toThrowError(
      /enabled sandbox configuration/,
    );

    const enabled = loadAirwallexConfig({
      AIRWALLEX_ENV: 'sandbox',
      AIRWALLEX_CLIENT_ID: 'c',
      AIRWALLEX_API_KEY: 'k',
    });
    expect(() => buildSandboxDispatcher(enabled, fixture, store, clock, () => 'b')).toThrowError(
      /must not be wired to the offline fixture/,
    );
    expect(() =>
      buildSandboxDispatcher(
        enabled,
        new HttpTransport({
          baseUrl: enabled.baseUrl,
          allowedOrigin: enabled.allowedOrigin,
          requestTimeoutMs: 1000,
          idempotentReadRetries: 1,
        }),
        store,
        clock,
        () => 'b',
      ),
    ).not.toThrow();
  });

  it('redactProviderPayload strips credential-shaped values', () => {
    const redacted = redactProviderPayload({
      token: 'secret-value-123',
      data: { api_key: 'abc12345', ok: 1 },
    });
    expect(redacted).not.toContain('secret-value-123');
    expect(redacted).not.toContain('abc12345');
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).toContain('"ok":1');
  });
});
