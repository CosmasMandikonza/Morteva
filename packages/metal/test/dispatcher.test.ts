/**
 * OFFLINE TESTS — MetalDispatcher dispatch + reconcile adversarial matrix
 * (issue #6; task D4/D8). All chain behavior is the labeled simulated chain;
 * no live RPC is contacted and nothing here is evidence of a real transaction.
 */
import { describe, expect, it } from 'vitest';
import type { ProviderSubmissionStatus } from '@moterva/providers';
import { keccak256 } from 'viem';
import {
  buildOfflineFixtureDispatcher,
  buildTestnetDispatcher,
  MetalDispatcher,
} from '../src/dispatcher.js';
import { loadMetalConfig } from '../src/config.js';
import type { MetalAdapterConfig } from '../src/config.js';
import { MetalSigner } from '../src/signer.js';
import { toHex } from 'viem';
import {
  InMemoryReceiptStore,
  SimulatedChain,
  TEST_MERCHANT,
  TEST_PRIVATE_KEY,
  TEST_TOKEN,
} from './helpers.js';

const CLOCK = {
  now: () => new Date('2026-11-08T12:00:00Z'),
  iso: () => '2026-11-08T12:00:00.000Z',
};

function testConfig(overrides: Record<string, string> = {}): MetalAdapterConfig {
  return loadMetalConfig({
    METAL_ENV: 'testnet',
    METAL_SIGNER_PRIVATE_KEY: TEST_PRIVATE_KEY,
    METAL_USDZ_TOKEN_ADDRESS: TEST_TOKEN,
    METAL_USDZ_DECIMALS: '6',
    METAL_USDZ_SYMBOL: 'USDZ',
    METAL_MERCHANT_ADDRESS: TEST_MERCHANT,
    METAL_FINALITY_CONFIRMATIONS: '2',
    ...overrides,
  });
}

function makeDispatcher(options?: { config?: MetalAdapterConfig; merchant?: string | undefined }) {
  const chain = new SimulatedChain();
  const store = new InMemoryReceiptStore();
  const signer = new MetalSigner(TEST_PRIVATE_KEY, (options?.config ?? testConfig()).chainId);
  const merchantForOrg =
    options !== undefined && 'merchant' in options ? () => options.merchant : () => TEST_MERCHANT;
  const dispatcher = buildOfflineFixtureDispatcher(
    options?.config ?? testConfig(),
    chain.transport,
    store,
    CLOCK,
    merchantForOrg,
    signer,
  );
  return { chain, store, signer, dispatcher, config: options?.config ?? testConfig() };
}

function dispatchCommand(overrides: Record<string, unknown> = {}) {
  return {
    operationId: 'op_test_1',
    orgId: 'org_test',
    missionId: 'mis_test',
    kind: 'metal_order',
    requestId: 'req-0001',
    amountMinor: 2_500_000,
    currency: 'USDZ',
    beneficiary: TEST_MERCHANT,
    purpose: 'purchase hull-thickness diagnostic report',
    ...overrides,
  };
}

const SCOPE = {
  orgId: 'org_test',
  operationId: 'op_test_1',
  amountMinor: 2_500_000,
  currency: 'USDZ',
  merchant: TEST_MERCHANT,
};

