import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAirwallexConfig } from '../src/config.js';
import { FixtureTransport, created, ok, unavailable } from '../src/fixture-transport.js';
import type { FixtureScript } from '../src/fixture-transport.js';
import { buildOfflineFixtureDispatcher } from '../src/dispatcher.js';
import { AirwallexClient } from '../src/client.js';
import { providerRequestIdFor } from '../src/provider-request-id.js';
import { runSmokeTransfer } from '../src/smoke/transfer-runner.js';
import type { SmokeTransferResult } from '../src/smoke/transfer-runner.js';
import { openLedger, TunableClock } from '@moterva/ledger';
import type { Ledger } from '@moterva/ledger';

/**
 * Final R3 review (round 2) correction matrix for PR #30. Every test is a
 * targeted adversarial proof against REAL SQLite ledgers through the strictly
 * tagged offline fixture (never presented as provider evidence):
 *   FINAL-P0-1  smoke rerun/crash/concurrency: at most ONE create ever
 *   FINAL-P0-2  strict transfer identity (list AND get-by-id) validation
 *   FINAL-P0-3  incomplete/untrusted scope can never confirm
 *   FINAL-P1    fail-closed pagination of the recovery listing
 */

const CREDS = {
  AIRWALLEX_ENV: 'sandbox',
  AIRWALLEX_CLIENT_ID: 'cid',
  AIRWALLEX_API_KEY: 'key',
} as const;
const CONFIG = loadAirwallexConfig(CREDS);
const BEN = 'ben-1';

// ------------------------------------------------------------- shared worlds

function makeWorld(
  scriptOrFactory?:
    | Partial<FixtureScript>
    | ((ctx: { orgId: string; ns: (ledgerRequestId: string) => string }) => Partial<FixtureScript>),
) {
  const path = join(mkdtempSync(join(tmpdir(), 'r3f-world-')), 'ledger.sqlite');
  const ledger = openLedger(path);
  ledger.migrate();
  const org = ledger.organizations.createOrganization('R3F Org');
  const ns = (ledgerRequestId: string) => providerRequestIdFor(org.id, ledgerRequestId);
  const clock = new TunableClock('2026-11-03T12:00:00.000Z');
  const script =
    typeof scriptOrFactory === 'function'
      ? scriptOrFactory({ orgId: org.id, ns })
      : (scriptOrFactory ?? {});
  const fixture = new FixtureTransport({
    login: [created({ token: 'r3f', expires_at: '2026-11-03T23:00:00.000Z' })],
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
    () => BEN,
    // Offline-fixture escape hatch (explicit; barred on the live builder):
    // the webhook-observes-only test exercises sink/evidence behavior.
    { allowUnverifiedWebhooks: true },
  );
  return { dispatcher, ledger, orgId: org.id, fixture, ns, clock, path };
}

const FULL_SCOPE = (orgId: string, operationId: string) => ({
  orgId,
  operationId,
  amountMinor: 1234,
  currency: 'USD',
  beneficiary: BEN,
});

function paidthroughRecord(ns: (id: string) => string, requestId: string, transferId: string) {
  return {
    id: transferId,
    request_id: ns(requestId),
    status: 'PAID',
    transfer_amount: 12.34,
    transfer_currency: 'USD',
    beneficiary_id: BEN,
  };
}

// ------------------------------------------------- FINAL-P0-1: smoke workflow

function smokeDir(): string {
  return mkdtempSync(join(tmpdir(), 'r3f-smoke-'));
}

async function smoke(input: {
  stateDir: string;
  clock: TunableClock;
  script: Partial<FixtureScript>;
  newIntent?: boolean;
  amountMinor?: number;
  beneficiaryId?: string;
}): Promise<SmokeTransferResult> {
  // One fixture per invocation, exactly like one process per CLI run. The
  // createTransfer lane is EMPTY unless a test explicitly scripts a create —
  // any unexpected create attempt exhausts the lane and fails the test.
  const fixture = new FixtureTransport({
    login: [
      created({ token: 'smk1', expires_at: '2026-11-03T23:00:00.000Z' }),
      created({ token: 'smk2', expires_at: '2026-11-03T23:00:00.000Z' }),
    ],
    balances: [
      ok({ items: [{ currency: 'USD', available_amount: 10_000, account_type: 'SANDBOX' }] }),
    ],
    createTransfer: [],
    listTransfers: [],
    getTransfer: [],
    ...input.script,
  });
  return runSmokeTransfer({
    config: CONFIG,
    transport: fixture,
    beneficiaryId: input.beneficiaryId ?? 'ben-smoke',
    amountMinor: input.amountMinor ?? 500,
    confirm: true,
    prepareOnly: false,
    newIntent: input.newIntent ?? false,
    stateDir: input.stateDir,
    buildDispatcher: buildOfflineFixtureDispatcher,
    now: () => input.clock.now(),
    ledgerClock: input.clock,
  });
}

function readSmokeState(stateDir: string): {
  providerRequestId: string;
  orgId: string;
  operationId: string;
  ledgerRequestId: string;
} {
  return JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')) as {
    providerRequestId: string;
    orgId: string;
    operationId: string;
    ledgerRequestId: string;
  };
}

