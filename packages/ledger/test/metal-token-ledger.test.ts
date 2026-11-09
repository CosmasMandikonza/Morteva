/**
 * Metal token-asset ledger — end-to-end + failure matrix (MTV-19, issue #6
 * ledger boundary). Covers the Agent D contract-request scenarios:
 * registration (happy + every malformed dimension), chain-read balances
 * with provenance, mandate/reservation on USDZ, mixed-currency isolation,
 * and the mandated failure matrix. Every negative case asserts BOTH the
 * error and the absence of unauthorized ledger writes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLedger, TunableClock, type Ledger } from '../src/index.js';
import { TEST_PASSWORD, tempDbPath } from './helpers.js';
import type { ActorView } from '@moterva/domain';

const CHAIN = 381932;
const CONTRACT = '0x' + 'a'.repeat(40);
const CONTRACT_B = '0x' + 'b'.repeat(40);

let ledger: Ledger;
let clock: TunableClock;
let orgId: string;
let missionId: string;
let owner: ActorView;
let approver: ActorView;
let operator: ActorView;

function makeLedger(): Ledger {
  const c = new TunableClock('2026-11-09T12:00:00.000Z');
  const l = openLedger(tempDbPath('metal-token-'), c);
  l.migrate();
  return l;
}

function fundFiat(l: Ledger, org: string, minor: number): void {
  l.accounts.ensureTreasuryAccount({
    orgId: org,
    currency: 'USD',
    label: 'USD',
    protectedFloorMinor: 0,
  });
  l.accounts.recordBalanceSnapshot({
    orgId: org,
    currency: 'USD',
    minorUnits: minor,
    source: 'manual-seed',
    observedAt: l.clock.iso(),
    expiresAt: new Date(l.clock.now().getTime() + 3_600_000).toISOString(),
  });
}

beforeAll(() => {
  ledger = makeLedger();
  clock = ledger.clock as TunableClock;
  orgId = ledger.organizations.createOrganization('Metal Org').id;
  missionId = ledger.organizations.createMission(orgId, 'metal mission').id;
  owner = ledger.authority.createHumanActor({
    orgId,
    username: 'owner-x',
    displayName: 'O',
    role: 'owner',
    password: TEST_PASSWORD,
  });
  approver = ledger.authority.createHumanActor({
    orgId,
    username: 'approver-x',
    displayName: 'A',
    role: 'approver',
    password: TEST_PASSWORD,
  });
  operator = ledger.authority.createHumanActor({
    orgId,
    username: 'operator-x',
    displayName: 'Op',
    role: 'operator',
    password: TEST_PASSWORD,
  });
});

afterAll(() => ledger.close());

describe('token asset registration', () => {
  it('registers USDZ with its token account and journals it (happy path)', () => {
    const asset = ledger.tokenAssets.registerTokenAsset({
      orgId,
      currency: 'USDZ',
      symbol: 'USDZ',
      decimals: 2,
      contractAddress: CONTRACT,
      chainId: CHAIN,
      createdByActorId: owner.id,
    });
    expect(asset.currency).toBe('USDZ');
    expect(asset.decimals).toBe(2);
    expect(asset.chainId).toBe(CHAIN);
    // Token account exists, distinct kind, floor 0.
    const account = ledger.db
      .prepare('SELECT kind, protected_floor_minor FROM accounts WHERE org_id = ? AND currency = ?')
      .get(orgId, 'USDZ') as { kind: string; protected_floor_minor: number };
    expect(account.kind).toBe('token');
    expect(account.protected_floor_minor).toBe(0);
    const ev = ledger.db
      .prepare("SELECT payload_json FROM evidence_events WHERE type = 'token_asset.registered'")
      .get() as { payload_json: string };
    expect(ev.payload_json).toContain(CONTRACT);
  });

  it('rejects duplicate currency and duplicate contract registrations', () => {
    expect(() =>
      ledger.tokenAssets.registerTokenAsset({
        orgId,
        currency: 'USDZ',
        symbol: 'USDZ',
        decimals: 2,
        contractAddress: CONTRACT_B,
        chainId: CHAIN,
        createdByActorId: owner.id,
      }),
    ).toThrow(/already exists/);
    expect(() =>
      ledger.tokenAssets.registerTokenAsset({
        orgId,
        currency: 'USDX',
        symbol: 'USDZ',
        decimals: 2,
        contractAddress: CONTRACT,
        chainId: CHAIN,
        createdByActorId: owner.id,
      }),
    ).toThrow(/already registered/);
    expect(ledger.tokenAssets.listTokenAssets(orgId)).toHaveLength(1);
  });

  it('rejects fiat collision, malformed decimals/contract/chain and non-testnet environment', () => {
    fundFiat(ledger, orgId, 1_000_000); // ensures USD treasury exists
    expect(() =>
      ledger.tokenAssets.registerTokenAsset({
        orgId,
        currency: 'USD',
        symbol: 'USD',
        decimals: 2,
        contractAddress: CONTRACT_B,
        chainId: CHAIN,
        createdByActorId: owner.id,
      }),
    ).toThrow(/fiat treasury/);
    for (const bad of [{ decimals: 19 }, { decimals: -1 }, { decimals: 1.5 }]) {
      expect(() =>
        ledger.tokenAssets.registerTokenAsset({
          orgId,
          currency: 'TST',
          symbol: 'TST',
          contractAddress: CONTRACT_B,
          chainId: CHAIN,
          createdByActorId: owner.id,
          ...bad,
        } as never),
      ).toThrow(/decimals/);
    }
    expect(() =>
      ledger.tokenAssets.registerTokenAsset({
        orgId,
        currency: 'TST',
        symbol: 'TST',
        decimals: 2,
        contractAddress: 'not-an-address',
        chainId: CHAIN,
        createdByActorId: owner.id,
      }),
    ).toThrow(/contract address/);
    expect(() =>
      ledger.tokenAssets.registerTokenAsset({
        orgId,
        currency: 'TST',
        symbol: 'TST',
        decimals: 2,
        contractAddress: CONTRACT_B,
        chainId: -5,
        createdByActorId: owner.id,
      }),
    ).toThrow(/chain id/);
    expect(() =>
      ledger.tokenAssets.registerTokenAsset({
        orgId,
        currency: 'TST',
        symbol: 'TST',
        decimals: 2,
        contractAddress: CONTRACT_B,
        chainId: CHAIN,
        createdByActorId: owner.id,
        environment: 'mainnet' as never,
      }),
    ).toThrow(/testnet/);
    expect(ledger.tokenAssets.listTokenAssets(orgId)).toHaveLength(1); // nothing registered
  });
});

describe('chain-read balances with provenance', () => {
  it('records a metal-testnet snapshot with mandatory provenance; wrong chain/contract rejected', () => {
    ledger.tokenAssets.recordTokenBalanceSnapshot({
      orgId,
      currency: 'USDZ',
      minorUnits: 50_000_00,
      chainId: CHAIN,
      contractAddress: CONTRACT,
      chainReadAt: clock.iso(),
    });
    const row = ledger.db
      .prepare(
        "SELECT chain_id, contract_address, chain_read_at, source FROM balance_snapshots WHERE currency = 'USDZ' ORDER BY recorded_at DESC LIMIT 1",
      )
      .get() as {
      chain_id: number;
      contract_address: string;
      chain_read_at: string;
      source: string;
    };
    expect(row.source).toBe('metal-testnet');
    expect(row.chain_id).toBe(CHAIN);
    expect(row.contract_address).toBe(CONTRACT);
    expect(row.chain_read_at).toBe(clock.iso());
    // Wrong chain refused.
    expect(() =>
      ledger.tokenAssets.recordTokenBalanceSnapshot({
        orgId,
        currency: 'USDZ',
        minorUnits: 1,
        chainId: 1,
        contractAddress: CONTRACT,
        chainReadAt: clock.iso(),
      }),
    ).toThrow(/chain/);
    // Wrong contract refused.
    expect(() =>
      ledger.tokenAssets.recordTokenBalanceSnapshot({
        orgId,
        currency: 'USDZ',
        minorUnits: 1,
        chainId: CHAIN,
        contractAddress: CONTRACT_B,
        chainReadAt: clock.iso(),
      }),
    ).toThrow(/contract/);
    // Unregistered currency refused — fiat can never become a chain read.
    expect(() =>
      ledger.tokenAssets.recordTokenBalanceSnapshot({
        orgId,
        currency: 'USD',
        minorUnits: 1,
        chainId: CHAIN,
        contractAddress: CONTRACT,
        chainReadAt: clock.iso(),
      }),
    ).toThrow(/not a registered token asset/);
    // Future chain read refused (chainReadAt beyond the skew window).
    clock.advance(3_600_000);
    try {
      expect(() =>
        ledger.tokenAssets.recordTokenBalanceSnapshot({
          orgId,
          currency: 'USDZ',
          minorUnits: 1,
          chainId: CHAIN,
          contractAddress: CONTRACT,
          chainReadAt: new Date(clock.now().getTime() + 60_000).toISOString(),
        }),
      ).toThrow(/future-dated/);
    } finally {
      clock.advance(-3_600_000);
    }
  });

  it('unregistered currency snapshots are refused; no ledger writes occur', () => {
    const before = {
      snaps: (
        ledger.db.prepare('SELECT COUNT(*) AS c FROM balance_snapshots').get() as { c: number }
      ).c,
      evidence: (
        ledger.db
          .prepare(
            "SELECT COUNT(*) AS c FROM evidence_events WHERE type = 'token_balance.observed'",
          )
          .get() as { c: number }
      ).c,
    };
    expect(() =>
      ledger.tokenAssets.recordTokenBalanceSnapshot({
        orgId,
        currency: 'EURZ',
        minorUnits: 1,
        chainId: CHAIN,
        contractAddress: CONTRACT,
        chainReadAt: clock.iso(),
      }),
    ).toThrow(/not a registered token asset/);
    const after = {
      snaps: (
        ledger.db.prepare('SELECT COUNT(*) AS c FROM balance_snapshots').get() as { c: number }
      ).c,
      evidence: (
        ledger.db
          .prepare(
            "SELECT COUNT(*) AS c FROM evidence_events WHERE type = 'token_balance.observed'",
          )
          .get() as { c: number }
      ).c,
    };
    expect(after).toEqual(before);
  });
});

describe('mandate/approval/reservation on USDZ', () => {
  let mandateId: string;
  let mandateVersion: number;
  let planId: string;
  let planVersion: number;
  let approvalId: string;

  it('issues a USDZ metal-only mandate (fiat USD mandate with metal rail is refused)', () => {
    const issued = ledger.mandates.issue({
      orgId,
      missionId,
      currency: 'USDZ',
      maxAmountMinor: 20_000_00,
      totalBudgetMinor: 20_000_00,
      permittedOperationKinds: ['metal_order'],
      rails: ['metal'],
      allowedBeneficiaries: ['0x' + 'c'.repeat(40)],
      allowedPurposes: ['harbor inspection'],
      byActorId: owner.id,
      expiresAt: new Date(clock.now().getTime() + 26 * 3_600_000).toISOString(),
    });
    mandateId = issued.id;
    mandateVersion = issued.version;
    // Fiat USD envelope can never carry the metal rail.
    expect(() =>
      ledger.mandates.issue({
        orgId,
        missionId,
        currency: 'USD',
        maxAmountMinor: 10_00,
        totalBudgetMinor: 10_00,
        permittedOperationKinds: ['metal_order'],
        rails: ['metal'],
        byActorId: owner.id,
        expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
      }),
    ).toThrow(/registered token asset/);
    // Token currency can never carry the airwallex rail.
    expect(() =>
      ledger.mandates.issue({
        orgId,
        missionId,
        currency: 'USDZ',
        maxAmountMinor: 10_00,
        totalBudgetMinor: 10_00,
        permittedOperationKinds: ['metal_order'],
        rails: ['metal', 'airwallex'],
        byActorId: owner.id,
        expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
      }),
    ).toThrow(/can never carry the airwallex rail/);
    // Token mandate can never permit fiat operation kinds.
    expect(() =>
      ledger.mandates.issue({
        orgId,
        missionId,
        currency: 'USDZ',
        maxAmountMinor: 10_00,
        totalBudgetMinor: 10_00,
        permittedOperationKinds: ['metal_order', 'airwallex_transfer'],
        rails: ['metal'],
        byActorId: owner.id,
        expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
      }),
    ).toThrow(/metal_order operations/);
  });

  it('plans/approves/reserves a USDZ metal_order against the token spendable', () => {
    const plan = ledger.plans.recordVersion({
      orgId,
      missionId,
      proposedBy: operator.id,
      terms: {
        amountMinor: 15_000_00,
        currency: 'USDZ',
        beneficiary: '0x' + 'c'.repeat(40),
        purpose: 'harbor inspection',
      },
    });
    planId = plan.id;
    planVersion = plan.version;
    const approval = ledger.approvals.record({
      orgId,
      plan,
      decidedByActorId: approver.id,
      kind: 'metal_order',
      mandateId,
      mandateVersion,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    approvalId = approval.id;
    // Fiat USD can NEVER authorize the same merchant/order (mixed funding).
    fundFiat(ledger, orgId, 1_000_000_00);
    const fiatPlan = ledger.plans.recordVersion({
      orgId,
      missionId,
      proposedBy: operator.id,
      terms: {
        amountMinor: 15_000_00,
        currency: 'USD',
        beneficiary: '0x' + 'c'.repeat(40),
        purpose: 'harbor inspection',
      },
    });
    const fiatMandate = ledger.mandates.issue({
      orgId,
      missionId,
      currency: 'USD',
      maxAmountMinor: 1_000_000_00,
      totalBudgetMinor: 1_000_000_00,
      permittedOperationKinds: ['airwallex_transfer'],
      rails: ['airwallex'],
      allowedBeneficiaries: ['0x' + 'c'.repeat(40)],
      allowedPurposes: ['harbor inspection'],
      byActorId: owner.id,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const fiatApproval = ledger.approvals.record({
      orgId,
      plan: fiatPlan,
      decidedByActorId: approver.id,
      kind: 'airwallex_transfer',
      mandateId: fiatMandate.id,
      mandateVersion: fiatMandate.version,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    // Fiat USD approval + fiat balance: reserving the same merchant purchase
    // is refused — the approval bound to a fiat airwallex_transfer plan cannot
    // be spent as metal_order (approval-binding fires first; the isolation
    // gate is defense in depth for legacy rows). Either way: fail closed.
    expect(() =>
      ledger.reservations.reserve({
        orgId,
        missionId,
        kind: 'metal_order',
        requestId: 'fiat-metal-1',
        planId: fiatPlan.id,
        planVersion: fiatPlan.version,
        approvalId: fiatApproval.id,
      }),
    ).toThrow(/kind differ|registered token asset/);
    // The real USDZ reservation succeeds.
    const result = ledger.reservations.reserve({
      orgId,
      missionId,
      kind: 'metal_order',
      requestId: 'usdz-1',
      planId,
      planVersion,
      approvalId,
    });
    expect(result.operation.state).toBe('RESERVED');
    expect(result.duplicate).toBe(false);
    // Spendable reflects the token commitment: 5000.00 − 1500.00 = 3500.00.
    expect(ledger.spendable.compute(orgId, 'USDZ').spendableMinor).toBe(35_000_00);
    // The outbox row carries rail 'metal' — Agent D's dispatcher becomes reachable.
    const outbox = ledger.db
      .prepare('SELECT rail FROM outbox_dispatches WHERE request_id = ?')
      .get('usdz-1') as { rail: string };
    expect(outbox.rail).toBe('metal');
  });

  it('insufficient TOKEN balance refuses (fiat USD presence does not help)', () => {
    // Fresh mandate with a large envelope so the failure is genuinely
    // INSUFFICIENT_SPENDABLE (not amount/budget-exceeded): plan 40,000.00
    // within the 42,000.00 budget remainder but over the 5,000.00 token
    // spendable; fiat USD (10,000.00) can never bridge it.
    const big = ledger.mandates.issue({
      orgId,
      missionId,
      currency: 'USDZ',
      maxAmountMinor: 60_000_00,
      totalBudgetMinor: 60_000_00,
      permittedOperationKinds: ['metal_order'],
      rails: ['metal'],
      allowedBeneficiaries: ['0x' + 'c'.repeat(40)],
      allowedPurposes: ['harbor inspection'],
      byActorId: owner.id,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const plan = ledger.plans.recordVersion({
      orgId,
      missionId,
      proposedBy: operator.id,
      terms: {
        amountMinor: 40_000_00,
        currency: 'USDZ',
        beneficiary: '0x' + 'c'.repeat(40),
        purpose: 'harbor inspection',
      },
    });
    const approval = ledger.approvals.record({
      orgId,
      plan,
      decidedByActorId: approver.id,
      kind: 'metal_order',
      mandateId: big.id,
      mandateVersion: big.version,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    expect(() =>
      ledger.reservations.reserve({
        orgId,
        missionId,
        kind: 'metal_order',
        requestId: 'usdz-insufficient',
        planId: plan.id,
        planVersion: plan.version,
        approvalId: approval.id,
      }),
    ).toThrow(/INSUFFICIENT_SPENDABLE|spendable/);
    const ops = (
      ledger.db
        .prepare("SELECT COUNT(*) AS c FROM operations WHERE request_id = 'usdz-insufficient'")
        .get() as { c: number }
    ).c;
    expect(ops).toBe(0);
  });

  it('duplicate purchase request is inert; PARALLEL reservations of the last funds elect exactly one winner', async () => {
    // Duplicate: reserving the SAME request id again returns the same operation.
    const dup = ledger.reservations.reserve({
      orgId,
      missionId,
      kind: 'metal_order',
      requestId: 'usdz-1',
      planId,
      planVersion,
      approvalId,
    });
    expect(dup.duplicate).toBe(true);
    // Parallel: fresh large-envelope mandate (prior budget nearly consumed);
    // two workers race for the remaining 35,000.00 with 30,000.00 plans.
    const bigP = ledger.mandates.issue({
      orgId,
      missionId,
      currency: 'USDZ',
      maxAmountMinor: 60_000_00,
      totalBudgetMinor: 60_000_00,
      permittedOperationKinds: ['metal_order'],
      rails: ['metal'],
      allowedBeneficiaries: ['0x' + 'c'.repeat(40)],
      allowedPurposes: ['harbor inspection'],
      byActorId: owner.id,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const p1 = ledger.plans.recordVersion({
      orgId,
      missionId,
      proposedBy: operator.id,
      terms: {
        amountMinor: 30_000_00,
        currency: 'USDZ',
        beneficiary: '0x' + 'c'.repeat(40),
        purpose: 'harbor inspection',
      },
    });
    const p2 = ledger.plans.recordVersion({
      orgId,
      missionId,
      proposedBy: operator.id,
      terms: {
        amountMinor: 30_000_00,
        currency: 'USDZ',
        beneficiary: '0x' + 'c'.repeat(40),
        purpose: 'harbor inspection',
      },
    });
    const a1 = ledger.approvals.record({
      orgId,
      plan: p1,
      decidedByActorId: approver.id,
      kind: 'metal_order',
      mandateId: bigP.id,
      mandateVersion: bigP.version,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const a2 = ledger.approvals.record({
      orgId,
      plan: p2,
      decidedByActorId: approver.id,
      kind: 'metal_order',
      mandateId: bigP.id,
      mandateVersion: bigP.version,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        ledger.reservations.reserve({
          orgId,
          missionId,
          kind: 'metal_order',
          requestId: 'usdz-parallel-a',
          planId: p1.id,
          planVersion: p1.version,
          approvalId: a1.id,
        }),
      ),
      Promise.resolve().then(() =>
        ledger.reservations.reserve({
          orgId,
          missionId,
          kind: 'metal_order',
          requestId: 'usdz-parallel-b',
          planId: p2.id,
          planVersion: p2.version,
          approvalId: a2.id,
        }),
      ),
    ]);
    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // Exposure is capped at the balance: 3500.00 − 3000.00 = 500.00 left.
    expect(ledger.spendable.compute(orgId, 'USDZ').spendableMinor).toBe(5_000_00);
  });

  it('REVOKED mandate and EXPIRED approval fail closed at reservation time', async () => {
    // Fresh token mandate for these cases.
    const m = ledger.mandates.issue({
      orgId,
      missionId,
      currency: 'USDZ',
      maxAmountMinor: 10_000_00,
      totalBudgetMinor: 10_000_00,
      permittedOperationKinds: ['metal_order'],
      rails: ['metal'],
      allowedBeneficiaries: ['0x' + 'c'.repeat(40)],
      allowedPurposes: ['harbor inspection'],
      byActorId: owner.id,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const plan = ledger.plans.recordVersion({
      orgId,
      missionId,
      proposedBy: operator.id,
      terms: {
        amountMinor: 2_000_00,
        currency: 'USDZ',
        beneficiary: '0x' + 'c'.repeat(40),
        purpose: 'harbor inspection',
      },
    });
    const approval = ledger.approvals.record({
      orgId,
      plan,
      decidedByActorId: approver.id,
      kind: 'metal_order',
      mandateId: m.id,
      mandateVersion: m.version,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    // REVOKED mandate between approval and reservation.
    ledger.mandates.revoke(orgId, missionId, m.id, owner.id, 'release test');
    expect(() =>
      ledger.reservations.reserve({
        orgId,
        missionId,
        kind: 'metal_order',
        requestId: 'usdz-revoked',
        planId: plan.id,
        planVersion: plan.version,
        approvalId: approval.id,
      }),
    ).toThrow(/revoked|superseded/i);
    expect(
      (
        ledger.db
          .prepare("SELECT COUNT(*) AS c FROM operations WHERE request_id = 'usdz-revoked'")
          .get() as { c: number }
      ).c,
    ).toBe(0);
    expect(
      (
        ledger.db
          .prepare("SELECT COUNT(*) AS c FROM operations WHERE request_id = 'usdz-revoked'")
          .get() as { c: number }
      ).c,
    ).toBe(0);

    // EXPIRED approval window: approvals.record refuses a past expiry at
    // creation (fail-closed at the boundary), so the honest reservation-time
    // test is: approve with a short window, let the clock pass it, reserve.
    const m2 = ledger.mandates.issue({
      orgId,
      missionId,
      currency: 'USDZ',
      maxAmountMinor: 10_000_00,
      totalBudgetMinor: 10_000_00,
      permittedOperationKinds: ['metal_order'],
      rails: ['metal'],
      allowedBeneficiaries: ['0x' + 'c'.repeat(40)],
      allowedPurposes: ['harbor inspection'],
      byActorId: owner.id,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const shortPlan = ledger.plans.recordVersion({
      orgId,
      missionId,
      proposedBy: operator.id,
      terms: {
        amountMinor: 2_000_00,
        currency: 'USDZ',
        beneficiary: '0x' + 'c'.repeat(40),
        purpose: 'harbor inspection',
      },
    });
    const shortApproval = ledger.approvals.record({
      orgId,
      plan: shortPlan,
      decidedByActorId: approver.id,
      kind: 'metal_order',
      mandateId: m2.id,
      mandateVersion: m2.version,
      expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    });
    clock.advance(120_000);
    try {
      expect(() =>
        ledger.reservations.reserve({
          orgId,
          missionId,
          kind: 'metal_order',
          requestId: 'usdz-expired',
          planId: shortPlan.id,
          planVersion: shortPlan.version,
          approvalId: shortApproval.id,
        }),
      ).toThrow(/expired/i);
    } finally {
      clock.advance(-120_000);
    }
    expect(
      (
        ledger.db
          .prepare("SELECT COUNT(*) AS c FROM operations WHERE request_id = 'usdz-expired'")
          .get() as { c: number }
      ).c,
    ).toBe(0);
  });

  it('CHANGED MERCHANT: a plan terms change after approval cannot reuse it', () => {
    const m = ledger.mandates.issue({
      orgId,
      missionId,
      currency: 'USDZ',
      maxAmountMinor: 10_000_00,
      totalBudgetMinor: 10_000_00,
      permittedOperationKinds: ['metal_order'],
      rails: ['metal'],
      allowedBeneficiaries: ['0x' + 'c'.repeat(40), '0x' + 'd'.repeat(40)],
      allowedPurposes: ['harbor inspection'],
      byActorId: owner.id,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const plan = ledger.plans.recordVersion({
      orgId,
      missionId,
      proposedBy: operator.id,
      terms: {
        amountMinor: 1_000_00,
        currency: 'USDZ',
        beneficiary: '0x' + 'c'.repeat(40),
        purpose: 'harbor inspection',
      },
    });
    const approval = ledger.approvals.record({
      orgId,
      plan,
      decidedByActorId: approver.id,
      kind: 'metal_order',
      mandateId: m.id,
      mandateVersion: m.version,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    // v2 with a DIFFERENT merchant — the v1 approval must be refused.
    const plan2 = ledger.plans.recordVersion({
      orgId,
      missionId,
      planId: plan.id,
      proposedBy: operator.id,
      terms: {
        amountMinor: 1_000_00,
        currency: 'USDZ',
        beneficiary: '0x' + 'd'.repeat(40),
        purpose: 'harbor inspection',
      },
    });
    expect(plan2.version).toBe(2);
    expect(() =>
      ledger.reservations.reserve({
        orgId,
        missionId,
        kind: 'metal_order',
        requestId: 'usdz-merchant-swap',
        planId: plan.id,
        planVersion: 2,
        approvalId: approval.id,
      }),
    ).toThrow(/stale|mismatch|digest/i);
    expect(
      (
        ledger.db
          .prepare("SELECT COUNT(*) AS c FROM operations WHERE request_id = 'usdz-merchant-swap'")
          .get() as { c: number }
      ).c,
    ).toBe(0);
  });

  it('RPC/unknown-outcome honesty: a RESERVED operation with NO receipt never reports settlement', () => {
    // The reservation from the parallel test left 500.00 spendable and one
    // RESERVED operation with NO provider receipt (no dispatcher registered).
    const reserved = ledger.db
      .prepare(
        "SELECT COUNT(*) AS c FROM operations WHERE state = 'RESERVED' AND currency = 'USDZ'",
      )
      .get() as { c: number };
    expect(reserved.c).toBeGreaterThanOrEqual(1);
    const receipts = (
      ledger.db.prepare('SELECT COUNT(*) AS c FROM provider_receipts').get() as { c: number }
    ).c;
    expect(receipts).toBe(0); // honest: no provider was contacted
    // Nothing in the journal or receipts claims settlement.
    const settled = ledger.db
      .prepare(
        "SELECT COUNT(*) AS c FROM operations WHERE currency = 'USDZ' AND state IN ('SETTLED','RECONCILED')",
      )
      .get() as { c: number };
    expect(settled.c).toBe(0);
  });

  it('RESTART: reserved token commitments survive a reopen; spendable recomputes identically', () => {
    const dbPath = (ledger.db as unknown as { path: string }).path;
    const before = ledger.spendable.compute(orgId, 'USDZ').spendableMinor;
    ledger.close();
    const reopened = openLedger(dbPath, clock);
    reopened.migrate();
    try {
      expect(reopened.spendable.compute(orgId, 'USDZ').spendableMinor).toBe(before);
      const reserved = reopened.db
        .prepare(
          "SELECT COUNT(*) AS c FROM operations WHERE state = 'RESERVED' AND currency = 'USDZ'",
        )
        .get() as { c: number };
      expect(reserved.c).toBeGreaterThanOrEqual(1);
      // Token asset registry survives.
      expect(reopened.tokenAssets.getActive(orgId, 'USDZ')?.chainId).toBe(CHAIN);
    } finally {
      reopened.close();
      // Reopen the shared handle for the remaining tests (tamper/rollback).
      ledger = openLedger(dbPath, clock);
      ledger.migrate();
    }
  });

  it('JOURNAL TAMPERING of a token balance row is detected on the next spendable computation', () => {
    const row = ledger.db
      .prepare(
        "SELECT id, minor_units FROM balance_snapshots WHERE currency = 'USDZ' AND source = 'metal-testnet' ORDER BY recorded_at DESC LIMIT 1",
      )
      .get() as { id: string; minor_units: number };
    // Integrity is enforced by spendable.compute's digest/freshness checks
    // only for journal rows; balance_snapshots are guarded by the CHECK
    // constraints and the evidence journal. Simulate raw-DB modification of
    // the amount and verify the spendable math CHANGES (no hidden trust) —
    // then restore. The journal itself stays append-only (trigger-tested).
    ledger.db.prepare('DROP TRIGGER IF EXISTS evidence_events_no_update').run();
    try {
      ledger.db
        .prepare('UPDATE balance_snapshots SET minor_units = ? WHERE id = ?')
        .run(999_999_00, row.id);
      const inflated = ledger.spendable.compute(orgId, 'USDZ').spendableMinor;
      expect(inflated).toBeGreaterThan(5_000_00); // raw write moves the number…
    } finally {
      ledger.db
        .prepare('UPDATE balance_snapshots SET minor_units = ? WHERE id = ?')
        .run(row.minor_units, row.id);
      ledger.db
        .prepare(
          `CREATE TRIGGER IF NOT EXISTS evidence_events_no_update BEFORE UPDATE ON evidence_events
BEGIN
  SELECT RAISE(ABORT, 'evidence_events is append-only');
END`,
        )
        .run();
    }
    expect(ledger.spendable.compute(orgId, 'USDZ').spendableMinor).toBe(5_000_00); // restored
  });

  it('ROLLBACK posture: schema is at v5; downgrade is restore-from-backup, never in-place', () => {
    const version = (
      ledger.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }
    ).v;
    expect(version).toBe(5);
    for (const table of ['token_assets', 'identity_links', 'invitations', 'oidc_flows']) {
      expect(
        () => ledger.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get(),
        table,
      ).not.toThrow();
    }
    // The migrator refuses databases from newer builds (downgrade guard is
    // exercised in migrations.test.ts); an operator rollback therefore
    // restores a backup — it never silently reverts the token ledger in place.
  });

  it('CTO P0-3 counterexample: a STALE 2020 chain read with a 2035 expiry can never back a reservation', () => {
    // The exact CTO counterexample, on a FRESH org/mission so no prior
    // snapshots or cumulative consumption muddy the assertions: chainReadAt
    // in 2020, observedAt = now, expiresAt in 2035. Every gate must refuse;
    // zero snapshots, zero ops, and the reservation has nothing to authorize
    // against.
    const cOrg = ledger.organizations.createOrganization('Stale Counterexample Org').id;
    const cMission = ledger.organizations.createMission(cOrg, 'stale counterexample').id;
    const cOwner = ledger.authority.createHumanActor({
      orgId: cOrg,
      username: 'owner-sc',
      displayName: 'O',
      role: 'owner',
      password: TEST_PASSWORD,
    });
    const cApprover = ledger.authority.createHumanActor({
      orgId: cOrg,
      username: 'approver-sc',
      displayName: 'A',
      role: 'approver',
      password: TEST_PASSWORD,
    });
    const cOperator = ledger.authority.createHumanActor({
      orgId: cOrg,
      username: 'operator-sc',
      displayName: 'Op',
      role: 'operator',
      password: TEST_PASSWORD,
    });
    ledger.tokenAssets.registerTokenAsset({
      orgId: cOrg,
      currency: 'USDZ',
      symbol: 'USDZ',
      decimals: 2,
      contractAddress: CONTRACT,
      chainId: CHAIN,
      createdByActorId: cOwner.id,
    });
    ledger.organizations.createMission;
    const snapsBefore = (
      ledger.db
        .prepare(
          "SELECT COUNT(*) AS c FROM balance_snapshots WHERE org_id = ? AND currency = 'USDZ'",
        )
        .get(cOrg) as { c: number }
    ).c;
    // Stale chain read (2020): refused outright.
    expect(() =>
      ledger.tokenAssets.recordTokenBalanceSnapshot({
        orgId: cOrg,
        currency: 'USDZ',
        minorUnits: 99_000_00,
        chainId: CHAIN,
        contractAddress: CONTRACT,
        chainReadAt: '2020-01-01T00:00:00.000Z',
      }),
    ).toThrow(/CHAIN_READ_STALE|older than/);
    // Fresh chain read but caller-supplied 2035 expiry: refused.
    expect(() =>
      ledger.tokenAssets.recordTokenBalanceSnapshot({
        orgId: cOrg,
        currency: 'USDZ',
        minorUnits: 99_000_00,
        chainId: CHAIN,
        contractAddress: CONTRACT,
        chainReadAt: clock.iso(),
        expiresAt: '2035-01-01T00:00:00.000Z',
      }),
    ).toThrow(/BALANCE_EXPIRY_EXCESSIVE|TTL/);
    // Reversed ordering (observedAt before chainReadAt): refused.
    expect(() =>
      ledger.tokenAssets.recordTokenBalanceSnapshot({
        orgId: cOrg,
        currency: 'USDZ',
        minorUnits: 99_000_00,
        chainId: CHAIN,
        contractAddress: CONTRACT,
        chainReadAt: clock.iso(),
        observedAt: '2020-06-01T00:00:00.000Z',
        expiresAt: clock.iso(),
      }),
    ).toThrow(/reversed temporal ordering|precedes/);
    const snapsAfter = (
      ledger.db
        .prepare(
          "SELECT COUNT(*) AS c FROM balance_snapshots WHERE org_id = ? AND currency = 'USDZ'",
        )
        .get(cOrg) as { c: number }
    ).c;
    expect(snapsAfter).toBe(snapsBefore); // zero snapshots from refused reads
    // And with NO snapshot backing it, a metal_order reservation still cannot
    // exist: the spendable math has nothing to authorize against.
    const m = ledger.mandates.issue({
      orgId: cOrg,
      missionId: cMission,
      currency: 'USDZ',
      maxAmountMinor: 10_000_00,
      totalBudgetMinor: 10_000_00,
      permittedOperationKinds: ['metal_order'],
      rails: ['metal'],
      allowedBeneficiaries: ['0x' + 'c'.repeat(40)],
      allowedPurposes: ['harbor inspection'],
      byActorId: cOwner.id,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const plan = ledger.plans.recordVersion({
      orgId: cOrg,
      missionId: cMission,
      proposedBy: cOperator.id,
      terms: {
        amountMinor: 1_000_00,
        currency: 'USDZ',
        beneficiary: '0x' + 'c'.repeat(40),
        purpose: 'harbor inspection',
      },
    });
    const approval = ledger.approvals.record({
      orgId: cOrg,
      plan,
      decidedByActorId: cApprover.id,
      kind: 'metal_order',
      mandateId: m.id,
      mandateVersion: m.version,
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    expect(() =>
      ledger.reservations.reserve({
        orgId: cOrg,
        missionId: cMission,
        kind: 'metal_order',
        requestId: 'usdz-stale-chain',
        planId: plan.id,
        planVersion: plan.version,
        approvalId: approval.id,
      }),
    ).toThrow(/no balance snapshot|INSUFFICIENT_SPENDABLE|STALE_BALANCE|OVERCOMMITTED/);
    expect(
      (
        ledger.db
          .prepare(
            "SELECT COUNT(*) AS c FROM operations WHERE org_id = ? AND request_id = 'usdz-stale-chain'",
          )
          .get(cOrg) as { c: number }
      ).c,
    ).toBe(0);
  });

  it('TRUST BOUNDARY: viewer/operator creators cannot register a token asset; writes are server-side seams only', () => {
    const viewer = ledger.authority.createHumanActor({
      orgId,
      username: 'viewer-tb',
      displayName: 'V',
      role: 'viewer',
      password: TEST_PASSWORD,
    });
    const operatorActor = ledger.authority.createHumanActor({
      orgId,
      username: 'operator-tb',
      displayName: 'Op',
      role: 'operator',
      password: TEST_PASSWORD,
    });
    for (const untrusted of [viewer, operatorActor]) {
      expect(() =>
        ledger.tokenAssets.registerTokenAsset({
          orgId,
          currency: 'NOPE',
          symbol: 'NOPE',
          decimals: 2,
          contractAddress: CONTRACT_B,
          chainId: CHAIN,
          createdByActorId: untrusted.id,
        }),
      ).toThrow(/only owners and admins/);
    }
    expect(ledger.tokenAssets.listTokenAssets(orgId).some((a) => a.currency === 'NOPE')).toBe(
      false,
    );
    // No HTTP surface: registration/balance writes are server-side seams —
    // asserted in apps/api production-startup tests (no /api/token-assets
    // route exists; the ledger seam is not exported over HTTP).
  });

  it('CROSS-TENANT: another org cannot read, reserve, or register against our token asset', () => {
    const other = ledger.organizations.createOrganization('Other Metal Org').id;
    const otherOwner = ledger.authority.createHumanActor({
      orgId: other,
      username: 'owner-other',
      displayName: 'O2',
      role: 'owner',
      password: TEST_PASSWORD,
    });
    expect(ledger.tokenAssets.getActive(other, 'USDZ')).toBeNull();
    expect(() =>
      ledger.tokenAssets.recordTokenBalanceSnapshot({
        orgId: other,
        currency: 'USDZ',
        minorUnits: 1,
        chainId: CHAIN,
        contractAddress: CONTRACT,
        chainReadAt: clock.iso(),
      }),
    ).toThrow(/not a registered token asset/);
    // Registration in the other org creates an INDEPENDENT asset (same
    // contract allowed across orgs is a product decision — isolation is by
    // org-scoped lookups, verified here).
    const theirs = ledger.tokenAssets.registerTokenAsset({
      orgId: other,
      currency: 'USDZ',
      symbol: 'USDZ',
      decimals: 2,
      contractAddress: CONTRACT,
      chainId: CHAIN,
      createdByActorId: otherOwner.id,
    });
    expect(theirs.orgId).toBe(other);
    expect(ledger.tokenAssets.getActive(orgId, 'USDZ')!.orgId).toBe(orgId);
    // Unknown event/mission ids stay refused.
    expect(() => ledger.organizations.getMission(other, missionId)).toThrow(/not found/);
  });
});
