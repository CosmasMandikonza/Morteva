/**
 * GATED Metal testnet purchase smoke — the operator-facing entry to the
 * agentic paid-information journey (issue #6; task D6).
 *
 * The journey core is side-effect-free (../journey.ts); this CLI:
 *  - refuses (exit 2, BLOCKED) without an enabled testnet configuration;
 *  - refuses without --confirm (fresh payments need explicit authorization);
 *  - takes the offer, decision and mandate gates from env/config so the
 *    operator authorizes environment + amount + currency + destination;
 *  - writes redacted evidence JSON into the smoke state directory;
 *  - exits: 0 confirmed/declined · 1 requires-human/unverified · 2 blocked.
 *
 * IMPORTANT HONESTY NOTES:
 *  - The diagnostic vendor here is a SYNTHETIC service (config-driven URL).
 *    Payment evidence is REAL on-chain evidence; delivery evidence is
 *    recorded separately and labeled SYNTHETIC — payment proves payment,
 *    never data quality.
 *  - Mandate/budget authority remains the ledger's (Agent A). Until the
 *    metal_order rail is ledger-enabled, this smoke enforces the SAME rules
 *    at the harness boundary and says so in its output.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpJsonRpcTransport } from '../chain-transport.js';
import { loadMetalConfig } from '../config.js';
import { MetalSigner } from '../signer.js';
import { runMetalPurchaseJourney } from '../journey.js';
import type { DiagnosticVendorClient } from '../journey.js';
import { FileReceiptStore } from '../file-receipt-store.js';

function blocked(reason: string): never {
  console.error('BLOCKED: ' + reason);
  process.exit(2);
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    blocked(`${name} must be a positive integer`);
  }
  return value;
}

class HttpVendorClient implements DiagnosticVendorClient {
  async fetchReport(
    url: string,
  ): Promise<{ ok: boolean; status: number | null; payload: unknown | null; error?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return { ok: false, status: response.status, payload: null };
      return { ok: true, status: response.status, payload: await response.json() };
    } catch (error) {
      return {
        ok: false,
        status: null,
        payload: null,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const confirm = args.has('--confirm');
  const newIntent = args.has('--new-intent');

  let config;
  try {
    config = loadMetalConfig();
  } catch (error) {
    blocked(
      `metal purchase smoke is disabled: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!config.enabled) {
    blocked(
      'metal purchase smoke is disabled: no testnet credentials configured (METAL_ENV=testnet + signer + USDZ token + decimals + symbol + merchant). The real-testnet gate stays BLOCKED; nothing is signed or broadcast.',
    );
  }

  const priceMinor = envNumber('METAL_SMOKE_PRICE_MINOR');
  if (priceMinor === undefined) {
    blocked('METAL_SMOKE_PRICE_MINOR (token minor units) is required — the documented offer price');
  }
  const informationValueMinor = envNumber('METAL_SMOKE_VALUE_MINOR');
  if (informationValueMinor === undefined) {
    blocked(
      'METAL_SMOKE_VALUE_MINOR (estimated information value, token minor units) is required — the no-purchase gate',
    );
  }
  const perPurchaseCapMinor = envNumber('METAL_MAX_PURCHASE_MINOR');
  if (perPurchaseCapMinor === undefined) {
    blocked('METAL_MAX_PURCHASE_MINOR (mandate per-purchase cap) is required');
  }
  const mandateExpiresAt = process.env.METAL_SMOKE_MANDATE_EXPIRES_AT ?? '';
  if (mandateExpiresAt === '' || Number.isNaN(Date.parse(mandateExpiresAt))) {
    blocked('METAL_SMOKE_MANDATE_EXPIRES_AT (ISO mandate expiry) is required');
  }
  const vendorId = process.env.METAL_SMOKE_VENDOR_ID ?? 'synthetic-diagnostics-testnet';
  const productName =
    process.env.METAL_SMOKE_PRODUCT_NAME ?? 'Diagnostic Information Product (SYNTHETIC vendor)';
  const reportUrl = process.env.METAL_SMOKE_REPORT_URL;

  const transport = new HttpJsonRpcTransport({
    rpcUrl: config.rpcUrl,
    allowedOrigin: config.allowedOrigin,
    requestTimeoutMs: config.requestTimeoutMs,
    idempotentReadRetries: config.idempotentReadRetries,
  });
  const signer = new MetalSigner(process.env.METAL_SIGNER_PRIVATE_KEY ?? '', config.chainId);
  const stateDir = resolve(
    process.env.METAL_SMOKE_STATE_DIR ?? join(tmpdir(), 'moterva-metal-purchase-smoke'),
  );
  mkdirSync(stateDir, { recursive: true });

  const evidence = await runMetalPurchaseJourney({
    config,
    transport,
    signer,
    store: new FileReceiptStore(stateDir), // durable JSONL journal; the ledger store is Agent A's contract
    clock: { now: () => new Date(), iso: () => new Date().toISOString() },
    merchantForOrg: () => config.merchantAddress ?? undefined,
    offer: {
      vendorId,
      productName,
      priceMinor: priceMinor as number,
      currency: 'USDZ',
      merchantAddress: config.merchantAddress ?? '',
      quoteExpiresAt: mandateExpiresAt as string,
      reportUrl,
    },
    decision: {
      informationValueMinor: informationValueMinor as number,
      orgId: process.env.METAL_SMOKE_ORG_ID ?? 'smoke-org',
      missionId: process.env.METAL_SMOKE_MISSION_ID ?? 'smoke-mission',
      purpose: process.env.METAL_SMOKE_PURPOSE ?? 'purchase diagnostic information under mandate',
    },
    gates: {
      perPurchaseCapMinor: perPurchaseCapMinor as number,
      mandateExpiresAt: mandateExpiresAt as string,
    },
    vendor: new HttpVendorClient(),
    stateDir,
    confirm,
    newIntent,
    reconcileDelayMs: 15_000,
  });

  // Redact on-chain addresses for console output (evidence keeps digests).
  console.info('metal purchase smoke outcome:', evidence.outcome);
  console.info('  reason         :', evidence.reason);
  console.info('  environment    :', evidence.environment);
  console.info('  request id     :', evidence.ledgerRequestId);
  console.info('  tx hash        :', evidence.txHash ?? 'none');
  if (evidence.txHash !== null) {
    console.info('  explorer       : https://tahoe.metalscan.io/tx/' + evidence.txHash);
  }
  console.info(
    '  settlement     :',
    evidence.settlement === null
      ? 'not verified'
      : `${evidence.settlement.onchainStatus} at ${evidence.settlement.verifiedAt}`,
  );
  console.info(
    '  delivery       :',
    evidence.delivery === null
      ? 'not assessed'
      : evidence.delivery.delivered
        ? 'delivered (SYNTHETIC vendor; quality assessed separately)'
        : `NOT delivered — ${evidence.delivery.error ?? 'unknown'}`,
  );
  if (evidence.decisionTrace !== null) {
    console.info('  decision gate  :', evidence.decisionTrace.gateFailed ?? 'all gates passed');
  }
  if (evidence.outcome === 'blocked') process.exit(2);
  if (evidence.outcome === 'requires-human' || evidence.outcome === 'unverified') process.exit(1);
  process.exit(0);
}

main().catch((error) => {
  console.error(
    'metal purchase smoke failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
