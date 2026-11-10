/**
 * Sponsor paid-diagnostic journey (issue #6 D2) — the value-of-information
 * gate, payment-identity binding, mandate payment through the OFFICIAL CLI,
 * independent settlement verification, and separately-assessed delivery.
 *
 * Preserved invariants from the legacy journey (all still tested):
 *  - the VoI gate REFUSES to pay when estimated information value is below
 *    the quoted price (the no-purchase case is first-class);
 *  - price, payee, asset/case id, cap, payment identity and permitted service
 *    are bound into the durable intent BEFORE any payment;
 *  - settlement is verified independently (mandate verify / facilitator
 *    settlements) BEFORE the paid content is fetched, and the content is
 *    digested, shape-checked and instruction-quarantined — an x402 payment
 *    does NOT prove the diagnostic is true;
 *  - delivery evidence is recorded SEPARATELY from payment evidence;
 *  - one durable intent per state directory; corrupt/missing state never
 *    authorizes a new payment; rerun reconciles the SAME payment identity.
 *
 * Sponsor-specific additions: the offer must be `*USDZ`-priced (any other
 * token is refused pre-sign, replicating the official client), amounts are
 * exact 18-decimal base units (never rounded), and a `payment in doubt`
 * outcome is terminal for the journey until an operator resolves it via
 * `metal-agent status` — the journey never signs again for an in-doubt
 * payment identity.
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
import type { SponsorConfig, SponsorSecretPaths } from './config.js';
import type { AgentCliRunner, AgentPaymentResult } from './agent-cli.js';
import { requirePositiveBaseUnits, usdzFromBaseUnits, UsdzError } from './usdz.js';

export interface SponsorDiagnosticOffer {
  readonly sellerId: string;
  readonly productName: string;
  /** Quoted price in *USDZ base units (decimal string) from the signed offer. */
  readonly priceBaseUnits: string;
  /** The payee the offer names (must be on the mandate's payee allowlist). */
  readonly payee: string;
  /** Asset/case identifier the diagnostic is about (bound into the intent). */
  readonly assetCaseId: string;
  /** Signed-offer text when the seller requires one (extra.signedOffer). */
  readonly signedOffer: string | null;
  /** Where the report is fetched after verified settlement. */
  readonly reportUrl: string;
  readonly quoteExpiresAt: string;
}

export interface SponsorDecisionInput {
  readonly orgId: string;
  readonly missionId: string;
  readonly purpose: string;
  /** Estimated information value in *USDZ base units (planner output in production). */
  readonly informationValueBaseUnits: string;
}

export interface SponsorVendorClient {
  fetchReport(
    url: string,
  ): Promise<{ ok: boolean; status: number | null; payload: unknown | null; error?: string }>;
  /** Fetches the x402 offer for the diagnostic (server-side, unpaid). */
  fetchOffer(url: string): Promise<{
    ok: boolean;
    status: number | null;
    offer: SponsorDiagnosticOffer | null;
    error?: string;
  }>;
}

export interface SponsorPurchaseEvidence {
  readonly outcome:
    | 'blocked'
    | 'declined'
    | 'paid-and-verified'
    | 'paid-delivery-unverified'
    | 'refused-by-mandate'
    | 'in-doubt'
    | 'unverified'
    | 'failed';
  readonly reason: string;
  readonly sellerId: string | null;
  readonly offerDigest: string | null;
  readonly paymentIdentity: string | null;
  readonly nonce: string | null;
  readonly txHash: string | null;
  readonly explorerUrl: string | null;
  readonly amountBaseUnits: string | null;
  readonly amountUsdz: string | null;
  readonly environment: 'sponsor-testnet' | 'disabled';
  readonly settlement: {
    readonly verified: boolean;
    readonly how: string | null;
    readonly verifiedAt: string | null;
  } | null;
  readonly delivery: {
    readonly delivered: boolean;
    readonly reportDigest: string | null;
    readonly injectionQuarantined: boolean;
    readonly error: string | null;
  } | null;
  readonly decisionTrace: {
    readonly informationValueBaseUnits: string;
    readonly priceBaseUnits: string;
    readonly maxPaymentBaseUnits: string;
    readonly quoteExpiresAt: string;
    readonly gatesPassed: readonly string[];
    readonly gateFailed: string | null;
  } | null;
}

