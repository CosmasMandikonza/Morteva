/**
 * A1 READ-ONLY CONNECTION PROOF (issue #5): prove the sandbox account is
 * actually reachable with founder-provisioned credentials WITHOUT any
 * financial write — login (implicit), USD balance, bounded beneficiary list,
 * optional single-beneficiary read, optional single-transfer read.
 *
 * Honesty contract:
 *  - With no credentials the proof is BLOCKED (exit 2 from the CLI); nothing
 *    is fabricated and no provider call is made.
 *  - Beneficiary evidence is an identity projection ONLY (id/nickname/
 *    transfer_methods — bank details never leave the parse boundary); the
 *    transfer read reuses the receipt minimizer projection.
 *  - Exactly one DURABLE balance-read receipt is persisted per successful
 *    run into a state-dir ledger (provider_receipts kind='balance-read',
 *    environment='sandbox') — durable evidence of the authenticated account
 *    read; beneficiary/transfer reads are printed redacted but not persisted
 *    (provider receipts remain financial-act-scoped by contract).
 *  - Provider timestamps (token expiry, transfer created_at/updated_at) are
 *    carried through verbatim where the provider returns them.
 */
import { openLedger, type Ledger } from '@moterva/ledger';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { AirwallexAdapterConfig } from '../config.js';
import type { AirwallexTransport } from '../transport.js';
import { AirwallexClient, type AirwallexBeneficiary, type AirwallexBalance } from '../client.js';
import { AirwallexDefinitiveRejectionError } from '../client.js';
import { minimizeTransfer, type MinimizedTransfer } from '../minimize.js';
import { TransportUnavailableError } from '../transport.js';
import { minorToMajorUnits } from '../money.js';

export interface ConnectionProofInput {
  readonly config: AirwallexAdapterConfig;
  readonly transport: AirwallexTransport;
  /** Durable state directory for the evidence ledger (created if missing). */
  readonly stateDir: string;
  /** Optional beneficiary id to read (read-only single-get proof). */
  readonly beneficiaryId?: string;
  /** Optional provider transfer id to read (read-only single-get proof). */
  readonly transferId?: string;
  /** Ledger factory — injectable for tests; defaults to a real sqlite ledger. */
  readonly openLedgerAt?: (dbPath: string) => Ledger;
}

export interface ConnectionProofResult {
  /** True only after the provider answered an authenticated account read. */
  readonly authenticated: boolean;
  readonly balances: readonly AirwallexBalance[];
  readonly beneficiaryPage: {
    readonly items: readonly AirwallexBeneficiary[];
    readonly hasMore: boolean;
  } | null;
  readonly beneficiary: AirwallexBeneficiary | null;
  readonly transfer: MinimizedTransfer | null;
  readonly balanceReceiptRecorded: boolean;
  /** Redacted receipt payload actually persisted (for assertions/tests). */
  readonly persistedReceiptPayload: string | null;
}

export const CONNECTION_STATE_DIR_DEFAULT = 'moterva-awx-connection-proof';

export async function runConnectionProof(
  input: ConnectionProofInput,
): Promise<ConnectionProofResult> {
  const { config, transport } = input;
  const client = new AirwallexClient(config, transport, { now: () => new Date() });

  const balances = await client.balancesCurrent();

  const beneficiaryPage = await client.listBeneficiaries({ pageSize: 10, pageNumber: 1 });

  const beneficiary =
    input.beneficiaryId !== undefined && input.beneficiaryId !== ''
      ? await client.getBeneficiary(input.beneficiaryId)
      : null;

  const transfer =
    input.transferId !== undefined && input.transferId !== ''
      ? minimizeTransfer((await client.getTransfer(input.transferId)).raw)
      : null;

  // Durable balance-read receipt in a REAL sqlite ledger under the state dir.
  // The payload is computed up front: this function either persists it and
  // returns, or throws — the success flag below is only reachable on success.
  const payload = JSON.stringify(
    balances.map((b) => ({
      currency: b.currency,
      available: b.availableAmount.minorUnits,
      pending: b.pendingAmount.minorUnits,
      reserved: b.reservedAmount.minorUnits,
    })),
  );
  mkdirSync(input.stateDir, { recursive: true });
  const ledger = (input.openLedgerAt ?? openLedgerAtDefault)(join(input.stateDir, 'ledger.sqlite'));
  try {
    ledger.migrate();
    const existing = ledger.db
      .prepare("SELECT id FROM organizations WHERE name = 'Airwallex Connection Proof'")
      .get() as { id: string } | undefined;
    const orgId =
      existing?.id ?? ledger.organizations.createOrganization('Airwallex Connection Proof').id;
    ledger.providerReceipts.append({
      provider: 'airwallex',
      orgId,
      operationId: null,
      requestId: 'connection-proof-balance-read',
      providerResourceId: null,
      kind: 'balance-read',
      environment: 'sandbox',
      httpStatus: 200,
      providerStatus: null,
      payloadJson: payload,
      recordedAt: new Date().toISOString(),
    });
  } finally {
    if (ledger.db.open) ledger.close();
  }

  return {
    authenticated: true,
    balances,
    beneficiaryPage,
    beneficiary,
    transfer,
    balanceReceiptRecorded: true,
    persistedReceiptPayload: payload,
  };
}

