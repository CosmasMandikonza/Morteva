import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAirwallexConfig, SANDBOX_BASE_URL } from '../src/config.js';
import { HttpTransport } from '../src/http-transport.js';
import { TransportUnavailableError } from '../src/transport.js';
import { FixtureTransport, created, ok, unavailable } from '../src/fixture-transport.js';
import type { FixtureScript } from '../src/fixture-transport.js';
import { buildOfflineFixtureDispatcher, buildSandboxDispatcher } from '../src/dispatcher.js';
import { normalizeTransferStatus } from '../src/status.js';
import { providerRequestIdFor } from '../src/provider-request-id.js';
import { minimizeTransfer } from '../src/minimize.js';
import { openLedger, TunableClock } from '@moterva/ledger';
import type { Ledger } from '@moterva/ledger';
import type { DispatchCommand } from '@moterva/ledger';
import { AirwallexClient } from '../src/client.js';

/**
 * R3 CTO review correction matrix (PR #30). One focused adversarial test per
 * correction, all against REAL SQLite ledgers via the strictly-tagged offline
 * fixture (never presented as provider evidence).
 */

const CREDS = {
  AIRWALLEX_ENV: 'sandbox',
  AIRWALLEX_CLIENT_ID: 'cid',
  AIRWALLEX_API_KEY: 'key',
} as const;
const CONFIG = loadAirwallexConfig({});

// ------------------------------------------------------------------ P0-1

