/**
 * Ledger binding — the ONLY place the planner touches durable state, and
 * strictly read-only + proposal-only. The ledger remains the sole financial
 * authority: every planner pre-check is re-enforced by the ledger itself at
 * reservation time (tested in ledger-integration.test.ts).
 */
import type { Ledger } from '@moterva/ledger';
import { LedgerError } from '@moterva/ledger';
import type { CandidatePlanView } from '@moterva/domain';
import type { DecisionResult, FinancialFacts } from './contracts.js';

/**
 * Snapshot the durable financial facts for one org/mission/currency.
 * Mirrors the engine's own semantics: stale/missing balance snapshots are
 * carried as status (never coerced to a number), ambiguous and escalated
 * exposure both count as committed.
 */
export function financialFacts(
  ledger: Ledger,
  orgId: string,
  missionId: string,
  currency: string,
): FinancialFacts {
  const inspected = ledger.spendable.inspect(orgId, currency);
  let balanceStatus: FinancialFacts['balanceStatus'];
  let balanceMinor: number | null = null;
  let spendableMinor: number | null = null;
  if (inspected.kind === 'ok') {
    balanceStatus = 'ok';
    balanceMinor = inspected.view.balanceMinor;
    spendableMinor = inspected.view.spendableMinor;
  } else if (inspected.kind === 'stale') {
    balanceStatus = 'stale';
  } else {
    balanceStatus = 'no_snapshot';
  }

  const account = (() => {
    try {
      return ledger.accounts.getTreasuryAccount(orgId, currency);
    } catch {
      return { protectedFloorMinor: 0 };
    }
  })();

  const committedRows = ledger.db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN state IN ('reserved','unknown') THEN amount_minor ELSE 0 END), 0) AS outstanding,
              COALESCE(SUM(CASE WHEN state = 'unknown' THEN amount_minor ELSE 0 END), 0) AS ambiguous
         FROM commitments WHERE org_id = ? AND currency = ?`,
    )
    .get(orgId, currency) as { outstanding: number; ambiguous: number };

  // IMPORTANT: use the ledger's authoritative activeFor() selector instead
  // of sorting mandate versions in SQL. Different mandate IDs may both have
  // version 1: the older superseded record must never hide the effective
  // active envelope, and conflicting active rows must FAIL CLOSED.
  let mandate: FinancialFacts['mandate'] = null;
  try {
    const active = ledger.mandates.activeFor(orgId, missionId, ledger.clock.now(), currency);
    const consumed = ledger.mandates.consumedMissionBudget(orgId, missionId, currency);
    const total = ledger.mandates.effectiveTotalBudget(active);
    mandate = {
      id: active.id,
      version: active.version,
      expiresAt: active.expiresAt,
      maxPerPaymentMinor: active.maxAmountMinor,
      remainingBudgetMinor: Math.max(0, total - consumed),
      permittedKinds: active.permittedOperationKinds,
      allowedBeneficiaries: active.allowedBeneficiaries,
      allowedPurposes: active.allowedPurposes,
    };
  } catch (error) {
    // A missing/revoked/superseded/expired mandate provides NO spend authority.
    // Unexpected errors (including contradictory active mandates or DB damage)
    // are not silently swallowed.
    if (
      !(error instanceof LedgerError) ||
      !['MANDATE_NOT_FOUND', 'MANDATE_EXPIRED', 'MANDATE_REVOKED', 'MANDATE_SUPERSEDED'].includes(
        error.code,
      )
    ) {
      throw error;
    }
  }

  return {
    orgId,
    missionId,
    currency,
    balanceStatus,
    balanceMinor,
    spendableMinor,
    outstandingCommittedMinor: committedRows.outstanding,
    ambiguousCommittedMinor: committedRows.ambiguous,
    protectedFloorMinor: account.protectedFloorMinor,
    mandate,
  };
}

/**
 * Record the SELECTED decision's plan in the ledger through the EXISTING
 * versioned-plan flow. This creates a candidate plan only — approval and
 * reservation remain human/actor actions through the ledger's own gates.
 * The planner never authorizes anything.
 */
export function recordDecisionPlan(
  ledger: Ledger,
  decision: DecisionResult,
  input: { orgId: string; missionId: string; proposedBy: string | null },
): { plan: CandidatePlanView | null; note: string } {
  if (decision.outcome !== 'select' || decision.selected === null) {
    return { plan: null, note: 'no selected action to propose' };
  }
  const c = decision.selected.candidate;
  const plan = ledger.plans.recordVersion({
    orgId: input.orgId,
    missionId: input.missionId,
    proposedBy: input.proposedBy,
    terms: {
      amountMinor: c.costMinor + c.feeMinor,
      currency: c.currency,
      beneficiary: c.beneficiary,
      purpose: c.purpose,
      // Floats are forbidden in financial terms: probabilities are stored
      // as exact basis-point integers (e.g. 0.855 -> 8550).
      quote: {
        plannerEvaluationId: decision.trace.evaluationId,
        candidateId: c.id,
        candidateKind: c.kind,
        effectiveProbabilityBps: Math.round(decision.selected.effectiveProbability * 10000),
        expectedNetMinor: decision.selected.expectedNetMinor,
        evidenceIds: [...c.evidenceIds],
        truthLabel: decision.trace.truthLabel,
      },
    },
  });
  return { plan, note: 'candidate plan recorded; approval and reservation remain actor-gated' };
}

/**
 * Journal a planner decision as append-only evidence for replay. Payload is
 * structured and safe by construction (ids, codes, numbers, the fixed truth
 * label) — the ledger's own evidence service handles durability.
 */
export function journalDecision(
  ledger: Ledger,
  decision: DecisionResult,
  tenant: { orgId: string; missionId: string },
): void {
  ledger.evidence.append({
    orgId: tenant.orgId,
    missionId: tenant.missionId,
    topic: 'operational',
    type: 'planner.decision',
    eventKey: `planner:${decision.trace.evaluationId}:${decision.trace.decision}`,
    payload: {
      evaluationId: decision.trace.evaluationId,
      decision: decision.trace.decision,
      selectedId: decision.trace.selectedId,
      truthLabel: decision.trace.truthLabel,
      reasons: decision.reasons.map((r) => r.code),
      evidenceIds: decision.trace.evidenceAcceptedIds,
      scores: decision.trace.scores.map((s) => ({
        id: s.candidate.id,
        feasible: s.feasible,
        rejection: s.rejection?.code ?? null,
        net: s.expectedNetMinor,
      })),
    },
  });
}
