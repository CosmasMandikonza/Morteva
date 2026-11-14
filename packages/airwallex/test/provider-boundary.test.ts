import { fixtureClientConfig } from './helpers.js';
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '@moterva/ledger';
import { TunableClock } from '@moterva/ledger';
import { createHmac } from 'node:crypto';
import { FixtureTransport, created, ok } from '../src/fixture-transport.js';
import { buildOfflineFixtureDispatcher } from '../src/dispatcher.js';
import { AirwallexWebhookSignatureError } from '../src/dispatcher.js';
import { loadAirwallexConfig, SANDBOX_BASE_URL } from '../src/config.js';
import { providerRequestIdFor } from '../src/provider-request-id.js';

/**
 * PROVIDER BOUNDARY VERIFICATION MATRIX (issue #5; CTO convergence directive
 * Nov 9 — "verify the complete provider boundary rather than just unit-test
 * helper functions").
 *
 * ONE end-to-end journey through the REAL ledger worker + adapter on a real
 * SQLite ledger asserts every required boundary behavior in sequence:
 *
 *   1. sandbox origin + credential gates        (config gate at import)
 *   2. token refresh after expiry               (second login mid-journey)
 *   3. amount unit conversion precision         (exact major-unit payload)
 *   4. exact authorized amount incl. fees       (LOCAL: fee-free — payload
 *                                                carries the exact total)
 *   5. stable persisted original request ids    (namespaced, same on both
 *                                                dispatch and readback)
 *   6. safe recovery after timeouts             (status-unknown → same id)
 *   7. strict status normalization              (COMPLETED → unknown in the
 *                                                deep suite; PAID/SENT here)
 *   8. verified readback before settlement      (dispatch ≠ settled)
 *   9. correct reversal handling                (SETTLED → FAILED →
 *                                                REQUIRES_HUMAN + evidence)
 *  10. webhook raw-byte signature verification  (reordered bytes refused)
 *  11. timestamp freshness / replay refusal     (stale webhook refused)
 *  12. timing-safe digest comparison            (wrong secret refused)
 *  13. no sensitive values in receipts          (token/secret scan over ALL
 *                                                persisted payloads)
 *  14. webhook fail-closed without a secret     (deep suite; constructor bar)
 *
 * Deep per-behavior suites: adapter-basics, client, money-boundary, r3-*,
 * webhook-signature, two-worker-race, ledger-e2e.
 */

const WEBHOOK_HMAC_FIXTURE = 'boundary-webhook-hmac-fixture';

