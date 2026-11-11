/**
 * Operator-facing language for planner outcomes and refusals. The planner's
 * typed codes are the truth; this table only explains them in plain words —
 * it never softens a refusal into a success and never invents a reason.
 * apps/web/test/decisionCopy.test.ts reads the planner contract source and
 * fails if a rejection code exists without copy (drift guard).
 */

export const REJECTION_COPY: Readonly<Record<string, string>> = {
  ASSET_SAFETY_BLOCKED:
    'The asset this option depends on is blocked — or its status is unknown — under your safety policy, so it cannot be used.',
  MANDATE_EXPIRED:
    'No active, unexpired mandate covers this mission. Spending is refused until a human grants authority.',
  BENEFICIARY_NOT_ALLOWED: 'The beneficiary is not on the mandate’s approved list.',
  PURPOSE_NOT_ALLOWED: 'The purpose is not on the mandate’s approved list.',
  KIND_NOT_PERMITTED: 'The mandate does not permit this kind of operation.',
  OVER_PER_PAYMENT_CAP: 'The amount exceeds the mandate’s per-operation cap.',
  OVER_MISSION_BUDGET: 'The amount exceeds what remains of the mandate’s mission budget.',
  INSUFFICIENT_SPENDABLE:
    'The observed balance, after commitments, is not enough. A stale or missing balance observation also blocks spending.',
  RESERVE_BREACH: 'Paying this would dip into the protected reserve, which is never spendable.',
  DEADLINE_INFEASIBLE:
    'The supplier cannot start and finish before the mission deadline (lead time + duration).',
  QUOTE_EXPIRED: 'The supplier’s quote has expired.',
  UNCONFIRMED_AVAILABILITY_FORBIDDEN:
    'The supplier has not confirmed availability, and policy forbids paying on an unconfirmed offer.',
  INFORMATION_NOT_WORTH_PRICE:
    'The diagnostic would cost more than the decision value it is expected to add.',
  EVIDENCE_NOT_FOUND: 'The option cites evidence that was never admitted.',
  EVIDENCE_REJECTED: 'The option cites evidence that was refused in this review.',
  MALFORMED_CANDIDATE: 'The option failed structural validation and was discarded.',
  CURRENCY_UNSUPPORTED: 'The option’s currency has no registered precision.',
  PROBABILITY_OUT_OF_RANGE: 'The success probability is outside (0, 1].',
  INVALID_ARITHMETIC: 'The option’s amounts could not be computed exactly.',
};

export function rejectionCopy(code: string | null): string {
  if (code === null || code === 'none') return 'Eligible under your policy and mandate.';
  return REJECTION_COPY[code] ?? `Refused by policy (${code}).`;
}

export type OutcomeKind = 'no-action' | 'spend' | 'decline' | 'escalate';

export interface OutcomeDescriptor {
  readonly kind: OutcomeKind;
  readonly label: string;
  readonly explanation: string;
}

/** Classify a decision into the four outcomes an operator must tell apart. */
export function describeOutcome(
  outcome: 'select' | 'decline' | 'escalate',
  selected: { grossMinor: number; candidateId?: string } | null,
): OutcomeDescriptor {
  if (outcome === 'escalate') {
    return {
      kind: 'escalate',
      label: 'ESCALATED — HUMAN DECISION',
      explanation:
        'The evidence conflicts or is too uncertain for the system to pick a side. No spend is proposed; a person must decide.',
    };
  }
  if (outcome === 'decline') {
    return {
      kind: 'decline',
      label: 'DECLINED — NOTHING PERMITTED',
      explanation:
        'No option is permitted right now (for example, no active mandate or no spendable balance). Nothing is proposed.',
    };
  }
  if (selected === null || selected.grossMinor <= 0) {
    return {
      kind: 'no-action',
      label: 'NO ACTION — HOLD THE CURRENT PLAN',
      explanation:
        'Under your thresholds and costs, spending now is not justified. This is a decision, not an error: the plan continues unchanged.',
    };
  }
  return {
    kind: 'spend',
    label: 'SPEND PROPOSED — AWAITING HUMAN APPROVAL',
    explanation:
      'The cheapest-expected-loss option that survives every safety, mandate and budget gate. It is only a proposal until a separate person approves exact terms.',
  };
}

/** Provenance wording: what a source label does and does NOT assert. */
export function provenanceCopy(provenance: string): { badge: string; detail: string } {
  if (provenance === 'FIELD') {
    return {
      badge: 'FIELD · SOURCE-AUTHENTICATED CLAIM',
      detail:
        'A registered source authenticated with its credential claimed this observation. MOTERVA verified who signed it, not that the sensor is correct.',
    };
  }
  if (provenance === 'SYNTHETIC') {
    return {
      badge: 'SYNTHETIC · NOT A FIELD MEASUREMENT',
      detail: 'Simulated or test data. It must never be read as a real-world observation.',
    };
  }
  return { badge: `${provenance} · UNRECOGNIZED`, detail: 'Unrecognized provenance label.' };
}