describe('FINAL-P0-1 smoke workflow: one durable economic intent per state dir', () => {
  it('a second invocation reconciles the SAME operation and never creates a second transfer', async () => {
    const stateDir = smokeDir();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');

    // Run 1: fresh intent. Create accepted; the readback stays ambiguous so
    // the intent is left IN_FLIGHT (the interesting rerun state).
    const run1 = await smoke({
      stateDir,
      clock,
      script: {
        createTransfer: [
          created({
            id: 'tr_smoke_1',
            status: 'PROCESSING',
            transfer_amount: 5,
            transfer_currency: 'USD',
            beneficiary_id: 'ben-smoke',
          }),
        ],
        listTransfers: [unavailable('readback transport dropped (run 1)')],
      },
    });
    expect(run1.outcome).toBe('unverified'); // accepted create, readback ambiguous
    if (run1.outcome === 'unverified') {
      expect(run1.workerReport?.dispatched).toBe(1);
      expect(run1.operationState).toBe('IN_FLIGHT'); // submitted is NOT settled
    }
    const state = readSmokeState(stateDir);
    expect(state.providerRequestId).toBe(providerRequestIdFor(state.orgId, state.ledgerRequestId));
    expect(state.ledgerRequestId.startsWith('awx-smoke-')).toBe(true);

    // Restart: NEW process (new fixture), create lane EMPTY by construction.
    clock.advance(120_000); // claim TTL — the stale claim must replay via reconcile
    const run2 = await smoke({
      stateDir,
      clock,
      script: {
        listTransfers: [
          ok({
            items: [
              {
                id: 'tr_smoke_1',
                request_id: state.providerRequestId,
                status: 'PROCESSING',
                transfer_amount: 5,
                transfer_currency: 'USD',
                beneficiary_id: 'ben-smoke',
              },
            ],
          }),
          ok({
            items: [
              {
                id: 'tr_smoke_1',
                request_id: state.providerRequestId,
                status: 'PROCESSING',
                transfer_amount: 5,
                transfer_currency: 'USD',
                beneficiary_id: 'ben-smoke',
              },
            ],
          }),
        ],
        getTransfer: [
          ok({
            id: 'tr_smoke_1',
            request_id: state.providerRequestId,
            status: 'PAID',
            transfer_amount: 5,
            transfer_currency: 'USD',
            beneficiary_id: 'ben-smoke',
          }),
          ok({
            id: 'tr_smoke_1',
            request_id: state.providerRequestId,
            status: 'PAID',
            transfer_amount: 5,
            transfer_currency: 'USD',
            beneficiary_id: 'ben-smoke',
          }),
        ],
      },
    });
    // Exactly one create EVER (run 1); run 2 reconciled the same operation.
    expect(run2.outcome).toBe('confirmed');
    if (run2.outcome === 'confirmed') {
      expect(run2.workerReport.dispatched).toBe(0); // never a second submission
      expect(run2.operationId).toBe(state.operationId);
      expect(run2.orgId).toBe(state.orgId);
      expect(run2.ledgerRequestId).toBe(state.ledgerRequestId);
      expect(run2.operationState).toBe('SETTLED');
    }
    // The durable ledger holds exactly ONE economic operation for this dir.
    const ledger = openLedger(join(stateDir, 'smoke.sqlite'));
    const ops = ledger.db.prepare('SELECT COUNT(*) AS c FROM operations').get() as { c: number };
    expect(ops.c).toBe(1);
    ledger.close();
  }, 30_000);

  it('crash-after-accept (connection lost after the provider took the create) restarts into reconcile-only', async () => {
    const stateDir = smokeDir();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');

    const run1 = await smoke({
      stateDir,
      clock,
      script: {
        createTransfer: [unavailable('process died after the provider accepted the create')],
        listTransfers: [unavailable('no readback either')],
      },
    });
    // The create response was LOST: the attempt is ambiguous — STATUS_UNKNOWN,
    // funds retained, no dispatch success claimed.
    expect(run1.outcome).toBe('unverified'); // create response LOST: STATUS_UNKNOWN, funds retained
    if (run1.outcome === 'unverified') {
      expect(run1.operationState).toBe('STATUS_UNKNOWN');
      expect(run1.workerReport?.markedUnknown).toBe(1);
    }
    const state = readSmokeState(stateDir);

    // Restart with the create lane EMPTY: any resubmission fails the test.
    clock.advance(120_000);
    const run2 = await smoke({
      stateDir,
      clock,
      script: {
        listTransfers: [
          ok({
            items: [
              {
                id: 'tr_smoke_1',
                request_id: state.providerRequestId,
                status: 'PAID',
                transfer_amount: 5,
                transfer_currency: 'USD',
                beneficiary_id: 'ben-smoke',
              },
            ],
          }),
          ok({
            items: [
              {
                id: 'tr_smoke_1',
                request_id: state.providerRequestId,
                status: 'PAID',
                transfer_amount: 5,
                transfer_currency: 'USD',
                beneficiary_id: 'ben-smoke',
              },
            ],
          }),
        ],
        getTransfer: [
          ok({
            id: 'tr_smoke_1',
            request_id: state.providerRequestId,
            status: 'PAID',
            transfer_amount: 5,
            transfer_currency: 'USD',
            beneficiary_id: 'ben-smoke',
          }),
          ok({
            id: 'tr_smoke_1',
            request_id: state.providerRequestId,
            status: 'PAID',
            transfer_amount: 5,
            transfer_currency: 'USD',
            beneficiary_id: 'ben-smoke',
          }),
        ],
      },
    });
    expect(run2.outcome).toBe('confirmed');
    if (run2.outcome === 'confirmed') {
      expect(run2.workerReport.dispatched).toBe(0);
      expect(run2.operationId).toBe(state.operationId);
      expect(run2.operationState).toBe('SETTLED'); // resolved from STATUS_UNKNOWN by readback
    }
    const ledger = openLedger(join(stateDir, 'smoke.sqlite'));
    const ops = ledger.db.prepare('SELECT COUNT(*) AS c FROM operations').get() as { c: number };
    expect(ops.c).toBe(1); // exactly one economic intent ever existed
    ledger.close();
  }, 30_000);

  it('deleting the state file does NOT authorize a new payment (the durable ledger blocks it)', async () => {
    const stateDir = smokeDir();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');
    const run1 = await smoke({
      stateDir,
      clock,
      script: {
        createTransfer: [
          created({
            id: 'tr_smoke_1',
            status: 'PROCESSING',
            transfer_amount: 5,
            transfer_currency: 'USD',
            beneficiary_id: 'ben-smoke',
          }),
        ],
        listTransfers: [unavailable('ambiguous')],
      },
    });
    expect(run1.outcome).toBe('unverified'); // IN_FLIGHT: money possibly in motion

    rmSync(join(stateDir, 'state.json')); // the "reset" a careless operator would try
    expect(existsSync(join(stateDir, 'state.json'))).toBe(false);

    const run2 = await smoke({ stateDir, clock, script: {} }); // empty script: ANY provider write attempt fails the test
    expect(run2.outcome).toBe('blocked');
    if (run2.outcome === 'blocked') {
      expect(run2.reason).toMatch(/prior operations/);
    }
  }, 30_000);

  it('--new-intent while the prior intent is unresolved is refused', async () => {
    const stateDir = smokeDir();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');
    const run1 = await smoke({
      stateDir,
      clock,
      script: {
        createTransfer: [
          created({
            id: 'tr_smoke_1',
            status: 'PROCESSING',
            transfer_amount: 5,
            transfer_currency: 'USD',
            beneficiary_id: 'ben-smoke',
          }),
        ],
        listTransfers: [unavailable('ambiguous')],
      },
    });
    expect(run1.outcome).toBe('unverified'); // accepted create, ambiguous readback

    const run2 = await smoke({ stateDir, clock, script: {}, newIntent: true });
    expect(run2.outcome).toBe('blocked');
    if (run2.outcome === 'blocked') {
      expect(run2.reason).toMatch(/not fully resolved/);
    }
  }, 30_000);

  it('a corrupt state file never authorizes a fresh create', async () => {
    const stateDir = smokeDir();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');
    writeFileSync(join(stateDir, 'state.json'), '{"version":1,"orgId":'); // torn write
    const run = await smoke({ stateDir, clock, script: {} });
    expect(run.outcome).toBe('blocked');
    if (run.outcome === 'blocked') {
      expect(run.reason).toMatch(/corrupt|incomplete/);
    }
  }, 30_000);

  it('concurrent invocations are refused by the exclusive lock', async () => {
    const stateDir = smokeDir();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');
    const lockFd = openSync(join(stateDir, 'run.lock'), 'wx');
    writeFileSync(lockFd, 'pid=999 at=2026-11-03T12:00:00.000Z', 'utf8');
    closeSync(lockFd);
    const run = await smoke({ stateDir, clock, script: {} });
    expect(run.outcome).toBe('blocked');
    if (run.outcome === 'blocked') {
      expect(run.reason).toMatch(/another smoke invocation holds the lock/);
    }
  }, 30_000);
});