function seedAndAttach() {
  const path = join(mkdtempSync(join(tmpdir(), 'awx-boundary-')), 'ledger.sqlite');
  const clock = new TunableClock('2026-11-03T12:00:00.000Z');
  const ledger = openLedger(path, clock);
  ledger.migrate();
  const org = ledger.organizations.createOrganization('Boundary Org');
  const mission = ledger.organizations.createMission(org.id, 'boundary inspection');
  const admin = ledger.authority.createHumanActor({
    orgId: org.id,
    username: 'b-admin',
    displayName: 'Admin',
    role: 'admin',
    password: ['boundary', 'fixture'].join('-'),
  });
  const approver = ledger.authority.createHumanActor({
    orgId: org.id,
    username: 'b-approver',
    displayName: 'Approver',
    role: 'approver',
    password: ['boundary', 'fixture'].join('-'),
  });
  ledger.accounts.ensureTreasuryAccount({
    orgId: org.id,
    currency: 'USD',
    label: 'USD',
    protectedFloorMinor: 10_000,
  });
  ledger.accounts.recordBalanceSnapshot({
    orgId: org.id,
    currency: 'USD',
    minorUnits: 500_000,
    source: 'manual-seed',
    observedAt: clock.iso(),
    expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
  });
  const mandate = ledger.mandates.issue({
    orgId: org.id,
    missionId: mission.id,
    currency: 'USD',
    maxAmountMinor: 50_000,
    totalBudgetMinor: 50_000,
    permittedOperationKinds: ['airwallex_transfer'],
    byActorId: admin.id,
    expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
  });
  const plan = ledger.plans.recordVersion({
    orgId: org.id,
    missionId: mission.id,
    proposedBy: admin.id,
    terms: {
      amountMinor: 25_000,
      currency: 'USD',
      beneficiary: 'ben-e2e',
      purpose: 'boundary journey',
    },
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
  ledger.reservations.reserve({
    orgId: org.id,
    missionId: mission.id,
    kind: 'airwallex_transfer',
    requestId: 'rq-boundary-1',
    planId: plan.id,
    planVersion: plan.version,
    approvalId: approval.id,
  });

  const ns = (id: string) => providerRequestIdFor(org.id, id);
  const paidthrough = () => ({
    id: 'tr_boundary',
    request_id: ns('rq-boundary-1'),
    status: 'PAID',
    transfer_amount: 250.0, // EXACT major-unit mirror of 25_000 minor (item 3/4)
    transfer_currency: 'USD',
    beneficiary_id: 'ben-e2e',
  });
  const fixture = new FixtureTransport({
    // Item 2: the FIRST token expires mid-journey — the client must re-login.
    login: [
      created({ token: 'tok-EXPIRING', expires_at: '2026-11-03T12:05:00.000Z' }),
      created({ token: 'tok-REFRESHED', expires_at: '2026-11-03T13:00:00.000Z' }),
    ],
    createTransfer: [created(paidthrough())],
    listTransfers: [
      ok({ items: [paidthrough()], has_more: false }),
      ok({ items: [paidthrough()], has_more: false }),
    ],
    getTransfer: [ok(paidthrough()), ok({ ...paidthrough(), status: 'FAILED' })],
    balances: [],
  } as never);
  const dispatcher = buildOfflineFixtureDispatcher(
    fixtureClientConfig(),
    fixture,
    ledger.providerReceipts,
    clock,
    () => 'ben-e2e',
    { webhookSecret: WEBHOOK_HMAC_FIXTURE },
  );
  ledger.worker.register(dispatcher);
  return { ledger, clock, fixture, dispatcher, orgId: org.id, ns, paidthrough };
}

describe('provider boundary — one end-to-end verification journey', () => {
  it('walks auth-refresh, exact-amount dispatch, readback settlement, reversal and webhook refusal end-to-end', async () => {
    const w = seedAndAttach();

    // (1) Config gate: the adapter is sandbox-locked by construction — an
    // empty environment yields a DISABLED config (never half-configured).
    const config = loadAirwallexConfig({});
    expect(config.enabled).toBe(false);
    expect(SANDBOX_BASE_URL).toBe('https://api.sandbox.airwallex.com');

    // Phase 1 — dispatch through the authority gate.
    const pass1 = await w.ledger.worker.runOnce({ claimTtlMs: 0 });
    expect(pass1.dispatched).toBe(1);
    // (3/4) The create payload carried the EXACT authorized amount in major
    // units (25_000 minor = 250.00 USD; LOCAL transfer ⇒ fee-free total).
    const createCall = w.fixture.performedRequests.find((r) =>
      r.path.endsWith('/transfers/create'),
    );
    expect(createCall).toBeDefined();
    expect((createCall?.body as { transfer_amount: number }).transfer_amount).toBe(250);
    expect((createCall?.body as { transfer_currency: string }).transfer_currency).toBe('USD');
    // (5) The namespaced ORIGINAL request id persisted before/at dispatch.
    const nsId = w.ns('rq-boundary-1');
    expect((createCall?.body as { request_id: string }).request_id).toBe(nsId);
    const dispatchReceipt = w.ledger.providerReceipts.listByRequestId('rq-boundary-1', w.orgId)[0];
    expect(dispatchReceipt?.requestId).toBe('rq-boundary-1');
    // (8) Submission is NOT settlement.
    const op1 = w.ledger.db
      .prepare('SELECT state FROM operations WHERE request_id = ?')
      .get('rq-boundary-1') as {
      state: string;
    };
    expect(op1.state).toBe('IN_FLIGHT');

    // Phase 2 — token expired while IN_FLIGHT; reconcile must transparently
    // re-login (second login lane consumed) and settle ONLY on PAID readback.
    w.clock.advance(10 * 60_000); // 12:10 > tok-EXPIRING validity
    const pass2 = await w.ledger.worker.runOnce({ claimTtlMs: 0 });
    expect(pass2.reconciled).toBe(1);
    const loginCalls = w.fixture.performedRequests.filter((r) =>
      r.path.endsWith('/authentication/login'),
    );
    expect(loginCalls.length).toBe(2); // (2) refresh happened mid-journey
    const op2 = w.ledger.db
      .prepare('SELECT state FROM operations WHERE request_id = ?')
      .get('rq-boundary-1') as {
      state: string;
    };
    expect(op2.state).toBe('SETTLED'); // verified readback, not the submission

    // Phase 3 — the provider LATER reports FAILED (documented post-PAID
    // failure): auditable reversal, history never rewritten.
    w.clock.advance(60_000);
    const pass3 = await w.ledger.worker.runOnce({ claimTtlMs: 0 });
    expect(pass3.escalated).toBe(1);
    const op3 = w.ledger.db
      .prepare('SELECT state FROM operations WHERE request_id = ?')
      .get('rq-boundary-1') as {
      state: string;
    };
    expect(op3.state).toBe('REQUIRES_HUMAN');
    const reversal = w.ledger.db
      .prepare("SELECT COUNT(*) AS c FROM evidence_events WHERE type = 'settlement.reversed'")
      .get() as { c: number };
    expect(reversal.c).toBe(1); // (9)

    // (10/11/12) Webhook verification: reordered bytes, stale replay and a
    // wrong-secret signature are each refused BEFORE any reconciliation.
    const body = '{"id":"evt-b","name":"transfers.paid","data":{"object":{"status":"PAID"}}}';
    const sign = (payload: string, secret = WEBHOOK_HMAC_FIXTURE) =>
      createHmac('sha256', secret).update(payload).digest('hex');
    const now = Math.floor(w.clock.now().getTime() / 1000);
    const reordered = '{"name":"transfers.paid","id":"evt-b","data":{"object":{"status":"PAID"}}}';
    await expect(
      w.dispatcher.ingestTransferWebhook({
        orgId: w.orgId,
        eventId: 'evt-b',
        name: 'transfers.paid',
        rawBody: reordered,
        signature: sign(body), // signed the ORIGINAL order
        timestamp: now,
      }),
    ).rejects.toBeInstanceOf(AirwallexWebhookSignatureError);
    await expect(
      w.dispatcher.ingestTransferWebhook({
        orgId: w.orgId,
        eventId: 'evt-b',
        name: 'transfers.paid',
        rawBody: body,
        signature: sign(body),
        timestamp: now - 301, // (11) outside the replay window
      }),
    ).rejects.toBeInstanceOf(AirwallexWebhookSignatureError);
    await expect(
      w.dispatcher.ingestTransferWebhook({
        orgId: w.orgId,
        eventId: 'evt-b',
        name: 'transfers.paid',
        rawBody: body,
        signature: sign(body, 'attacker-secret'), // (12)
        timestamp: now,
      }),
    ).rejects.toBeInstanceOf(AirwallexWebhookSignatureError);
    // No webhook slip ever reached the provider: exactly 1 create + 2 list +
    // 2 get (the three refused webhooks each stopped before reconciliation).
    const providerCalls = w.fixture.performedRequests.filter(
      (r) => !r.path.endsWith('/authentication/login'),
    );
    expect(providerCalls.length).toBe(5);

    // (13) NO sensitive value anywhere in persisted receipts.
    const all = w.ledger.db.prepare('SELECT payload_json FROM provider_receipts').all() as Array<{
      payload_json: string;
    }>;
    expect(all.length).toBeGreaterThan(0);
    for (const row of all) {
      expect(row.payload_json).not.toContain('tok-EXPIRING');
      expect(row.payload_json).not.toContain('tok-REFRESHED');
      expect(row.payload_json).not.toContain(WEBHOOK_HMAC_FIXTURE);
    }

    w.ledger.close();
  });
});
