/**
 * Airwallex transfer smoke runner (issue #5, final-round P0-1 safety contract).
 *
 * ONE durable economic intent per state directory — enforced by the DURABLE
 * LEDGER, not just by a file:
 *
 *  - the first invocation creates exactly one org/mission/authorization/
 *    reservation, persists its full identity (org id, operation id, ledger
 *    request id, derived provider request id, beneficiary, amount, currency,
 *    sandbox-account fingerprint) ATOMICALLY BEFORE any provider call;
 *  - every rerun REOPENS the same ledger operation and only dispatches
 *    (same id, provider-deduped) or reconciles it. A rerun never creates a
 *    new organization, reservation or economic identity;
 *  - a failed/missing/ambiguous/incomplete readback blocks another create;
 *  - deleting or corrupting the state file does NOT authorize a new payment:
 *    any unresolved smoke operation still in the ledger blocks fresh setup;
 *  - a separate economic intent requires --new-intent (an explicit new
 *    authorization) AND that every prior smoke operation is resolved;
 *  - concurrent invocations are serialized by an exclusive lock file;
 *  - a FRESH VERIFIED sandbox balance read gates every invocation, and the
 *    amount is capped far below observed funds.
 *
 * This module is side-effect free and returns structured outcomes so the
 * double-run/crash/restart guarantees are provable in tests; the CLI wrapper
 * (transfer.ts) maps outcomes to console output and exit codes.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Ledger } from '@moterva/ledger';
import { openLedger } from '@moterva/ledger';
import type { ProviderCallResult, ProviderCallStatus } from '@moterva/providers';
import type { ProviderReceiptStore } from '@moterva/providers';
import type { AirwallexAdapterConfig } from '../config.js';
import type { AirwallexDispatcher } from '../dispatcher.js';
import { buildSandboxDispatcher } from '../dispatcher.js';
import type { AirwallexTransport } from '../transport.js';
import { AirwallexClient } from '../client.js';
import { providerRequestIdFor } from '../provider-request-id.js';

export const SMOKE_CURRENCY = 'USD';
export const MAX_SMOKE_AMOUNT_MINOR = 2_000; // hard cap (USD 20.00 equivalent)
export const DEFAULT_SMOKE_AMOUNT_MINOR = 500; // USD 5.00 equivalent
export const FUNDING_SAFETY_FACTOR = 10; // provider funds must exceed 10× the amount
/** Every request id this smoke creates starts with this marker (orphan guard). */
export const SMOKE_REQUEST_PREFIX = 'awx-smoke-';

export interface SmokeTransferInput {
  readonly config: AirwallexAdapterConfig;
  readonly transport: AirwallexTransport;
  /** Server-side sandbox beneficiary (from the environment, never persisted raw beyond the state file). */
  readonly beneficiaryId: string;
  /** Requested amount for a NEW intent (minor units). Ignored on reruns — the persisted authorized terms govern. */
  readonly amountMinor: number;
  /** Explicit human authorization for this invocation (required every run). */
  readonly confirm: boolean;
  /** Explicit new economic intent; requires every prior smoke operation to be resolved. */
  readonly newIntent: boolean;
  /** State directory holding the ledger DB, state file and lock. */
  readonly stateDir: string;
  /** Dispatcher factory; tests inject the offline-fixture builder. */
  readonly buildDispatcher?: DispatcherBuilder;
  readonly now?: () => Date;
  /** Ledger clock override (tests advance claim TTLs deterministically). */
  readonly ledgerClock?: { now(): Date; iso(): string };
}

export type DispatcherBuilder = (
  config: AirwallexAdapterConfig,
  transport: AirwallexTransport,
  store: ProviderReceiptStore,
  clock: { now(): Date; iso(): string },
  beneficiaryIdForOrg: (orgId: string) => string | undefined,
) => AirwallexDispatcher;

