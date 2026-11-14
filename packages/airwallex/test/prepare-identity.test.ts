/**
 * PREPARE → CONFIRM ACCOUNT-IDENTITY LAW (CTO decision, issue #5): the
 * durable execution intent binds to the DISTINCT Transfers-Write credential
 * AT PREPARATION, and the strict account fingerprint is NEVER relaxed.
 *
 * The regression proven here used TWO DIFFERENT client ids (a write pair and
 * a read pair) — the exact shape that failed closed before this fix because
 * preparation ran under the read client id:
 *   I-1  prepare under the WRITE id (read id serving only a same-account-
 *        verified funding read) → confirm under the SAME write id resumes
 *        the SAME operation / request id / beneficiary / amount with
 *        exactly ONE provider-create attempt;
 *   I-2  cross-account substitution at confirm → BLOCKED, original intent
 *        untouched and still resumable by its true credential;
 *   I-3  a read credential whose provider token belongs to a DIFFERENT
 *        account (or carries no readable claims) is NEVER used for the
 *        funding gate → BLOCKED before any intent is created;
 *   I-4  mismatched beneficiary at confirm → BLOCKED, zero provider calls;
 *   I-5  revoked credentials (login 401/403) → BLOCKED pre-attempt;
 *   I-6  restart + duplicate execution: a second --confirm on the same
 *        attempted intent reconciles THE SAME identity — never a second
 *        create.
 * accountIdentityFromToken is also unit-tested (claims parse, null-on-junk).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureTransport, created, httpError, ok } from '../src/index.js';
import type { FixtureScript } from '../src/index.js';
import { accountIdentityFromToken } from '../src/client.js';
import { buildOfflineFixtureDispatcher } from '../src/dispatcher.js';
import { loadAirwallexConfig } from '../src/config.js';
import type { AirwallexAdapterConfig } from '../src/config.js';
import { openLedger, TunableClock } from '@moterva/ledger';
import { runSmokeTransfer, type SmokeTransferResult } from '../src/smoke/transfer-runner.js';

const WRITE_CID = 'cid-transfers-write';
const READ_CID = 'cid-read-only';
const OTHER_ACCOUNT_CID = 'cid-other-account-write';
const BEN = 'ben-identity-1';

function configFor(clientId: string): AirwallexAdapterConfig {
  return loadAirwallexConfig({
    AIRWALLEX_ENV: 'sandbox',
    AIRWALLEX_CLIENT_ID: clientId,
    AIRWALLEX_API_KEY: `key-for-${clientId}`,
  });
}

/** A provider-shaped HS256 JWT carrying org/account claims (fixture only). */
function fixtureJwt(orgId: string, accountId = 'acct-fixture-1'): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    b64({ alg: 'HS256', kid: 'fixture' }),
    b64({ type: 'scoped', org_id: orgId, account_id: accountId }),
    b64({ sig: 'fixture-not-a-real-signature' }),
  ].join('.');
}

const USD_OK = ok({
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
});
const login = (orgId: string, accountId: string | null = 'acct-fixture-1') =>
  created({
    token:
      accountId === null
        ? Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'fixture' })).toString('base64url') +
          '.' +
          Buffer.from(JSON.stringify({ type: 'scoped', org_id: orgId })).toString('base64url') +
          '.' +
          Buffer.from(JSON.stringify({ sig: 'fixture' })).toString('base64url')
        : fixtureJwt(orgId, accountId),
    expires_at: '2026-11-13T23:00:00.000Z',
  });

interface World {
  stateDir: string;
  fixture: FixtureTransport;
  clock: TunableClock;
}

function makeWorld(script: Partial<FixtureScript>): World {
  const stateDir = mkdtempSync(join(tmpdir(), 'awx-identity-'));
  const fixture = new FixtureTransport({
    login: [],
    createTransfer: [],
    listTransfers: [],
    getTransfer: [],
    balances: [],
    ...script,
  });
  return { stateDir, fixture, clock: new TunableClock('2026-11-13T12:00:00.000Z') };
}

