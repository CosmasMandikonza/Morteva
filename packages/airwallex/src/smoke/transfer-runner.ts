/**
 * Airwallex transfer smoke runner (issue #5; final-acceptance safety contract).
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
 *  - the one-intent policy covers ALL persisted states: a missing state file
 *    NEVER authorizes another payment, regardless of the prior operation's
 *    state (SETTLED awaiting reconciliation and REQUIRES_HUMAN count as
 *    unresolved, not resolved). A separate economic intent requires
 *    --new-intent (explicit new authorization) AND that every prior smoke
 *    operation is fully resolved (RECONCILED/CANCELLED); only then is the
 *    prior state file ARCHIVED (never deleted — the original request and
 *    provider identities remain recoverable from the archive, the ledger and
 *    the provider receipts);
 *  - concurrent invocations are serialized by an exclusive lock file; state
 *    writes are temp+rename atomic; a FRESH VERIFIED sandbox balance read
 *    gates every invocation and the amount is capped far below observed funds.
 *
 * Outcome taxonomy (unambiguous by construction):
 *   blocked        — strictly BEFORE any provider attempt this run: nothing
 *                    was submitted.
 *   unverified     — a provider attempt may have occurred (this run or an
 *                    earlier one): outcome unknown, funds remain committed;
 *                    the ONLY recovery is reconciling THIS intent by its
 *                    original identity — never a new one.
 *   requires-human — explicit escalation (definitive provider failure,
 *                    authoritative late-failure reversal after settlement,
 *                    or a contradictory readback after reconciliation).
 *   confirmed      — an identity-verified PAID readback at a specific
 *                    verification time AND the ledger state machine says
 *                    SETTLED/RECONCILED. Late failure remains possible and
 *                    monitored (PAID is not irreversible delivery).
 *
 * Provider-truth handling is routed through the AUTHORITATIVE worker/state
 * machine (worker.runOnce({claimTtlMs: 0}) reconciles immediately): the
 * runner's own readback is for reporting and may only SETTLE (never reverse
 * or rewrite) — reversals and escalations are always the worker's, with
 * their auditable evidence events.
 *
 * This module is side-effect free and returns structured outcomes; the CLI
 * wrapper (transfer.ts) maps outcomes to console output and exit codes.
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
/** Every request id this smoke creates starts with this marker (intent guard). */
export const SMOKE_REQUEST_PREFIX = 'awx-smoke-';
/**
 * A smoke operation is RESOLVED only when nothing further is owed: RECONCILED
 * (funds confirmed arrived, monitoring drained) or CANCELLED (never executed).
 * SETTLED is NOT resolved — it is provider-verified success still awaiting
 * reconciliation (PAID can still fail late). REQUIRES_HUMAN is NOT resolved —
 * a human owns an open money decision. (Kept in sync with the unresolved
 * list inside unresolvedSmokeOperations.)
 */