// ---------------------- FINAL ACCEPTANCE: the three merge-gated corrections

/**
 * Acceptance scenarios run the ACTUAL smoke workflow through
 * runSmokeTransfer against a deterministic fixture. The create lane is EMPTY
 * on any run where a create must not happen (an unexpected create exhausts
 * the lane and fails the test).
 */
const ACCEPT_BEN = 'ben-smoke';

function acceptSmoke(input: {
  stateDir: string;
  clock: TunableClock;
  script: Partial<FixtureScript>;
  newIntent?: boolean;
}): Promise<SmokeTransferResult> {
  return smoke({ ...input, beneficiaryId: ACCEPT_BEN });
}

/** Accepted create (the only run-type that may script a create). */
const acceptedCreate = [
  created({
    id: 'tr_acc',
    status: 'PROCESSING',
    transfer_amount: 5,
    transfer_currency: 'USD',
    beneficiary_id: ACCEPT_BEN,
  }),
];

/** Provider records for a readback of THIS intent's provider request id. */
function readbackPages(providerRequestId: string, status: string): Partial<FixtureScript> {
  const listed = {
    id: 'tr_acc',
    request_id: providerRequestId,
    status,
    transfer_amount: 5,
    transfer_currency: 'USD',
    beneficiary_id: ACCEPT_BEN,
  };
  return {
    // worker reconcile + direct readback consume one page each
    listTransfers: [ok({ items: [listed] }), ok({ items: [listed] })],
    getTransfer: [ok(listed), ok(listed)],
  };
}

/** Provider reports terminal FAILED for this intent (readback-only). */
function failedReadbackScript(providerRequestId: string): Partial<FixtureScript> {
  const failed = {
    id: 'tr_acc',
    request_id: providerRequestId,
    status: 'FAILED',
    transfer_amount: 5,
    transfer_currency: 'USD',
    beneficiary_id: ACCEPT_BEN,
    failure: { code: 'clearing_rejected' },
  };
  return {
    listTransfers: [ok({ items: [failed] }), ok({ items: [failed] })],
    getTransfer: [ok(failed), ok(failed)],
  };
}