function run(
  world: World,
  options: {
    writeCid?: string;
    readCid?: string;
    confirm?: boolean;
    prepareOnly?: boolean;
    beneficiaryId?: string;
  },
): Promise<SmokeTransferResult> {
  const readConfig = options.readCid === undefined ? undefined : configFor(options.readCid);
  return runSmokeTransfer({
    config: configFor(options.writeCid ?? WRITE_CID),
    transport: world.fixture,
    ...(readConfig === undefined ? {} : { readConfig, readTransport: world.fixture }),
    beneficiaryId: options.beneficiaryId ?? BEN,
    amountMinor: 500,
    confirm: options.confirm ?? false,
    prepareOnly: options.prepareOnly ?? false,
    newIntent: false,
    stateDir: world.stateDir,
    buildDispatcher: buildOfflineFixtureDispatcher,
    now: () => world.clock.now(),
    ledgerClock: world.clock,
  });
}

/** Mirrors the runner's one-way fingerprint (16-hex truncated sha256 of the client id). */
function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function createCalls(world: World): number {
  return world.fixture.performedRequests.filter((r) => r.path.endsWith('/transfers/create')).length;
}

describe('accountIdentityFromToken (provider-token claims; null is UNVERIFIABLE)', () => {
  it('reads org/account claims from an HS256 JWT and returns null for anything else', () => {
    expect(accountIdentityFromToken(fixtureJwt('org-A', 'acct-1'))).toEqual({
      orgId: 'org-A',
      accountId: 'acct-1',
    });
    expect(accountIdentityFromToken(null)).toBeNull();
    expect(accountIdentityFromToken('')).toBeNull();
    expect(accountIdentityFromToken('opaque-token')).toBeNull();
    expect(accountIdentityFromToken('a.b.c')).toBeNull(); // not base64url JSON
    // A JWT with no org claim is unverifiable, never a wildcard match.
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    expect(
      accountIdentityFromToken([b64({ alg: 'HS256' }), b64({ sub: 'x' }), b64({})].join('.')),
    ).toBeNull();
    // A different algorithm header is not the documented provider token shape.
    expect(
      accountIdentityFromToken([b64({ alg: 'none' }), b64({ org_id: 'org-A' }), b64({})].join('.')),
    ).toBeNull();
  });
});