describe('P0-1 credential exfiltration boundary', () => {
  it('rejects ANY base-URL override other than the exact sandbox origin while credentials are enabled', () => {
    for (const evil of [
      'https://api.sandbox.airwallex.com.evil.example',
      'https://evil.example',
      'http://api.sandbox.airwallex.com',
      'https://localhost:9999',
      'https://api.airwallex.com',
    ]) {
      expect(() => loadAirwallexConfig({ ...CREDS, AIRWALLEX_BASE_URL: evil }), evil).toThrowError(
        /not allowed while sandbox credentials are configured/,
      );
    }
    // The exact sanctioned origin is accepted.
    expect(loadAirwallexConfig({ ...CREDS, AIRWALLEX_BASE_URL: SANDBOX_BASE_URL }).baseUrl).toBe(
      SANDBOX_BASE_URL,
    );
    // Disabled (no creds) may still point anywhere HTTPS for future tooling.
    expect(loadAirwallexConfig({ AIRWALLEX_BASE_URL: 'https://mirror.example' }).enabled).toBe(
      false,
    );
  });

  it('the transport refuses to deliver requests (and Authorization headers) to any non-approved origin', async () => {
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({
      baseUrl: 'https://api.sandbox.airwallex.com',
      allowedOrigin: 'https://api.sandbox.airwallex.com',
      requestTimeoutMs: 1000,
      idempotentReadRetries: 0,
      fetchImpl,
    });
    await expect(
      transport.request(
        { authorization: 'Bearer secret-token' },
        { method: 'GET', path: '/api/v1/transfers' },
      ),
    ).resolves.toBeDefined();
    expect(fetchCalled).toBe(true);

    fetchCalled = false;
    const misrouted = new HttpTransport({
      baseUrl: 'https://api.sandbox.airwallex.com',
      allowedOrigin: 'https://api.sandbox.airwallex.com',
      requestTimeoutMs: 1000,
      idempotentReadRetries: 0,
      // A transport whose baseUrl was somehow pointed elsewhere never sends.
      fetchImpl: (async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    void misrouted;
    const guard = new HttpTransport({
      baseUrl: 'https://evil.example',
      allowedOrigin: 'https://api.sandbox.airwallex.com',
      requestTimeoutMs: 1000,
      idempotentReadRetries: 0,
      fetchImpl,
    });
    await expect(
      guard.request(
        { authorization: 'Bearer x' },
        { method: 'GET', path: '/api/v1/balances/current' },
      ),
    ).rejects.toThrowError(/not the approved origin/);
    expect(fetchCalled).toBe(false);
  });

  it('redirects are blocked: credentials can never be re-sent to a redirect target', async () => {
    const fetchImpl = (async () => {
      // Simulate undici's redirect:'error' behavior (an error is thrown when
      // a redirect would be followed).
      throw new TypeError('fetch failed: unexpected redirect');
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({
      baseUrl: SANDBOX_BASE_URL,
      allowedOrigin: new URL(SANDBOX_BASE_URL).origin,
      requestTimeoutMs: 1000,
      idempotentReadRetries: 0,
      fetchImpl,
    });
    await expect(
      transport.request(
        { authorization: 'Bearer x' },
        { method: 'GET', path: '/api/v1/transfers' },
      ),
    ).rejects.toThrowError(TransportUnavailableError);
  });
});

// ------------------------------------------------------------------ P0-2

describe('P0-2 tenant-safe request identities', () => {
  it('namespaced provider request ids are org-unique: identical local ids in two orgs can NEVER collide', () => {
    const idA = providerRequestIdFor('org_aaa', 'pay-001');
    const idB = providerRequestIdFor('org_bbb', 'pay-001');
    expect(idA).not.toBe(idB);
    expect(idA).toMatch(/^mtv-[0-9a-f]{10}-pay-001$/);
    expect(idA).toBe(providerRequestIdFor('org_aaa', 'pay-001')); // deterministic for safe retry
    expect(idA.length).toBeGreaterThanOrEqual(10);
    expect(idA.length).toBeLessThanOrEqual(50);
  });

  it('rejects local ids that would break Airwallex request_id rules BEFORE any provider call', () => {
    expect(() => providerRequestIdFor('org_x', 'has spaces')).toThrowError(/characters Airwallex/);
    expect(() => providerRequestIdFor('org_x', '')).toThrowError(/non-empty/);
    expect(() => providerRequestIdFor('', 'pay-1')).toThrowError(/organization/);
    expect(() => providerRequestIdFor('org_x', 'x'.repeat(60))).toThrowError(/Shorten/);
  });

  it('two organizations with identical local request ids reconcile to THEIR OWN transfers (cross-tenant isolation)', async () => {
    // Real ledger with two orgs, both using local id 'pay-001'. The fixture
    // serves DIFFERENT transfer records under the two namespaced provider ids.
    const path = join(mkdtempSync(join(tmpdir(), 'r3-p02-')), 'ledger.sqlite');
    const ledger = openLedger(path);
    ledger.migrate();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');

    const orgA = ledger.organizations.createOrganization('Org A');
    const orgB = ledger.organizations.createOrganization('Org B');
    const missionA = ledger.organizations.createMission(orgA.id, 'a');
    const missionB = ledger.organizations.createMission(orgB.id, 'b');

    function seedReservation(
      org: { id: string },
      mission: { id: string },
      requestId: string,
    ): string {
      const now = ledger.clock.now();
      const approver =
        ledger.authority.getActorByUsername(org.id, 'r3-approver') ??
        ledger.authority.createHumanActor({
          orgId: org.id,
          username: 'r3-approver',
          displayName: 'A',
          role: 'approver',
          password: ['r3', 'only', 'fixture'].join('-'),
        });
      ledger.accounts.ensureTreasuryAccount({
        orgId: org.id,
        currency: 'USD',
        label: 'USD',
        protectedFloorMinor: 0,
      });
      ledger.accounts.recordBalanceSnapshot({
        orgId: org.id,
        currency: 'USD',
        minorUnits: 1_000_000,
        source: 'manual-seed',
        observedAt: ledger.clock.iso(),
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      });
      const mandate = ledger.mandates.issue({
        orgId: org.id,
        missionId: mission.id,
        currency: 'USD',
        maxAmountMinor: 100_000,
        totalBudgetMinor: 100_000,
        permittedOperationKinds: ['airwallex_transfer'],
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      });
      const plan = ledger.plans.recordVersion({
        orgId: org.id,
        missionId: mission.id,
        terms: { amountMinor: 1234, currency: 'USD', beneficiary: 'ben-1', purpose: 'r3' },
      });
      const approval = ledger.approvals.record({
        orgId: org.id,
        plan,
        decidedByActorId: approver.id,
        kind: 'airwallex_transfer',
        mandateId: mandate.id,
        mandateVersion: mandate.version,
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      });
      const reservation = ledger.reservations.reserve({
        orgId: org.id,
        missionId: mission.id,
        kind: 'airwallex_transfer',
        requestId,
        planId: plan.id,
        planVersion: plan.version,
        approvalId: approval.id,
      });
      ledger.reservations.transition({
        orgId: org.id,
        operationId: reservation.operation.id,
        to: 'SUBMITTING',
      });
      return reservation.operation.id;
    }

    const opA = seedReservation(orgA, missionA, 'pay-001');
    const opB = seedReservation(orgB, missionB, 'pay-001');
    void opB;

    const providerIdA = providerRequestIdFor(orgA.id, 'pay-001');
    const providerIdB = providerRequestIdFor(orgB.id, 'pay-001');
    expect(providerIdA).not.toBe(providerIdB);

    // Fixture lanes are request-agnostic; the dispatcher's list call carries
    // the namespaced id, and the returned records are validated against it.
    const fixture = new FixtureTransport({
      login: [created({ token: 'r3', expires_at: '2026-11-03T12:25:00.000Z' })],
      createTransfer: [],
      listTransfers: [
        // Org A readback: its own transfer, PAID, exact terms.
        ok({
          items: [
            {
              id: 'tr_org_a',
              request_id: providerIdA,
              status: 'PAID',
              transfer_amount: 12.34,
              transfer_currency: 'USD',
            },
          ],
        }),
        // Org B readback: a DIFFERENT transfer (its own namespaced id).
        ok({
          items: [
            {
              id: 'tr_org_b',
              request_id: providerIdB,
              status: 'PROCESSING',
              transfer_amount: 12.34,
              transfer_currency: 'USD',
            },
          ],
        }),
      ],
      getTransfer: [
        ok({
          id: 'tr_org_a',
          request_id: providerIdA,
          status: 'PAID',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
          beneficiary_id: 'ben-1',
        }),
        ok({
          id: 'tr_org_b',
          request_id: providerIdB,
          status: 'PROCESSING',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
        }),
      ],
      balances: [],
    });
    const dispatcher = buildOfflineFixtureDispatcher(
      CONFIG,
      fixture,
      ledger.providerReceipts,
      clock,
      () => 'ben-1',
    );

    // Scoped reconciliation for org A confirms ITS transfer; org B does not
    // read A's PAID as its own.
    const resultA = await dispatcher.reconcileByRequestId('pay-001', {
      orgId: orgA.id,
      operationId: opA,
      amountMinor: 1234,
      currency: 'USD',
      beneficiary: 'ben-1',
    });
    expect(resultA.status).toBe('confirmed');

    const resultB = await dispatcher.reconcileByRequestId('pay-001', {
      orgId: orgB.id,
      operationId: opB,
      amountMinor: 1234,
      currency: 'USD',
      beneficiary: 'ben-1',
    });
    expect(resultB.status).toBe('processing'); // org B's own transfer is still PROCESSING

    // Receipts stay tenant-scoped.
    const receiptsA = ledger.providerReceipts.listByRequestId('pay-001', orgA.id);
    expect(
      receiptsA.every((r) => r.providerResourceId === 'tr_org_a' || r.providerResourceId === null),
    ).toBe(true);
    const receiptsB = ledger.providerReceipts.listByRequestId('pay-001', orgB.id);
    expect(
      receiptsB.every((r) => r.providerResourceId === 'tr_org_b' || r.providerResourceId === null),
    ).toBe(true);

    // Restart survival: a fresh dispatcher with NO in-memory memory still
    // reconciles tenant-safely using the worker-provided scope.
    const reopened = openLedger(path);
    const fixture2 = new FixtureTransport({
      login: [created({ token: 'r3', expires_at: '2026-11-03T12:50:00.000Z' })],
      createTransfer: [],
      listTransfers: [
        ok({
          items: [
            {
              id: 'tr_org_a',
              request_id: providerIdA,
              status: 'PAID',
              transfer_amount: 12.34,
              transfer_currency: 'USD',
            },
          ],
        }),
      ],
      getTransfer: [
        ok({
          id: 'tr_org_a',
          request_id: providerIdA,
          status: 'PAID',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
          beneficiary_id: 'ben-1',
        }),
      ],
      balances: [],
    });
    const dispatcher2 = buildOfflineFixtureDispatcher(
      CONFIG,
      fixture2,
      reopened.providerReceipts,
      clock,
      () => 'ben-1',
    );
    const restarted = await dispatcher2.reconcileByRequestId('pay-001', {
      orgId: orgA.id,
      operationId: opA,
      amountMinor: 1234,
      currency: 'USD',
      beneficiary: 'ben-1',
    });
    expect(restarted.status).toBe('confirmed');
    reopened.close();
    ledger.close();
  });

  it('reconciliation without any tenant scope is status-unknown, never a guess', async () => {
    const { dispatcher, ledger } = makeR3World({});
    const result = await dispatcher.reconcileByRequestId('never-dispatched-anywhere');
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('NO_TENANT_SCOPE');
    ledger.close();
  });
});

// ------------------------------------------------------------------ P0-3

describe('P0-3 verified economic identity before settlement', () => {
  it('a FAILED get-by-id NEVER degrades to the listed record for confirmation (PAID listed ≠ confirmed)', async () => {
    const { dispatcher, ledger, orgId } = makeR3World(({ ns }) => ({
      listTransfers: [
        ok({
          items: [
            {
              id: 'tr_x',
              request_id: ns('pay-009'),
              status: 'PAID',
              transfer_amount: 12.34,
              transfer_currency: 'USD',
            },
          ],
        }),
      ],
      getTransfer: [unavailable('authoritative lookup failed')],
    }));
    const result = await dispatcher.reconcileByRequestId('pay-009', {
      orgId,
      operationId: 'op_9',
      amountMinor: 1234,
      currency: 'USD',
    });
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('READBACK_INCOMPLETE');
    ledger.close();
  });

  it('amount mismatch vs the authorized operation blocks confirmation', async () => {
    const { dispatcher, ledger, orgId } = makeR3World(({ ns }) => ({
      listTransfers: [
        ok({
          items: [
            {
              id: 'tr_am',
              request_id: ns('pay-010'),
              status: 'PAID',
              transfer_amount: 99.99,
              transfer_currency: 'USD',
            },
          ],
        }),
      ],
      getTransfer: [
        ok({
          id: 'tr_am',
          request_id: ns('pay-010'),
          status: 'PAID',
          transfer_amount: 99.99,
          transfer_currency: 'USD',
          beneficiary_id: 'ben-1',
        }),
      ],
    }));
    const result = await dispatcher.reconcileByRequestId('pay-010', {
      orgId,
      operationId: 'op_10',
      amountMinor: 1234, // authorized 12.34; provider record says 99.99
      currency: 'USD',
      beneficiary: 'ben-1',
    });
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('EVIDENCE_MISMATCH');
    ledger.close();
  });

  it('currency mismatch blocks confirmation', async () => {
    const { dispatcher, ledger, orgId } = makeR3World(({ ns }) => ({
      listTransfers: [
        ok({
          items: [
            {
              id: 'tr_cm',
              request_id: ns('pay-011'),
              status: 'PAID',
              transfer_amount: 12.34,
              transfer_currency: 'EUR',
            },
          ],
        }),
      ],
      getTransfer: [
        ok({
          id: 'tr_cm',
          request_id: ns('pay-011'),
          status: 'PAID',
          transfer_amount: 12.34,
          transfer_currency: 'EUR',
          beneficiary_id: 'ben-1',
        }),
      ],
    }));
    const result = await dispatcher.reconcileByRequestId('pay-011', {
      orgId,
      operationId: 'op_11',
      amountMinor: 1234,
      currency: 'USD',
      beneficiary: 'ben-1',
    });
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('EVIDENCE_MISMATCH');
    ledger.close();
  });

  it('beneficiary mismatch vs the org-configured beneficiary blocks confirmation', async () => {
    const { dispatcher, ledger, orgId } = makeR3World(({ ns }) => ({
      listTransfers: [
        ok({
          items: [
            {
              id: 'tr_bm',
              request_id: ns('pay-012'),
              status: 'PAID',
              transfer_amount: 12.34,
              transfer_currency: 'USD',
              beneficiary_id: 'ben-ATTACKER',
            },
          ],
        }),
      ],
      getTransfer: [
        ok({
          id: 'tr_bm',
          request_id: ns('pay-012'),
          status: 'PAID',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
          beneficiary_id: 'ben-ATTACKER',
        }),
      ],
    }));
    const result = await dispatcher.reconcileByRequestId('pay-012', {
      orgId,
      operationId: 'op_12',
      amountMinor: 1234,
      currency: 'USD',
      beneficiary: 'ben-1',
    });
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('EVIDENCE_MISMATCH');
    ledger.close();
  });

  it('duplicate matches under one request id never confirm — ambiguous for a human', async () => {
    const { dispatcher, ledger, orgId } = makeR3World(({ ns }) => ({
      listTransfers: [
        ok({
          items: [
            {
              id: 'tr_d1',
              request_id: ns('pay-013'),
              status: 'PAID',
              transfer_amount: 12.34,
              transfer_currency: 'USD',
            },
            {
              id: 'tr_d2',
              request_id: ns('pay-013'),
              status: 'PROCESSING',
              transfer_amount: 12.34,
              transfer_currency: 'USD',
            },
          ],
        }),
      ],
      getTransfer: [],
    }));
    const result = await dispatcher.reconcileByRequestId('pay-013', {
      orgId,
      operationId: 'op_13',
      amountMinor: 1234,
      currency: 'USD',
    });
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('DUPLICATE_MATCHES');
    ledger.close();
  });

  it('a foreign record under our namespaced id is rejected (REQUEST_ID_MISMATCH)', async () => {
    const { dispatcher, ledger, orgId } = makeR3World({
      listTransfers: [
        ok({
          items: [
            {
              id: 'tr_f',
              request_id: 'someone-elses-id',
              status: 'PAID',
              transfer_amount: 12.34,
              transfer_currency: 'USD',
            },
          ],
        }),
      ],
      getTransfer: [],
    });
    const result = await dispatcher.reconcileByRequestId('pay-014', {
      orgId,
      operationId: 'op_14',
      amountMinor: 1234,
      currency: 'USD',
    });
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('REQUEST_ID_MISMATCH');
    ledger.close();
  });

  it('well-formed, matching PAID readback still confirms (the correction does not over-block)', async () => {
    const { dispatcher, ledger, orgId } = makeR3World(({ ns }) => ({
      listTransfers: [
        ok({
          items: [
            {
              id: 'tr_ok',
              request_id: ns('pay-015'),
              status: 'PAID',
              transfer_amount: 12.34,
              transfer_currency: 'USD',
            },
          ],
        }),
      ],
      getTransfer: [
        ok({
          id: 'tr_ok',
          request_id: ns('pay-015'),
          status: 'PAID',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
          beneficiary_id: 'ben-1',
        }),
      ],
    }));
    const result = await dispatcher.reconcileByRequestId('pay-015', {
      orgId,
      operationId: 'op_15',
      amountMinor: 1234,
      currency: 'USD',
      beneficiary: 'ben-1',
    });
    expect(result.status).toBe('confirmed');
    expect(result.verifiedAt).toBeDefined();
    ledger.close();
  });
});

// ------------------------------------------------------------------ P0-4

describe('P0-4 PAID is not irreversible — late failure after settlement', () => {
  it('status mapping: COMPLETED is NOT a transfer status → unknown; PAID terminal at readback; FAILED terminal', () => {
    expect(normalizeTransferStatus('COMPLETED')).toBe('unknown');
    expect(normalizeTransferStatus('PAID')).toBe('terminal-success');
    expect(normalizeTransferStatus('FAILED')).toBe('terminal-failed');
    expect(normalizeTransferStatus('CANCELLED')).toBe('terminal-failed');
    expect(normalizeTransferStatus('SENT')).toBe('pending');
  });

  it('a SETTLED operation whose readback later says FAILED reverses to REQUIRES_HUMAN with auditable evidence and retained exposure', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'r3-p04-')), 'ledger.sqlite');
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');
    const ledger = openLedger(path, clock);
    ledger.migrate();
    const org = ledger.organizations.createOrganization('P04 Org');
    const mission = ledger.organizations.createMission(org.id, 'm');
    const admin = ledger.authority.createHumanActor({
      orgId: org.id,
      username: 'p04-admin',
      displayName: 'A',
      role: 'admin',
      password: ['p04', 'only', 'fixture'].join('-'),
    });
    const approver = ledger.authority.createHumanActor({
      orgId: org.id,
      username: 'p04-appr',
      displayName: 'B',
      role: 'approver',
      password: ['p04', 'only', 'fixture'].join('-'),
    });
    ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'USD',
      label: 'USD',
      protectedFloorMinor: 0,
    });
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 1_000_000,
      source: 'manual-seed',
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const mandate = ledger.mandates.issue({
      orgId: org.id,
      missionId: mission.id,
      currency: 'USD',
      maxAmountMinor: 100_000,
      totalBudgetMinor: 100_000,
      permittedOperationKinds: ['airwallex_transfer'],
      byActorId: admin.id,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const plan = ledger.plans.recordVersion({
      orgId: org.id,
      missionId: mission.id,
      proposedBy: admin.id,
      terms: { amountMinor: 1234, currency: 'USD', beneficiary: 'ben-1', purpose: 'p04' },
    });
    const approval = ledger.approvals.record({
      orgId: org.id,
      plan,
      decidedByActorId: approver.id,
      kind: 'airwallex_transfer',
      mandateId: mandate.id,
      mandateVersion: mandate.version,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const reservation = ledger.reservations.reserve({
      orgId: org.id,
      missionId: mission.id,
      kind: 'airwallex_transfer',
      requestId: 'p04-late-fail',
      planId: plan.id,
      planVersion: plan.version,
      approvalId: approval.id,
    });

    const providerId = providerRequestIdFor(org.id, 'p04-late-fail');
    // Pass 1: create accepted (PROCESSING).
    const fixture = new FixtureTransport({
      login: [created({ token: 'p04', expires_at: '2026-11-03T12:25:00.000Z' })],
      createTransfer: [
        created({
          id: 'tr_p04',
          request_id: providerId,
          status: 'PROCESSING',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
        }),
      ],
      listTransfers: [
        ok({
          items: [
            {
              id: 'tr_p04',
              request_id: providerId,
              status: 'PROCESSING',
              transfer_amount: 12.34,
              transfer_currency: 'USD',
              beneficiary_id: 'ben-1',
            },
          ],
        }),
      ],
      getTransfer: [
        ok({
          id: 'tr_p04',
          request_id: providerId,
          status: 'PAID',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
          beneficiary_id: 'ben-1',
        }),
      ],
      balances: [],
    });
    ledger.worker.register(
      buildOfflineFixtureDispatcher(CONFIG, fixture, ledger.providerReceipts, clock, () => 'ben-1'),
    );
    await ledger.worker.runOnce();
    clock.advance(90_000);
    const pass2 = await ledger.worker.runOnce();
    expect(pass2.reconciled).toBe(1);
    let op = ledger.reservations.getOperation(org.id, reservation.operation.id);
    expect(op.state).toBe('SETTLED');
    // Monitoring continues: the dispatch claim is NOT drained on settlement.
    expect(ledger.outbox.pendingCount()).toBe(1);
    // Evidence history so far includes the settlement.
    expect(ledger.evidence.list(org.id, {}).some((e) => e.type === 'operation.settled')).toBe(true);

    // Pass 3: the bank later rejects — readback now FAILED. The reversal
    // escalates without rewriting history: evidence keeps BOTH the settled
    // event and the reversal event.
    clock.advance(90_000);
    const failFixture = new FixtureTransport({
      login: [created({ token: 'p04', expires_at: '2026-11-03T13:00:00.000Z' })],
      createTransfer: [],
      listTransfers: [
        ok({
          items: [
            {
              id: 'tr_p04',
              request_id: providerId,
              status: 'FAILED',
              failure: { code: 'clearing_rejected' },
            },
          ],
        }),
      ],
      getTransfer: [
        ok({
          id: 'tr_p04',
          request_id: providerId,
          status: 'FAILED',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
          failure: { code: 'clearing_rejected', message: 'bank detail' },
        }),
      ],
      balances: [],
    });
    ledger.worker.register(
      buildOfflineFixtureDispatcher(
        CONFIG,
        failFixture,
        ledger.providerReceipts,
        clock,
        () => 'ben-1',
      ),
    );
    const pass3 = await ledger.worker.runOnce();
    expect(pass3.escalated).toBe(1);
    op = ledger.reservations.getOperation(org.id, reservation.operation.id);
    expect(op.state).toBe('REQUIRES_HUMAN');
    // Exposure accounting is unchanged (envelope stays consumed; a human decides the adjustment).
    const commitment = ledger.reservations.getCommitment(org.id, reservation.operation.id);
    expect(commitment.state).toBe('unknown');
    expect(ledger.mandates.consumedBudget(org.id, mandate.id)).toBe(1234);
    // Auditable reversal WITHOUT rewriting history: settlement AND reversal both recorded.
    const types = ledger.evidence.list(org.id, {}).map((e) => e.type);
    expect(types).toContain('operation.settled');
    expect(types).toContain('settlement.reversed');
    ledger.close();
  });
});

// ------------------------------------------------------------------ P1-6

describe('P1-6 malformed transfer-list responses fail closed', () => {
  it('a 200 body without an items array is AMBIGUOUS, never an empty success', async () => {
    const { client } = makeR3Client({ listTransfers: [ok({ unexpected: true })] });
    await expect(client.listTransfersByRequestId('rq')).rejects.toThrowError(
      /malformed body|missing items/,
    );
  });

  it('a non-object body is ambiguous', async () => {
    const { client } = makeR3Client({ listTransfers: [ok(null)] });
    await expect(client.listTransfersByRequestId('rq')).rejects.toThrowError(/malformed/);
  });

  it('a well-formed empty items array IS the authoritative empty result (distinguished from malformed)', async () => {
    const { client } = makeR3Client({ listTransfers: [ok({ items: [] })] });
    const found = await client.listTransfersByRequestId('rq');
    expect(found).toEqual([]);
  });
});

// ------------------------------------------------------------------ P1-7

describe('P1-7 receipt minimization (allowlist, not regex)', () => {
  it('keeps only reconciliation facts and drops everything else — nested secrets, PII, unknown fields', () => {
    const minimized = minimizeTransfer({
      id: 'tr_1',
      request_id: 'mtv-x-pay-1',
      status: 'PAID',
      transfer_currency: 'USD',
      transfer_amount: 12.34,
      beneficiary_id: 'ben-1',
      short_reference_id: 'S-1',
      created_at: '2026-11-03T00:00:00Z',
      updated_at: '2026-11-03T01:00:00Z',
      failure: { code: 'clearing_rejected', message: 'recipient bank said <PII name, phone>' },
      // Everything below must be dropped:
      beneficiary: {
        full_name: 'Jane Doe',
        email: 'jane@example.test',
        address: { street: '1 Main St', phone: '+15550001111', token: 'Bearer abc' },
        bank_details: { account_number: '123456789', api_key: 'nested-key-1' },
        nested: { deeply: { authorization: 'Bearer inner', arbitrary: [1, 2, { x: 'y' }] } },
      },
      metadata: { authorization: 'Bearer zzz', arbitrary: 'field' },
      client_data: { api_key: 'another-secret', anything: { nested: { token: 't' } } },
      payer: { email: 'payer@example.test' },
    });
    const json = JSON.stringify(minimized);
    expect(json).toContain('"status":"PAID"');
    expect(json).toContain('"transfer_amount":12.34');
    expect(json).toContain('"failure_code":"clearing_rejected"'); // code kept
    for (const forbidden of [
      'Jane Doe',
      'jane@example.test',
      '+15550001111',
      '123456789',
      'super-secret-key-value',
      'Bearer abc',
      'Bearer inner',
      'Bearer zzz',
      'another-secret',
      'recipient bank said',
      'full_name',
      'bank_details',
      'metadata',
      'client_data',
      'arbitrary',
    ]) {
      expect(json, forbidden).not.toContain(forbidden);
    }
    // Exact allowlisted shape:
    expect(Object.keys(minimized).sort()).toEqual(
      [
        'beneficiary_id',
        'created_at',
        'failure_code',
        'id',
        'request_id',
        'short_reference_id',
        'status',
        'transfer_amount',
        'transfer_currency',
        'updated_at',
      ].sort(),
    );
  });

  it('receipts persisted by the dispatcher contain NO raw provider payloads', async () => {
    const { dispatcher, ledger, orgId, fixture } = makeR3World({
      createTransfer: [
        created({
          id: 'tr_min',
          request_id: 'x',
          status: 'PROCESSING',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
          beneficiary: {
            full_name: 'Secret Person',
            email: 'x@y.test',
            bank_details: { account_number: '999' },
          },
        }),
      ],
    });
    await dispatcher.dispatch({
      operationId: 'op_min',
      orgId,
      missionId: 'msn',
      kind: 'airwallex_transfer',
      requestId: 'pay-min',
      amountMinor: 1234,
      currency: 'USD',
      beneficiary: 'ben-1',
      purpose: 'min',
    });
    const receipts = ledger.providerReceipts.listByRequestId('pay-min', orgId);
    expect(receipts.length).toBeGreaterThan(0);
    const payload = receipts[0]?.payloadJson ?? '{}';
    expect(payload).not.toContain('Secret Person');
    expect(payload).not.toContain('account_number');
    expect(payload).toContain('"id":"tr_min"');
    void fixture;
    ledger.close();
  });
});

// ---------------------------------------------------------------- helpers

function makeR3World(
  scriptOrFactory?:
    | Partial<FixtureScript>
    | ((ctx: { orgId: string; ns: (ledgerRequestId: string) => string }) => Partial<FixtureScript>),
): {
  dispatcher: ReturnType<typeof buildOfflineFixtureDispatcher>;
  ledger: Ledger;
  orgId: string;
  fixture: FixtureTransport;
  ns: (ledgerRequestId: string) => string;
} {
  const path = join(mkdtempSync(join(tmpdir(), 'r3-world-')), 'ledger.sqlite');
  const ledger = openLedger(path);
  ledger.migrate();
  const org = ledger.organizations.createOrganization('R3 Org');
  const ns = (ledgerRequestId: string) => providerRequestIdFor(org.id, ledgerRequestId);
  const clock = new TunableClock('2026-11-03T12:00:00.000Z');
  const script =
    typeof scriptOrFactory === 'function'
      ? scriptOrFactory({ orgId: org.id, ns })
      : (scriptOrFactory ?? {});
  const fixture = new FixtureTransport({
    login: [created({ token: 'r3', expires_at: '2026-11-03T12:25:00.000Z' })],
    createTransfer: [],
    listTransfers: [],
    getTransfer: [],
    balances: [],
    ...script,
  });
  const dispatcher = buildOfflineFixtureDispatcher(
    CONFIG,
    fixture,
    ledger.providerReceipts,
    clock,
    () => 'ben-1',
  );
  return { dispatcher, ledger, orgId: org.id, fixture, ns };
}

function makeR3Client(script: Partial<FixtureScript>): {
  client: AirwallexClient;
  fixture: FixtureTransport;
} {
  const fixture = new FixtureTransport({
    login: [created({ token: 'r3c', expires_at: '2026-11-03T12:25:00.000Z' })],
    createTransfer: [],
    listTransfers: [],
    getTransfer: [],
    balances: [],
    ...script,
  });
  const client = new AirwallexClient(loadAirwallexConfig(CREDS), fixture, {
    now: () => new Date('2026-11-03T12:00:00.000Z'),
  });
  return { client, fixture };
}

// P0-2 helper: sandbox dispatcher still refuses fixture transports (regression).
describe('builder guard regression (fixture can never be the live rail)', () => {
  it('buildSandboxDispatcher rejects a FixtureTransport even with full credentials', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'r3-guard-')), 'l.sqlite');
    const ledger = openLedger(path);
    ledger.migrate();
    const config = loadAirwallexConfig(CREDS);
    const fixture = new FixtureTransport({
      login: [],
      createTransfer: [],
      listTransfers: [],
      getTransfer: [],
      balances: [],
    });
    expect(() =>
      buildSandboxDispatcher(
        config,
        fixture,
        ledger.providerReceipts,
        new TunableClock('2026-11-03T12:00:00.000Z'),
        () => 'b',
      ),
    ).toThrowError(/offline fixture/);
    ledger.close();
  });
});

