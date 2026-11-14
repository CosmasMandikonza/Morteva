/**
 * OFFLINE TESTS — configuration gate (issue #6). Every input below is a
 * labeled fixture; the "private key" is a thrown-away test value.
 */
import { describe, expect, it } from 'vitest';
import { loadMetalConfig, TAHOE_CCHAIN_RPC_URL, TAHOE_CHAIN_ID } from '../src/config.js';
import { TEST_PRIVATE_KEY, TEST_MERCHANT, TEST_TOKEN } from './helpers.js';

describe('metal adapter configuration gate', () => {
  it('is disabled by default: no env means no rail, no calls, honest detail', () => {
    const config = loadMetalConfig({});
    expect(config.enabled).toBe(false);
    expect(config.environment).toBe('disabled');
    expect(config.rpcUrl).toBe(TAHOE_CCHAIN_RPC_URL);
    expect(config.chainId).toBe(TAHOE_CHAIN_ID);
  });

  it('fails closed on a half-configured testnet (never a silent partial rail)', () => {
    expect(() => loadMetalConfig({ METAL_ENV: 'testnet' })).toThrow(
      /METAL_ENV=testnet requires .*METAL_SIGNER_PRIVATE_KEY.*METAL_USDZ_TOKEN_ADDRESS/,
    );
    expect(() =>
      loadMetalConfig({
        METAL_ENV: 'testnet',
        METAL_SIGNER_PRIVATE_KEY: TEST_PRIVATE_KEY,
      }),
    ).toThrow(/METAL_USDZ_TOKEN_ADDRESS/);
  });

  it('rejects any environment other than testnet (production unsupported by construction)', () => {
    expect(() => loadMetalConfig({ METAL_ENV: 'mainnet' })).toThrow(/TAHOE TESTNET only/);
    expect(() => loadMetalConfig({ METAL_ENV: 'production' })).toThrow(/TAHOE TESTNET only/);
  });

  it('validates key, address and decimals shapes before anything else', () => {
    expect(() =>
      loadMetalConfig({
        METAL_ENV: 'testnet',
        METAL_SIGNER_PRIVATE_KEY: '0x1234',
        METAL_USDZ_TOKEN_ADDRESS: TEST_TOKEN,
        METAL_MERCHANT_ADDRESS: TEST_MERCHANT,
        METAL_USDZ_DECIMALS: '6',
        METAL_USDZ_SYMBOL: 'USDZ',
      }),
    ).toThrow(/METAL_SIGNER_PRIVATE_KEY/);
    expect(() =>
      loadMetalConfig({
        METAL_ENV: 'testnet',
        METAL_SIGNER_PRIVATE_KEY: TEST_PRIVATE_KEY,
        METAL_USDZ_TOKEN_ADDRESS: '0xnotanaddress',
        METAL_MERCHANT_ADDRESS: TEST_MERCHANT,
        METAL_USDZ_DECIMALS: '6',
        METAL_USDZ_SYMBOL: 'USDZ',
      }),
    ).toThrow(/METAL_USDZ_TOKEN_ADDRESS/);
    expect(() =>
      loadMetalConfig({
        METAL_ENV: 'testnet',
        METAL_SIGNER_PRIVATE_KEY: TEST_PRIVATE_KEY,
        METAL_USDZ_TOKEN_ADDRESS: TEST_TOKEN,
        METAL_MERCHANT_ADDRESS: TEST_MERCHANT,
        METAL_USDZ_DECIMALS: '25',
        METAL_USDZ_SYMBOL: 'USDZ',
      }),
    ).toThrow(/METAL_USDZ_DECIMALS/);
  });

  it('locks the RPC origin to the official Tahoe endpoint while credentials are configured (exfiltration boundary)', () => {
    const env = {
      METAL_ENV: 'testnet',
      METAL_SIGNER_PRIVATE_KEY: TEST_PRIVATE_KEY,
      METAL_USDZ_TOKEN_ADDRESS: TEST_TOKEN,
      METAL_MERCHANT_ADDRESS: TEST_MERCHANT,
      METAL_USDZ_DECIMALS: '6',
      METAL_USDZ_SYMBOL: 'USDZ',
    };
    expect(() =>
      loadMetalConfig({ ...env, METAL_RPC_URL: 'https://evil.example.com/ext/bc/C/rpc' }),
    ).toThrow(/not allowed while testnet signer credentials are configured/);
    expect(() =>
      loadMetalConfig({ ...env, METAL_RPC_URL: 'http://tahoe.metalblockchain.org/ext/bc/C/rpc' }),
    ).toThrow(/not allowed while testnet signer credentials are configured/);
    expect(() =>
      loadMetalConfig({ ...env, METAL_RPC_URL: 'https://tahoe.metalblockchain.org.evil.test/rpc' }),
    ).toThrow(/not allowed while testnet signer credentials are configured/);
    const ok = loadMetalConfig({ ...env, METAL_RPC_URL: TAHOE_CCHAIN_RPC_URL });
    expect(ok.enabled).toBe(true);
    expect(ok.allowedOrigin).toBe(new URL(TAHOE_CCHAIN_RPC_URL).origin);
  });

  it('allows a non-default HTTPS RPC only WITHOUT credentials (future tooling), never with them', () => {
    const offline = loadMetalConfig({
      METAL_RPC_URL: 'https://localhost:8545/rpc',
    });
    expect(offline.enabled).toBe(false);
    expect(offline.rpcUrl).toBe('https://localhost:8545/rpc');
  });

  it('rejects any chain id other than the official Tahoe value while enabled', () => {
    const env = {
      METAL_ENV: 'testnet',
      METAL_SIGNER_PRIVATE_KEY: TEST_PRIVATE_KEY,
      METAL_USDZ_TOKEN_ADDRESS: TEST_TOKEN,
      METAL_MERCHANT_ADDRESS: TEST_MERCHANT,
      METAL_USDZ_DECIMALS: '6',
      METAL_USDZ_SYMBOL: 'USDZ',
    };
    expect(() => loadMetalConfig({ ...env, METAL_CHAIN_ID: '1' })).toThrow(/chain id 381932/);
    const ok = loadMetalConfig({ ...env, METAL_CHAIN_ID: String(TAHOE_CHAIN_ID) });
    expect(ok.chainId).toBe(TAHOE_CHAIN_ID);
  });

  it('defaults finality confirmations to 12 and accepts an explicit override', () => {
    const env = {
      METAL_ENV: 'testnet',
      METAL_SIGNER_PRIVATE_KEY: TEST_PRIVATE_KEY,
      METAL_USDZ_TOKEN_ADDRESS: TEST_TOKEN,
      METAL_MERCHANT_ADDRESS: TEST_MERCHANT,
      METAL_USDZ_DECIMALS: '6',
      METAL_USDZ_SYMBOL: 'USDZ',
    };
    expect(loadMetalConfig(env).finalityConfirmations).toBe(12);
    expect(
      loadMetalConfig({ ...env, METAL_FINALITY_CONFIRMATIONS: '3' }).finalityConfirmations,
    ).toBe(3);
    expect(() => loadMetalConfig({ ...env, METAL_FINALITY_CONFIRMATIONS: '0' })).toThrow(
      /METAL_FINALITY_CONFIRMATIONS/,
    );
  });

  it('parses the per-purchase cap as exact non-negative token minor units', () => {
    const env = {
      METAL_ENV: 'testnet',
      METAL_SIGNER_PRIVATE_KEY: TEST_PRIVATE_KEY,
      METAL_USDZ_TOKEN_ADDRESS: TEST_TOKEN,
      METAL_MERCHANT_ADDRESS: TEST_MERCHANT,
      METAL_USDZ_DECIMALS: '6',
      METAL_USDZ_SYMBOL: 'USDZ',
    };
    expect(loadMetalConfig({ ...env, METAL_MAX_PURCHASE_MINOR: '2500000' }).maxPurchaseMinor).toBe(
      2_500_000n,
    );
    expect(() => loadMetalConfig({ ...env, METAL_MAX_PURCHASE_MINOR: '-1' })).toThrow(
      /METAL_MAX_PURCHASE_MINOR/,
    );
    expect(() => loadMetalConfig({ ...env, METAL_MAX_PURCHASE_MINOR: '2.5' })).toThrow(
      /METAL_MAX_PURCHASE_MINOR/,
    );
  });
});