export type SmokeTransferResult =
  | {
      readonly outcome: 'blocked';
      readonly reason: string;
    }
  | {
      readonly outcome: 'requires-human';
      readonly reason: string;
    }
  | {
      readonly outcome: 'confirmed' | 'monitoring' | 'dispatched';
      readonly orgId: string;
      readonly operationId: string;
      readonly operationState: string;
      readonly ledgerRequestId: string;
      readonly providerRequestId: string;
      readonly readbackStatus: string;
      readonly readbackProviderState: string | null;
      readonly verifiedAt: string | null;
      readonly workerReport: Readonly<Record<string, number>>;
      readonly receiptCount: number;
    };

interface SmokeState {
  readonly version: 1;
  readonly orgId: string;
  readonly missionId: string;
  readonly operationId: string;
  readonly ledgerRequestId: string;
  readonly providerRequestId: string;
  readonly beneficiaryId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly accountFingerprint: string;
  readonly createdAt: string;
}

interface UnresolvedOperation {
  readonly requestId: string;
  readonly operationId: string;
  readonly state: string;
}

function fingerprintOf(clientId: string | null): string {
  // One-way fingerprint of the sandbox-account identity; never the credential.
  return createHash('sha256')
    .update(clientId ?? '<disabled>')
    .digest('hex')
    .slice(0, 16);
}

function lockPathOf(stateDir: string): string {
  return join(stateDir, 'run.lock');
}

function acquireLock(stateDir: string, now: () => Date): { release: () => void } {
  mkdirSync(stateDir, { recursive: true });
  const path = lockPathOf(stateDir);
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch {
    const holder = existsSync(path) ? readFileSync(path, 'utf8').trim() : 'unknown';
    throw new Error(
      `another smoke invocation holds the lock (${holder}). Concurrent invocations are refused; if the holder crashed, verify no transfer is in flight at the provider before removing ${path}.`,
    );
  }
  try {
    writeFileSync(fd, `pid=${String(process.pid)} at=${now().toISOString()}`, 'utf8');
  } finally {
    closeSync(fd);
  }
  return {
    release: () => {
      try {
        unlinkSync(path);
      } catch {
        // already removed — nothing to do
      }
    },
  };
}

function readState(stateFile: string): { state: SmokeState } | { corrupt: true } | null {
  if (!existsSync(stateFile)) return null;
  let raw: string;
  try {
    raw = readFileSync(stateFile, 'utf8');
  } catch {
    return { corrupt: true };
  }
  try {
    const parsed = JSON.parse(raw) as SmokeState;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof parsed.orgId !== 'string' ||
      typeof parsed.operationId !== 'string' ||
      typeof parsed.ledgerRequestId !== 'string' ||
      typeof parsed.providerRequestId !== 'string' ||
      typeof parsed.beneficiaryId !== 'string' ||
      typeof parsed.amountMinor !== 'number' ||
      typeof parsed.currency !== 'string' ||
      typeof parsed.accountFingerprint !== 'string'
    ) {
      return { corrupt: true };
    }
    return { state: parsed };
  } catch {
    return { corrupt: true };
  }
}

function writeStateAtomic(stateFile: string, state: SmokeState): void {
  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, stateFile);
}

function unresolvedSmokeOperations(ledger: Ledger): UnresolvedOperation[] {
  return ledger.db
    .prepare(
      `SELECT o.request_id AS requestId, o.id AS operationId, o.state AS state
         FROM operations o
        WHERE o.request_id LIKE ?
          AND o.state IN ('RESERVED','SUBMITTING','IN_FLIGHT','STATUS_UNKNOWN')`,
    )
    .all(`${SMOKE_REQUEST_PREFIX}%`) as UnresolvedOperation[];
}

function describeUnresolved(unresolved: readonly UnresolvedOperation[]): string {
  return unresolved
    .map((o) => `${o.requestId} (${o.operationId.slice(0, 8)}…) state=${o.state}`)
    .join('; ');
}

/**
 * The smoke workflow. NEVER process.exits; returns a structured outcome.
 * 'blocked' is fail-closed: nothing was sent to the provider.
 */
