/**
 * --prepare-only readiness proof (issue #5, founder P0 round): the governed
 * sandbox transfer can be FULLY PREPARED — mandate → plan (exact terms) →
 * separate-role approval → reservation → durable intent persisted — WITHOUT
 * any provider write, then EXECUTED later as the SAME intent.
 *
 * Proven against a real SQLite ledger through the offline fixture:
 *   P-1  prepare builds the chain and stops: operation RESERVED, ZERO outbox
 *        dispatches, ZERO provider receipts, fixture saw only login+balances;
 *   P-2  a later --confirm execution resumes the SAME operation (identical
 *        ids) and dispatches exactly ONE provider create;
 *   P-3  prepare-only refuses an already-attempted intent (beyond RESERVED);
 *   P-4  prepare-only without --confirm is explicitly allowed (confirm is
 *        the EXECUTION authorization only).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureTransport, created, ok } from '../src/index.js';
import { buildOfflineFixtureDispatcher } from '../src/dispatcher.js';
import { openLedger, TunableClock } from '@moterva/ledger';
import { runSmokeTransfer, type SmokeTransferResult } from '../src/smoke/transfer-runner.js';
import { loadAirwallexConfig } from '../src/config.js';

const CREDS = {
  AIRWALLEX_ENV: 'sandbox',
  AIRWALLEX_CLIENT_ID: 'cid',
  AIRWALLEX_API_KEY: 'key',
} as const;
const CONFIG = loadAirwallexConfig(CREDS);
const BEN = 'ben-prepare-1';

function fixtureScript() {
  return {
    login: [
      created({ token: 'prep', expires_at: '2026-11-13T23:00:00.000Z' }),
      created({ token: 'prep', expires_at: '2026-11-13T23:00:00.000Z' }),
      created({ token: 'prep', expires_at: '2026-11-13T23:00:00.000Z' }),
      created({ token: 'prep', expires_at: '2026-11-13T23:00:00.000Z' }),
    ],
    createTransfer: [
      created({
        id: 'trf-prepared-1',
        request_id: 'will-be-asserted-by-runner-ns',
        status: 'SUBMITTED',
        transfer_amount: 5,
        transfer_currency: 'USD',
        beneficiary_id: BEN,
      }),
    ],
    listTransfers: [
      ok({
        items: [],
        has_more: false,
      }),
    ],
    getTransfer: [],
    balances: [
      ok({
        items: [
          {
            currency: 'USD',
            available_amount: 1_000_000,
            pending_amount: 0,
            reserved_amount: 0,
            total_amount: 1_000_000,
            account_type: 'cash',
          },
        ],
      }),
      ok({
        items: [
          {
            currency: 'USD',
            available_amount: 1_000_000,
            pending_amount: 0,
            reserved_amount: 0,
            total_amount: 1_000_000,
            account_type: 'cash',
          },
        ],
      }),
      ok({
        items: [
          {
            currency: 'USD',
            available_amount: 1_000_000,
            pending_amount: 0,
            reserved_amount: 0,
            total_amount: 1_000_000,
            account_type: 'cash',
          },
        ],
      }),
    ],
  };
}

interface World {
  stateDir: string;
  fixture: FixtureTransport;
  ledgerPath: string;
  clock: TunableClock;
}

function makeWorld(): World {
  const stateDir = mkdtempSync(join(tmpdir(), 'awx-prepare-'));
  const clock = new TunableClock('2026-11-13T12:00:00.000Z');
  const fixture = new FixtureTransport(fixtureScript());
  return { stateDir, fixture, ledgerPath: join(stateDir, 'smoke.sqlite'), clock };
}

function run(input: {
  world: World;
  confirm?: boolean;
  prepareOnly?: boolean;
}): Promise<SmokeTransferResult> {
  const { world } = input;
  return runSmokeTransfer({
    config: CONFIG,
    transport: world.fixture,
    beneficiaryId: BEN,
    amountMinor: 500,
    confirm: input.confirm ?? false,
    prepareOnly: input.prepareOnly ?? false,
    newIntent: false,
    stateDir: world.stateDir,
    buildDispatcher: buildOfflineFixtureDispatcher,
    now: () => world.clock.now(),
    ledgerClock: world.clock,
  });
}

describe('--prepare-only: the governed transfer staged WITHOUT execution', () => {
  it('P-1: prepare builds mandate/plan/approval/reservation + durable intent and dispatches NOTHING', async () => {
    const world = makeWorld();
    try {
      const result = await run({ world, prepareOnly: true });
      if (result.outcome !== 'prepared') {
        throw new Error(`expected prepared, got ${result.outcome}: ${JSON.stringify(result)}`);
      }
      expect(result.operationState).toBe('RESERVED');
      expect(result.amountMinor).toBe(500);
      expect(result.currency).toBe('USD');
      expect(result.beneficiaryId).toBe(BEN);
      expect(result.verifiedUsdAvailableMinor).toBe(100_000_000);
      // Distinct authorization identities, all linked to one org/mission.
      expect(result.mandateId).toBeTruthy();
      expect(result.planId).toBeTruthy();
      expect(result.approvalId).toBeTruthy();

      // The durable ledger holds the RESERVED operation and its evidence.
      const ledger = openLedger(world.ledgerPath);
      try {
        const op = ledger.reservations.getOperation(result.orgId, result.operationId);
        expect(op.state).toBe('RESERVED');
        expect(op.amountMinor).toBe(500);
        expect(op.beneficiary).toBe(BEN);
        // The outbox row exists BY DESIGN at reserve (transactional outbox,
        // rail already stamped) but was NEVER claimed: attempts = 0, queued.
        const dispatchRow = ledger.db
          .prepare('SELECT attempts, status FROM outbox_dispatches')
          .get() as { attempts: number; status: string } | undefined;
        expect(dispatchRow).toBeDefined();
        expect(dispatchRow!.attempts).toBe(0);
        expect(dispatchRow!.status).toBe('pending');
        // ZERO provider receipts (no provider write, no readback).
        const receipts = ledger.db.prepare('SELECT COUNT(*) AS c FROM provider_receipts').get() as {
          c: number;
        };
        expect(receipts.c).toBe(0);
        // Two-person authorization proven below (approver ≠ plan proposer).
        const approvalRow = ledger.db
          .prepare('SELECT kind, decided_by FROM approvals WHERE id = ? AND org_id = ?')
          .get(result.approvalId, result.orgId) as { kind: string; decided_by: string } | undefined;
        expect(approvalRow).toBeDefined();
        expect(approvalRow!.kind).toBe('airwallex_transfer');
        // Two-person law: the approver is a DIFFERENT actor from the plan proposer (the admin).
        const planRow = ledger.db
          .prepare('SELECT proposed_by FROM candidate_plans WHERE id = ?')
          .get(result.planId) as { proposed_by: string } | undefined;
        expect(planRow).toBeDefined();
        expect(approvalRow!.decided_by).not.toBe(planRow!.proposed_by);
      } finally {
        ledger.close();
      }
      // The fixture saw ONLY the login + balance reads (read-level operation).
      const paths = world.fixture.performedRequests.map((r) => r.path);
      expect(paths.some((p) => p.endsWith('/authentication/login'))).toBe(true);
      expect(paths.some((p) => p.endsWith('/balances/current'))).toBe(true);
      expect(paths.some((p) => p.includes('/transfers'))).toBe(false);
    } finally {
      rmSync(world.stateDir, { recursive: true, force: true });
    }
  });

  it('P-2: a later --confirm execution resumes the SAME prepared intent and dispatches exactly once', async () => {
    const world = makeWorld();
    try {
      const prepared = await run({ world, prepareOnly: true });
      if (prepared.outcome !== 'prepared') throw new Error('P-1 regressed');
      const executed = await run({ world, confirm: true });
      // Whatever the outcome family, it is THIS intent — never a new identity.
      if (executed.outcome !== 'blocked' && executed.outcome !== 'prepared') {
        expect(executed.operationId).toBe(prepared.operationId);
        expect(executed.ledgerRequestId).toBe(prepared.ledgerRequestId);
      } else {
        throw new Error(`execution unexpectedly returned ${executed.outcome}`);
      }
      // Exactly ONE provider create ever.
      const creates = world.fixture.performedRequests.filter((r) =>
        r.path.endsWith('/transfers/create'),
      );
      expect(creates).toHaveLength(1);
    } finally {
      rmSync(world.stateDir, { recursive: true, force: true });
    }
  });

  it('P-3: prepare-only refuses an ALREADY-ATTEMPTED intent (state beyond RESERVED)', async () => {
    const world = makeWorld();
    try {
      await run({ world, prepareOnly: true });
      // Execute once (dispatch happens; fixture list lane serves no transfers
      // for the request id → dispatcher refuses definitively → REQUIRES_HUMAN
      // or unverified — either way the intent is now BEYOND RESERVED).
      await run({ world, confirm: true });
      const again = await run({ world, prepareOnly: true });
      expect(again.outcome).toBe('blocked');
      if (again.outcome === 'blocked') {
        expect(again.reason).toContain('already attempted');
      }
    } finally {
      rmSync(world.stateDir, { recursive: true, force: true });
    }
  });

  it('P-4: prepare-only does NOT require --confirm (confirm is the execution authorization)', async () => {
    const world = makeWorld();
    try {
      const result = await run({ world, prepareOnly: true, confirm: false });
      expect(result.outcome).toBe('prepared');
    } finally {
      rmSync(world.stateDir, { recursive: true, force: true });
    }
  });
});
