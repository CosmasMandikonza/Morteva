/**
 * The agentic paid-information journey (issue #6; task D6).
 *
 * PHYSICAL UNCERTAINTY → FINANCIAL EVALUATION → AUTHORIZED PURCHASE/REFUSAL
 * → GENUINE CHAIN PAYMENT → INDEPENDENTLY CHECKED OUTCOME → SEPARATELY
 * VERIFIED INFORMATION DELIVERY.
 *
 * The harness enforces every gate the repository requires at the adapter
 * boundary and is side-effect-free (CLI wrapper in smoke/purchase.ts; tests
 * drive this runner directly against the fixture transport):
 *
 *  - NAMED PRODUCT: the diagnostic product/vendor is explicit input
 *    (`DiagnosticOffer.vendorId`) — never an anonymous "data purchase".
 *  - DOCUMENTED PRICE: the offer carries an exact token-minor-unit price and
 *    currency, bound by an offer digest (sha256 over canonical terms).
 *  - CANDIDATE DECISION: purchase only when the quote is fresh, the price
 *    does not exceed the estimated information value, the per-purchase cap,
 *    the merchant allowlist and the verified token balance all permit it.
 *    A NO-PURCHASE case is a first-class outcome (`declined`), never an
 *    error — mirroring the planner's INFORMATION_NOT_WORTH_PRICE economics
 *    (the planner integration itself is Agent A's ledger-binding contract).
 *  - SIGNED ECONOMIC INTENT: the durable intent identity (org, operation,
 *    ledger request id, offer digest, price, merchant, purpose) is persisted
 *    BEFORE any signature; the signed tx hash is persisted BEFORE broadcast
 *    (dispatcher law).
 *  - SETTLEMENT vs DELIVERY ARE SEPARATE FACTS: settlement evidence comes
 *    only from the dispatcher's independent on-chain readback; delivery
 *    evidence comes only from the vendor client. Payment proves payment —
 *    never data quality, never delivery. Vendor payloads are UNTRUSTED:
 *    they are digested, shape-checked and instruction-quarantined; no free
 *    text from a paid report can ever reach financial authority.
 *  - ONE DURABLE INTENT per state directory (the Airwallex smoke safety
 *    model): exclusive lock, temp+rename atomic writes, missing/corrupt
 *    state never authorizes a new payment, rerun reconciles the SAME
 *    intent by its recorded identity, `--new-intent` requires every prior
 *    operation resolved and archives (never deletes) the prior state.
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '@moterva/domain';
import type { MetalAdapterConfig } from './config.js';
import type { JsonRpcTransport } from './chain-transport.js';
import { MetalDispatcher } from './dispatcher.js';
import type { MetalReceiptStore } from './dispatcher.js';
import type { MetalSigner } from './signer.js';
import { readNativeBalance, readTokenBalance, toQuantityHex } from './erc20.js';
import { minorToMajorString, TokenMoneyError } from './money.js';

export interface DiagnosticOffer {
  /** The specific named diagnostic information product/provider. */
  readonly vendorId: string;
  /** Product name as quoted (recorded verbatim in evidence). */
  readonly productName: string;
  /** Exact price in token minor units (USDZ). */
  readonly priceMinor: number;
  readonly currency: 'USDZ';
  /** The vendor's testnet payment address (must equal the configured merchant). */
  readonly merchantAddress: string;
  /** ISO timestamp after which the quote is stale. */
  readonly quoteExpiresAt: string;
  /** Vendor-reported report endpoint fetched AFTER payment (delivery evidence). */
  readonly reportUrl?: string;
}

export interface JourneyDecisionInput {
  /**
   * Estimated information value in token minor units — in production this is
   * the planner's value-of-information output (failure cost × gain, subject
   * to the diagnosticValueThreshold); the harness takes it as trusted input
   * and enforces the economic gate.
   */
  readonly informationValueMinor: number;
  /** Mission/org identity for the intent (tenant scope). */
  readonly orgId: string;
  readonly missionId: string;
  /** Machine purpose bound into the approval and receipts. */
  readonly purpose: string;
}

