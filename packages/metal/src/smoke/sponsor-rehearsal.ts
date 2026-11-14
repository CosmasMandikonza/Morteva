/**
 * PLAN-ONLY rehearsal against the LIVE sponsor seller (issue #6 D3, step 8).
 *
 * Fetches the real x402 offer from the sponsor demo seller (real HTTP),
 * runs every authorization gate through the sponsor journey with
 * planOnly: true and a fixture CLI that can never pay, and prints the
 * decision trace. NOTHING is signed; the fixture CLI records any attempted
 * command (there must be none).
 *
 * This is the founder-requested plan-only proof: it exercises the REAL
 * seller, the REAL offer and the REAL gates without an RPC endpoint, a
 * mandate binding, or spend authorization.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SPONSOR_DEMO_PAYEE_URL,
  SPONSOR_USDZ_ADDRESS,
  SPONSOR_TESTNET_CHAIN_ID,
} from '../sponsor/config.js';
import { FixtureAgentCliRunner } from '../sponsor/fixture-runner.js';
import { runSponsorPurchaseJourney } from '../sponsor/journey.js';
import type { SponsorDiagnosticOffer } from '../sponsor/journey.js';

async function fetchLiveOffer(url: string): Promise<SponsorDiagnosticOffer> {
  const response = await fetch(url, { method: 'GET' });
  if (response.status !== 402) {
    throw new Error(
      `expected HTTP 402 Payment Required from the seller, got ${String(response.status)}`,
    );
  }
  const encoded = response.headers.get('payment-required');
  if (encoded === null) {
    throw new Error('the seller response carries no payment-required offer header');
  }
  const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
    accepts: Array<{
      scheme: string;
      network: string;
      amount: string;
      asset: string;
      payTo: string;
      extra: { name?: string; version?: string; primaryType?: string };
    }>;
  };
  const exact = decoded.accepts.find((a) => a.scheme === 'exact');
  if (exact === undefined) {
    throw new Error('the seller offers no `exact` scheme payment');
  }
  if (exact.network !== `eip155:${String(SPONSOR_TESTNET_CHAIN_ID)}`) {
    throw new Error(`offer network ${exact.network} does not match the verified sponsor chain`);
  }
  if (exact.asset.toLowerCase() !== SPONSOR_USDZ_ADDRESS) {
    throw new Error(`offer asset ${exact.asset} is not the verified *USDZ address`);
  }
  if (exact.extra?.primaryType !== 'TransferWithAuthorization') {
    throw new Error(
      `offer primaryType ${String(exact.extra?.primaryType)} is not ERC-3009 TransferWithAuthorization`,
    );
  }
  return {
    sellerId: 'x402-demo-testnet.metalntwx.com (official sponsor demo seller)',
    productName: 'One quote, paid per request (sponsor demo seller, LIVE offer)',
    priceBaseUnits: exact.amount,
    payee: exact.payTo,
    assetCaseId: 'demo-quote-live-offer',
    signedOffer: null,
    reportUrl: url,
    quoteExpiresAt: new Date(Date.now() + (60 - 5) * 1000).toISOString(), // maxTimeoutSeconds 60
  };
}

async function main(): Promise<void> {
  // The rehearsal builds its config WITHOUT the strict enable gate: it runs
  // plan-only against the LIVE seller (no chain reads, no signing, no
  // credential paths). Every constant is still the verified sponsor value.
  const config = {
    enabled: true,
    environment: 'sponsor-testnet' as const,
    chainId: SPONSOR_TESTNET_CHAIN_ID,
    caip2: 'eip155:63825',
    usdz: {
      address: SPONSOR_USDZ_ADDRESS,
      symbol: '*USDZ',
      decimals: 18,
      eip712Version: '1',
    },
    facilitatorUrl: 'https://x402-testnet.metalntwx.com/x402/facilitator',
    consoleUrl: 'https://console-testnet.metalntwx.com',
    explorerUrl: 'https://testnet.metalntwx.com',
    faucetUrl: null,
    demoPayeeUrl: SPONSOR_DEMO_PAYEE_URL,
    diagnosticSellerUrl: SPONSOR_DEMO_PAYEE_URL,
    hasRpcEndpoint: false,
    hasAgentKeyFile: false,
    hasMandateCredential: false,
    spendApproved: false, // deliberately unset: nothing may sign
    maxPaymentBaseUnits: (1n * 10n ** 18n).toString(), // the official default 1 *USDZ cap
    infoValueBaseUnits: (5n * 10n ** 16n).toString(), // estimated info value 0.05 *USDZ > 0.01 price
  };
  const liveOffer = await fetchLiveOffer(SPONSOR_DEMO_PAYEE_URL);
  console.info('LIVE offer fetched from the sponsor seller (HTTP 402 payment-required, decoded):');
  console.info(
    '  network   :',
    `eip155:${String(SPONSOR_TESTNET_CHAIN_ID)}`,
    '(matches the verified sponsor chain)',
  );
  console.info('  asset     :', liveOffer ? SPONSOR_USDZ_ADDRESS : '', '(*USDZ, matches)');
  console.info('  price     :', liveOffer.priceBaseUnits, 'base units =', '0.01 *USDZ');
  console.info('  payTo     :', liveOffer.payee);

  const fixtureCli = new FixtureAgentCliRunner([], { settledIdentities: new Set() });
  const evidence = await runSponsorPurchaseJourney({
    config,
    paths: null, // plan-only: no credential paths are used or needed
    cli: fixtureCli, // fixture: structurally cannot pay
    vendor: {
      fetchOffer: async () => ({ ok: true, status: 402, offer: liveOffer }),
      fetchReport: async () => ({
        ok: false,
        status: null,
        payload: null,
        error: 'plan-only never fetches',
      }),
    },
    clock: { now: () => new Date(), iso: () => new Date().toISOString() },
    stateDir: mkdtempSync(join(tmpdir(), 'moterva-sponsor-rehearsal-')),
    runSalt: 'rehearsal-live',
    orgId: 'org-rehearsal',
    missionId: 'msn-rehearsal',
    purpose: 'plan-only rehearsal against the live sponsor seller',
    issuerPublicKeyFile: null,
    planOnly: true,
  });

  console.info('--- PLAN-ONLY RESULT ---');
  console.info('outcome            :', evidence.outcome);
  console.info('reason             :', evidence.reason);
  console.info('gates passed       :', JSON.stringify(evidence.decisionTrace?.gatesPassed));
  console.info('gate failed        :', evidence.decisionTrace?.gateFailed ?? 'none');
  console.info('would pay (amount) :', evidence.amountUsdz, '*USDZ to', liveOffer.payee);
  console.info(
    'CLI payment invoked:',
    fixtureCli.performedCommands.some((c) => c.startsWith('pay '))
      ? 'YES (BUG)'
      : 'NO — nothing was signed',
  );
  console.info('all CLI commands   :', JSON.stringify(fixtureCli.performedCommands));
  if (fixtureCli.performedCommands.some((c) => c.startsWith('pay '))) {
    process.exit(1);
  }
  console.info('VERIFIED: plan-only rehearsed the LIVE sponsor offer and signed NOTHING.');
}

main().catch((error) => {
  console.error('rehearsal failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