/**
 * Drive the workflow to a confirmed/SETTLED intent: run 1 submits (readback
 * ambiguous), run 2 reconciles by the persisted identity to identity-verified
 * PAID. Clock advances only 1s between runs — far below the claim TTL.
 */
async function runToConfirmed(
  stateDir: string,
  clock: TunableClock,
): Promise<{
  orgId: string;
  operationId: string;
  ledgerRequestId: string;
  providerRequestId: string;
}> {
  const run1 = await acceptSmoke({
    stateDir,
    clock,
    script: { createTransfer: acceptedCreate, listTransfers: [unavailable('readback deferred')] },
  });
  expect(run1.outcome).toBe('unverified'); // accepted create, readback ambiguous
  const state = readSmokeState(stateDir);
  clock.advance(1_000);
  const run2 = await acceptSmoke({
    stateDir,
    clock,
    script: readbackPages(state.providerRequestId, 'PAID'),
  });
  expect(run2.outcome).toBe('confirmed');
  return state;
}

function reconcileOperation(
  stateDir: string,
  clock: TunableClock,
  state: { orgId: string; operationId: string },
): void {
  const ledger = openLedger(join(stateDir, 'smoke.sqlite'), clock);
  ledger.reservations.transition({
    orgId: state.orgId,
    operationId: state.operationId,
    to: 'RECONCILED',
    attestation: { source: 'operator-action', note: 'funds confirmed arrived' },
  });
  ledger.close();
}

describe('FINAL ACCEPTANCE 1 — one-intent policy across ALL persisted states', () => {
  it('deleting the state file never authorizes a new payment when the prior operation is SETTLED (awaiting reconciliation)', async () => {
    const stateDir = smokeDir();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');
    const state = await runToConfirmed(stateDir, clock);
    const ledger = openLedger(join(stateDir, 'smoke.sqlite'), clock);
    expect(ledger.reservations.getOperation(state.orgId, state.operationId).state).toBe('SETTLED');
    ledger.close();

    rmSync(join(stateDir, 'state.json'));
    const run = await acceptSmoke({ stateDir, clock, script: {} }); // ANY create attempt fails the test
    expect(run.outcome).toBe('blocked');
    if (run.outcome === 'blocked') {
      expect(run.reason).toMatch(/prior operations/);
      expect(run.reason).toContain('SETTLED');
    }
  }, 45_000);

  it('deleting the state file never authorizes a new payment when the prior operation is REQUIRES_HUMAN', async () => {
    const stateDir = smokeDir();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');
    const run1 = await acceptSmoke({
      stateDir,
      clock,
      script: { createTransfer: acceptedCreate, listTransfers: [unavailable('readback deferred')] },
    });
    expect(run1.outcome).toBe('unverified'); // accepted create, ambiguous readback
    const state = readSmokeState(stateDir);
    clock.advance(1_000);
    const run2 = await acceptSmoke({
      stateDir,
      clock,
      script: failedReadbackScript(state.providerRequestId),
    });
    expect(run2.outcome).toBe('requires-human');
    const ledger = openLedger(join(stateDir, 'smoke.sqlite'), clock);
    expect(ledger.reservations.getOperation(state.orgId, state.operationId).state).toBe(
      'REQUIRES_HUMAN',
    );
    ledger.close();

    rmSync(join(stateDir, 'state.json'));
    const run3 = await acceptSmoke({ stateDir, clock, script: {} });
    expect(run3.outcome).toBe('blocked');
    if (run3.outcome === 'blocked') {
      expect(run3.reason).toMatch(/prior operations/);
      expect(run3.reason).toContain('REQUIRES_HUMAN');
    }
  }, 45_000);

  it('deleting the state file never authorizes a new payment even when the prior operation is RECONCILED (resolved)', async () => {
    const stateDir = smokeDir();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');
    const state = await runToConfirmed(stateDir, clock);
    reconcileOperation(stateDir, clock, state);

    rmSync(join(stateDir, 'state.json'));
    const run = await acceptSmoke({ stateDir, clock, script: {} }); // silent path must be refused
    expect(run.outcome).toBe('blocked');
    if (run.outcome === 'blocked') {
      expect(run.reason).toMatch(/prior operations/);
      expect(run.reason).toContain('RECONCILED');
    }
  }, 45_000);

  it('--new-intent is refused while the prior operation is SETTLED (still monitored, not resolved); state file NOT archived', async () => {
    const stateDir = smokeDir();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');
    await runToConfirmed(stateDir, clock);
    const run = await acceptSmoke({ stateDir, clock, script: {}, newIntent: true });
    expect(run.outcome).toBe('blocked');
    if (run.outcome === 'blocked') {
      expect(run.reason).toMatch(/not fully resolved/);
      expect(run.reason).toContain('SETTLED');
    }
    // Archiving happens only AFTER the checks pass — the state file is intact.
    expect(existsSync(join(stateDir, 'state.json'))).toBe(true);
  }, 45_000);

  it('--new-intent is refused while the prior operation is REQUIRES_HUMAN', async () => {
    const stateDir = smokeDir();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');
    const run1 = await acceptSmoke({
      stateDir,
      clock,
      script: { createTransfer: acceptedCreate, listTransfers: [unavailable('readback deferred')] },
    });
    expect(run1.outcome).toBe('unverified'); // accepted create, ambiguous readback
    const state = readSmokeState(stateDir);
    clock.advance(1_000);
    const run2 = await acceptSmoke({
      stateDir,
      clock,
      script: failedReadbackScript(state.providerRequestId),
    });
    expect(run2.outcome).toBe('requires-human');

    const run3 = await acceptSmoke({ stateDir, clock, script: {}, newIntent: true });
    expect(run3.outcome).toBe('blocked');
    if (run3.outcome === 'blocked') {
      expect(run3.reason).toMatch(/not fully resolved/);
      expect(run3.reason).toContain('REQUIRES_HUMAN');
    }
  }, 45_000);

  it('--new-intent after a RECONCILED (fully resolved) prior intent: explicit new authorization; archive keeps the original identity recoverable', async () => {
    const stateDir = smokeDir();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');
    const original = await runToConfirmed(stateDir, clock);
    reconcileOperation(stateDir, clock, original);

    clock.advance(1_000);
    const run = await acceptSmoke({
      stateDir,
      clock,
      script: { createTransfer: acceptedCreate, listTransfers: [unavailable('readback deferred')] },
      newIntent: true,
    });
    expect(run.outcome).toBe('unverified'); // the NEW intent submitted; its readback is ambiguous here
    const next = readSmokeState(stateDir); // state.json now describes the NEW intent
    expect(next.ledgerRequestId).not.toBe(original.ledgerRequestId);
    expect(next.orgId).not.toBe(original.orgId);

    // Original identity recoverable: archived state file + ledger + receipts.
    const archivePath = join(stateDir, `state-${original.ledgerRequestId}.json`);
    expect(existsSync(archivePath)).toBe(true);
    const archive = JSON.parse(readFileSync(archivePath, 'utf8')) as {
      providerRequestId: string;
      operationId: string;
    };
    expect(archive.providerRequestId).toBe(original.providerRequestId);
    expect(archive.operationId).toBe(original.operationId);
    const ledger = openLedger(join(stateDir, 'smoke.sqlite'), clock);
    const ops = ledger.db.prepare('SELECT COUNT(*) AS c FROM operations').get() as { c: number };
    expect(ops.c).toBe(2); // two DISTINCT authorized intents, never a duplicate of one
    expect(ledger.reservations.getOperation(original.orgId, original.operationId).state).toBe(
      'RECONCILED',
    );
    const oldReceipts = ledger.providerReceipts.listByRequestId(
      original.ledgerRequestId,
      original.orgId,
    );
    expect(oldReceipts.length).toBeGreaterThan(0);
    ledger.close();
  }, 45_000);
});