export interface JourneyGates {
  /** Per-purchase cap in token minor units (mandate per-action cap input). */
  readonly perPurchaseCapMinor: number;
  /** Mandate expiry — purchases after this instant are refused. */
  readonly mandateExpiresAt: string;
}

export interface DiagnosticVendorClient {
  /**
   * Fetches the paid report. UNTRUSTED data: implementations must never
   * interpret the payload beyond the returned shape.
   */
  fetchReport(
    url: string,
  ): Promise<{ ok: boolean; status: number | null; payload: unknown | null; error?: string }>;
}

export interface PurchaseEvidence {
  readonly outcome:
    'declined' | 'confirmed' | 'unverified' | 'requires-human' | 'blocked' | 'dispatched';
  readonly reason: string;
  readonly vendorId: string | null;
  readonly productName: string | null;
  readonly offerDigest: string | null;
  readonly ledgerRequestId: string | null;
  readonly providerRequestId: string | null;
  readonly txHash: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly environment: 'testnet' | 'offline-fixture' | 'disabled';
  readonly settlement: {
    readonly onchainStatus: string | null;
    readonly verifiedAt: string | null;
    readonly confirmations: number | null;
  } | null;
  readonly delivery: {
    readonly delivered: boolean;
    readonly status: number | null;
    readonly reportDigest: string | null;
    readonly reportShape: string | null;
    /** Quarantined instruction-like content found in the paid payload. */
    readonly injectionQuarantined: boolean;
    readonly error: string | null;
  } | null;
  readonly decisionTrace: {
    readonly informationValueMinor: number;
    readonly priceMinor: number;
    readonly capMinor: number;
    readonly mandateExpiresAt: string;
    readonly quoteExpiresAt: string;
    readonly gatesPassed: readonly string[];
    readonly gateFailed: string | null;
  } | null;
}

const INTENT_STATE_VERSION = 1;

interface IntentState {
  readonly version: typeof INTENT_STATE_VERSION;
  readonly outcomeStage: 'decided-purchase' | 'declined' | 'submitted' | 'settled' | 'failed';
  readonly orgId: string;
  readonly missionId: string;
  readonly purpose: string;
  readonly ledgerRequestId: string;
  readonly offer: DiagnosticOffer;
  readonly offerDigest: string;
  readonly informationValueMinor: number;
  readonly perPurchaseCapMinor: number;
  readonly mandateExpiresAt: string;
  readonly merchantAddress: string;
  readonly usdzTokenAddress: string;
  readonly usdzDecimals: number;
  readonly createdAt: string;
  readonly archivedPriorState: string | null;
}

export function offerDigestOf(offer: DiagnosticOffer): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        vendorId: offer.vendorId,
        productName: offer.productName,
        priceMinor: offer.priceMinor,
        currency: offer.currency,
        merchantAddress: offer.merchantAddress.toLowerCase(),
        quoteExpiresAt: offer.quoteExpiresAt,
      }),
    )
    .digest('hex');
}

/** External report payloads are untrusted; quarantine instruction-like content. */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?(prior|previous)\s+instructions/i,
  /you\s+are\s+now\s+/i,
  /system\s*:\s*/i,
  /(approve|transfer|release|spend)\s+(all\s+)?funds/i,
  /grant\s+(me\s+)?(admin|authority|access)/i,
  /</, // any markup/script content in a paid report
];