const INTENT_VERSION = 1;

export interface SponsorIntentState {
  readonly version: typeof INTENT_VERSION;
  readonly stage: 'decided' | 'submitted' | 'settled';
  readonly orgId: string;
  readonly missionId: string;
  readonly purpose: string;
  readonly paymentIdentity: string;
  readonly offerDigest: string;
  readonly offer: SponsorDiagnosticOffer;
  readonly priceBaseUnits: string;
  readonly informationValueBaseUnits: string;
  readonly maxPaymentBaseUnits: string;
  readonly createdAt: string;
}

export function sponsorOfferDigest(offer: SponsorDiagnosticOffer): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        sellerId: offer.sellerId,
        productName: offer.productName,
        priceBaseUnits: offer.priceBaseUnits,
        payee: offer.payee.toLowerCase(),
        assetCaseId: offer.assetCaseId,
        quoteExpiresAt: offer.quoteExpiresAt,
        reportUrl: offer.reportUrl,
      }),
    )
    .digest('hex');
}

/**
 * The payment identity binds EVERYTHING the mandate will enforce: seller,
 * asset/case, offer digest, price and the per-payment nonce window. Two
 * purchases of one offer under two identities are two payments; the same
 * identity re-run never signs again (the CLI reports `already paid`).
 */
function paymentIdentityFor(
  orgId: string,
  missionId: string,
  offerDigest: string,
  runSalt: string,
): string {
  return (
    'pmt_' +
    createHash('sha256')
      .update(canonicalJson({ orgId, missionId, offerDigest, runSalt }))
      .digest('hex')
      .slice(0, 24)
  );
}

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?(prior|previous)\s+instructions/i,
  /you\s+are\s+now\s+/i,
  /system\s*:\s*/i,
  /(approve|transfer|release|spend)\s+(all\s+)?funds/i,
  /grant\s+(me\s+)?(admin|authority|access)/i,
];

export function quarantineFindings(payload: unknown): boolean {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function writeStateAtomic(stateDir: string, state: SponsorIntentState): void {
  const tmp = join(stateDir, '.state.json.tmp');
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, join(stateDir, 'state.json'));
}

function exclusiveLock(stateDir: string): number | null {
  try {
    return openSync(join(stateDir, 'sponsor.lock'), 'wx');
  } catch {
    return null;
  }
}

export interface SponsorJourneyInput {
  /** Mission linkage bound into the payment identity (replayable, journaled). */
  readonly orgId: string;
  readonly missionId: string;
  readonly purpose: string;
  readonly config: SponsorConfig;
  readonly paths: SponsorSecretPaths;
  readonly cli: AgentCliRunner;
  readonly vendor: SponsorVendorClient;
  readonly clock: { now(): Date; iso(): string };
  readonly stateDir: string;
  /** Per-journey salt for the payment identity (a rerun of the SAME intent reuses its stored identity). */
  readonly runSalt: string;
  readonly issuerPublicKeyFile: string | null;
}

function blocked(evidenceBase: Record<string, unknown>, reason: string): SponsorPurchaseEvidence {
  return {
    ...(evidenceBase as unknown as SponsorPurchaseEvidence),
    outcome: 'blocked',
    reason,
    txHash: null,
    settlement: null,
    delivery: null,
    decisionTrace: null,
  };
}