describe('FINAL ACCEPTANCE 2 — fresh provider readback is authoritative for reporting', () => {
  it('a later FAILED readback after SETTLED is NEVER reported confirmed — even before the claim TTL has elapsed', async () => {
    const stateDir = smokeDir();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');
    const state = await runToConfirmed(stateDir, clock);

    // Restart 1s later: the worker claim TTL (60s+) has NOT elapsed — yet the
    // authoritative worker path (immediate reconcile) must handle the late
    // failure, and the report must be requires-human, never confirmed.
    clock.advance(1_000);
    const run = await acceptSmoke({
      stateDir,
      clock,
      script: failedReadbackScript(state.providerRequestId),
    });
    expect(run.outcome).not.toBe('confirmed');
    expect(run.outcome).toBe('requires-human');
    if (run.outcome === 'requires-human') {
      expect(run.operationState).toBe('REQUIRES_HUMAN');
    }
    const ledger = openLedger(join(stateDir, 'smoke.sqlite'), clock);
    expect(ledger.reservations.getOperation(state.orgId, state.operationId).state).toBe(
      'REQUIRES_HUMAN',
    );
    // Auditable reversal WITHOUT rewriting history: settlement AND reversal both recorded.
    const types = ledger.evidence.list(state.orgId, {}).map((e) => e.type);
    expect(types).toContain('operation.settled');
    expect(types).toContain('settlement.reversed');
    // Exposure accounting unchanged pending the human adjustment.
    const commitment = ledger.reservations.getCommitment(state.orgId, state.operationId);
    expect(commitment.state).toBe('unknown');
    ledger.close();
  }, 45_000);

  it('RECONCILED with a contradictory later FAILED readback escalates WITHOUT rewriting terminal history', async () => {
    const stateDir = smokeDir();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');
    const state = await runToConfirmed(stateDir, clock);
    reconcileOperation(stateDir, clock, state);

    clock.advance(1_000);
    const run = await acceptSmoke({
      stateDir,
      clock,
      script: failedReadbackScript(state.providerRequestId),
    });
    expect(run.outcome).not.toBe('confirmed');
    expect(run.outcome).toBe('requires-human');
    if (run.outcome === 'requires-human') {
      expect(run.reason).toMatch(/contradictory|reconciliation/);
    }
    const ledger = openLedger(join(stateDir, 'smoke.sqlite'), clock);
    expect(ledger.reservations.getOperation(state.orgId, state.operationId).state).toBe(
      'RECONCILED',
    );
    const types = ledger.evidence.list(state.orgId, {}).map((e) => e.type);
    expect(types).toContain('settlement.reversed.after_reconciled');
    ledger.close();
  }, 45_000);
});

