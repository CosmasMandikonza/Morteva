import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '@moterva/ledger';
import type { Ledger } from '@moterva/ledger';
import { TunableClock } from '@moterva/ledger';
import { FixtureTransport, created, ok, unavailable } from '../src/fixture-transport.js';
import type { FixtureScript } from '../src/fixture-transport.js';
import { buildOfflineFixtureDispatcher } from '../src/dispatcher.js';
import { providerRequestIdFor } from '../src/provider-request-id.js';
import { loadAirwallexConfig } from '../src/config.js';

/**
 * End-to-end ledger integration (issue #5 "executable end-to-end test path
 * with a strictly separated deterministic offline fixture"): the REAL ledger
 * worker + authority gates drive the adapter through the scripted fixture —
 * reserve → authority-gated dispatch → IN_FLIGHT → crash → restart →
 * reconcile by original request id → settle ONLY on terminal-success
 * readback with a provider-readback attestation.
 */

const CONFIG = loadAirwallexConfig({});

function world() {
  const path = join(mkdtempSync(join(tmpdir(), 'awx-e2e-')), 'ledger.sqlite');
  const clock = new TunableClock('2026-11-03T12:00:00.000Z');
  const ledger = openLedger(path, clock);
  ledger.migrate();
  const org = ledger.organizations.createOrganization('E2E Org');
  const mission = ledger.organizations.createMission(org.id, 'harbor inspection');
  const admin = ledger.authority.createHumanActor({
    orgId: org.id,
    username: 'e2e-admin',
    displayName: 'Admin',
    role: 'admin',
    password: ['e2e', 'only', 'fixture'].join('-'),
  });
  const approver = ledger.authority.createHumanActor({
    orgId: org.id,
    username: 'e2e-approver',
    displayName: 'Approver',
    role: 'approver',
    password: ['e2e', 'only', 'fixture'].join('-'),
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
  function reserve(requestId: string) {
    const plan = ledger.plans.recordVersion({
      orgId: org.id,
      missionId: mission.id,
      proposedBy: admin.id,
      terms: {
        amountMinor: 25_000,
        currency: 'USD',
        beneficiary: 'ben-e2e',
        purpose: 'diagnostic sweep',
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
    return ledger.reservations.reserve({
      orgId: org.id,
      missionId: mission.id,
      kind: 'airwallex_transfer',
      requestId,
      planId: plan.id,
      planVersion: plan.version,
      approvalId: approval.id,
    });
  }
  return { path, ledger, clock, org, mission, reserve };
}

function attach(
  ledger: Ledger,
  clock: TunableClock,
  script:
    Partial<FixtureScript> | ((ns: (ledgerRequestId: string) => string) => Partial<FixtureScript>),
  orgId?: string,
) {
  const ns =
    orgId !== undefined
      ? (ledgerRequestId: string) => providerRequestIdFor(orgId, ledgerRequestId)
      : (ledgerRequestId: string) => ledgerRequestId;
  const resolved = typeof script === 'function' ? script(ns) : script;
  const fixture = new FixtureTransport({
    login: [created({ token: 'e2e-tok', expires_at: '2026-11-03T12:25:00.000Z' })],
    createTransfer: [],
    listTransfers: [],
    getTransfer: [],
    balances: [],
    ...resolved,
  } as FixtureScript);
  const dispatcher = buildOfflineFixtureDispatcher(
    CONFIG,
    fixture,
    ledger.providerReceipts,
    clock,
    () => 'ben-e2e',
  );
  ledger.worker.register(dispatcher);
  return { fixture, dispatcher, ns };
}

describe('E2E: ledger worker × airwallex adapter (offline fixture)', () => {
  it('happy path: reserve → dispatch → IN_FLIGHT (not settled) → readback PAID → SETTLED with attestation', async () => {
    const w = world();
    const reserved = w.reserve('e2e-happy-1');
    attach(
      w.ledger,
      w.clock,
      (ns) => ({
        createTransfer: [
          created({
            id: 'tr_h1',
            request_id: ns('e2e-happy-1'),
            status: 'PROCESSING',
            transfer_amount: 250,
            transfer_currency: 'USD',
          }),
        ],
        listTransfers: [
          ok({
            items: [
              {
                id: 'tr_h1',
                request_id: ns('e2e-happy-1'),
                status: 'PROCESSING',
                beneficiary_id: 'ben-e2e',
              },
            ],
          }),
        ],
        getTransfer: [
          ok({
            id: 'tr_h1',
            request_id: ns('e2e-happy-1'),
            status: 'PAID',
            transfer_amount: 250,
            transfer_currency: 'USD',
            beneficiary_id: 'ben-e2e',
          }),
        ],
      }),
      w.org.id,
    );
    const pass1 = await w.ledger.worker.runOnce();
    expect(pass1.dispatched).toBe(1);
    const afterDispatch = w.ledger.reservations.getOperation(w.org.id, reserved.operation.id);
    expect(afterDispatch.state).toBe('IN_FLIGHT'); // submitted ≠ settled
    expect(w.ledger.reservations.getCommitment(w.org.id, reserved.operation.id).state).toBe(
      'reserved',
    );

    w.clock.advance(90_000); // claim TTL
    const pass2 = await w.ledger.worker.runOnce();
    expect(pass2.reconciled).toBe(1);
    const settled = w.ledger.reservations.getOperation(w.org.id, reserved.operation.id);
    expect(settled.state).toBe('SETTLED');
    const commitment = w.ledger.reservations.getCommitment(w.org.id, reserved.operation.id);
    expect(commitment.finalizedAt).not.toBeNull();
    // Receipt evidence chain: dispatch + readback persisted, tenant-scoped.
    const receipts = w.ledger.providerReceipts.listByRequestId('e2e-happy-1', w.org.id);
    expect(receipts.some((r) => r.kind === 'dispatch-create')).toBe(true);
    expect(receipts.some((r) => r.kind === 'readback-by-id' && r.providerStatus === 'PAID')).toBe(
      true,
    );
    w.ledger.close();
  }, 30_000);

  it('crash-after-SUBMITTING-before-reply: STATUS_UNKNOWN, exposure retained, restart reconciles (never resubmits)', async () => {
    const w = world();
    const reserved = w.reserve('e2e-crash-1');
    attach(
      w.ledger,
      w.clock,
      {
        createTransfer: [unavailable('process died after provider accepted')], // lost HTTP response
      },
      w.org.id,
    );
    const pass1 = await w.ledger.worker.runOnce();
    expect(pass1.markedUnknown).toBe(1);
    expect(w.ledger.reservations.getOperation(w.org.id, reserved.operation.id).state).toBe(
      'STATUS_UNKNOWN',
    );
    // funds still committed
    expect(w.ledger.spendable.compute(w.org.id, 'USD').outstandingCommittedMinor).toBe(25_000);
    w.ledger.close();

    // Restart: new process, SAME database; the stale claim replays via the
    // RECONCILE path only — the create is never re-sent.
    const reopened = openLedger(w.path, w.clock);
    const ns2 = (id: string) => providerRequestIdFor(w.org.id, id);
    const fixture2 = new FixtureTransport({
      balances: [],
      login: [created({ token: 'e2e-tok-2', expires_at: '2026-11-03T12:50:00.000Z' })],
      createTransfer: [], // EMPTY: any create attempt would exhaust the lane and fail the test
      listTransfers: [
        ok({
          items: [
            {
              id: 'tr_c1',
              request_id: ns2('e2e-crash-1'),
              status: 'PAID',
              transfer_amount: 250,
              transfer_currency: 'USD',
              beneficiary_id: 'ben-e2e',
            },
          ],
        }),
      ],
      getTransfer: [
        ok({
          id: 'tr_c1',
          request_id: ns2('e2e-crash-1'),
          status: 'PAID',
          transfer_amount: 250,
          transfer_currency: 'USD',
          beneficiary_id: 'ben-e2e',
        }),
      ],
    });
    reopened.worker.register(
      buildOfflineFixtureDispatcher(
        CONFIG,
        fixture2,
        reopened.providerReceipts,
        w.clock,
        () => 'ben-e2e',
      ),
    );
    w.clock.advance(90_000); // stale claim TTL
    const pass2 = await reopened.worker.runOnce();
    expect(pass2.reconciled).toBe(1);
    const settled = reopened.reservations.getOperation(w.org.id, reserved.operation.id);
    expect(settled.state).toBe('SETTLED');
    // exactly one economic intent ever existed
    const ops = reopened.db.prepare('SELECT COUNT(*) AS c FROM operations').get() as { c: number };
    expect(ops.c).toBe(1);
    reopened.close();
  }, 30_000);

  it('provider keeps processing forever → commitment retained, never settled, repeated readbacks scheduled', async () => {
    const w = world();
    const reserved = w.reserve('e2e-pending-1');
    attach(
      w.ledger,
      w.clock,
      (ns) => ({
        createTransfer: [
          created({
            id: 'tr_p1',
            request_id: ns('e2e-pending-1'),
            status: 'PROCESSING',
            transfer_amount: 250,
            transfer_currency: 'USD',
          }),
        ],
        listTransfers: [
          ok({ items: [{ id: 'tr_p1', request_id: ns('e2e-pending-1'), status: 'PROCESSING' }] }),
        ],
        getTransfer: [
          ok({
            id: 'tr_p1',
            request_id: ns('e2e-pending-1'),
            status: 'PROCESSING',
            transfer_amount: 250,
            transfer_currency: 'USD',
          }),
        ],
      }),
      w.org.id,
    );
    await w.ledger.worker.runOnce();
    w.clock.advance(90_000);
    const pass2 = await w.ledger.worker.runOnce();
    expect(pass2.reconciled).toBe(0); // processing readback: no settlement
    const op = w.ledger.reservations.getOperation(w.org.id, reserved.operation.id);
    expect(op.state).toBe('IN_FLIGHT');
    expect(w.ledger.reservations.getCommitment(w.org.id, reserved.operation.id).state).toBe(
      'reserved',
    );
    expect(w.ledger.outbox.pendingCount()).toBe(1); // still scheduled for the next readback
    w.ledger.close();
  }, 30_000);

  it('definitive rejection at dispatch → REQUIRES_HUMAN, exposure retained (no auto-release)', async () => {
    const w = world();
    const reserved = w.reserve('e2e-reject-1');
    attach(
      w.ledger,
      w.clock,
      {
        createTransfer: [
          {
            kind: 'respond',
            httpStatus: 400,
            body: { code: 'invalid_argument', message: 'beneficiary invalid' },
          },
        ],
      },
      w.org.id,
    );
    const pass = await w.ledger.worker.runOnce();
    expect(pass.escalated).toBe(1);
    const op = w.ledger.reservations.getOperation(w.org.id, reserved.operation.id);
    expect(op.state).toBe('REQUIRES_HUMAN');
    expect(w.ledger.reservations.getCommitment(w.org.id, reserved.operation.id).state).toBe(
      'unknown',
    ); // retains
    w.ledger.close();
  }, 30_000);
});