export async function runSmokeTransfer(input: SmokeTransferInput): Promise<SmokeTransferResult> {
  const now = input.now ?? (() => new Date());
  const builder = input.buildDispatcher ?? buildSandboxDispatcher;

  if (!input.confirm) {
    return {
      outcome: 'blocked',
      reason: 'pass --confirm to explicitly authorize this sandbox transfer attempt.',
    };
  }
  if (input.beneficiaryId.trim() === '') {
    return {
      outcome: 'blocked',
      reason: 'AIRWALLEX_SANDBOX_BENEFICIARY_ID is not set.',
    };
  }
  if (
    !Number.isInteger(input.amountMinor) ||
    input.amountMinor <= 0 ||
    input.amountMinor > MAX_SMOKE_AMOUNT_MINOR
  ) {
    return {
      outcome: 'blocked',
      reason: `amount must be a positive integer ≤ ${String(MAX_SMOKE_AMOUNT_MINOR)} minor units; refusing uncontrolled amounts.`,
    };
  }

  const fingerprint = fingerprintOf(input.config.clientId);
  const stateFile = join(input.stateDir, 'state.json');
  const dbPath = join(input.stateDir, 'smoke.sqlite');

  mkdirSync(input.stateDir, { recursive: true });
  let lock: { release: () => void };
  try {
    lock = acquireLock(input.stateDir, now);
  } catch (error) {
    return {
      outcome: 'blocked',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const client = new AirwallexClient(input.config, input.transport, { now });

    // Read persisted state first: the PERSISTED authorized terms govern reruns.
    let persisted = readState(stateFile);
    if (input.newIntent && persisted !== null && !('corrupt' in persisted)) {
      // Explicit new authorization: archive (never delete) the prior state.
      const archive = join(input.stateDir, `state-${persisted.state.ledgerRequestId}.json`);
      renameSync(stateFile, archive);
      persisted = null;
    }

    // Open the durable ledger (the real backstop for every file-based check).
    const ledger =
      input.ledgerClock === undefined ? openLedger(dbPath) : openLedger(dbPath, input.ledgerClock);
    ledger.migrate();
    try {
      if (persisted === null || 'corrupt' in persisted) {
        if (persisted !== null) {
          return {
            outcome: 'blocked',
            reason: `state file ${stateFile} is corrupt or incomplete. A damaged state file never authorizes a new payment; resolve the existing intent manually (its ledger operation id is recoverable from ${dbPath}).`,
          };
        }
        // No state file: fresh intent is allowed ONLY when the durable ledger
        // holds no unresolved smoke operation (deleting the state file must
        // not silently authorize a new payment).
        const unresolved = unresolvedSmokeOperations(ledger);
        if (unresolved.length > 0) {
          return {
            outcome: 'blocked',
            reason: `state file is absent but the smoke ledger still holds unresolved operations: ${describeUnresolved(unresolved)}. Restore its state file or resolve manually; refusing to create a new payment. (Use --new-intent only after every prior intent is resolved.)`,
          };
        }
        return await createFreshIntent(input, ledger, client, builder, fingerprint, now, stateFile);
      }
      return await continueExistingIntent(
        input,
        ledger,
        client,
        builder,
        fingerprint,
        persisted.state,
      );
    } finally {
      ledger.close();
    }
  } catch (error) {
    return {
      outcome: 'blocked',
      reason: `unexpected failure: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    lock.release();
  }
}

async function verifyFreshBalanceGate(
  client: AirwallexClient,
  amountMinor: number,
): Promise<string | null> {
  let availableMinor: number;
  try {
    const available = await readVerifiedUsdBalance(client);
    if (available === null) {
      return `no ${SMOKE_CURRENCY} balance account exists in this Airwallex sandbox account; fund the sandbox wallet first.`;
    }
    availableMinor = available;
  } catch (error) {
    return `fresh sandbox balance read failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (availableMinor < amountMinor * FUNDING_SAFETY_FACTOR) {
    return `verified ${SMOKE_CURRENCY} available (${String(availableMinor)} minor) is less than ${String(FUNDING_SAFETY_FACTOR)}× the amount (${String(amountMinor)} minor); refusing to spend into an underfunded sandbox.`;
  }
  return null;
}

async function readVerifiedUsdBalance(client: AirwallexClient): Promise<number | null> {
  const balances = await client.balancesCurrent();
  const usd = balances.find((balance) => balance.currency === SMOKE_CURRENCY);
  if (usd === undefined) return null;
  return usd.availableAmount.minorUnits;
}

async function createFreshIntent(
  input: SmokeTransferInput,
  ledger: Ledger,
  client: AirwallexClient,
  builder: DispatcherBuilder,
  fingerprint: string,
  now: () => Date,
  stateFile: string,
): Promise<SmokeTransferResult> {
  let verifiedMinor: number;
  try {
    const available = await readVerifiedUsdBalance(client);
    if (available === null) {
      return {
        outcome: 'blocked',
        reason: `no ${SMOKE_CURRENCY} balance account exists in this Airwallex sandbox account; fund the sandbox wallet first.`,
      };
    }
    verifiedMinor = available;
  } catch (error) {
    return {
      outcome: 'blocked',
      reason: `fresh sandbox balance read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (verifiedMinor < input.amountMinor * FUNDING_SAFETY_FACTOR) {
    return {
      outcome: 'blocked',
      reason: `verified ${SMOKE_CURRENCY} available (${String(verifiedMinor)} minor) is less than ${String(FUNDING_SAFETY_FACTOR)}× the amount (${String(input.amountMinor)} minor); refusing to spend into an underfunded sandbox.`,
    };
  }

  const requestId = `${SMOKE_REQUEST_PREFIX}${now().toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}`;
  const org = ledger.organizations.createOrganization(
    `Airwallex Transfer Smoke ${now().toISOString().slice(0, 10)}`,
  );
  const mission = ledger.organizations.createMission(org.id, 'sandbox transfer smoke');
  const admin = ledger.authority.createHumanActor({
    orgId: org.id,
    username: `smoke-admin-${requestId.slice(-8)}`,
    displayName: 'Smoke Admin',
    role: 'admin',
    password: ['smoke', 'only', 'fixture'].join('-'),
  });
  const approver = ledger.authority.createHumanActor({
    orgId: org.id,
    username: `smoke-approver-${requestId.slice(-8)}`,
    displayName: 'Smoke Approver',
    role: 'approver',
    password: ['smoke', 'only', 'fixture'].join('-'),
  });
  ledger.accounts.ensureTreasuryAccount({
    orgId: org.id,
    currency: SMOKE_CURRENCY,
    label: 'USD',
    protectedFloorMinor: 0,
  });
  // Funding model records the VERIFIED provider-read balance, never a seed.
  ledger.accounts.recordBalanceSnapshot({
    orgId: org.id,
    currency: SMOKE_CURRENCY,
    minorUnits: verifiedMinor,
    source: 'airwallex-sandbox',
    observedAt: now().toISOString(),
    expiresAt: new Date(now().getTime() + 3_600_000).toISOString(),
  });
  return finishIntentSetup(input, ledger, builder, fingerprint, now, stateFile, {
    orgId: org.id,
    missionId: mission.id,
    adminId: admin.id,
    approverId: approver.id,
    requestId,
    amountMinor: input.amountMinor,
  });
}

/**
 * Shared setup tail for a fresh intent: mandate → plan → approval → reserve →
 * persist state ATOMICALLY (before any provider call) → dispatch → readback.
 */
async function finishIntentSetup(
  input: SmokeTransferInput,
  ledger: Ledger,
  builder: DispatcherBuilder,
  fingerprint: string,
  now: () => Date,
  stateFile: string,
  ids: {
    orgId: string;
    missionId: string;
    adminId: string;
    approverId: string;
    requestId: string;
    amountMinor: number;
  },
): Promise<SmokeTransferResult> {
  ledger.mandates.issue({
    orgId: ids.orgId,
    missionId: ids.missionId,
    currency: SMOKE_CURRENCY,
    maxAmountMinor: MAX_SMOKE_AMOUNT_MINOR,
    totalBudgetMinor: MAX_SMOKE_AMOUNT_MINOR,
    permittedOperationKinds: ['airwallex_transfer'],
    byActorId: ids.adminId,
    expiresAt: new Date(now().getTime() + 3_600_000).toISOString(),
  });
  const plan = ledger.plans.recordVersion({
    orgId: ids.orgId,
    missionId: ids.missionId,
    proposedBy: ids.adminId,
    terms: {
      amountMinor: ids.amountMinor,
      currency: SMOKE_CURRENCY,
      beneficiary: input.beneficiaryId,
      purpose: 'MTV-03 sandbox transfer smoke',
    },
  });
  const approval = ledger.approvals.record({
    orgId: ids.orgId,
    plan,
    decidedByActorId: ids.approverId,
    kind: 'airwallex_transfer',
    expiresAt: new Date(now().getTime() + 3_600_000).toISOString(),
  });
  const reservation = ledger.reservations.reserve({
    orgId: ids.orgId,
    missionId: ids.missionId,
    kind: 'airwallex_transfer',
    requestId: ids.requestId,
    planId: plan.id,
    planVersion: plan.version,
    approvalId: approval.id,
  });

  // Persist the complete intent identity BEFORE any provider call, so a
  // crash-after-accept always restarts into reconcile of THIS intent.
  const providerRequestId = providerRequestIdFor(ids.orgId, ids.requestId);
  writeStateAtomic(stateFile, {
    version: 1,
    orgId: ids.orgId,
    missionId: ids.missionId,
    operationId: reservation.operation.id,
    ledgerRequestId: ids.requestId,
    providerRequestId,
    beneficiaryId: input.beneficiaryId,
    amountMinor: ids.amountMinor,
    currency: SMOKE_CURRENCY,
    accountFingerprint: fingerprint,
    createdAt: now().toISOString(),
  });

  return dispatchAndReport(input, ledger, builder, {
    orgId: ids.orgId,
    operationId: reservation.operation.id,
    ledgerRequestId: ids.requestId,
    providerRequestId,
    beneficiaryId: input.beneficiaryId,
    amountMinor: ids.amountMinor,
    currency: SMOKE_CURRENCY,
  });
}

async function continueExistingIntent(
  input: SmokeTransferInput,
  ledger: Ledger,
  client: AirwallexClient,
  builder: DispatcherBuilder,
  fingerprint: string,
  state: SmokeState,
): Promise<SmokeTransferResult> {
  if (state.accountFingerprint !== fingerprint) {
    return {
      outcome: 'blocked',
      reason:
        'state file belongs to a different sandbox account (credential fingerprint mismatch); a different account must not resume or replace this intent.',
    };
  }
  if (state.beneficiaryId !== input.beneficiaryId) {
    return {
      outcome: 'blocked',
      reason: `AIRWALLEX_SANDBOX_BENEFICIARY_ID changed mid-intent (state authorizes a specific beneficiary). Resolve this intent or use --new-intent after it is resolved.`,
    };
  }
  let operation;
  try {
    operation = ledger.reservations.getOperation(state.orgId, state.operationId);
  } catch {
    return {
      outcome: 'blocked',
      reason: `the durable ledger has no operation ${state.operationId} for org ${state.orgId}; state file and ledger disagree — resolve manually, never re-create.`,
    };
  }
  if (
    operation.requestId !== state.ledgerRequestId ||
    operation.amountMinor !== state.amountMinor ||
    operation.currency !== state.currency ||
    operation.beneficiary !== state.beneficiaryId
  ) {
    return {
      outcome: 'blocked',
      reason:
        'persisted state and the durable operation disagree on the authorized terms; resolve manually — never re-create or substitute terms.',
    };
  }
  if (providerRequestIdFor(state.orgId, state.ledgerRequestId) !== state.providerRequestId) {
    return {
      outcome: 'blocked',
      reason:
        'persisted provider request id does not match the namespacing of the persisted org/request ids; state integrity failure — resolve manually.',
    };
  }

  const blocked = await verifyFreshBalanceGate(client, state.amountMinor);
  if (blocked !== null) return { outcome: 'blocked', reason: blocked };

  // Reopen the SAME durable intent: worker pass dispatches only if this
  // intent was never attempted (same request id — provider-deduped);
  // otherwise it reconciles by the original identity. Never a second
  // economic identity.
  return dispatchAndReport(input, ledger, builder, {
    orgId: state.orgId,
    operationId: state.operationId,
    ledgerRequestId: state.ledgerRequestId,
    providerRequestId: state.providerRequestId,
    beneficiaryId: state.beneficiaryId,
    amountMinor: state.amountMinor,
    currency: state.currency,
  });
}

async function dispatchAndReport(
  input: SmokeTransferInput,
  ledger: Ledger,
  builder: DispatcherBuilder,
  identity: {
    orgId: string;
    operationId: string;
    ledgerRequestId: string;
    providerRequestId: string;
    beneficiaryId: string;
    amountMinor: number;
    currency: string;
  },
): Promise<SmokeTransferResult> {
  const dispatcher = builder(
    input.config,
    input.transport,
    ledger.providerReceipts,
    ledger.clock,
    () => identity.beneficiaryId,
  );
  ledger.worker.register(dispatcher);
  const workerReport = await ledger.worker.runOnce();

  let readback: ProviderCallResult<unknown, ProviderCallStatus>;
  try {
    readback = await dispatcher.reconcileByRequestId(identity.ledgerRequestId, {
      orgId: identity.orgId,
      operationId: identity.operationId,
      amountMinor: identity.amountMinor,
      currency: identity.currency,
      beneficiary: identity.beneficiaryId,
    });
  } catch (error) {
    return {
      outcome: 'blocked',
      reason: `readback failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let operationState: string;
  try {
    const current = ledger.reservations.getOperation(identity.orgId, identity.operationId);
    operationState = current.state;
    if (
      readback.status === 'confirmed' &&
      ['IN_FLIGHT', 'STATUS_UNKNOWN', 'SUBMITTING'].includes(current.state)
    ) {
      ledger.reservations.transition({
        orgId: identity.orgId,
        operationId: identity.operationId,
        to: 'SETTLED',
        attestation: {
          source: 'provider-readback',
          note: 'sandbox smoke: terminal-success readback',
        },
      });
      operationState = 'SETTLED';
    }
  } catch (error) {
    return {
      outcome: 'blocked',
      reason: `operation state update failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const receipts = ledger.providerReceipts.listByRequestId(
    identity.ledgerRequestId,
    identity.orgId,
  );
  const outcome: SmokeTransferResult['outcome'] =
    readback.status === 'confirmed' ||
    operationState === 'SETTLED' ||
    operationState === 'RECONCILED'
      ? 'confirmed'
      : operationState === 'REQUIRES_HUMAN'
        ? 'requires-human'
        : workerReport.dispatched > 0
          ? 'dispatched'
          : 'monitoring';
  if (outcome === 'requires-human') {
    return {
      outcome: 'requires-human',
      reason: `operation escalated (state ${operationState}, providerState ${String(readback.providerState)}); funds remain committed pending human resolution. No further create attempts will be made for this intent.`,
    };
  }
  return {
    outcome,
    orgId: identity.orgId,
    operationId: identity.operationId,
    operationState,
    ledgerRequestId: identity.ledgerRequestId,
    providerRequestId: identity.providerRequestId,
    readbackStatus: readback.status,
    readbackProviderState: readback.providerState ?? null,
    verifiedAt: readback.verifiedAt ?? null,
    workerReport: {
      claimed: workerReport.claimed,
      dispatched: workerReport.dispatched,
      reconciled: workerReport.reconciled,
      markedUnknown: workerReport.markedUnknown,
      escalated: workerReport.escalated,
      blocked: workerReport.blocked,
    },
    receiptCount: receipts.length,
  };
}
