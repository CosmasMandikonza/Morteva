/**
 * GATED sponsor purchase smoke (issue #6 D3).
 *
 * Requires, in the server environment ONLY:
 *   METAL_SPEND_ENV=sponsor-testnet
 *   METAL_RPC_URL=<console-issued endpoint>   (credential-bearing; env only)
 *   METAL_AGENT_KEY_FILE=<agent key path>
 *   METAL_MANDATE_CREDENTIAL=<bound mandate credential>
 *   METAL_SPEND_APPROVED=<explicit founder approval token>
 * plus the SELLER env (METAL_DIAGNOSTIC_SELLER_URL) and offer terms. Without
 * any of these it exits 2 with a BLOCKED report and NEVER invokes the CLI.
 *
 * With everything configured it STILL stops before signing unless
 * --confirm is present. The actual payment is performed by the OFFICIAL
 * @metalntwx/metal-agent CLI; settlement is verified independently
 * (mandate verify) before the paid content is fetched; the delivery is
 * assessed separately. Redacted evidence is printed; the RPC endpoint and
 * key paths are never printed.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSponsorConfig, sponsorSecretPaths, SPONSOR_CONSOLE_URL } from '../sponsor/config.js';
import { NpxAgentCliRunner } from '../sponsor/agent-cli.js';
import { runSponsorPurchaseJourney } from '../sponsor/journey.js';

function blocked(reason: string): never {
  console.error('BLOCKED: ' + reason);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const confirm = args.has('--confirm');
  const planOnly = args.has('--plan'); // plan mode: read-only, enforced INSIDE the journey

  let config;
  try {
    config = loadSponsorConfig();
  } catch (error) {
    blocked(
      `sponsor purchase smoke is disabled: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const paths = sponsorSecretPaths(config);
  if (paths === null) {
    blocked(
      'sponsor purchase smoke is disabled: METAL_SPEND_ENV=sponsor-testnet with METAL_RPC_URL (an endpoint created at ' +
        SPONSOR_CONSOLE_URL +
        '), METAL_AGENT_KEY_FILE and METAL_MANDATE_CREDENTIAL are required. Nothing was signed.',
    );
  }

  // The price comes from the LIVE offer in plan-only mode; a pre-configured
  // price is only required for a signed run (--confirm).
  const priceBaseUnits = process.env.METAL_SMOKE_PRICE_BASE_UNITS ?? '';
  if (!planOnly && (priceBaseUnits === '' || !/^\d+$/.test(priceBaseUnits))) {
    blocked(
      'METAL_SMOKE_PRICE_BASE_UNITS (the signed offer price in *USDZ base units) is required',
    );
  }

  const evidence = await runSponsorPurchaseJourney({
    config,
    paths: paths as { rpcUrl: string; agentKeyFile: string; mandateCredential: string },
    cli: new NpxAgentCliRunner({ timeoutMs: 180_000 }),
    vendor: {
      fetchOffer: async (url) => {
        // The real seller speaks x402: an unpaid GET answers HTTP 402 with the
        // offer base64-encoded in the `payment-required` response header
        // (verified live against x402-demo-testnet.metalntwx.com). Some
        // sellers also serve the offer as the JSON body; both are parsed.
        try {
          const response = await fetch(url, { method: 'GET' });
          const header = response.headers.get('payment-required');
          if (header !== null && header !== '') {
            try {
              const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
                accepts?: Array<{
                  scheme: string;
                  network: string;
                  amount: string;
                  asset: string;
                  payTo: string;
                  maxTimeoutSeconds?: number;
                  extra?: { primaryType?: string };
                }>;
              };
              const exact = decoded.accepts?.find((a) => a.scheme === 'exact');
              if (exact === undefined) {
                return {
                  ok: false,
                  status: response.status,
                  offer: null,
                  error: 'the 402 offer names no exact-scheme payment',
                };
              }
              return {
                ok: true,
                status: response.status,
                offer: {
                  sellerId: 'x402-seller',
                  productName:
                    process.env.METAL_SMOKE_PRODUCT_NAME ?? 'SYNTHETIC diagnostic (testnet)',
                  priceBaseUnits: exact.amount,
                  payee: exact.payTo,
                  assetCaseId: process.env.METAL_SMOKE_ASSET_CASE_ID ?? 'case-smoke-1',
                  signedOffer: null,
                  reportUrl: url,
                  quoteExpiresAt: new Date(
                    Date.now() + (exact.maxTimeoutSeconds ?? 600) * 1000,
                  ).toISOString(),
                },
              };
            } catch (parseError) {
              return {
                ok: false,
                status: response.status,
                offer: null,
                error: `the payment-required header is not a decodable offer: ${
                  parseError instanceof Error ? parseError.message : String(parseError)
                }`,
              };
            }
          }
          const text = await response.text();
          try {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            const inner = (parsed.offer ?? parsed) as Record<string, unknown>;
            const payTo = String(inner.payTo ?? '');
            const price =
              typeof inner.price === 'object' && inner.price !== null
                ? String((inner.price as { amount?: string }).amount ?? '')
                : String(inner.price ?? '');
            return {
              ok: response.ok && payTo !== '' && price !== '',
              status: response.status,
              offer:
                payTo !== '' && price !== ''
                  ? {
                      sellerId: 'x402-seller',
                      productName:
                        process.env.METAL_SMOKE_PRODUCT_NAME ?? 'SYNTHETIC diagnostic (testnet)',
                      priceBaseUnits: price,
                      payee: payTo,
                      assetCaseId: process.env.METAL_SMOKE_ASSET_CASE_ID ?? 'case-smoke-1',
                      signedOffer: null,
                      reportUrl: url,
                      quoteExpiresAt: new Date(Date.now() + 600_000).toISOString(),
                    }
                  : null,
              error:
                payTo === '' || price === ''
                  ? 'the seller response did not name a payee and price'
                  : undefined,
            };
          } catch {
            return {
              ok: false,
              status: response.status,
              offer: null,
              error: 'the seller response is not JSON',
            };
          }
        } catch (error) {
          return {
            ok: false,
            status: null,
            offer: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      fetchReport: async (url) => {
        // The paid content: the official CLI already paid this URL, so a
        // plain GET is allowed within the payment's credit window.
        const response = await fetch(url, { method: 'GET' });
        if (!response.ok) return { ok: false, status: response.status, payload: null };
        return { ok: true, status: response.status, payload: await response.json() };
      },
    },
    planOnly,
    clock: { now: () => new Date(), iso: () => new Date().toISOString() },
    stateDir: process.env.METAL_SMOKE_STATE_DIR ?? join(tmpdir(), 'moterva-sponsor-smoke'),
    runSalt: process.env.METAL_SMOKE_RUN_SALT ?? String(Date.now()),
    orgId: process.env.METAL_SMOKE_ORG_ID ?? 'smoke-org',
    missionId: process.env.METAL_SMOKE_MISSION_ID ?? 'smoke-mission',
    purpose: process.env.METAL_SMOKE_PURPOSE ?? 'sponsor-testnet diagnostic purchase under mandate',
    issuerPublicKeyFile: process.env.METAL_ISSUER_PUBLIC_KEY_FILE ?? null,
  });

  console.info('sponsor purchase smoke outcome:', evidence.outcome);
  console.info('  reason        :', evidence.reason);
  console.info('  environment   :', evidence.environment);
  console.info('  payment id    :', evidence.paymentIdentity ?? 'none');
  console.info('  nonce         :', evidence.nonce ?? 'none');
  console.info('  tx hash       :', evidence.txHash ?? 'none');
  if (evidence.txHash !== null) {
    console.info('  explorer      : https://testnet.metalntwx.com/tx/' + evidence.txHash);
  }
  console.info('  amount        :', evidence.amountUsdz ?? 'none', '*USDZ');
  console.info(
    '  settlement    :',
    evidence.settlement === null
      ? 'not verified'
      : evidence.settlement.verified
        ? 'VERIFIED from the chain (mandate verify)'
        : 'NOT verified',
  );
  console.info(
    '  delivery      :',
    evidence.delivery === null
      ? 'not assessed'
      : evidence.delivery.delivered
        ? 'delivered (digest ' +
          (evidence.delivery.reportDigest ?? '').slice(0, 16) +
          '…; injection-quarantined: ' +
          String(evidence.delivery.injectionQuarantined) +
          ')'
        : 'NOT delivered — ' + (evidence.delivery.error ?? ''),
  );

  // Plan mode stops here regardless of outcome: read-only verification of
  // the offer/quote path never signs (planOnly is enforced inside the
  // journey; this final guard is defense in depth).
  if (planOnly) {
    console.info(
      'PLAN-ONLY RUN: the journey never invoked the CLI payment (enforced inside the journey). Pass --confirm with explicit founder approval to sign.',
    );
    process.exit(0);
  }
  if (!confirm) {
    blocked(
      'no --confirm: a signed payment requires explicit founder approval of environment, payee, amount and asset/case. Nothing was signed in this run.',
    );
  }
  if (evidence.outcome === 'blocked') process.exit(2);
  if (
    evidence.outcome === 'failed' ||
    evidence.outcome === 'unverified' ||
    evidence.outcome === 'in-doubt'
  )
    process.exit(1);
  process.exit(0);
}

main().catch((error) => {
  console.error(
    'sponsor purchase smoke failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