export async function runSponsorPurchaseJourney(
  input: SponsorJourneyInput,
): Promise<SponsorPurchaseEvidence> {
  const { config, clock } = input;
  const evidenceBase = {
    sellerId: null,
    offerDigest: null,
    paymentIdentity: null,
    nonce: null,
    txHash: null,
    explorerUrl: null,
    amountBaseUnits: null,
    amountUsdz: null,
    environment: config.enabled ? 'sponsor-testnet' : 'disabled',
  } as const;

  if (!config.enabled) {
    return blocked(
      evidenceBase,
      'BLOCKED: the sponsor rail is not enabled (METAL_SPEND_ENV=sponsor-testnet + console RPC endpoint + agent key file + mandate credential). The legacy Tahoe config is not a substitute (SPONSOR-AUDIT.md).',
    );
  }
  if (!config.spendApproved) {
    return blocked(
      evidenceBase,
      'BLOCKED: no founder authorization for signed spend (METAL_SPEND_APPROVED unset). Read-only verification may run, but nothing is signed. This is the D3 stop-before-signing gate.',
    );
  }

  mkdirSync(input.stateDir, { recursive: true });
  const lock = exclusiveLock(input.stateDir);
  if (lock === null) {
    return blocked(evidenceBase, 'BLOCKED: another journey holds the state directory lock');
  }
  const statePath = join(input.stateDir, 'state.json');
  try {
    if (existsSync(statePath)) {
      let prior: SponsorIntentState | null = null;
      try {
        prior = JSON.parse(readFileSync(statePath, 'utf8')) as SponsorIntentState;
      } catch {
        return blocked(
          evidenceBase,
          'BLOCKED: corrupt state.json — resolve manually; a corrupt state never authorizes a new payment',
        );
      }
      if (prior.version !== INTENT_VERSION) {
        return blocked(evidenceBase, 'BLOCKED: unknown state version — resolve manually');
      }
      return await reconcileSponsorIntent(input, prior, evidenceBase);
    }

    // ---- Offer fetch (unpaid) with quote/offer verification.
    const offerResponse = await input.vendor.fetchOffer(config.diagnosticSellerUrl);
    const offer = offerResponse.offer;
    if (!offerResponse.ok || offer === null) {
      return blocked(
        { ...evidenceBase },
        `BLOCKED: the seller's offer is unavailable (${offerResponse.error ?? String(offerResponse.status ?? 'no status')}); nothing was signed`,
      );
    }
    const offerDigest = sponsorOfferDigest(offer);
    const gatesPassed: string[] = [];
    const trace = {
      informationValueBaseUnits: config.infoValueBaseUnits ?? '0',
      priceBaseUnits: offer.priceBaseUnits,
      maxPaymentBaseUnits: config.maxPaymentBaseUnits,
      quoteExpiresAt: offer.quoteExpiresAt,
      gatesPassed,
      gateFailed: null as string | null,
    };
    const decline = (gate: string, reason: string): SponsorPurchaseEvidence => {
      trace.gateFailed = gate;
      return {
        ...(evidenceBase as unknown as SponsorPurchaseEvidence),
        outcome: 'declined',
        reason,
        sellerId: offer.sellerId,
        offerDigest,
        amountBaseUnits: offer.priceBaseUnits,
        amountUsdz: usdzFromBaseUnits(offer.priceBaseUnits),
        txHash: null,
        settlement: null,
        delivery: null,
        decisionTrace: trace,
      };
    };

    // ---- Offer verification BEFORE anything else: *USDZ-only, exact units,
    // positive, payee present, and a price inside the per-payment cap.
    let price: bigint;
    try {
      price = BigInt(requirePositiveBaseUnits(offer.priceBaseUnits));
    } catch (error) {
      return decline(
        'OFFER_INVALID',
        `the offer's price is not a valid positive *USDZ amount: ${error instanceof UsdzError ? error.message : String(error)}`,
      );
    }
    if (
      offer.sellerId.trim() === '' ||
      offer.assetCaseId.trim() === '' ||
      offer.payee.trim() === ''
    ) {
      return decline(
        'OFFER_INCOMPLETE',
        'the offer is missing seller, asset/case or payee identity; refusing to price an unnamed purchase',
      );
    }
    gatesPassed.push('offer-wellformed');
    // A cap of zero (unset) means the configured max is the only limit; the
    // config default is the official client's 1 *USDZ.
    if (BigInt(config.maxPaymentBaseUnits) < price) {
      return decline(
        'PER_PAYMENT_CAP_EXCEEDED',
        `the quoted price ${offer.priceBaseUnits} base units exceeds the configured per-payment cap ${config.maxPaymentBaseUnits}`,
      );
    }
    gatesPassed.push('cap-ok');
    if (Date.parse(offer.quoteExpiresAt) <= clock.now().getTime()) {
      return decline('QUOTE_EXPIRED', `the offer expired at ${offer.quoteExpiresAt}; no purchase`);
    }
    gatesPassed.push('quote-fresh');

    // ---- Value-of-information gate: pay only when the expected value of the
    // information exceeds its price under the governing policy.
    const infoValue = BigInt(config.infoValueBaseUnits ?? '0');
    if (infoValue < price) {
      return decline(
        'INFORMATION_NOT_WORTH_PRICE',
        `estimated information value ${infoValue.toString()} < price ${price.toString()} base units; the no-purchase case`,
      );
    }
    gatesPassed.push('economics-ok');
    if (!config.hasMandateCredential) {
      return blocked(
        evidenceBase,
        'BLOCKED: no mandate credential configured — a payment without an on-chain mandate is not authorized',
      );
    }
    gatesPassed.push('mandate-credential-present');

    // ---- Durable intent BEFORE any payment (identity binds all terms).
    const identity = paymentIdentityFor(input.orgId, input.missionId, offerDigest, input.runSalt);
    const state: SponsorIntentState = {
      version: INTENT_VERSION,
      stage: 'decided',
      orgId: input.orgId,
      missionId: input.missionId,
      purpose: input.purpose,
      paymentIdentity: identity,
      offerDigest,
      offer,
      priceBaseUnits: offer.priceBaseUnits,
      informationValueBaseUnits: config.infoValueBaseUnits ?? '0',
      maxPaymentBaseUnits: config.maxPaymentBaseUnits,
      createdAt: clock.iso(),
    };
    writeStateAtomic(input.stateDir, state);

    // ---- Pay through the OFFICIAL CLI under the on-chain mandate.
    const payment: AgentPaymentResult = await input.cli.pay({
      url: config.diagnosticSellerUrl,
      mandateCredentialPath: input.paths.mandateCredential,
      rpcUrl: input.paths.rpcUrl,
      network: 'testnet',
    });

    if (payment.phase === 'in-doubt-at-settlement') {
      // TERMINAL for this identity until an operator resolves it with
      // `metal-agent status` — the journey never signs again for an in-doubt
      // payment identity (that would risk a second settlement).
      return {
        ...(evidenceBase as unknown as SponsorPurchaseEvidence),
        outcome: 'in-doubt',
        reason: `PAYMENT IN DOUBT at settlement: ${payment.refusalReason ?? 'unknown'} — the payment may have settled; resolve with metal-agent status <tx> and NEVER re-run this identity`,
        sellerId: offer.sellerId,
        offerDigest,
        paymentIdentity: identity,
        nonce: payment.nonce,
        txHash: payment.txHash,
        explorerUrl: payment.explorerUrl,
        amountBaseUnits: offer.priceBaseUnits,
        amountUsdz: usdzFromBaseUnits(offer.priceBaseUnits),
        settlement: null,
        delivery: null,
        decisionTrace: trace,
      };
    }
    if (payment.phase === 'refused' || payment.phase === 'refused-at-settlement') {
      const mandateRefusal = (payment.refusalReason ?? '').startsWith('mandate_');
      return {
        ...(evidenceBase as unknown as SponsorPurchaseEvidence),
        outcome: mandateRefusal ? 'refused-by-mandate' : 'failed',
        reason: `PAYMENT REFUSED${payment.phase === 'refused-at-settlement' ? ' AT SETTLEMENT' : ''}: ${payment.refusalReason ?? 'unknown'} — nothing was paid${payment.txHash !== null ? ` (tx ${payment.txHash} recorded the refusal)` : ''}`,
        sellerId: offer.sellerId,
        offerDigest,
        paymentIdentity: identity,
        nonce: payment.nonce,
        txHash: payment.txHash,
        explorerUrl: payment.explorerUrl,
        amountBaseUnits: offer.priceBaseUnits,
        amountUsdz: usdzFromBaseUnits(offer.priceBaseUnits),
        settlement: null,
        delivery: null,
        decisionTrace: trace,
      };
    }
    if (payment.phase === 'failed' || payment.phase === 'pending' || payment.phase === 'held') {
      return {
        ...(evidenceBase as unknown as SponsorPurchaseEvidence),
        outcome: payment.phase === 'failed' ? 'failed' : 'unverified',
        reason:
          payment.phase === 'failed'
            ? `the official CLI failed without a documented refusal: ${payment.refusalReason ?? 'unknown'} — treat as unverified, never re-sign this identity`
            : `payment is ${payment.phase.toUpperCase()} (may settle); reconcile with metal-agent status before fetching content`,
        sellerId: offer.sellerId,
        offerDigest,
        paymentIdentity: identity,
        nonce: payment.nonce,
        txHash: payment.txHash,
        explorerUrl: payment.explorerUrl,
        amountBaseUnits: offer.priceBaseUnits,
        amountUsdz: usdzFromBaseUnits(offer.priceBaseUnits),
        settlement: null,
        delivery: null,
        decisionTrace: trace,
      };
    }

    // ---- paid: verify settlement INDEPENDENTLY before fetching content.
    writeStateAtomic(input.stateDir, {
      ...state,
      stage: 'submitted',
    });
    const verification = await verifySponsorSettlement(input, state, payment);
    if (!verification.ok) {
      return {
        ...(evidenceBase as unknown as SponsorPurchaseEvidence),
        outcome: 'unverified',
        reason:
          'the CLI reports paid but independent settlement verification did not confirm it; content is NOT fetched until verified',
        sellerId: offer.sellerId,
        offerDigest,
        paymentIdentity: identity,
        nonce: payment.nonce,
        txHash: payment.txHash,
        explorerUrl: payment.explorerUrl,
        amountBaseUnits: offer.priceBaseUnits,
        amountUsdz: usdzFromBaseUnits(offer.priceBaseUnits),
        settlement: { verified: false, how: verification.detail, verifiedAt: null },
        delivery: null,
        decisionTrace: trace,
      };
    }
    writeStateAtomic(input.stateDir, { ...state, stage: 'settled' });
    return await deliverSponsorContent(
      input,
      state,
      evidenceBase,
      trace,
      payment,
      identity,
      offerDigest,
      verification,
    );
  } finally {
    try {
      closeSync(lock);
      const lockPath = join(input.stateDir, 'sponsor.lock');
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      /* lock release never masks the outcome */
    }
  }
}