export interface SmokeTransferInput {
  readonly config: AirwallexAdapterConfig;
  readonly transport: AirwallexTransport;
  /** Server-side sandbox beneficiary (from the environment, never persisted raw beyond the state file). */
  readonly beneficiaryId: string;
  /** Requested amount for a NEW intent (minor units). Ignored on reruns — the persisted authorized terms govern. */
  readonly amountMinor: number;
  /** Explicit human authorization for this invocation (required every run). */
  readonly confirm: boolean;
  /**
   * PREPARE without executing: build the full governed chain (mandate → plan
   * → separate-role approval → reservation → durable intent persisted) and
   * STOP before any dispatcher is constructed or any provider write is sent.
   * The balance gate still runs (a READ). Never requires --confirm — that
   * remains the execution authorization for a LATER invocation.
   */
  readonly prepareOnly: boolean;
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
      /** Governed chain fully built and durably persisted; NOTHING dispatched. */
      readonly outcome: 'prepared';
      readonly orgId: string;
      readonly missionId: string;
      readonly mandateId: string;
      readonly planId: string;
      readonly approvalId: string;
      readonly operationId: string;
      readonly operationState: string;
      readonly ledgerRequestId: string;
      readonly providerRequestId: string;
      readonly beneficiaryId: string;
      readonly amountMinor: number;
      readonly currency: string;
      /** Provider-read USD available at preparation time (the funding gate input). */
      readonly verifiedUsdAvailableMinor: number | null;
    }
  | {
      readonly outcome: 'unverified';
      readonly reason: string;
      readonly orgId: string;
      readonly operationId: string;
      readonly operationState: string;
      readonly ledgerRequestId: string;
      readonly providerRequestId: string;
      readonly workerReport?: Readonly<Record<string, number>>;
      readonly receiptCount?: number;
    }
  | {
      readonly outcome: 'requires-human';
      readonly reason: string;
      readonly orgId: string;
      readonly operationId: string;
      readonly operationState: string;
      readonly ledgerRequestId: string;
      readonly providerRequestId: string;
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

interface PriorOperation {
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

/** Every smoke operation in the durable ledger, in any state. */
function allSmokeOperations(ledger: Ledger): PriorOperation[] {
  return ledger.db
    .prepare(
      `SELECT o.request_id AS requestId, o.id AS operationId, o.state AS state
         FROM operations o
        WHERE o.request_id LIKE ?
        ORDER BY o.created_at`,
    )
    .all(`${SMOKE_REQUEST_PREFIX}%`) as PriorOperation[];
}

/** Smoke operations that still owe something (money may be in motion, verified-success still monitored, or a human decision open). */
function unresolvedSmokeOperations(ledger: Ledger): PriorOperation[] {
  const unresolvedStates = [
    'RESERVED',
    'SUBMITTING',
    'IN_FLIGHT',
    'STATUS_UNKNOWN',
    'SETTLED',
    'REQUIRES_HUMAN',
  ];
  return allSmokeOperations(ledger).filter((o) => unresolvedStates.includes(o.state));
}

function describeOperations(operations: readonly PriorOperation[]): string {
  return operations
    .map((o) => `${o.requestId} (operation ${o.operationId.slice(0, 8)}…) state=${o.state}`)
    .join('; ');
}

/**
 * The smoke workflow. NEVER process.exits; returns a structured outcome.
 * 'blocked' is fail-closed and strictly pre-attempt: nothing was sent to the
 * provider. Anything after a possible provider attempt reports 'unverified'.
 */
export async function runSmokeTransfer(input: SmokeTransferInput): Promise<SmokeTransferResult> {
  const now = input.now ?? (() => new Date());
  const builder = input.buildDispatcher ?? buildSandboxDispatcher;

  if (!input.confirm && !input.prepareOnly) {
    return {
      outcome: 'blocked',
      reason:
        'pass --confirm to explicitly authorize this sandbox transfer attempt (or --prepare-only to stage the governed intent WITHOUT executing).',
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

  // Set the moment a provider attempt becomes possible in THIS run; after
  // that point every failure is 'unverified', never 'blocked'.
  const runState = { providerAttemptPossible: false };

  try {
    const client = new AirwallexClient(input.config, input.transport, { now });

    let persisted = readState(stateFile);
    if (persisted !== null && 'corrupt' in persisted) {
      return {
        outcome: 'blocked',
        reason: `state file ${stateFile} is corrupt or incomplete. A damaged state file never authorizes a new payment; the original intent's operation and identities remain recoverable from the durable ledger (${dbPath}) and its provider receipts.`,
      };
    }

    // Open the durable ledger (the real backstop for every file-based check).
    const ledger =
      input.ledgerClock === undefined ? openLedger(dbPath) : openLedger(dbPath, input.ledgerClock);
    ledger.migrate();
    try {
      if (input.newIntent) {
        // Explicit new authorization. The check comes FIRST; archiving the
        // prior state file happens only after every prior smoke operation is
        // fully resolved (RECONCILED/CANCELLED — SETTLED still monitors and
        // REQUIRES_HUMAN still owes a human decision, so both block).
        const unresolved = unresolvedSmokeOperations(ledger);
        if (unresolved.length > 0) {
          return {
            outcome: 'blocked',
            reason: `--new-intent refused: prior smoke operations are not fully resolved (SETTLED awaits reconciliation; REQUIRES_HUMAN owes a human decision): ${describeOperations(unresolved)}. Resolve them first; their identities remain recoverable from the ledger and archived state.`,
          };
        }
        if (persisted !== null) {
          // Checks passed: archive (never delete) so the original identities
          // stay recoverable, then start the explicitly authorized new intent.
          const archive = join(input.stateDir, `state-${persisted.state.ledgerRequestId}.json`);
          renameSync(stateFile, archive);
          persisted = null;
        }
        return await createFreshIntent(
          input,
          ledger,
          client,
          builder,
          fingerprint,
          now,
          stateFile,
          runState,
        );
      }
      if (persisted !== null) {
        return await continueExistingIntent(
          input,
          ledger,
          client,
          builder,
          fingerprint,
          persisted.state,
          runState,
        );
      }
      // No state file and no --new-intent: a fresh payment is authorized ONLY
      // when the durable ledger holds NO prior smoke operation at all — in ANY
      // state. Deleting the state file must never silently authorize another
      // payment, regardless of the prior operation's state.
      const priors = allSmokeOperations(ledger);
      if (priors.length > 0) {
        return {
          outcome: 'blocked',
          reason: `state file is absent but the smoke ledger holds prior operations: ${describeOperations(priors)}. A missing state file never authorizes a new payment in any state; resolve/reconcile via the existing intent or pass --new-intent (explicit new authorization, only after every prior intent is fully resolved).`,
        };
      }
      return await createFreshIntent(
        input,
        ledger,
        client,
        builder,
        fingerprint,
        now,
        stateFile,
        runState,
      );
    } finally {
      ledger.close();
    }
  } catch (error) {
    const message = `unexpected failure: ${error instanceof Error ? error.message : String(error)}`;
    if (runState.providerAttemptPossible) {
      return {
        outcome: 'unverified',
        reason: `${message} — a provider attempt may already have occurred. Funds remain committed; recover ONLY by reconciling this same intent (rerun this script); never substitute a new identity.`,
        orgId: '(see state file / durable ledger)',
        operationId: '(see state file / durable ledger)',
        operationState: 'unknown',
        ledgerRequestId: '(see state file / durable ledger)',
        providerRequestId: '(see state file / durable ledger)',
      };
    }
    return { outcome: 'blocked', reason: message };
  } finally {
    lock.release();
  }
}

async function readVerifiedUsdBalance(client: AirwallexClient): Promise<number | null> {
  const balances = await client.balancesCurrent();
  const usd = balances.find((balance) => balance.currency === SMOKE_CURRENCY);
  if (usd === undefined || usd.availableAmount === null) return null;
  return usd.availableAmount.minorUnits;
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

async function createFreshIntent(
  input: SmokeTransferInput,
  ledger: Ledger,
  client: AirwallexClient,
  builder: DispatcherBuilder,
  fingerprint: string,
  now: () => Date,
  stateFile: string,
  runState: { providerAttemptPossible: boolean },
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
  return finishIntentSetup(input, ledger, builder, fingerprint, now, stateFile, runState, {
    orgId: org.id,
    missionId: mission.id,
    adminId: admin.id,
    approverId: approver.id,
    requestId,
    amountMinor: input.amountMinor,
    verifiedUsdAvailableMinor: verifiedMinor,
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
  runState: { providerAttemptPossible: boolean },
  ids: {
    orgId: string;
    missionId: string;
    adminId: string;
    approverId: string;
    requestId: string;
    amountMinor: number;
    verifiedUsdAvailableMinor: number;
  },
): Promise<SmokeTransferResult> {
  const mandate = ledger.mandates.issue({
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

  // PREPARE-ONLY: the governed chain is fully built and durably persisted;
  // the intent stops at RESERVED with NO dispatcher constructed, NO outbox
  // claim, NO provider write. Execution is a LATER invocation with --confirm.
  if (input.prepareOnly) {
    return {
      outcome: 'prepared',
      orgId: ids.orgId,
      missionId: ids.missionId,
      mandateId: mandate.id,
      planId: plan.id,
      approvalId: approval.id,
      operationId: reservation.operation.id,
      operationState: reservation.operation.state,
      ledgerRequestId: ids.requestId,
      providerRequestId,
      beneficiaryId: input.beneficiaryId,
      amountMinor: ids.amountMinor,
      currency: SMOKE_CURRENCY,
      verifiedUsdAvailableMinor: ids.verifiedUsdAvailableMinor,
    };
  }

  return dispatchAndReport(input, ledger, builder, runState, {
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
  runState: { providerAttemptPossible: boolean },
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

  // PREPARE-ONLY on an existing intent: only a never-attempted (RESERVED)
  // intent can be prepared — anything beyond RESERVED means an attempt
  // happened and the normal execution/reconciliation mode must be used.
  if (input.prepareOnly) {
    if (operation.state !== 'RESERVED') {
      return {
        outcome: 'blocked',
        reason: `prepare-only refused: this intent was already attempted (state ${operation.state}); use the normal execution mode to reconcile or resolve it.`,
      };
    }
    return {
      outcome: 'prepared',
      orgId: state.orgId,
      missionId: state.missionId,
      mandateId: operation.mandateId,
      planId: operation.planId,
      approvalId: operation.approvalId,
      operationId: state.operationId,
      operationState: operation.state,
      ledgerRequestId: state.ledgerRequestId,
      providerRequestId: state.providerRequestId,
      beneficiaryId: state.beneficiaryId,
      amountMinor: state.amountMinor,
      currency: state.currency,
      verifiedUsdAvailableMinor: null,
    };
  }

  // Reopen the SAME durable intent: the worker pass dispatches only if this
  // intent was never attempted (same request id — provider-deduped);
  // otherwise it reconciles by the original identity. Never a second
  // economic identity.
  return dispatchAndReport(input, ledger, builder, runState, {
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
  runState: { providerAttemptPossible: boolean },
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

  // A prior run may already have attempted this intent (anything beyond
  // RESERVED means an attempt happened or was begun).
  const before = ledger.reservations.getOperation(identity.orgId, identity.operationId);
  if (before.state !== 'RESERVED') {
    runState.providerAttemptPossible = true;
  }

  // AUTHORITATIVE pass first (claimTtlMs 0 → stale claims reconcile
  // immediately instead of waiting out the TTL): the state machine owns
  // every escalation and reversal with its auditable evidence events.
  const firstPass = await ledger.worker.runOnce({ claimTtlMs: 0 });
  let workerTotals: Readonly<Record<string, number>> = {
    claimed: firstPass.claimed,
    dispatched: firstPass.dispatched,
    reconciled: firstPass.reconciled,
    markedUnknown: firstPass.markedUnknown,
    escalated: firstPass.escalated,
    blocked: firstPass.blocked,
  };
  if (firstPass.dispatched > 0 || firstPass.markedUnknown > 0) {
    runState.providerAttemptPossible = true;
  }

  // Fresh provider readback — the authoritative observation for reporting.
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
    return unverified(
      identity,
      'readback attempt failed' + `: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let operation = ledger.reservations.getOperation(identity.orgId, identity.operationId);

  // If the FRESH readback contradicts the local state, drive the
  // authoritative worker once more so the state machine (not this reporter)
  // resolves it — e.g. a definitive failure the first pass did not see.
  if (
    readback.status === 'failed' &&
    ['SETTLED', 'IN_FLIGHT', 'STATUS_UNKNOWN', 'SUBMITTING'].includes(operation.state)
  ) {
    const secondPass = await ledger.worker.runOnce({ claimTtlMs: 0 });
    workerTotals = {
      claimed: workerTotals.claimed! + secondPass.claimed,
      dispatched: workerTotals.dispatched! + secondPass.dispatched,
      reconciled: workerTotals.reconciled! + secondPass.reconciled,
      markedUnknown: workerTotals.markedUnknown! + secondPass.markedUnknown,
      escalated: workerTotals.escalated! + secondPass.escalated,
      blocked: workerTotals.blocked! + secondPass.blocked,
    };
    operation = ledger.reservations.getOperation(identity.orgId, identity.operationId);
  }

  // The runner may only SETTLE (never reverse or rewrite) and only on a
  // fresh identity-verified terminal-success readback.
  if (
    readback.status === 'confirmed' &&
    ['IN_FLIGHT', 'STATUS_UNKNOWN', 'SUBMITTING'].includes(operation.state)
  ) {
    try {
      ledger.reservations.transition({
        orgId: identity.orgId,
        operationId: identity.operationId,
        to: 'SETTLED',
        attestation: {
          source: 'provider-readback',
          note: 'sandbox smoke: terminal-success readback',
        },
      });
      operation = ledger.reservations.getOperation(identity.orgId, identity.operationId);
    } catch (error) {
      return unverified(
        identity,
        `operation state update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const receipts = ledger.providerReceipts.listByRequestId(
    identity.ledgerRequestId,
    identity.orgId,
  );

  // Outcome mapping — fresh provider truth AND ledger state must agree
  // before anything positive is reported; a definitive failure always
  // escalates; unknown outcomes after an attempt are 'unverified'.
  if (operation.state === 'REQUIRES_HUMAN') {
    return {
      outcome: 'requires-human',
      reason: `operation escalated (state REQUIRES_HUMAN; fresh readback status=${readback.status} providerState=${String(readback.providerState)}). ${
        readback.status === 'failed'
          ? 'The authoritative worker recorded the definitive/late failure with auditable evidence; history is preserved and exposure remains held pending human resolution.'
          : 'Funds remain committed pending human resolution.'
      } No further create attempts will be made for this intent.`,
      orgId: identity.orgId,
      operationId: identity.operationId,
      operationState: operation.state,
      ledgerRequestId: identity.ledgerRequestId,
      providerRequestId: identity.providerRequestId,
    };
  }
  if (readback.status === 'failed') {
    // The worker pass(es) should have escalated; if the state machine could
    // not (e.g. already RECONCILED — history is never rewritten), escalate
    // the REPORT and say so. Never a positive or neutral outcome here.
    return {
      outcome: 'requires-human',
      reason:
        operation.state === 'RECONCILED'
          ? `contradictory provider readback (${String(readback.providerState)}) AFTER reconciliation: terminal history is never rewritten; the authoritative worker recorded reversal-after-reconciled evidence. Human investigation required; exposure decisions belong to a human.`
          : `fresh readback is definitive-failure (${String(readback.providerState)}) while the operation state is ${operation.state}; the authoritative escalation did not complete — investigate before any further action. Funds remain committed.`,
      orgId: identity.orgId,
      operationId: identity.operationId,
      operationState: operation.state,
      ledgerRequestId: identity.ledgerRequestId,
      providerRequestId: identity.providerRequestId,
    };
  }
  const confirmedNow =
    readback.status === 'confirmed' && ['SETTLED', 'RECONCILED'].includes(operation.state);
  if (confirmedNow) {
    return {
      outcome: 'confirmed',
      orgId: identity.orgId,
      operationId: identity.operationId,
      operationState: operation.state,
      ledgerRequestId: identity.ledgerRequestId,
      providerRequestId: identity.providerRequestId,
      readbackStatus: readback.status,
      readbackProviderState: readback.providerState ?? null,
      verifiedAt: readback.verifiedAt ?? null,
      workerReport: workerTotals,
      receiptCount: receipts.length,
    };
  }
  if (readback.status === 'status-unknown') {
    // The outcome of a provider attempt (this run's or an earlier one's) is
    // UNKNOWN — distinct from both 'blocked' (nothing was attempted) and
    // 'dispatched'/'monitoring' (verifiably pending). Recovery is always
    // reconciling THIS intent by its original identity.
    return {
      outcome: 'unverified' as const,
      reason: `fresh readback is ambiguous (providerState=${String(readback.providerState)}); the outcome of the provider attempt is unknown — a provider attempt may already have occurred; funds remain committed. Recover ONLY by reconciling this same intent (rerun this script); never substitute a new identity.`,
      orgId: identity.orgId,
      operationId: identity.operationId,
      operationState: operation.state,
      ledgerRequestId: identity.ledgerRequestId,
      providerRequestId: identity.providerRequestId,
      workerReport: workerTotals,
      receiptCount: receipts.length,
    };
  }
  if (providerAttemptedThisRun(workerTotals) && readback.status !== 'confirmed') {
    // Submitted this run (provider accepted); readback verifiably pending.
    return dispatchedOrMonitoring(
      identity,
      operation.state,
      workerTotals,
      receipts.length,
      readback,
    );
  }
  // Nothing dispatched this run and no terminal readback: still monitored.
  return dispatchedOrMonitoring(identity, operation.state, workerTotals, receipts.length, readback);
}

function providerAttemptedThisRun(workerTotals: Readonly<Record<string, number>>): boolean {
  return (workerTotals.dispatched ?? 0) > 0 || (workerTotals.markedUnknown ?? 0) > 0;
}

function dispatchedOrMonitoring(
  identity: {
    orgId: string;
    operationId: string;
    ledgerRequestId: string;
    providerRequestId: string;
  },
  operationState: string,
  workerTotals: Readonly<Record<string, number>>,
  receiptCount: number,
  readback: ProviderCallResult<unknown, ProviderCallStatus>,
): SmokeTransferResult {
  return {
    outcome: (workerTotals.dispatched ?? 0) > 0 ? 'dispatched' : 'monitoring',
    orgId: identity.orgId,
    operationId: identity.operationId,
    operationState,
    ledgerRequestId: identity.ledgerRequestId,
    providerRequestId: identity.providerRequestId,
    readbackStatus: readback.status,
    readbackProviderState: readback.providerState ?? null,
    verifiedAt: readback.verifiedAt ?? null,
    workerReport: { ...workerTotals },
    receiptCount,
  };
}

function unverified(
  identity: {
    orgId: string;
    operationId: string;
    ledgerRequestId: string;
    providerRequestId: string;
  },
  reason: string,
): SmokeTransferResult {
  return {
    outcome: 'unverified',
    reason: `${reason} — a provider attempt may already have occurred; funds remain committed. Recover ONLY by reconciling this same intent (rerun this script); never substitute a new identity.`,
    orgId: identity.orgId,
    operationId: identity.operationId,
    operationState: 'STATUS_UNKNOWN (or in flight — see durable ledger)',
    ledgerRequestId: identity.ledgerRequestId,
    providerRequestId: identity.providerRequestId,
  };
}