function openLedgerAtDefault(dbPath: string): Ledger {
  return openLedger(dbPath);
}

/**
 * Payout-readiness summary from a connection proof: which beneficiary ids are
 * LOCAL/SWIFT-payable (a beneficiary with NO transfer methods is NOT payout
 * ready — an empty resource is reported as such, never an error and never a
 * success), plus the USD available balance the founder's funding check uses.
 */
export function payoutReadiness(result: ConnectionProofResult): {
  usdAvailableMinor: number | null;
  payoutReadyBeneficiaries: string[];
  nonPayoutReadyBeneficiaries: string[];
} {
  const usd = result.balances.find((b) => b.currency === 'USD');
  const ids = result.beneficiaryPage?.items ?? [];
  return {
    usdAvailableMinor: usd !== undefined ? usd.availableAmount.minorUnits : null,
    payoutReadyBeneficiaries: ids.filter((b) => b.transferMethods.length > 0).map((b) => b.id),
    nonPayoutReadyBeneficiaries: ids.filter((b) => b.transferMethods.length === 0).map((b) => b.id),
  };
}

/**
 * Distinguishes an EMPTY sandbox resource from a scope/IP block from a plain
 * failure (founder step 2): a 403 from a least-privilege read key is a
 * permissions/IP-allowlist diagnostic, not an empty account and not a bug;
 * an empty beneficiary page is a real (valid) empty resource.
 */
export function classifyConnectionFailure(error: unknown): {
  kind: 'scope-or-ip' | 'not-found' | 'ambiguous' | 'other';
  detail: string;
} {
  if (error instanceof AirwallexDefinitiveRejectionError) {
    if (error.httpStatus === 403) {
      return {
        kind: 'scope-or-ip',
        detail: `403 ${error.providerCode}: the credential's scope does not cover this resource OR the source IP is not on the sandbox IP allowlist. This is a permissions/network configuration diagnostic — not an empty resource and not a fabricated failure. Check: (1) the key's scopes in the Airwallex sandbox UI, (2) the allowlisted public egress IP of THIS machine (an AWS host's EIP differs from a local IP).`,
      };
    }
    if (error.httpStatus === 404) {
      return {
        kind: 'not-found',
        detail: `404 ${error.providerCode}: the requested resource id does not exist in this sandbox account (a wrong id is a configuration error, not an empty list).`,
      };
    }
    return {
      kind: 'other',
      detail: `${String(error.httpStatus)} ${error.providerCode}: definitive provider rejection.`,
    };
  }
  if (error instanceof TransportUnavailableError) {
    return {
      kind: 'ambiguous',
      detail: `${error.message} — AMBIGUOUS: the provider may or may not have processed anything; reads can be retried safely, but this is never reported as success.`,
    };
  }
  return {
    kind: 'other',
    detail: error instanceof Error ? error.message : String(error),
  };
}

/** Redacted console lines for the CLI (never the token, never bank details). */
export function printConnectionProof(result: ConnectionProofResult): void {
  console.info('airwallex sandbox connection proof — READ ONLY (no transfer attempted):');
  console.info('  authentication: OK (bearer token issued; held in memory only, never printed)');
  const usd = result.balances.find((b) => b.currency === 'USD');
  for (const b of result.balances) {
    console.info(
      `  balance ${b.currency}: available ${b.availableAmount.minorUnits} minor (major ${minorToMajorUnits(b.currency, b.availableAmount.minorUnits)}) account_type=${b.accountType}`,
    );
  }
  if (usd === undefined) {
    console.info('  balance USD: NOT PRESENT in this sandbox account (report honestly)');
  }
  if (result.beneficiaryPage !== null) {
    console.info(
      `  beneficiaries: ${String(result.beneficiaryPage.items.length)} on page 1 (has_more=${String(result.beneficiaryPage.hasMore)}):`,
    );
    for (const b of result.beneficiaryPage.items) {
      console.info(
        `    id=${b.id} nickname=${b.nickname ?? '(none)'} transfer_methods=[${b.transferMethods.join(',')}]`,
      );
    }
  }
  if (result.beneficiary !== null) {
    console.info(
      `  beneficiary read: id=${result.beneficiary.id} nickname=${result.beneficiary.nickname ?? '(none)'} transfer_methods=[${result.beneficiary.transferMethods.join(',')}] (bank details intentionally not read)`,
    );
  }
  if (result.transfer !== null) {
    console.info(
      `  transfer read (minimized): id=${result.transfer.id} status=${result.transfer.status} request_id=${result.transfer.request_id ?? '(none)'} amount=${result.transfer.transfer_amount ?? '(none)'} ${result.transfer.transfer_currency ?? ''} created_at=${result.transfer.created_at ?? '(none)'}`,
    );
  }
  console.info('  one durable balance-read receipt persisted (environment=sandbox).');
}