export function quarantineFindings(payload: unknown): boolean {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/** Minimal structural check of a paid report — shape, never semantics. */
function reportShapeOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const keys = Object.keys(payload as Record<string, unknown>).sort();
  return keys.join(',');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function writeStateAtomic(stateDir: string, name: string, state: unknown): void {
  const tmp = join(stateDir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, join(stateDir, name));
}

function exclusiveLock(stateDir: string): number | null {
  const lockPath = join(stateDir, 'journey.lock');
  try {
    // O_EXCL create with the handle HELD for the journey's duration:
    // exclusive across processes on the same volume (and an open handle
    // blocks deletion on most platforms — belt and braces).
    return openSync(lockPath, 'wx');
  } catch {
    return null;
  }
}

export interface MetalJourneyInput {
  readonly config: MetalAdapterConfig;
  readonly transport: JsonRpcTransport;
  readonly signer: MetalSigner;
  readonly store: MetalReceiptStore;
  readonly clock: { now(): Date; iso(): string };
  readonly merchantForOrg: (orgId: string) => string | undefined;
  readonly offer: DiagnosticOffer;
  readonly decision: JourneyDecisionInput;
  readonly gates: JourneyGates;
  readonly vendor: DiagnosticVendorClient;
  /** State directory (one durable intent per directory). */
  readonly stateDir: string;
  /** Explicit operator authorization for the actual payment. */
  readonly confirm: boolean;
  /** Explicit new intent: archives prior state, requires prior resolution. */
  readonly newIntent?: boolean;
  /** Max reconcile passes before reporting unverified (fixture tests use small values). */
  readonly maxReconcilePasses?: number;
  /** Milliseconds between reconcile passes (live default 15s; tests pass 1). */
  readonly reconcileDelayMs?: number;
  /** The ledger request id for this intent (persisted before any signature). */
  readonly ledgerRequestId?: string;
}

export async function runMetalPurchaseJourney(input: MetalJourneyInput): Promise<PurchaseEvidence> {
  const { config, clock, offer, decision, gates } = input;
  const evidenceBase = {
    vendorId: offer?.vendorId ?? null,
    productName: offer?.productName ?? null,
    ledgerRequestId: input.ledgerRequestId ?? null,
    providerRequestId: null,
    amountMinor: offer?.priceMinor ?? null,
    currency: offer?.currency ?? 'USDZ',
    environment: config.enabled
      ? (input.transport as { __offlineFixture?: boolean }).__offlineFixture === true
        ? 'offline-fixture'
        : 'testnet'
      : 'disabled',
  } as const;

  // Gate 0: an enabled configuration is required for any journey step
  // (decision, signature or readback).
  if (!config.enabled) {
    return {
      ...evidenceBase,
      outcome: 'blocked',
      reason:
        'pre-attempt BLOCKED: metal testnet configuration is not enabled (METAL_ENV + signer + USDZ token + merchant). The real-testnet gate stays honest; nothing was signed or broadcast',
      offerDigest: offer === undefined ? null : offerDigestOf(offer),
      txHash: null,
      settlement: null,
      delivery: null,
      decisionTrace: null,
    };
  }

  mkdirSync(input.stateDir, { recursive: true });
  const lock = exclusiveLock(input.stateDir);
  if (lock === null) {
    return {
      ...evidenceBase,
      outcome: 'blocked',
      reason: 'pre-attempt BLOCKED: another journey holds the state directory lock',
      offerDigest: null,
      txHash: null,
      settlement: null,
      delivery: null,
      decisionTrace: null,
    };
  }

  const statePath = join(input.stateDir, 'state.json');
  try {
    // One-intent policy: existing state ALWAYS wins. Reruns RECONCILE the
    // same intent by its recorded identity (read-only on-chain) without
    // requiring fresh authorization; only NEW signatures require --confirm.
    if (existsSync(statePath)) {
      let prior: IntentState | null = null;
      try {
        prior = JSON.parse(readFileSync(statePath, 'utf8')) as IntentState;
      } catch {
        return blockedEvidence(
          evidenceBase,
          'corrupt state.json — resolve manually; a corrupt state never authorizes a new payment',
        );
      }
      if (prior.version !== INTENT_STATE_VERSION) {
        return blockedEvidence(evidenceBase, 'unknown state version — resolve manually');
      }
      if (input.newIntent === true) {
        // A separate intent requires explicit new authorization AND the prior
        // intent fully resolved (definitive terminal outcome on-chain). The
        // prior state file is archived (never deleted) — the original
        // request id and tx hash stay recoverable from the archive.
        const resolution = await resolveOnce(input, prior);
        if (resolution !== 'confirmed' && resolution !== 'failed') {
          return blockedEvidence(
            evidenceBase,
            `--new-intent refused: prior intent ${prior.ledgerRequestId} is not resolved (reconcile status ${resolution}); reconcile or resolve it first — unresolved money is never abandoned`,
          );
        }
        const archivePath = join(input.stateDir, `state-${prior.ledgerRequestId}.json`);
        renameSync(statePath, archivePath);
        // Fall through to fresh setup below (the archive keeps the history).
      } else {
        // Reopen the SAME intent: reconcile by the original identity.
        return await reconcileExistingIntent(input, prior, evidenceBase);
      }
    }

    // Fresh intent: explicit operator authorization for an actual payment.
    if (!input.confirm) {
      return {
        ...evidenceBase,
        outcome: 'blocked',
        reason:
          'pre-attempt BLOCKED: payment requires --confirm (explicit owner authorization of environment, amount, currency and destination); nothing was signed or broadcast',
        offerDigest: offerDigestOf(offer),
        txHash: null,
        settlement: null,
        delivery: null,
        decisionTrace: null,
      };
    }

    // Fresh intent setup.
    const now = clock.now();
    const quoteExpired = Date.parse(offer.quoteExpiresAt) <= now.getTime();
    const mandateExpired = Date.parse(gates.mandateExpiresAt) <= now.getTime();
    const gatesPassed: string[] = [];
    const trace = {
      informationValueMinor: decision.informationValueMinor,
      priceMinor: offer.priceMinor,
      capMinor: gates.perPurchaseCapMinor,
      mandateExpiresAt: gates.mandateExpiresAt,
      quoteExpiresAt: offer.quoteExpiresAt,
      gatesPassed,
      gateFailed: null as string | null,
    };

    const fail = (gate: string, reason: string): PurchaseEvidence => {
      trace.gateFailed = gate;
      return {
        ...evidenceBase,
        outcome: 'declined',
        reason,
        offerDigest: offerDigestOf(offer),
        txHash: null,
        settlement: null,
        delivery: null,
        decisionTrace: trace,
      } as PurchaseEvidence;
    };

    // Decision gate 1: quote freshness.
    if (quoteExpired)
      return fail(
        'QUOTE_EXPIRED',
        `the vendor quote expired at ${offer.quoteExpiresAt}; no purchase`,
      );
    gatesPassed.push('quote-fresh');
    // Decision gate 2: mandate validity.
    if (mandateExpired)
      return fail(
        'MANDATE_EXPIRED',
        `the spending mandate expired at ${gates.mandateExpiresAt}; no purchase`,
      );
    gatesPassed.push('mandate-valid');
    // Decision gate 3: merchant allowlist.
    const configuredMerchant = input.merchantForOrg(decision.orgId);
    if (
      configuredMerchant === undefined ||
      offer.merchantAddress.toLowerCase() !== config.merchantAddress?.toLowerCase() ||
      offer.merchantAddress.toLowerCase() !== configuredMerchant.toLowerCase()
    ) {
      return fail(
        'MERCHANT_NOT_ALLOWED',
        'the offer merchant is not the permitted vendor address; no purchase',
      );
    }
    gatesPassed.push('merchant-allowed');
    // Decision gate 4: per-purchase cap.
    if (offer.priceMinor > gates.perPurchaseCapMinor) {
      return fail(
        'PER_PURCHASE_CAP_EXCEEDED',
        `price ${String(offer.priceMinor)} minor exceeds the per-purchase cap ${String(gates.perPurchaseCapMinor)} minor; no purchase`,
      );
    }
    gatesPassed.push('cap-ok');
    // Decision gate 5: the economics — information must be worth its price.
    if (decision.informationValueMinor < offer.priceMinor) {
      return fail(
        'INFORMATION_NOT_WORTH_PRICE',
        `estimated information value ${String(decision.informationValueMinor)} minor is below the price ${String(offer.priceMinor)} minor; the agent declines (no-purchase case)`,
      );
    }
    gatesPassed.push('economics-ok');

    // Verified funds gate (fresh chain reads, never assumed). Gas and token
    // balances are checked BEFORE any state persist or signature: an empty
    // gas wallet is a pre-attempt blocker, not an on-chain failure.
    let native: bigint;
    let token: bigint;
    try {
      native = await readNativeBalance(input.transport, input.signer.address);
      token = await readTokenBalance(
        input.transport,
        config.usdzTokenAddress as string,
        input.signer.address,
      );
    } catch (error) {
      return {
        ...evidenceBase,
        outcome: 'blocked',
        reason: `pre-attempt BLOCKED: chain balance read failed: ${error instanceof Error ? error.message : String(error)}`,
        offerDigest: offerDigestOf(offer),
        txHash: null,
        settlement: null,
        delivery: null,
        decisionTrace: trace,
      };
    }
    if (native <= 1_000_000_000_000n) {
      return {
        ...evidenceBase,
        outcome: 'blocked',
        reason:
          'pre-attempt BLOCKED: wallet native (gas) balance is effectively empty — fund the testnet wallet from the official faucet (https://faucet.metalblockchain.org) and rerun; nothing was signed or broadcast',
        offerDigest: offerDigestOf(offer),
        txHash: null,
        settlement: null,
        delivery: null,
        decisionTrace: trace,
      };
    }
    if (token < BigInt(offer.priceMinor)) {
      return fail(
        'INSUFFICIENT_USDZ',
        `wallet holds ${token.toString()} base units, price is ${String(offer.priceMinor)} minor; no purchase`,
      );
    }
    gatesPassed.push('funds-ok');

    // Durable intent BEFORE any signature (the signed intent identity).
    const ledgerRequestId =
      input.ledgerRequestId ??
      `metal-journey-${sha256Hex(`${decision.orgId}:${offer.vendorId}:${offerDigestOf(offer)}`).slice(0, 20)}`;
    const state: IntentState = {
      version: INTENT_STATE_VERSION,
      outcomeStage: 'decided-purchase',
      orgId: decision.orgId,
      missionId: decision.missionId,
      purpose: decision.purpose,
      ledgerRequestId,
      offer,
      offerDigest: offerDigestOf(offer),
      informationValueMinor: decision.informationValueMinor,
      perPurchaseCapMinor: gates.perPurchaseCapMinor,
      mandateExpiresAt: gates.mandateExpiresAt,
      merchantAddress: offer.merchantAddress.toLowerCase(),
      usdzTokenAddress: (config.usdzTokenAddress as string).toLowerCase(),
      usdzDecimals: config.usdzDecimals as number,
      createdAt: clock.iso(),
      archivedPriorState: null,
    };
    writeStateAtomic(input.stateDir, 'state.json', state);

    return await dispatchAndSettle(input, state, evidenceBase, trace);
  } finally {
    try {
      // Release the lock (best-effort; a crashed process leaves the file,
      // which keeps the one-intent policy safe until manual resolution).
      closeSync(lock);
      const lockPath = join(input.stateDir, 'journey.lock');
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      // Lock release must never mask the outcome.
    }
  }
}

function blockedEvidence(evidenceBase: Record<string, unknown>, reason: string): PurchaseEvidence {
  return {
    ...(evidenceBase as unknown as PurchaseEvidence),
    outcome: 'blocked',
    reason,
    txHash: null,
    settlement: null,
    delivery: null,
    decisionTrace: null,
  };
}

/** One reconcile pass of an existing intent, for resolution checks. */
async function resolveOnce(
  input: MetalJourneyInput,
  state: IntentState,
): Promise<'confirmed' | 'failed' | 'pending' | 'unverified'> {
  const dispatcher = new MetalDispatcher({
    config: input.config,
    transport: input.transport,
    store: input.store,
    clock: input.clock,
    merchantForOrg: input.merchantForOrg,
    environment:
      (input.transport as { __offlineFixture?: boolean }).__offlineFixture === true
        ? 'offline-fixture'
        : 'testnet',
    signer: input.signer,
  });
  try {
    const result = await dispatcher.reconcileByRequestId(state.ledgerRequestId, {
      orgId: state.orgId,
      operationId: `op_${state.ledgerRequestId}`,
      amountMinor: state.offer.priceMinor,
      currency: state.offer.currency,
      merchant: state.merchantAddress,
    });
    if (result.status === 'confirmed' || result.status === 'failed') return result.status;
    if (result.status === 'processing') return 'pending';
    return 'unverified';
  } catch {
    return 'unverified';
  }
}

async function dispatchAndSettle(
  input: MetalJourneyInput,
  state: IntentState,
  evidenceBase: Record<string, unknown>,
  trace: NonNullable<PurchaseEvidence['decisionTrace']>,
): Promise<PurchaseEvidence> {
  const dispatcher = new MetalDispatcher({
    config: input.config,
    transport: input.transport,
    store: input.store,
    clock: input.clock,
    merchantForOrg: input.merchantForOrg,
    environment:
      (input.transport as { __offlineFixture?: boolean }).__offlineFixture === true
        ? 'offline-fixture'
        : 'testnet',
    signer: input.signer,
  });

  const result = await dispatcher.dispatch({
    operationId: `op_${state.ledgerRequestId}`,
    orgId: state.orgId,
    missionId: state.missionId,
    kind: 'metal_order',
    requestId: state.ledgerRequestId,
    amountMinor: state.offer.priceMinor,
    currency: state.offer.currency,
    beneficiary: state.merchantAddress,
    purpose: state.purpose,
  });

  if (result.status === 'failed') {
    return {
      ...(evidenceBase as unknown as PurchaseEvidence),
      outcome: 'requires-human',
      reason: `dispatch failed definitively (${result.providerState ?? 'failed'}); the commitment is retained for human resolution`,
      offerDigest: state.offerDigest,
      ledgerRequestId: state.ledgerRequestId,
      providerRequestId: null,
      txHash: result.receiptRef?.startsWith('metal:0x') ? result.receiptRef.slice(6) : null,
      settlement: null,
      delivery: null,
      decisionTrace: trace,
    };
  }
  if (result.status === 'status-unknown') {
    return {
      ...(evidenceBase as unknown as PurchaseEvidence),
      outcome: 'unverified',
      reason:
        'dispatch outcome is ambiguous (the transaction may or may not have broadcast); funds are committed — recovery reconciles THIS intent, never a new identity',
      offerDigest: state.offerDigest,
      ledgerRequestId: state.ledgerRequestId,
      providerRequestId: null,
      txHash: result.receiptRef?.startsWith('metal:0x') ? result.receiptRef.slice(6) : null,
      settlement: null,
      delivery: null,
      decisionTrace: trace,
    };
  }

  // submitted: settle by independent readback passes.
  return await reconcileExistingIntent(input, state, evidenceBase);
}

async function reconcileExistingIntent(
  input: MetalJourneyInput,
  state: IntentState,
  evidenceBase: Record<string, unknown>,
): Promise<PurchaseEvidence> {
  const dispatcher = new MetalDispatcher({
    config: input.config,
    transport: input.transport,
    store: input.store,
    clock: input.clock,
    merchantForOrg: input.merchantForOrg,
    environment:
      (input.transport as { __offlineFixture?: boolean }).__offlineFixture === true
        ? 'offline-fixture'
        : 'testnet',
    signer: input.signer,
  });
  const trace = {
    informationValueMinor: state.informationValueMinor,
    priceMinor: state.offer.priceMinor,
    capMinor: state.perPurchaseCapMinor,
    mandateExpiresAt: state.mandateExpiresAt,
    quoteExpiresAt: state.offer.quoteExpiresAt,
    gatesPassed: ['reopened-existing-intent'],
    gateFailed: null,
  };
  const maxPasses = input.maxReconcilePasses ?? 5;
  const delayMs = input.reconcileDelayMs ?? 15_000;

  let last: Awaited<ReturnType<MetalDispatcher['reconcileByRequestId']>> | null = null;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (pass > 0 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    last = await dispatcher.reconcileByRequestId(state.ledgerRequestId, {
      orgId: state.orgId,
      operationId: `op_${state.ledgerRequestId}`,
      amountMinor: state.offer.priceMinor,
      currency: state.offer.currency,
      merchant: state.merchantAddress,
    });
    if (last.status === 'confirmed' || last.status === 'failed') break;
  }
  const final = last as NonNullable<typeof last>;

  if (final.status === 'confirmed') {
    // Settlement is verified. Delivery is a SEPARATE fact, evaluated now.
    const delivery = await deliverAndAssess(input, state);
    return {
      ...(evidenceBase as unknown as PurchaseEvidence),
      outcome: 'confirmed',
      reason:
        'on-chain settlement independently verified at finality depth; delivery evidence recorded separately (payment proves payment, not data quality)',
      offerDigest: state.offerDigest,
      ledgerRequestId: state.ledgerRequestId,
      providerRequestId: `mtv-${sha256Hex(state.orgId).slice(0, 10)}-${state.ledgerRequestId}`,
      txHash: final.receiptRef?.startsWith('metal:0x') ? final.receiptRef.slice(6) : null,
      settlement: {
        onchainStatus: final.providerState ?? 'FINALIZED',
        verifiedAt: final.verifiedAt ?? null,
        confirmations: null,
      },
      delivery,
      decisionTrace: trace,
    };
  }
  if (final.status === 'failed') {
    return {
      ...(evidenceBase as unknown as PurchaseEvidence),
      outcome: 'requires-human',
      reason: `reconcile reports definitive failure (${final.providerState ?? 'failed'}); escalation retains the commitment for human resolution`,
      offerDigest: state.offerDigest,
      ledgerRequestId: state.ledgerRequestId,
      providerRequestId: `mtv-${sha256Hex(state.orgId).slice(0, 10)}-${state.ledgerRequestId}`,
      txHash: final.receiptRef?.startsWith('metal:0x') ? final.receiptRef.slice(6) : null,
      settlement: null,
      delivery: null,
      decisionTrace: trace,
    };
  }
  return {
    ...(evidenceBase as unknown as PurchaseEvidence),
    outcome: 'unverified',
    reason: `settlement not yet verifiable after ${String(maxPasses)} reconcile pass(es) (${final.status}); funds remain committed — rerun reconciles THIS intent`,
    offerDigest: state.offerDigest,
    ledgerRequestId: state.ledgerRequestId,
    providerRequestId: `mtv-${sha256Hex(state.orgId).slice(0, 10)}-${state.ledgerRequestId}`,
    txHash: final.receiptRef?.startsWith('metal:0x') ? final.receiptRef.slice(6) : null,
    settlement: null,
    delivery: null,
    decisionTrace: trace,
  };
}

async function deliverAndAssess(
  input: MetalJourneyInput,
  state: IntentState,
): Promise<NonNullable<PurchaseEvidence['delivery']>> {
  const url = state.offer.reportUrl;
  if (url === undefined || url === '') {
    return {
      delivered: false,
      status: null,
      reportDigest: null,
      reportShape: null,
      injectionQuarantined: false,
      error: 'no report URL on the offer; payment verified, delivery pending vendor',
    };
  }
  try {
    const response = await input.vendor.fetchReport(url);
    if (!response.ok || response.payload === null) {
      return {
        delivered: false,
        status: response.status,
        reportDigest: null,
        reportShape: null,
        injectionQuarantined: false,
        error: `${response.error ?? `vendor returned status ${String(response.status ?? 'unknown')}`}; payment verified, delivery NOT verified`,
      };
    }
    const text = JSON.stringify(response.payload);
    return {
      delivered: true,
      status: response.status,
      reportDigest: sha256Hex(text),
      reportShape: reportShapeOf(response.payload),
      injectionQuarantined: quarantineFindings(response.payload),
      error: null,
    };
  } catch (error) {
    return {
      delivered: false,
      status: null,
      reportDigest: null,
      reportShape: null,
      injectionQuarantined: false,
      error: `vendor unreachable: ${error instanceof Error ? error.message : String(error)}; payment verified, delivery NOT verified`,
    };
  }
}

export { minorToMajorString, toQuantityHex, TokenMoneyError };
