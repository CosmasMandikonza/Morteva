/**
 * Provider-aware receipts for the Metal rail (MTV-19, Agent D contract R2).
 *
 * A metal receipt (provider 'metal', environment 'testnet', payload carrying
 * the adapter's durable identity: nonce, signed-tx hash, recovery metadata)
 * persists through the SAME allowlisted channel as Airwallex receipts —
 * with provider truth preserved, never relabeled — and survives restart.
 * Independence law: a receipt is evidence, never settlement; authorization
 * (mandate/approval/reservation), blockchain confirmation (adapter readback
 * receipt), and diagnostics delivery stay separate concerns.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, TunableClock, type Ledger } from '../src/index.js';
import { tempDbPath } from './helpers.js';

const DIR = mkdtempSync(join(tmpdir(), 'metal-receipts-'));
const DB = join(DIR, 'ledger.sqlite');
const clock = new TunableClock('2026-11-09T12:00:00.000Z');
let ledger: Ledger;

// Adapter-shaped receipt payload (allowlist-minimized: ids and hashes only,
// no keys, no oversized payloads).
const METAL_PAYLOAD = JSON.stringify({
  nonce: 7,
  txHash: '0x' + '9'.repeat(64),
  from: '0x' + '1'.repeat(40),
  to: '0x' + 'c'.repeat(40),
  chainId: 381932,
  amountMinor: 15_000_00,
  currency: 'USDZ',
  recovery: { status: 'broadcast', attempts: 1 },
});

beforeAll(() => {
  ledger = openLedger(DB, clock);
  ledger.migrate();
});

afterAll(() => {
  if (ledger.db.open) ledger.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe('metal testnet receipts through the shared channel', () => {
  let orgId: string;
  let operationId: string;

  it('persists a metal/testnet receipt with provider truth intact', () => {
    // An org + mission + a RESERVED USDZ operation as the receipt anchor.
    const org = ledger.organizations.createOrganization('Metal Receipt Org');
    orgId = org.id;
    const mission = ledger.organizations.createMission(org.id, 'receipt mission');
    const owner = ledger.authority.createHumanActor({
      orgId: org.id,
      username: 'owner-r',
      displayName: 'O',
      role: 'owner',
      password: 'dev-only-fixture',
    });
    const approver = ledger.authority.createHumanActor({
      orgId: org.id,
      username: 'approver-r',
      displayName: 'A',
      role: 'approver',
      password: 'dev-only-fixture',
    });
    ledger.tokenAssets.registerTokenAsset({
      orgId: org.id,
      currency: 'USDZ',
      symbol: 'USDZ',
      decimals: 2,
      contractAddress: '0x' + 'a'.repeat(40),
      chainId: 381932,
      createdByActorId: owner.id,
    });
    ledger.tokenAssets.recordTokenBalanceSnapshot({
      orgId: org.id,
      currency: 'USDZ',
      minorUnits: 50_000_00,
      chainId: 381932,
      contractAddress: '0x' + 'a'.repeat(40),
      chainReadAt: ledger.clock.iso(),
    });
    ledger.mandates.issue({
      orgId: org.id,
      missionId: mission.id,
      currency: 'USDZ',
      maxAmountMinor: 20_000_00,
      totalBudgetMinor: 20_000_00,
      permittedOperationKinds: ['metal_order'],
      rails: ['metal'],
      allowedBeneficiaries: ['0x' + 'c'.repeat(40)],
      allowedPurposes: ['harbor inspection'],
      byActorId: owner.id,
      expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
    });
    const plan = ledger.plans.recordVersion({
      orgId: org.id,
      missionId: mission.id,
      proposedBy: owner.id,
      terms: {
        amountMinor: 15_000_00,
        currency: 'USDZ',
        beneficiary: '0x' + 'c'.repeat(40),
        purpose: 'harbor inspection',
      },
    });
    const approval = ledger.approvals.record({
      orgId: org.id,
      plan,
      decidedByActorId: approver.id,
      kind: 'metal_order',
      mandateId: undefined,
      mandateVersion: undefined,
      expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
    });
    const reserved = ledger.reservations.reserve({
      orgId: org.id,
      missionId: mission.id,
      kind: 'metal_order',
      requestId: 'metal-rcpt-1',
      planId: plan.id,
      planVersion: plan.version,
      approvalId: approval.id,
    });
    operationId = reserved.operation.id;

    ledger.providerReceipts.append({
      provider: 'metal',
      orgId: org.id,
      operationId,
      requestId: 'metal-rcpt-1',
      providerResourceId: '0x' + '9'.repeat(64),
      kind: 'dispatch-create',
      environment: 'testnet',
      httpStatus: null,
      providerStatus: 'broadcast',
      payloadJson: METAL_PAYLOAD,
      recordedAt: '',
    });
    const stored = ledger.providerReceipts.listByRequestId('metal-rcpt-1', org.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.provider).toBe('metal'); // provider truth preserved
    expect(stored[0]!.environment).toBe('testnet');
    const parsed = JSON.parse(stored[0]!.payloadJson) as { nonce: number; txHash: string };
    expect(parsed.nonce).toBe(7); // durable identity round-trips
    expect(parsed.txHash).toBe('0x' + '9'.repeat(64));
    // DB row carries provider 'metal'.
    const row = ledger.db
      .prepare('SELECT provider, environment FROM provider_receipts WHERE request_id = ?')
      .get('metal-rcpt-1') as { provider: string; environment: string };
    expect(row.provider).toBe('metal');
    expect(row.environment).toBe('testnet');
  });

  it('an airwallex receipt written afterwards keeps its own provider (no relabeling)', () => {
    ledger.providerReceipts.append({
      provider: 'airwallex',
      orgId: orgId,
      operationId,
      requestId: 'metal-rcpt-1',
      providerResourceId: 'transfer_xfer',
      kind: 'readback-by-id',
      environment: 'sandbox',
      httpStatus: 200,
      providerStatus: 'PAID',
      payloadJson: JSON.stringify({ transferId: 'transfer_xfer', status: 'PAID' }),
      recordedAt: '',
    });
    const stored = ledger.providerReceipts.listByRequestId('metal-rcpt-1', orgId);
    expect(stored.map((r) => r.provider).sort()).toEqual(['airwallex', 'metal']);
    expect(stored.filter((r) => r.environment === 'testnet')).toHaveLength(1);
    expect(stored.filter((r) => r.environment === 'sandbox')).toHaveLength(1);
  });

  it('credential-shaped payloads are still refused on the metal path', () => {
    expect(() =>
      ledger.providerReceipts.append({
        provider: 'metal',
        orgId: orgId,
        operationId,
        requestId: 'metal-rcpt-key',
        providerResourceId: null,
        kind: 'dispatch-create',
        environment: 'testnet',
        httpStatus: null,
        providerStatus: null,
        payloadJson: JSON.stringify({ secret: '0x' + 'k'.repeat(64) }),
        recordedAt: '',
      }),
    ).toThrow(/credential material/);
  });

  it('RESTART: metal receipts and their durable identity survive the reopen', () => {
    ledger.close();
    const reopened = openLedger(DB, clock);
    reopened.migrate();
    try {
      const stored = reopened.providerReceipts.listByRequestId('metal-rcpt-1', orgId);
      expect(stored.length).toBeGreaterThanOrEqual(1);
      const metal = stored.find((r) => r.provider === 'metal')!;
      expect(JSON.parse(metal.payloadJson).txHash).toBe('0x' + '9'.repeat(64));
    } finally {
      reopened.close();
      ledger = openLedger(DB, clock);
      ledger.migrate();
    }
  });
});