describe('FINAL ACCEPTANCE 3 — BLOCKED is strictly pre-attempt; post-attempt unknown is unambiguous', () => {
  it('failure after successful provider submission but before readback completion reports STATUS_UNKNOWN (never BLOCKED), and rerun reconciles the same intent', async () => {
    const stateDir = smokeDir();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');
    // The create is ACCEPTED; the independent get-by-id readback then fails
    // (lane exhausted → READBACK_INCOMPLETE): the submission happened, the
    // outcome is unknown — the run must NOT claim BLOCKED.
    const listedProcessing = {
      id: 'tr_acc',
      request_id: 'WILL_NOT_MATCH_READBACK', // readback identity cannot be known yet
      status: 'PROCESSING',
      transfer_amount: 5,
      transfer_currency: 'USD',
      beneficiary_id: ACCEPT_BEN,
    };
    const run1 = await acceptSmoke({
      stateDir,
      clock,
      script: {
        createTransfer: acceptedCreate,
        listTransfers: [ok({ items: [listedProcessing] })],
        getTransfer: [], // readback get-by-id fails AFTER the submission
      },
    });
    expect(run1.outcome).toBe('unverified'); // NOT blocked: a submission occurred
    if (run1.outcome === 'unverified') {
      expect(run1.reason).toMatch(/never substitute a new identity/);
    }
    const state = readSmokeState(stateDir);
    const ledger = openLedger(join(stateDir, 'smoke.sqlite'), clock);
    expect(ledger.reservations.getOperation(state.orgId, state.operationId).state).toBe(
      'IN_FLIGHT',
    );
    expect(ledger.spendable.compute(state.orgId, 'USD').outstandingCommittedMinor).toBe(500);
    ledger.close();

    // Recovery reconciles THIS intent by its original identity (create lane EMPTY).
    clock.advance(1_000);
    const run2 = await acceptSmoke({
      stateDir,
      clock,
      script: readbackPages(state.providerRequestId, 'PAID'),
    });
    expect(run2.outcome).toBe('confirmed');
    if (run2.outcome === 'confirmed') {
      expect(run2.workerReport.dispatched).toBe(0);
      expect(run2.operationId).toBe(state.operationId);
    }
  }, 45_000);

  it('BLOCKED stays strictly pre-attempt: a corrupt state file reports blocked and sends nothing', async () => {
    const stateDir = smokeDir();
    const clock = new TunableClock('2026-11-03T12:00:00.000Z');
    writeFileSync(join(stateDir, 'state.json'), '{"version":1,"orgId":');
    const run = await acceptSmoke({ stateDir, clock, script: {} });
    expect(run.outcome).toBe('blocked');
    if (run.outcome === 'blocked') {
      expect(run.reason).toMatch(/corrupt/);
    }
  }, 30_000);
});

// ------------------------------------------- FINAL-P0-2: strict identity checks

describe('FINAL-P0-2 strict transfer identity validation (list AND get-by-id)', () => {
  it('a listed record MISSING request_id is ambiguous — never confirmable', async () => {
    const w = makeWorld({
      listTransfers: [
        ok({
          items: [
            {
              id: 'tr_x1',
              status: 'PAID',
              transfer_amount: 12.34,
              transfer_currency: 'USD',
              beneficiary_id: BEN,
            },
          ],
        }),
      ],
    });
    const result = await w.dispatcher.reconcileByRequestId('pay-f1', FULL_SCOPE(w.orgId, 'op_f1'));
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('EVIDENCE_INCOMPLETE');
    w.ledger.close();
  });

  it('a get-by-id record MISSING request_id cannot confirm (even with the right amount)', async () => {
    const w = makeWorld(({ ns }) => ({
      listTransfers: [ok({ items: [paidthroughRecord(ns, 'pay-f2', 'tr_x2')] })],
      getTransfer: [
        ok({
          id: 'tr_x2',
          status: 'PAID',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
          beneficiary_id: BEN,
        }),
      ],
    }));
    const result = await w.dispatcher.reconcileByRequestId('pay-f2', FULL_SCOPE(w.orgId, 'op_f2'));
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('EVIDENCE_INCOMPLETE');
    w.ledger.close();
  });

  it('a get-by-id record with a FOREIGN request_id cannot confirm', async () => {
    const w = makeWorld(({ ns }) => ({
      listTransfers: [ok({ items: [paidthroughRecord(ns, 'pay-f3', 'tr_x3')] })],
      getTransfer: [
        ok({
          id: 'tr_x3',
          request_id: 'mtv-0000000000-someone-elses-id',
          status: 'PAID',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
          beneficiary_id: BEN,
        }),
      ],
    }));
    const result = await w.dispatcher.reconcileByRequestId('pay-f3', FULL_SCOPE(w.orgId, 'op_f3'));
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('REQUEST_ID_MISMATCH');
    w.ledger.close();
  });

  it('a get-by-id body naming a DIFFERENT transfer id than the listing stays ambiguous', async () => {
    const w = makeWorld(({ ns }) => ({
      listTransfers: [ok({ items: [paidthroughRecord(ns, 'pay-f4', 'tr_x4')] })],
      getTransfer: [
        ok({
          id: 'tr_OTHER',
          request_id: ns('pay-f4'),
          status: 'PAID',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
          beneficiary_id: BEN,
        }),
      ],
    }));
    const result = await w.dispatcher.reconcileByRequestId('pay-f4', FULL_SCOPE(w.orgId, 'op_f4'));
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('EVIDENCE_INCOMPLETE');
    w.ledger.close();
  });

  it('a PAID record missing beneficiary_id cannot confirm (missing identity fields are ambiguous)', async () => {
    const w = makeWorld(({ ns }) => ({
      listTransfers: [ok({ items: [paidthroughRecord(ns, 'pay-f5', 'tr_x5')] })],
      getTransfer: [
        ok({
          id: 'tr_x5',
          request_id: ns('pay-f5'),
          status: 'PAID',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
          // beneficiary_id deliberately absent
        }),
      ],
    }));
    const result = await w.dispatcher.reconcileByRequestId('pay-f5', FULL_SCOPE(w.orgId, 'op_f5'));
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('EVIDENCE_INCOMPLETE');
    w.ledger.close();
  });

  it('a fully consistent PAID readback still confirms (no over-blocking)', async () => {
    const w = makeWorld(({ ns }) => ({
      listTransfers: [ok({ items: [paidthroughRecord(ns, 'pay-f6', 'tr_x6')] })],
      getTransfer: [ok(paidthroughRecord(ns, 'pay-f6', 'tr_x6'))],
    }));
    const result = await w.dispatcher.reconcileByRequestId('pay-f6', FULL_SCOPE(w.orgId, 'op_f6'));
    expect(result.status).toBe('confirmed');
    expect(result.verifiedAt).toBeDefined();
    w.ledger.close();
  });
});