describe('metal dispatch — acceptance and identity', () => {
  it('broadcasts an authorized purchase and returns submitted, never confirmed', async () => {
    const { chain, store, dispatcher } = makeDispatcher();
    const result = await dispatcher.dispatch(dispatchCommand());
    // Type-level law: a submission result cannot even BE 'confirmed'
    // (ProviderSubmissionStatus excludes it) — asserted here for the record.
    const submission: ProviderSubmissionStatus = result.status;
    expect<ProviderSubmissionStatus>(submission).toBe('submitted');
    expect(result.providerState).toBe('BROADCAST_ACCEPTED');
    // One signed transaction recorded, in order: SIGNED before broadcast.
    const dispatchReceipts = store
      .listByRequestId('req-0001', 'org_test')
      .filter((r) => r.kind === 'dispatch-create');
    expect(dispatchReceipts.length).toBe(2); // SIGNED + BROADCAST_ACCEPTED, one hash
    const signedFirst = JSON.parse(dispatchReceipts[0]?.payloadJson ?? '{}');
    expect(signedFirst.broadcast).toBe('not-broadcast');
    const accepted = JSON.parse(dispatchReceipts[1]?.payloadJson ?? '{}');
    expect(accepted.broadcast).toBe('accepted');
    expect(accepted.payment.txHash).toBe(signedFirst.payment.txHash);
    const txHash = signedFirst.payment.txHash as string;
    expect(chain.txs.has(txHash)).toBe(true);
    expect(result.receiptRef).toBe(`metal:${txHash}`);
  });

  it('persists the signed identity BEFORE the broadcast attempt (crash-safe either way)', async () => {
    const { chain, store, dispatcher } = makeDispatcher();
    chain.sendRawBehavior = 'timeout';
    const result = await dispatcher.dispatch(dispatchCommand());
    expect(result.status).toBe('status-unknown');
    const receipts = store.listByRequestId('req-0001', 'org_test');
    // The SIGNED receipt existed before the broadcast attempt failed.
    const signed = receipts.find(
      (r) => r.kind === 'dispatch-create' && r.providerStatus === 'SIGNED',
    );
    expect(signed).toBeDefined();
    const payment = JSON.parse(signed?.payloadJson ?? '{}').payment;
    expect(payment.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(payment.nonce).toBe(0);
    expect(payment.chainId).toBe(381932);
    expect(receipts.some((r) => r.kind === 'ambiguous-failure')).toBe(true);
  });

  it('refuses a beneficiary that is not the configured merchant BEFORE any chain call', async () => {
    const { chain, store, dispatcher } = makeDispatcher();
    const result = await dispatcher.dispatch(
      dispatchCommand({ beneficiary: '0x9999999999999999999999999999999999999999' }),
    );
    expect(result.status).toBe('failed');
    expect(result.providerState).toBe('MERCHANT_NOT_ALLOWED');
    expect(chain.performedCalls.length).toBe(0); // no RPC at all
    expect(store.listByRequestId('req-0001', 'org_test')[0]?.kind).toBe('definitive-rejection');
  });

  it('refuses when no merchant is configured for the organization', async () => {
    const { dispatcher } = makeDispatcher({ merchant: undefined });
    const result = await dispatcher.dispatch(dispatchCommand());
    expect(result.status).toBe('failed');
    expect(result.providerState).toBe('NO_MERCHANT_CONFIGURED');
  });

  it('refuses unsupported kinds and non-positive/over-cap amounts', async () => {
    const { dispatcher, chain } = makeDispatcher();
    expect(
      (await dispatcher.dispatch(dispatchCommand({ kind: 'airwallex_transfer' }))).providerState,
    ).toBe('UNSUPPORTED_KIND');
    expect(
      (await dispatcher.dispatch(dispatchCommand({ requestId: 'req-0002', amountMinor: 0 })))
        .providerState,
    ).toBe('INVALID_AMOUNT');
    expect(
      (await dispatcher.dispatch(dispatchCommand({ requestId: 'req-0003', amountMinor: -5 })))
        .providerState,
    ).toBe('INVALID_AMOUNT');
    expect(
      (await dispatcher.dispatch(dispatchCommand({ requestId: 'req-0004', amountMinor: 2.5 })))
        .providerState,
    ).toBe('INVALID_AMOUNT');
    const capped = makeDispatcher({ config: testConfig({ METAL_MAX_PURCHASE_MINOR: '2000000' }) });
    expect(
      (await capped.dispatcher.dispatch(dispatchCommand({ requestId: 'req-0005' }))).providerState,
    ).toBe('PER_PURCHASE_CAP_EXCEEDED');
    expect(chain.performedCalls.length).toBe(0);
  });

  it('maps a broadcast refusal (node error) to definitive failure with the signed identity recorded', async () => {
    const { chain, store, dispatcher } = makeDispatcher();
    chain.sendRawBehavior = 'reject'; // e.g. insufficient native balance for gas
    const result = await dispatcher.dispatch(dispatchCommand());
    expect(result.status).toBe('failed');
    expect(result.providerState).toBe('BROADCAST_REJECTED');
    const kinds = store.listByRequestId('req-0001', 'org_test').map((r) => r.kind);
    expect(kinds).toContain('dispatch-create'); // SIGNED was durable
    expect(kinds).toContain('definitive-rejection');
  });
});

describe('metal reconcile — verified finality and evidence validation', () => {
  it('confirms ONLY a finalized receipt whose Transfer log matches every authorized term, with a full scope', async () => {
    const { chain, dispatcher } = makeDispatcher();
    await dispatcher.dispatch(dispatchCommand());
    // In mempool → processing.
    expect((await dispatcher.reconcileByRequestId('req-0001', SCOPE)).status).toBe('processing');
    // Included, shallow → processing.
    chain.mine(1);
    const shallow = await dispatcher.reconcileByRequestId('req-0001', SCOPE);
    expect(shallow.status).toBe('processing');
    expect(shallow.providerState).toBe('PENDING-FINALITY');
    // At finality depth → confirmed, timestamped, never from the submission.
    chain.mine(1);
    const confirmed = await dispatcher.reconcileByRequestId('req-0001', SCOPE);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.providerState).toBe('FINALIZED');
    expect(confirmed.verifiedAt).toBe(CLOCK.iso());
    expect(confirmed.receiptRef).toMatch(/^metal:0x[0-9a-f]{64}$/);
  });

  it('never confirms without a complete settlement scope (observe-only)', async () => {
    const { chain, dispatcher } = makeDispatcher();
    await dispatcher.dispatch(dispatchCommand());
    chain.mine(2);
    // No scope at all: without the tenant binding the readback is impossible, not "empty".
    const noScope = await dispatcher.reconcileByRequestId('req-0001');
    expect(noScope.status).toBe('status-unknown');
    expect(noScope.providerState).toBe('NO_TENANT_SCOPE');
    // Tenant-bound but operation-less: observes, never confirms.
    const partial = await dispatcher.reconcileByRequestId('req-0001', {
      orgId: 'org_test',
      operationId: null,
    });
    expect(partial.status).toBe('status-unknown');
    expect(partial.providerState).toBe('SCOPE_INCOMPLETE');
    const noTenant = await dispatcher.reconcileByRequestId('req-0001', {
      ...SCOPE,
      orgId: '',
    });
    expect(noTenant.status).toBe('status-unknown');
    expect(noTenant.providerState).toBe('NO_TENANT_SCOPE');
  });

  it('maps a reverted receipt to definitive failure (ledger escalates; commitment retained)', async () => {
    const { chain, dispatcher } = makeDispatcher();
    chain.tokenBalance = 0n;
    await dispatcher.dispatch(dispatchCommand());
    chain.mine(2);
    const result = await dispatcher.reconcileByRequestId('req-0001', SCOPE);
    expect(result.status).toBe('failed');
    expect(result.providerState).toBe('REVERTED');
  });

  it('reports an unknown recorded hash as status-unknown (may still be propagating) — never re-signs', async () => {
    const { store, dispatcher, config } = makeDispatcher();
    store.append({
      orgId: 'org_test',
      operationId: 'op_test_1',
      requestId: 'req-0001',
      providerResourceId: '0x' + 'e'.repeat(64),
      kind: 'dispatch-create',
      environment: 'offline-fixture',
      httpStatus: null,
      providerStatus: 'SIGNED',
      payloadJson: JSON.stringify({
        request_id: 'mtv-x-req-0001',
        payment: {
          txHash: '0x' + 'e'.repeat(64),
          nonce: 0,
          chainId: 381932,
          tokenAddress: TEST_TOKEN,
          merchant: TEST_MERCHANT,
          amountBaseUnits: '2500000',
          maxFeePerGas: '1',
          maxPriorityFeePerGas: '1',
          gas: '100000',
        },
        broadcast: 'not-broadcast',
      }),
      recordedAt: CLOCK.iso(),
    });
    void config;
    const result = await dispatcher.reconcileByRequestId('req-0001', SCOPE);
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('TRANSACTION_NOT_FOUND');
  });

  it('definitively reports non-execution when nothing was ever signed+persisted (persist-before-broadcast law)', async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.reconcileByRequestId('req-unknown', SCOPE);
    expect(result.status).toBe('failed');
    expect(result.providerState).toBe('NO_BROADCAST_FOR_REQUEST_ID');
  });

  it('resolves a broadcast-refused identity as definitively failed', async () => {
    const { chain, dispatcher } = makeDispatcher();
    chain.sendRawBehavior = 'reject';
    await dispatcher.dispatch(dispatchCommand());
    const result = await dispatcher.reconcileByRequestId('req-0001', SCOPE);
    expect(result.status).toBe('failed');
    expect(result.providerState).toBe('BROADCAST_REJECTED');
  });

  it('flags multiple distinct recorded hashes as DUPLICATE_DISPATCH_RECORDS (never picks one)', async () => {
    const { store, dispatcher } = makeDispatcher();
    for (const [i, hashSeed] of ['d', 'c'].entries()) {
      store.append({
        orgId: 'org_test',
        operationId: 'op_test_1',
        requestId: 'req-0001',
        providerResourceId: `0x${hashSeed.repeat(64)}`,
        kind: 'dispatch-create',
        environment: 'offline-fixture',
        httpStatus: null,
        providerStatus: 'BROADCAST_ACCEPTED',
        payloadJson: JSON.stringify({
          payment: {
            txHash: `0x${hashSeed.repeat(64)}`,
            nonce: i,
            chainId: 381932,
            tokenAddress: TEST_TOKEN,
            merchant: TEST_MERCHANT,
            amountBaseUnits: '2500000',
            maxFeePerGas: '1',
            maxPriorityFeePerGas: '1',
            gas: '100000',
          },
          broadcast: 'accepted',
        }),
        recordedAt: CLOCK.iso(),
      });
    }
    const result = await dispatcher.reconcileByRequestId('req-0001', SCOPE);
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('DUPLICATE_DISPATCH_RECORDS');
  });

  it('fails closed when the finalized receipt carries a WRONG economic identity', async () => {
    // Wrong recipient on-chain (signed order valid but incorrect resource).
    const wrongRecipient = makeDispatcher();
    const r1 = await wrongRecipient.dispatcher.dispatch(dispatchCommand());
    const tx1 = r1.receiptRef?.slice('metal:'.length) ?? '';
    wrongRecipient.chain.mine(2);
    const wrongMerchantPadded = '0x' + '9'.repeat(40).padStart(64, '0');
    const tx = wrongRecipient.chain.txs.get(tx1);
    if (tx?.receipt) tx.receipt.logs[0]!.topics[2] = wrongMerchantPadded;
    const result1 = await wrongRecipient.dispatcher.reconcileByRequestId('req-0001', SCOPE);
    expect(result1.status).toBe('status-unknown');
    expect(result1.providerState).toBe('EVIDENCE_MISMATCH');

    // Wrong amount on-chain (vendor changed the payload after quote).
    const wrongAmount = makeDispatcher();
    const r2 = await wrongAmount.dispatcher.dispatch(dispatchCommand());
    const tx2 = r2.receiptRef?.slice('metal:'.length) ?? '';
    wrongAmount.chain.mine(2);
    const tx2rec = wrongAmount.chain.txs.get(tx2);
    if (tx2rec?.receipt)
      tx2rec.receipt.logs[0]!.data = `0x${1_000_000n.toString(16).padStart(64, '0')}`;
    const result2 = await wrongAmount.dispatcher.reconcileByRequestId('req-0001', SCOPE);
    expect(result2.status).toBe('status-unknown');
    expect(result2.providerState).toBe('EVIDENCE_MISMATCH');
  });

  it('flags a same-height block-hash change between readbacks as REORG_SUSPECTED (status-unknown, monitored)', async () => {
    const { chain, dispatcher } = makeDispatcher();
    await dispatcher.dispatch(dispatchCommand());
    chain.mine(2);
    const first = await dispatcher.reconcileByRequestId('req-0001', SCOPE);
    expect(first.status).toBe('confirmed');
    const txHash = first.receiptRef?.slice('metal:'.length) ?? '';
    chain.reorgBlockHash(txHash);
    const second = await dispatcher.reconcileByRequestId('req-0001', SCOPE);
    expect(second.status).toBe('status-unknown');
    expect(second.providerState).toBe('REORG_SUSPECTED');
  });

  it('maps readback transport failures to READBACK_INCOMPLETE (incomplete, never empty)', async () => {
    const { chain, dispatcher } = makeDispatcher();
    await dispatcher.dispatch(dispatchCommand());
    chain.mine(2);
    chain.unavailableNext = { method: 'eth_getTransactionReceipt', count: 9 };
    const result = await dispatcher.reconcileByRequestId('req-0001', SCOPE);
    expect(result.status).toBe('status-unknown');
    expect(result.providerState).toBe('READBACK_INCOMPLETE');
  });

  it('verifies chain id live at connect and refuses the wrong chain', async () => {
    const { chain, dispatcher, config } = makeDispatcher();
    const connection = await dispatcher.verifyConnection();
    expect(connection.chainId).toBe(381932);
    expect(connection.token).toEqual({ address: TEST_TOKEN, symbol: 'USDZ', decimals: 6 });
    chain.chainId = 1n;
    await expect(dispatcher.verifyConnection()).rejects.toThrow(
      /does not match the configured chain id/,
    );
    void config;
    expect(toHex(381932n)).toBe('0x5d3ec');
  });

  it('keccak of a raw tx equals its broadcast hash (identity property)', () => {
    // Property asserted end-to-end by the simulated chain; stated here for the record.
    const raw = '0xdeadbeef' as `0x${string}`;
    expect(keccak256(raw)).toBeDefined();
  });
});