async function verifySponsorSettlement(
  input: SponsorJourneyInput,
  state: SponsorIntentState,
  payment: AgentPaymentResult,
): Promise<{ ok: boolean; detail: string }> {
  // Independent verification FROM THE CHAIN ALONE via the official CLI: the
  // binding, the credential under its issuer, and this payment/refusal as the
  // mandate key's own signed per-payment mandate, rebuilt from its transaction.
  const verify = await input.cli.mandateVerify({
    mandateCredentialPath: input.paths.mandateCredential,
    issuerPublicKeyFile:
      input.issuerPublicKeyFile ?? input.paths.mandateCredential + '.issuer.public.json',
    txHash: payment.txHash,
    signedOffer: state.offer.signedOffer,
    rpcUrl: input.paths.rpcUrl,
    network: 'testnet',
  });
  return { ok: verify.ok, detail: verify.detail.slice(0, 400) };
}

async function deliverSponsorContent(
  input: SponsorJourneyInput,
  state: SponsorIntentState,
  evidenceBase: Record<string, unknown>,
  trace: NonNullable<SponsorPurchaseEvidence['decisionTrace']>,
  payment: AgentPaymentResult,
  identity: string,
  offerDigest: string,
  verification: { ok: boolean; detail: string },
): Promise<SponsorPurchaseEvidence> {
  const reportUrl = state.offer.reportUrl;
  let delivery: NonNullable<SponsorPurchaseEvidence['delivery']>;
  try {
    const report = await input.vendor.fetchReport(reportUrl);
    if (!report.ok || report.payload === null) {
      delivery = {
        delivered: false,
        reportDigest: null,
        injectionQuarantined: false,
        error: `${report.error ?? `seller returned status ${String(report.status ?? 'unknown')}`}; payment verified, delivery NOT verified`,
      };
    } else {
      const text = JSON.stringify(report.payload);
      delivery = {
        delivered: true,
        reportDigest: sha256Hex(text),
        injectionQuarantined: quarantineFindings(report.payload),
        error: null,
      };
    }
  } catch (error) {
    delivery = {
      delivered: false,
      reportDigest: null,
      injectionQuarantined: false,
      error: `seller unreachable: ${error instanceof Error ? error.message : String(error)}; payment verified, delivery NOT verified`,
    };
  }
  return {
    ...(evidenceBase as unknown as SponsorPurchaseEvidence),
    outcome: delivery.delivered ? 'paid-and-verified' : 'paid-delivery-unverified',
    reason:
      'settlement verified independently from the chain (mandate verify); delivery assessed SEPARATELY — an x402 payment does not prove the diagnostic is true',
    sellerId: state.offer.sellerId,
    offerDigest,
    paymentIdentity: identity,
    nonce: payment.nonce,
    txHash: payment.txHash,
    explorerUrl: payment.explorerUrl,
    amountBaseUnits: state.priceBaseUnits,
    amountUsdz: usdzFromBaseUnits(state.priceBaseUnits),
    settlement: { verified: true, how: verification.detail, verifiedAt: input.clock.iso() },
    delivery,
    decisionTrace: trace,
  };
}

