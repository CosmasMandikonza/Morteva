/**
 * OFFLINE TESTS — signer, ERC-20 helpers and on-chain status normalization
 * (issue #6). The private key here is a thrown-away test fixture; all chain
 * answers come from the in-memory simulated chain.
 */
import { describe, expect, it } from 'vitest';
import { keccak256, parseTransaction, toHex, recoverTransactionAddress } from 'viem';
import type { TransactionSerializedEIP1559 } from 'viem';
import { MetalSigner, transferCalldata, quantityHex } from '../src/signer.js';
import { buildTransferCalldata, discoverToken, TRANSFER_EVENT_TOPIC } from '../src/erc20.js';
import { decodeTransferLog, observeOnchain } from '../src/status.js';
import {
  SimulatedChain,
  TEST_MERCHANT,
  TEST_PRIVATE_KEY,
  TEST_TOKEN,
  TAHOE_CHAIN_ID_HEX,
} from './helpers.js';

describe('metal signer (server-only, EIP-1559)', () => {
  it('derives a stable address from the fixture key and signs a valid 1559 transfer', async () => {
    const chain = new SimulatedChain();
    const signer = new MetalSigner(TEST_PRIVATE_KEY, 381932);
    expect(signer.address).toMatch(/^0x[0-9a-f]{40}$/);
    const nonce = await signer.fetchNonce(chain.transport);
    expect(nonce).toBe(0);
    const signed = await signer.signTransfer({
      transport: chain.transport,
      tokenAddress: TEST_TOKEN,
      to: TEST_MERCHANT,
      amountBaseUnits: 2_500_000n,
      nonce,
    });
    expect(signed.txHash).toBe(keccak256(signed.rawTransaction as `0x${string}`).toLowerCase());
    const parsed = parseTransaction(signed.rawTransaction as TransactionSerializedEIP1559);
    expect(parsed.type).toBe('eip1559');
    expect(parsed.chainId).toBe(381932);
    expect(Number(parsed.nonce)).toBe(0);
    expect(parsed.to?.toLowerCase()).toBe(TEST_TOKEN);
    expect(parsed.data?.toLowerCase()).toBe(
      transferCalldata(TEST_MERCHANT, 2_500_000n).toLowerCase(),
    );
    const recovered = (
      await recoverTransactionAddress({
        serializedTransaction: signed.rawTransaction as TransactionSerializedEIP1559,
      })
    ).toLowerCase();
    expect(recovered).toBe(signer.address);
  });

  it('refuses to sign a second transaction for the same nonce in-process (duplicate signed order)', async () => {
    const chain = new SimulatedChain();
    const signer = new MetalSigner(TEST_PRIVATE_KEY, 381932);
    await signer.signTransfer({
      transport: chain.transport,
      tokenAddress: TEST_TOKEN,
      to: TEST_MERCHANT,
      amountBaseUnits: 1n,
      nonce: 7,
    });
    expect(signer.hasSignedNonce(7)).toBe(true);
    await expect(
      signer.signTransfer({
        transport: chain.transport,
        tokenAddress: TEST_TOKEN,
        to: TEST_MERCHANT,
        amountBaseUnits: 1n,
        nonce: 7,
      }),
    ).rejects.toThrow(/duplicate signed order/);
  });

  it('fails BEFORE signing when the gas estimate exceeds the sanity cap (a transfer that would revert)', async () => {
    const chain = new SimulatedChain();
    chain.estimate = 400_000n; // *1.5 headroom = 600k > 500k cap
    const signer = new MetalSigner(TEST_PRIVATE_KEY, 381932);
    await expect(
      signer.signTransfer({
        transport: chain.transport,
        tokenAddress: TEST_TOKEN,
        to: TEST_MERCHANT,
        amountBaseUnits: 1n,
        nonce: 0,
      }),
    ).rejects.toThrow(/sanity cap/);
    expect(signer.hasSignedNonce(0)).toBe(false);
  });

  it('produces conservative 1559 fee fields from the chain gas price', async () => {
    const chain = new SimulatedChain();
    chain.gasPrice = 2_000_000_000n; // 2 gwei
    const signer = new MetalSigner(TEST_PRIVATE_KEY, 381932);
    const signed = await signer.signTransfer({
      transport: chain.transport,
      tokenAddress: TEST_TOKEN,
      to: TEST_MERCHANT,
      amountBaseUnits: 1n,
      nonce: 0,
    });
    expect(signed.maxFeePerGas).toBe(4_000_000_000n);
    expect(signed.maxPriorityFeePerGas).toBe(1_000_000_000n);
  });
});

describe('erc20 helpers and token discovery', () => {
  it('encodes transfer calldata with the canonical selector', () => {
    const data = buildTransferCalldata(TEST_MERCHANT, 2_500_000n);
    expect(data.slice(0, 10)).toBe('0xa9059cbb');
    expect(data.slice(10 + 24, 10 + 64)).toBe(TEST_MERCHANT.replace(/^0x/, '').toLowerCase());
    expect(BigInt(`0x${data.slice(10 + 64, 10 + 128)}`)).toBe(2_500_000n);
  });

  it('discovers on-chain token metadata and cross-checks the configured expectation', async () => {
    const chain = new SimulatedChain();
    const token = await discoverToken(chain.transport, {
      address: TEST_TOKEN,
      symbol: 'USDZ',
      decimals: 6,
    });
    expect(token).toEqual({ address: TEST_TOKEN, symbol: 'USDZ', decimals: 6 });
  });

  it('refuses an address without contract code (never send value to a non-contract by mistake)', async () => {
    const chain = new SimulatedChain();
    chain.tokenCode = '0x';
    await expect(
      discoverToken(chain.transport, { address: TEST_TOKEN, symbol: 'USDZ', decimals: 6 }),
    ).rejects.toThrow(/holds no contract code/);
  });

  it('refuses when on-chain metadata contradicts the configured expectation', async () => {
    const chain = new SimulatedChain();
    chain.symbol = 'USDC';
    await expect(
      discoverToken(chain.transport, { address: TEST_TOKEN, symbol: 'USDZ', decimals: 6 }),
    ).rejects.toThrow(/does not match the configured expectation/);
    const chain2 = new SimulatedChain();
    chain2.decimals = 18;
    await expect(
      discoverToken(chain2.transport, { address: TEST_TOKEN, symbol: 'USDZ', decimals: 6 }),
    ).rejects.toThrow(/does not match the configured expectation/);
  });
});