describe('prepare → confirm with TWO DIFFERENT client ids (strict fingerprint, never relaxed)', () => {
  it('I-1: the intent binds to the WRITE identity at preparation and the SAME write identity resumes it — one create', async () => {
    const world = makeWorld({
      // prepare: write login → (write balances 403) → read login → read balances ok
      // confirm: write login → write balances ok → dispatcher's own client login → create
      login: [login('org-A'), login('org-A'), login('org-A'), login('org-A')],
      balances: [httpError(403, 'forbidden', 'write key cannot read balances'), USD_OK, USD_OK],
      createTransfer: [
        created({
          id: 'trf-identity-1',
          request_id: 'runner-namespaced',
          status: 'SUBMITTED',
          transfer_amount: 5,
          transfer_currency: 'USD',
          beneficiary_id: BEN,
        }),
      ],
      listTransfers: [ok({ items: [], has_more: false })],
    });
    try {
      const prepared = await run(world, { readCid: READ_CID, prepareOnly: true });
      if (prepared.outcome !== 'prepared') {
        throw new Error(`expected prepared, got ${JSON.stringify(prepared)}`);
      }
      // The funding gate was served by the READ credential only after the
      // same-account verification (write 403 → read login → read balances).
      expect(prepared.verifiedUsdAvailableMinor).toBe(100_000_000);
      expect(createCalls(world)).toBe(0);

      // The durable intent is fingerprinted to the WRITE client id — never
      // the read client id that merely served the balance read.
      const state = JSON.parse(readFileSync(join(world.stateDir, 'state.json'), 'utf8')) as {
        accountFingerprint: string;
        operationId: string;
        ledgerRequestId: string;
        beneficiaryId: string;
        amountMinor: number;
      };
      expect(state.accountFingerprint).toBe(fingerprint(WRITE_CID));
      expect(state.accountFingerprint).not.toBe(fingerprint(READ_CID));

      // CONFIRM under the SAME write identity: resumes the SAME intent.
      const executed = await run(world, { confirm: true });
      if (executed.outcome === 'blocked' || executed.outcome === 'prepared') {
        throw new Error(`confirm did not resume the prepared intent: ${JSON.stringify(executed)}`);
      }
      expect(executed.operationId).toBe(prepared.operationId);
      expect(executed.ledgerRequestId).toBe(prepared.ledgerRequestId);
      expect(executed.providerRequestId).toBe(prepared.providerRequestId);
      // Same beneficiary and amount — read from the durable operation itself.
      const ledger = openLedger(join(world.stateDir, 'smoke.sqlite'));
      try {
        const operation = ledger.reservations.getOperation(prepared.orgId, prepared.operationId);
        expect(operation.beneficiary).toBe(prepared.beneficiaryId);
        expect(operation.amountMinor).toBe(prepared.amountMinor);
        expect(operation.requestId).toBe(prepared.ledgerRequestId);
        const operations = ledger.db.prepare('SELECT COUNT(*) AS c FROM operations').get() as {
          c: number;
        };
        expect(operations.c).toBe(1); // never a second payment intent
      } finally {
        ledger.close();
      }
      // EXACTLY ONE provider-create attempt, carrying the prepared request id.
      expect(createCalls(world)).toBe(1);
      const createBody = world.fixture.performedRequests.find((r) =>
        r.path.endsWith('/transfers/create'),
      )!.body as { request_id: string; beneficiary_id: string; transfer_amount: number };
      expect(createBody.request_id).toBe(prepared.providerRequestId);
      expect(createBody.beneficiary_id).toBe(BEN);
      expect(createBody.transfer_amount).toBe(5);
      // The create carried the WRITE credential's bearer token, never raw keys.
      const createCall = world.fixture.performedRequests.find((r) =>
        r.path.endsWith('/transfers/create'),
      )!;
      expect(createCall.headers['x-api-key']).toBeUndefined();
      expect(createCall.headers['authorization']).toMatch(/^Bearer /);
    } finally {
      rmSync(world.stateDir, { recursive: true, force: true });
    }
  });

  it('I-2: cross-account substitution at confirm is BLOCKED; the original intent stays resumable by its true credential', async () => {
    const world = makeWorld({
      // prepare login, confirm funding-gate login, dispatcher's own client login
      login: [login('org-A'), login('org-A'), login('org-A')],
      balances: [USD_OK, USD_OK],
      createTransfer: [
        created({
          id: 'trf-identity-2',
          request_id: 'runner-namespaced',
          status: 'SUBMITTED',
          transfer_amount: 5,
          transfer_currency: 'USD',
          beneficiary_id: BEN,
        }),
      ],
      listTransfers: [ok({ items: [], has_more: false })],
    });
    try {
      const prepared = await run(world, { prepareOnly: true });
      if (prepared.outcome !== 'prepared') throw new Error('prepare failed');
      const requestsBefore = world.fixture.performedRequests.length;

      // A DIFFERENT credential (another account's write key) tries to confirm.
      const hijack = await run(world, { writeCid: OTHER_ACCOUNT_CID, confirm: true });
      expect(hijack.outcome).toBe('blocked');
      if (hijack.outcome === 'blocked') {
        expect(hijack.reason).toContain('credential fingerprint mismatch');
      }
      // Refused BEFORE any provider call, and nothing was created.
      expect(world.fixture.performedRequests.length).toBe(requestsBefore);
      expect(createCalls(world)).toBe(0);
      // The read-only credential cannot confirm either (it is not the identity of record).
      const readAsWrite = await run(world, { writeCid: READ_CID, confirm: true });
      expect(readAsWrite.outcome).toBe('blocked');
      expect(createCalls(world)).toBe(0);

      // The TRUE credential still resumes the untouched original intent.
      const executed = await run(world, { confirm: true });
      if (executed.outcome === 'blocked' || executed.outcome === 'prepared') {
        throw new Error(`true credential could not resume: ${JSON.stringify(executed)}`);
      }
      expect(executed.operationId).toBe(prepared.operationId);
      expect(createCalls(world)).toBe(1);
    } finally {
      rmSync(world.stateDir, { recursive: true, force: true });
    }
  });

  it('I-3: a read credential from a DIFFERENT account (or with unreadable claims) is never used for the funding gate', async () => {
    // Different org on the read token.
    const different = makeWorld({
      login: [login('org-A'), login('org-B')],
      balances: [httpError(403, 'forbidden', 'write key cannot read balances'), USD_OK],
    });
    // Same org but a DIFFERENT account claim (an org can hold several accounts).
    const otherAccount = makeWorld({
      login: [login('org-A', 'acct-fixture-1'), login('org-A', 'acct-fixture-2')],
      balances: [httpError(403, 'forbidden', 'write key cannot read balances'), USD_OK],
    });
    // Same org but the read token carries NO account claim (org-only is not a binding).
    const noAccountClaim = makeWorld({
      login: [login('org-A', 'acct-fixture-1'), login('org-A', null)],
      balances: [httpError(403, 'forbidden', 'write key cannot read balances'), USD_OK],
    });
    // Unreadable (opaque) read token.
    const opaque = makeWorld({
      login: [
        login('org-A'),
        created({ token: 'opaque-not-a-jwt', expires_at: '2026-11-13T23:00:00.000Z' }),
      ],
      balances: [httpError(403, 'forbidden', 'write key cannot read balances'), USD_OK],
    });
    try {
      for (const world of [different, otherAccount, noAccountClaim, opaque]) {
        const result = await run(world, { readCid: READ_CID, prepareOnly: true });
        expect(result.outcome).toBe('blocked');
        if (result.outcome === 'blocked') {
          expect(result.reason).toContain('NOT verified as the same Airwallex account');
        }
        // The read credential's balance was NEVER requested (only the write
        // attempt reached /balances/current) and no intent was created.
        const balanceReads = world.fixture.performedRequests.filter((r) =>
          r.path.endsWith('/balances/current'),
        );
        expect(balanceReads).toHaveLength(1);
        expect(createCalls(world)).toBe(0);
        const ledger = openLedger(join(world.stateDir, 'smoke.sqlite'));
        try {
          const operations = ledger.db.prepare('SELECT COUNT(*) AS c FROM operations').get() as {
            c: number;
          };
          expect(operations.c).toBe(0);
        } finally {
          ledger.close();
        }
      }
    } finally {
      for (const world of [different, otherAccount, noAccountClaim, opaque]) {
        rmSync(world.stateDir, { recursive: true, force: true });
      }
    }
  });

  it('I-3b: without a read credential, a write key that cannot read balances fails closed (no assumed fallback)', async () => {
    const world = makeWorld({
      login: [login('org-A')],
      balances: [httpError(403, 'forbidden', 'write key cannot read balances')],
    });
    try {
      const result = await run(world, { prepareOnly: true });
      expect(result.outcome).toBe('blocked');
      if (result.outcome === 'blocked') {
        expect(result.reason).toContain('fresh sandbox balance read failed');
      }
      expect(createCalls(world)).toBe(0);
    } finally {
      rmSync(world.stateDir, { recursive: true, force: true });
    }
  });

  it('I-4: a mismatched beneficiary at confirm is BLOCKED with zero provider calls', async () => {
    const world = makeWorld({ login: [login('org-A')], balances: [USD_OK] });
    try {
      const prepared = await run(world, { prepareOnly: true });
      if (prepared.outcome !== 'prepared') throw new Error('prepare failed');
      const requestsBefore = world.fixture.performedRequests.length;
      const swapped = await run(world, { confirm: true, beneficiaryId: 'ben-attacker' });
      expect(swapped.outcome).toBe('blocked');
      if (swapped.outcome === 'blocked') {
        expect(swapped.reason).toContain('changed mid-intent');
      }
      expect(world.fixture.performedRequests.length).toBe(requestsBefore);
      expect(createCalls(world)).toBe(0);
    } finally {
      rmSync(world.stateDir, { recursive: true, force: true });
    }
  });

  it('I-5: revoked credentials (login rejected) fail closed pre-attempt at prepare AND at confirm', async () => {
    const revokedAtPrepare = makeWorld({
      login: [httpError(401, 'credentials_invalid', 'revoked')],
    });
    const revokedAtConfirm = makeWorld({
      login: [login('org-A'), httpError(403, 'unauthorized', 'Forbidden')],
      balances: [USD_OK],
    });
    try {
      const first = await run(revokedAtPrepare, { prepareOnly: true });
      expect(first.outcome).toBe('blocked');
      expect(createCalls(revokedAtPrepare)).toBe(0);

      const prepared = await run(revokedAtConfirm, { prepareOnly: true });
      if (prepared.outcome !== 'prepared') throw new Error('prepare failed');
      const confirm = await run(revokedAtConfirm, { confirm: true });
      // The funding gate cannot authenticate → strictly pre-attempt BLOCKED.
      expect(confirm.outcome).toBe('blocked');
      expect(createCalls(revokedAtConfirm)).toBe(0);
      // The prepared intent is intact (still RESERVED, never attempted).
      const ledger = openLedger(join(revokedAtConfirm.stateDir, 'smoke.sqlite'));
      try {
        expect(ledger.reservations.getOperation(prepared.orgId, prepared.operationId).state).toBe(
          'RESERVED',
        );
      } finally {
        ledger.close();
      }
    } finally {
      rmSync(revokedAtPrepare.stateDir, { recursive: true, force: true });
      rmSync(revokedAtConfirm.stateDir, { recursive: true, force: true });
    }
  });

  it('I-6: restart + duplicate execution — a second --confirm reconciles the SAME identity, never a second create', async () => {
    const world = makeWorld({
      // prepare, then (funding-gate login + dispatcher login) for each confirm
      login: [login('org-A'), login('org-A'), login('org-A'), login('org-A'), login('org-A')],
      balances: [USD_OK, USD_OK, USD_OK],
      // The first create is LOST (ambiguous) — the classic partial failure.
      createTransfer: [{ kind: 'unavailable', message: 'connection reset after send' }],
      listTransfers: [
        ok({ items: [], has_more: false }),
        ok({ items: [], has_more: false }),
        ok({ items: [], has_more: false }),
        ok({ items: [], has_more: false }),
        ok({ items: [], has_more: false }),
        ok({ items: [], has_more: false }),
      ],
    });
    try {
      const prepared = await run(world, { prepareOnly: true });
      if (prepared.outcome !== 'prepared') throw new Error('prepare failed');
      const first = await run(world, { confirm: true });
      if (first.outcome === 'blocked' || first.outcome === 'prepared') {
        throw new Error(`first confirm did not attempt: ${JSON.stringify(first)}`);
      }
      expect(first.operationId).toBe(prepared.operationId);
      expect(createCalls(world)).toBe(1);

      // "Restart": a brand-new invocation over the same durable state.
      const second = await run(world, { confirm: true });
      if (second.outcome === 'blocked' || second.outcome === 'prepared') {
        throw new Error(`second confirm did not reconcile: ${JSON.stringify(second)}`);
      }
      expect(second.operationId).toBe(prepared.operationId);
      expect(second.ledgerRequestId).toBe(prepared.ledgerRequestId);
      // The ambiguous create is NEVER blindly repeated.
      expect(createCalls(world)).toBe(1);
      const ledger = openLedger(join(world.stateDir, 'smoke.sqlite'));
      try {
        const operations = ledger.db.prepare('SELECT COUNT(*) AS c FROM operations').get() as {
          c: number;
        };
        expect(operations.c).toBe(1);
        // Exposure is retained while the outcome is not a verified settlement.
        const state = ledger.reservations.getOperation(prepared.orgId, prepared.operationId).state;
        expect(['SETTLED', 'RECONCILED', 'CANCELLED', 'RESERVED']).not.toContain(state);
      } finally {
        ledger.close();
      }
    } finally {
      rmSync(world.stateDir, { recursive: true, force: true });
    }
  });
});