// ------------------------------------ FINAL-P0-3: scope completeness mandatory

describe('FINAL-P0-3 incomplete or untrusted scope can never confirm', () => {
  it('tenant-only scope (webhook shape) observes but gets SCOPE_INCOMPLETE, never confirmed', async () => {
    const w = makeWorld(({ ns }) => ({
      listTransfers: [
        ok({ items: [paidthroughRecord(ns, 'pay-g1', 'tr_y1')] }),
        ok({ items: [paidthroughRecord(ns, 'pay-g1', 'tr_y1')] }),
      ],
      getTransfer: [ok(paidthroughRecord(ns, 'pay-g1', 'tr_y1'))],
    }));
    const result = await w.dispatcher.reconcileByRequestId('pay-g1', {
      orgId: w.orgId,
      operationId: null,
    });
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('SCOPE_INCOMPLETE');
    w.ledger.close();
  });

  it('scope missing the beneficiary term cannot confirm', async () => {
    const w = makeWorld(({ ns }) => ({
      listTransfers: [ok({ items: [paidthroughRecord(ns, 'pay-g2', 'tr_y2')] })],
      getTransfer: [ok(paidthroughRecord(ns, 'pay-g2', 'tr_y2'))],
    }));
    const result = await w.dispatcher.reconcileByRequestId('pay-g2', {
      orgId: w.orgId,
      operationId: 'op_g2',
      amountMinor: 1234,
      currency: 'USD',
      // beneficiary deliberately absent
    });
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('SCOPE_INCOMPLETE');
    w.ledger.close();
  });

  it('scope missing the amount term cannot confirm', async () => {
    const w = makeWorld(({ ns }) => ({
      listTransfers: [ok({ items: [paidthroughRecord(ns, 'pay-g3', 'tr_y3')] })],
      getTransfer: [ok(paidthroughRecord(ns, 'pay-g3', 'tr_y3'))],
    }));
    const result = await w.dispatcher.reconcileByRequestId('pay-g3', {
      orgId: w.orgId,
      operationId: 'op_g3',
      currency: 'USD',
      beneficiary: BEN,
      // amountMinor deliberately absent
    });
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('SCOPE_INCOMPLETE');
    w.ledger.close();
  });

  it('a scope inconsistent with the trusted server-side beneficiary mapping cannot confirm', async () => {
    const w = makeWorld(({ ns }) => ({
      listTransfers: [ok({ items: [paidthroughRecord(ns, 'pay-g4', 'tr_y4')] })],
      getTransfer: [
        ok({
          id: 'tr_y4',
          request_id: ns('pay-g4'),
          status: 'PAID',
          transfer_amount: 12.34,
          transfer_currency: 'USD',
          beneficiary_id: 'ben-forged',
        }),
      ],
    }));
    const result = await w.dispatcher.reconcileByRequestId('pay-g4', {
      orgId: w.orgId,
      operationId: 'op_g4',
      amountMinor: 1234,
      currency: 'USD',
      beneficiary: 'ben-forged', // matches the record but NOT the org mapping (ben-1)
    });
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('SCOPE_INCONSISTENT');
    w.ledger.close();
  });

  it('webhook ingestion of a PAID event records evidence but never settles anything', async () => {
    const w = makeWorld(({ ns }) => ({
      listTransfers: [ok({ items: [paidthroughRecord(ns, 'pay-g5', 'tr_y5')] })],
      getTransfer: [ok(paidthroughRecord(ns, 'pay-g5', 'tr_y5'))],
    }));
    const ingested = await w.dispatcher.ingestTransferWebhook({
      orgId: w.orgId,
      eventId: 'evt-g5',
      name: 'transfers.paid',
      transferId: 'tr_y5',
      requestId: 'pay-g5',
      payload: { status: 'PAID' },
    });
    expect(ingested.reconciled).toBe(true); // it DID trigger a reconciliation…
    // …but that reconciliation could only OBSERVE: the receipt trail proves it
    // ended SCOPE_INCOMPLETE, and no 'confirmed' settlement evidence exists.
    const receipts = w.ledger.providerReceipts.listByRequestId('pay-g5', w.orgId);
    expect(receipts.some((r) => r.providerStatus === 'SCOPE_INCOMPLETE')).toBe(true);
    expect(w.ledger.evidence.list(w.orgId, {}).some((e) => e.type === 'operation.settled')).toBe(
      false,
    );
    w.ledger.close();
  });
});

