/**
 * OFFLINE TESTS — sponsor config gate, *USDZ money semantics, and the
 * metal-agent CLI outcome classification (issue #6 D1/D4; SPONSOR-AUDIT.md).
 * Everything runs on the labeled fixture runner — no network, no signing.
 */
import { describe, expect, it } from 'vitest';
import {
  loadSponsorConfig,
  sponsorSecretPaths,
  SPONSOR_TESTNET_CHAIN_ID,
  SPONSOR_USDZ_ADDRESS,
  SPONSOR_USDZ_DECIMALS,
  SPONSOR_FACILITATOR_URL,
  SPONSOR_CONSOLE_URL,
  SPONSOR_EXPLORER_URL,
  SPONSOR_CAIP2,
} from '../src/sponsor/config.js';
import { classify, NpxAgentCliRunner, payCommandLine } from '../src/sponsor/agent-cli.js';
import {
  usdzToBaseUnits,
  usdzFromBaseUnits,
  requirePositiveBaseUnits,
  UsdzError,
} from '../src/sponsor/usdz.js';

describe('sponsor config gate (verified constants)', () => {
  it('is disabled by default with the verified network parameters', () => {
    const config = loadSponsorConfig({});
    expect(config.enabled).toBe(false);
    expect(config.environment).toBe('disabled');
    expect(config.chainId).toBe(63825);
    expect(config.caip2).toBe('eip155:63825');
    expect(config.usdz).toEqual({
      address: '0x000000000000000000000000000000000000b5d5',
      symbol: '*USDZ',
      decimals: 18,
      eip712Version: '1',
    });
    expect(config.facilitatorUrl).toBe('https://x402-testnet.metalntwx.com/x402/facilitator');
    expect(config.consoleUrl).toBe('https://console-testnet.metalntwx.com');
    expect(config.explorerUrl).toBe('https://testnet.metalntwx.com');
    expect(config.demoPayeeUrl).toBe('https://x402-demo-testnet.metalntwx.com/quote');
  });

  it('rejects any other environment tag and names the legacy Tahoe path as not-a-substitute', () => {
    expect(() => loadSponsorConfig({ METAL_SPEND_ENV: 'testnet' })).toThrow(/sponsor-testnet/);
    expect(() => loadSponsorConfig({ METAL_SPEND_ENV: 'testnet' })).toThrow(/NOT the sponsor network/);
  });

  it('refuses a half-configured sponsor rail, naming each missing credential input', () => {
    expect(() => loadSponsorConfig({ METAL_SPEND_ENV: 'sponsor-testnet' })).toThrow(
      /METAL_RPC_URL.*METAL_AGENT_KEY_FILE.*METAL_MANDATE_CREDENTIAL/,
    );
    expect(() =>
      loadSponsorConfig({
        METAL_SPEND_ENV: 'sponsor-testnet',
        METAL_RPC_URL: 'https://rpc-testnet.metalntwx.com/v1/endpoint-secret',
      }),
    ).toThrow(/METAL_AGENT_KEY_FILE.*METAL_MANDATE_CREDENTIAL/);
  });

  it('enables with all inputs; the RPC endpoint URL never lands in any config field', () => {
    const env = {
      METAL_SPEND_ENV: 'sponsor-testnet',
      METAL_RPC_URL: 'https://rpc-testnet.metalntwx.com/v1/endpoint-secret',
      METAL_AGENT_KEY_FILE: '/keys/agent.json',
      METAL_MANDATE_CREDENTIAL: '/mandates/diagnostic.json',
      METAL_SPEND_APPROVED: 'founder-2026-11-10',
    };
    const config = loadSponsorConfig(env);
    expect(config.enabled).toBe(true);
    expect(config.environment).toBe('sponsor-testnet');
    expect(config.hasRpcEndpoint).toBe(true);
    expect(config.spendApproved).toBe(true);
    expect(JSON.stringify(config)).not.toContain('endpoint-secret');
    expect(JSON.stringify(config)).not.toContain('/keys/agent.json');
    const paths = sponsorSecretPaths(config, env);
    expect(paths).toEqual({
      rpcUrl: 'https://rpc-testnet.metalntwx.com/v1/endpoint-secret',
      agentKeyFile: '/keys/agent.json',
      mandateCredential: '/mandates/diagnostic.json',
    });
  });

  it('binds the per-payment cap in exact 18-decimal base units and rejects garbage', () => {
    expect(loadSponsorConfig({}).maxPaymentBaseUnits).toBe((1n * 10n ** 18n).toString()); // official default 1 *USDZ
    const capped = loadSponsorConfig({ METAL_MAX_PAYMENT_USDZ: '0.50' });
    expect(capped.maxPaymentBaseUnits).toBe((5n * 10n ** 17n).toString());
    expect(() => loadSponsorConfig({ METAL_MAX_PAYMENT_USDZ: '0.1234567890123456789' })).toThrow(
      /more than 18 fractional digits/,
    );
    expect(() => loadSponsorConfig({ METAL_MAX_PAYMENT_USDZ: '1e6' })).toThrow(/decimal/);
  });

  it('converts the information-value gate from cents to base units with integer math', () => {
    expect(loadSponsorConfig({ METAL_INFO_VALUE_CENTS: '250' }).infoValueBaseUnits).toBe(
      (250n * 10n ** 16n).toString(),
    );
    expect(() => loadSponsorConfig({ METAL_INFO_VALUE_CENTS: '-5' })).toThrow(/positive integer/);
    expect(() => loadSponsorConfig({ METAL_INFO_VALUE_CENTS: '2.5' })).toThrow(/positive integer/);
  });

  it('keeps the verified constants as exported values (no drift)', () => {
    expect(SPONSOR_TESTNET_CHAIN_ID).toBe(63825);
    expect(SPONSOR_USDZ_ADDRESS).toBe('0x000000000000000000000000000000000000b5d5');
    expect(SPONSOR_USDZ_DECIMALS).toBe(18);
    expect(SPONSOR_CAIP2).toBe('eip155:63825');
    expect(SPONSOR_FACILITATOR_URL).toBe('https://x402-testnet.metalntwx.com/x402/facilitator');
    expect(SPONSOR_CONSOLE_URL).toBe('https://console-testnet.metalntwx.com');
    expect(SPONSOR_EXPLORER_URL).toBe('https://testnet.metalntwx.com');
  });
});