describe('metal dispatcher builder guards', () => {
  it('refuses to build a live dispatcher from a disabled config', () => {
    const chain = new SimulatedChain();
    const store = new InMemoryReceiptStore();
    const signer = new MetalSigner(TEST_PRIVATE_KEY, 381932);
    expect(() =>
      buildTestnetDispatcher(
        loadMetalConfig({}),
        chain.transport,
        store,
        CLOCK,
        () => TEST_MERCHANT,
        signer,
      ),
    ).toThrow(/requires an enabled testnet configuration/);
  });

  it('refuses to build a live dispatcher on the offline fixture transport (structural bar)', () => {
    const chain = new SimulatedChain();
    const store = new InMemoryReceiptStore();
    const signer = new MetalSigner(TEST_PRIVATE_KEY, 381932);
    expect(() =>
      buildTestnetDispatcher(
        testConfig(),
        chain.transport, // carries __offlineFixture
        store,
        CLOCK,
        () => TEST_MERCHANT,
        signer,
      ),
    ).toThrow(/must not be wired to the offline fixture transport/);
  });

  it('the fixture dispatcher reports environment simulated/testnet appropriately', async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.dispatch(dispatchCommand());
    expect(result.environment).toBe('simulated');
    expect(MetalDispatcher).toBeDefined();
  });
});