// -------------------------------------------- FINAL-P1: fail-closed pagination

function makeClientWorld(script: Partial<FixtureScript>): {
  client: AirwallexClient;
  fixture: FixtureTransport;
} {
  const fixture = new FixtureTransport({
    login: [created({ token: 'r3fc', expires_at: '2026-11-03T23:00:00.000Z' })],
    createTransfer: [],
    listTransfers: [],
    getTransfer: [],
    balances: [],
    ...script,
  });
  const clock = new TunableClock('2026-11-03T12:00:00.000Z');
  return { client: new AirwallexClient(CONFIG, fixture, clock), fixture };
}

const TRANSFER_ON_PAGE_2 = {
  id: 'tr_p2',
  request_id: 'mtv-aaaaaaaaaa-pay-h1',
  status: 'PAID',
  transfer_amount: 12.34,
  transfer_currency: 'USD',
  beneficiary_id: BEN,
};

describe('FINAL-P1 complete paginated readback (fail-closed)', () => {
  it('follows page_after across pages and returns the complete result set', async () => {
    const { client } = makeClientWorld({
      listTransfers: [
        ok({ items: [], has_more: true, page_after: 'cursor-1' }),
        ok({ items: [TRANSFER_ON_PAGE_2], has_more: false }),
      ],
    });
    const found = await client.listTransfersByRequestId('mtv-aaaaaaaaaa-pay-h1');
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe('tr_p2');
  });

  it('has_more=true without a cursor is incomplete, never an authoritative empty', async () => {
    const { client } = makeClientWorld({
      listTransfers: [ok({ items: [], has_more: true })],
    });
    await expect(client.listTransfersByRequestId('mtv-aaaaaaaaaa-pay-h2')).rejects.toThrowError(
      /has_more=true without a page_after cursor/,
    );
  });

  it('a REPEATED cursor is detected and the readback stays incomplete', async () => {
    const { client } = makeClientWorld({
      listTransfers: [
        ok({ items: [], has_more: true, page_after: 'loop' }),
        ok({ items: [], has_more: true, page_after: 'loop' }),
      ],
    });
    await expect(client.listTransfersByRequestId('mtv-aaaaaaaaaa-pay-h3')).rejects.toThrowError(
      /repeated pagination cursor/,
    );
  });

  it('page_after present while has_more is false is contradictory → incomplete', async () => {
    const { client } = makeClientWorld({
      listTransfers: [ok({ items: [], has_more: false, page_after: 'stale' })],
    });
    await expect(client.listTransfersByRequestId('mtv-aaaaaaaaaa-pay-h4')).rejects.toThrowError(
      /page_after while has_more is false/,
    );
  });

  it('a non-boolean has_more is malformed → incomplete', async () => {
    const { client } = makeClientWorld({
      listTransfers: [ok({ items: [], has_more: 'yes' })],
    });
    await expect(client.listTransfersByRequestId('mtv-aaaaaaaaaa-pay-h5')).rejects.toThrowError(
      /non-boolean has_more/,
    );
  });

  it('pagination beyond the hard bound is incomplete (no unbounded provider-driven loop)', async () => {
    const pages = Array.from({ length: 10 }, (_, i) =>
      ok({ items: [], has_more: true, page_after: `cursor-${String(i)}` }),
    );
    const { client } = makeClientWorld({ listTransfers: pages });
    await expect(client.listTransfersByRequestId('mtv-aaaaaaaaaa-pay-h6')).rejects.toThrowError(
      /exceeded the 10-page bound/,
    );
  });

  it('an empty result is authoritative ONLY after a complete traversal', async () => {
    const { client } = makeClientWorld({
      listTransfers: [
        ok({ items: [], has_more: true, page_after: 'cursor-fin' }),
        ok({ items: [], has_more: false }),
      ],
    });
    const found = await client.listTransfersByRequestId('mtv-aaaaaaaaaa-pay-h7');
    expect(found).toEqual([]);
  });

  it('dispatcher-level: a transfer found on page 2 reconciles to confirmed with a complete scope', async () => {
    const w = makeWorld(({ ns }) => ({
      listTransfers: [
        ok({ items: [], has_more: true, page_after: 'cursor-z' }),
        ok({ items: [paidthroughRecord(ns, 'pay-h8', 'tr_z8')], has_more: false }),
      ],
      getTransfer: [ok(paidthroughRecord(ns, 'pay-h8', 'tr_z8'))],
    }));
    const result = await w.dispatcher.reconcileByRequestId('pay-h8', FULL_SCOPE(w.orgId, 'op_h8'));
    expect(result.status).toBe('confirmed');
    w.ledger.close();
  });
});

// ------------------------------------------------- ledger baseline unaffected

describe('FINAL baseline: MTV-02/MTV-05 invariants preserved', () => {
  it('the ledger worker still refuses unregistered rails and reports them honestly', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'r3f-base-')), 'ledger.sqlite');
    const ledger: Ledger = openLedger(path);
    ledger.migrate();
    const report = await ledger.worker.runOnce();
    expect(report.claimed).toBe(0);
    expect(report.skippedNoDispatcher).toEqual([]);
    ledger.close();
  });
});