describe('*USDZ money semantics (mirrors the official metal-pay baseUnits)', () => {
  it('converts decimal *USDZ to exact 18-decimal base units', () => {
    expect(usdzToBaseUnits('1')).toBe((1n * 10n ** 18n).toString());
    expect(usdzToBaseUnits('0.01')).toBe((1n * 10n ** 16n).toString());
    expect(usdzToBaseUnits('2.50')).toBe((25n * 10n ** 17n).toString());
    expect(usdzToBaseUnits('0.000000000000000001')).toBe('1');
    expect(usdzToBaseUnits('$1.50')).toBe((15n * 10n ** 17n).toString()); // $ prefix tolerated
  });

  it('rejects more fractional digits than 18 — money is never rounded', () => {
    expect(() => usdzToBaseUnits('0.0000000000000000001')).toThrow(UsdzError);
    expect(() => usdzToBaseUnits('1.0000000000000000001')).toThrow(/never rounded/);
  });

  it('rejects non-decimal garbage, zero and negative payments', () => {
    expect(() => usdzToBaseUnits('1e6')).toThrow(UsdzError);
    expect(() => usdzToBaseUnits('abc')).toThrow(UsdzError);
    expect(() => usdzToBaseUnits('-1.00')).toThrow(UsdzError);
    expect(() => requirePositiveBaseUnits('0')).toThrow(/strictly positive/);
    expect(() => requirePositiveBaseUnits('-5')).toThrow(UsdzError);
    expect(requirePositiveBaseUnits('1')).toBe('1');
  });

  it('formats base units back for humans (trailing zeros trimmed)', () => {
    expect(usdzFromBaseUnits((1n * 10n ** 18n).toString())).toBe('1');
    expect(usdzFromBaseUnits('1')).toBe('0.000000000000000001');
    expect(usdzFromBaseUnits((25n * 10n ** 17n).toString())).toBe('2.5');
  });
});

describe('official CLI outcome classification (the README taxonomy)', () => {
  it('classifies paid (exit 0), refused, refused-at-settlement and in-doubt', () => {
    const paid = classify(0, 'nonce: 0xabc\nexplorer: https://testnet.metalntwx.com/tx/0x' + 'a'.repeat(64) + '\ntransaction hash: 0x' + 'a'.repeat(64), '');
    expect(paid).toMatchObject({ phase: 'paid', movedValue: true });
    expect(paid.nonce).toBe('0xabc');
    expect(paid.txHash).toBe('0x' + 'a'.repeat(64));
    expect(paid.explorerUrl).toContain('testnet.metalntwx.com/tx/');

    const refused = classify(1, 'payment refused: mandate_cap_exceeded (1.50 > cap 1.00)\nnothing was paid', '');
    expect(refused).toMatchObject({ phase: 'refused', movedValue: false, refusalReason: 'mandate_cap_exceeded (1.50 > cap 1.00)' });

    const refusedSettled = classify(
      1,
      'payment refused at settlement: seller check failed\ntransaction hash: 0x' + 'b'.repeat(64) + '\nnothing was paid',
      '',
    );
    expect(refusedSettled).toMatchObject({ phase: 'refused-at-settlement', movedValue: false });
    expect(refusedSettled.txHash).toBe('0x' + 'b'.repeat(64)); // refusal recorded on chain, nothing moved

    const inDoubt = classify(1, 'payment in doubt at settlement: the answer was lost\ntransaction hash: 0x' + 'c'.repeat(64), '');
    expect(inDoubt).toMatchObject({ phase: 'in-doubt-at-settlement', movedValue: true });
  });

  it('classifies mandate-pull exit codes: pending 3, held 4', () => {
    expect(classify(3, 'pending', '').phase).toBe('pending');
    expect(classify(4, 'held in escrow', '').phase).toBe('held');
    expect(classify(2, 'unexpected', '').phase).toBe('failed');
  });

  it('redacts the credential paths from the printable command line', () => {
    const line = payCommandLine({
      url: 'https://x402-demo-testnet.metalntwx.com/quote',
      mandateCredentialPath: '/secrets/mandate.json',
      rpcUrl: 'https://rpc-testnet.metalntwx.com/v1/endpoint-secret',
      network: 'testnet',
    });
    expect(line).toContain('x402-demo-testnet.metalntwx.com/quote');
    expect(line).not.toContain('/secrets/mandate.json');
    expect(line).not.toContain('endpoint-secret');
    expect(line).toContain('@metalntwx/metal-agent');
  });

  it('a timeout on the real runner is reported as IN DOUBT-adjacent guidance (no outcome known)', async () => {
    const runner = new NpxAgentCliRunner({ timeoutMs: 1 });
    await expect(
      runner.pay({
        url: 'https://x402-demo-testnet.metalntwx.com/quote',
        mandateCredentialPath: '/x.json',
        rpcUrl: null,
        network: 'testnet',
      }),
    ).rejects.toThrow(/IN DOUBT|timed out/i);
  });
});