async function reconcileSponsorIntent(
  input: SponsorJourneyInput,
  state: SponsorIntentState,
  evidenceBase: Record<string, unknown>,
): Promise<SponsorPurchaseEvidence> {
  // Rerun of the SAME intent: never sign again — reconcile by verification.
  const payment: AgentPaymentResult = {
    phase: 'pending',
    nonce: null,
    txHash: null,
    explorerUrl: null,
    refusalReason: null,
    movedValue: false,
    rawOutput: '',
  };
  const verification = await verifySponsorSettlement(input, state, payment);
  const trace = {
    informationValueBaseUnits: state.informationValueBaseUnits,
    priceBaseUnits: state.priceBaseUnits,
    maxPaymentBaseUnits: state.maxPaymentBaseUnits,
    quoteExpiresAt: state.offer.quoteExpiresAt,
    gatesPassed: ['reopened-existing-intent'],
    gateFailed: null,
  };
  if (!verification.ok) {
    return {
      ...(evidenceBase as unknown as SponsorPurchaseEvidence),
      outcome: 'unverified',
      reason:
        'the stored intent has a submitted payment whose settlement is not yet verifiable from the chain; reconcile later — NEVER re-sign this identity',
      sellerId: state.offer.sellerId,
      offerDigest: state.offerDigest,
      paymentIdentity: state.paymentIdentity,
      nonce: null,
      txHash: null,
      explorerUrl: null,
      amountBaseUnits: state.priceBaseUnits,
      amountUsdz: usdzFromBaseUnits(state.priceBaseUnits),
      settlement: { verified: false, how: verification.detail, verifiedAt: null },
      delivery: null,
      decisionTrace: trace,
    };
  }
  return await deliverSponsorContent(
    input,
    state,
    evidenceBase,
    trace,
    { ...payment, phase: 'paid' },
    state.paymentIdentity,
    state.offerDigest,
    verification,
  );
}