describe('on-chain status normalization (conservative, reorg-aware)', () => {
  it('decodes a correct Transfer log and rejects wrong token/from/to/shape', () => {
    const from = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const to = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const receipt = {
      status: '0x1',
      blockNumber: toHex(100n),
      blockHash: '0x' + 'c'.repeat(64),
      logs: [
        {
          address: TEST_TOKEN,
          topics: [
            TRANSFER_EVENT_TOPIC,
            `0x${from.replace(/^0x/, '').padStart(64, '0')}`,
            `0x${to.replace(/^0x/, '').padStart(64, '0')}`,
          ],
          data: `0x${2500000n.toString(16).padStart(64, '0')}`,
          blockNumber: toHex(100n),
        },
      ],
    };
    expect(decodeTransferLog(receipt, { tokenAddress: TEST_TOKEN, from, to })).toEqual({
      from,
      to,
      value: 2_500_000n,
    });
    // wrong token
    expect(
      decodeTransferLog(receipt, {
        tokenAddress: '0x3333333333333333333333333333333333333333',
        from,
        to,
      }),
    ).toBeNull();
    // wrong recipient
    expect(
      decodeTransferLog(receipt, {
        tokenAddress: TEST_TOKEN,
        from,
        to: '0xcccccccccccccccccccccccccccccccccccccccc',
      }),
    ).toBeNull();
    // empty logs
    expect(
      decodeTransferLog({ status: '0x1', logs: [] }, { tokenAddress: TEST_TOKEN, from, to }),
    ).toBeNull();
  });

  it('maps the observation ladder: not-found → mempool → pending-finality → finalized, reverted separately', async () => {
    const chain = new SimulatedChain();
    const signer = new MetalSigner(TEST_PRIVATE_KEY, 381932);
    const nonce = await signer.fetchNonce(chain.transport);
    const signed = await signer.signTransfer({
      transport: chain.transport,
      tokenAddress: TEST_TOKEN,
      to: TEST_MERCHANT,
      amountBaseUnits: 2_500_000n,
      nonce,
    });
    // Not found before broadcast:
    expect(await observeOnchain(chain.transport, signed.txHash, 2)).toMatchObject({
      status: 'not-found',
    });
    // Broadcast (sim accepts and records):
    await chain.transport.call({
      method: 'eth_sendRawTransaction',
      params: [signed.rawTransaction],
    });
    expect(await observeOnchain(chain.transport, signed.txHash, 2)).toMatchObject({
      status: 'mempool',
    });
    // Included but shallow:
    chain.mine(1);
    expect(await observeOnchain(chain.transport, signed.txHash, 2)).toMatchObject({
      status: 'pending-finality',
      confirmations: 1,
    });
    // Deep enough:
    chain.mine(1);
    expect(await observeOnchain(chain.transport, signed.txHash, 2)).toMatchObject({
      status: 'finalized',
      confirmations: 2,
    });
  });

  it('reports reverted receipts as terminal failure (executed, rolled back)', async () => {
    const chain = new SimulatedChain();
    chain.tokenBalance = 0n; // the transfer will revert at execution
    const signer = new MetalSigner(TEST_PRIVATE_KEY, 381932);
    const nonce = await signer.fetchNonce(chain.transport);
    const signed = await signer.signTransfer({
      transport: chain.transport,
      tokenAddress: TEST_TOKEN,
      to: TEST_MERCHANT,
      amountBaseUnits: 2_500_000n,
      nonce,
    });
    await chain.transport.call({
      method: 'eth_sendRawTransaction',
      params: [signed.rawTransaction],
    });
    chain.mine(2);
    expect(await observeOnchain(chain.transport, signed.txHash, 2)).toMatchObject({
      status: 'reverted',
    });
  });

  it('detects a same-height block-hash change as REORG-SUSPECTED (never ignored)', async () => {
    const chain = new SimulatedChain();
    const signer = new MetalSigner(TEST_PRIVATE_KEY, 381932);
    const nonce = await signer.fetchNonce(chain.transport);
    const signed = await signer.signTransfer({
      transport: chain.transport,
      tokenAddress: TEST_TOKEN,
      to: TEST_MERCHANT,
      amountBaseUnits: 2_500_000n,
      nonce,
    });
    await chain.transport.call({
      method: 'eth_sendRawTransaction',
      params: [signed.rawTransaction],
    });
    chain.mine(2);
    const first = await observeOnchain(chain.transport, signed.txHash, 2);
    expect(first.status).toBe('finalized');
    chain.reorgBlockHash(signed.txHash);
    const second = await observeOnchain(chain.transport, signed.txHash, 2, {
      blockNumber: first.blockNumber as bigint,
      blockHash: first.blockHash as string,
    });
    expect(second.status).toBe('reorg-suspected');
  });

  it('exposes exact hex quantity helpers', () => {
    expect(quantityHex(381932n)).toBe(TAHOE_CHAIN_ID_HEX);
  });
});