// P0-3 dispatch uses the namespaced provider id (verified in create payload).
describe('dispatch request identity', () => {
  it('the create call carries the namespaced provider request id, not the raw ledger id', async () => {
    const { dispatcher, ledger, orgId, fixture } = makeR3World({
      createTransfer: [
        created({
          id: 'tr_ns',
          request_id: 'x',
          status: 'PROCESSING',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
        }),
      ],
    });
    const command: DispatchCommand = {
      operationId: 'op_ns',
      orgId,
      missionId: 'msn',
      kind: 'airwallex_transfer',
      requestId: 'pay-ns-1',
      amountMinor: 1234,
      currency: 'USD',
      beneficiary: 'ben-1',
      purpose: 'ns',
    };
    await dispatcher.dispatch(command);
    const create = fixture.performedRequests.find((r) => r.path.endsWith('/transfers/create'));
    expect(create).toBeDefined();
    const body = create?.body as Record<string, unknown>;
    expect(body.request_id).toBe(providerRequestIdFor(orgId, 'pay-ns-1'));
    expect(body.request_id).not.toBe('pay-ns-1');
    ledger.close();
  });

  it('a local id with illegal characters fails BEFORE any provider call', async () => {
    const { dispatcher, ledger, orgId, fixture } = makeR3World({ createTransfer: [] });
    const result = await dispatcher.dispatch({
      operationId: 'op_bad',
      orgId,
      missionId: 'msn',
      kind: 'airwallex_transfer',
      requestId: 'bad id with spaces',
      amountMinor: 1234,
      currency: 'USD',
      beneficiary: 'ben-1',
      purpose: 'x',
    });
    expect(result.status).toBe('failed');
    expect(result.providerState).toBe('INVALID_REQUEST_ID');
    expect(
      fixture.performedRequests.filter((r) => r.path.endsWith('/transfers/create')),
    ).toHaveLength(0);
    ledger.close();
  });
});
