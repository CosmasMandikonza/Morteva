/**
 * Presentation status mapping — mirrors design/tokens.json v1.1.0
 * statusSemantics (ADR 0004), which is machine-checked against
 * packages/domain/src. Layers are never conflated: operation states are money
 * truth; mandate/approval states are authorization truth. Never color-only:
 * every state renders glyph + label + tone. Green (verified) is reserved for
 * readback-attested SETTLED/RECONCILED; nothing here implies irreversible
 * finality.
 */

export type Tone = 'neutral' | 'info' | 'transit' | 'hold' | 'attention' | 'verified' | 'danger';

export interface PresentationEntry {
  readonly tone: Tone;
  readonly glyph: string;
  readonly label: string;
  readonly meaning: string;
}

export type MandateStatus = 'active' | 'superseded' | 'expired' | 'revoked';
export type ApprovalStatus = 'valid' | 'consumed' | 'invalidated' | 'revoked';
export type OperationState =
  | 'PROPOSED'
  | 'RESERVED'
  | 'SUBMITTING'
  | 'IN_FLIGHT'
  | 'SETTLED'
  | 'RECONCILED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'STATUS_UNKNOWN'
  | 'CANCELLED'
  | 'REQUIRES_HUMAN';

export const OPERATION_PRESENTATION: Readonly<Record<OperationState, PresentationEntry>> = {
  PROPOSED: {
    tone: 'neutral',
    glyph: '○',
    label: 'Proposed',
    meaning: 'draft — no funds touched',
  },
  RESERVED: {
    tone: 'info',
    glyph: '◇',
    label: 'Reserved',
    meaning: 'internal hold — not provider escrow',
  },
  SUBMITTING: {
    tone: 'transit',
    glyph: '▲',
    label: 'Dispatching',
    meaning: 'dispatching — do not close',
  },
  IN_FLIGHT: {
    tone: 'transit',
    glyph: '▲',
    label: 'In flight',
    meaning: 'submitted to provider — finality NOT confirmed',
  },
  STATUS_UNKNOWN: {
    tone: 'hold',
    glyph: '⚠',
    label: 'Unknown',
    meaning: 'outcome ambiguous — funds remain committed; resolve by original request ID',
  },
  REQUIRES_HUMAN: {
    tone: 'attention',
    glyph: '✋',
    label: 'Needs decision',
    meaning: 'blocked — human decision required; exposure retained',
  },
  SETTLED: {
    tone: 'verified',
    glyph: '●',
    label: 'Settled',
    meaning: 'provider-verified at readback — strongest confirmed state, not irreversible finality',
  },
  RECONCILED: {
    tone: 'verified',
    glyph: '◎',
    label: 'Reconciled',
    meaning: 'fees + outcome reconciled',
  },
  REJECTED: {
    tone: 'danger',
    glyph: '✕',
    label: 'Rejected',
    meaning: 'refused — may occur at validation, before dispatch, or on unknown-outcome resolution',
  },
  EXPIRED: {
    tone: 'neutral',
    glyph: '⌛',
    label: 'Expired',
    meaning: 'authority lapsed',
  },
  CANCELLED: {
    tone: 'neutral',
    glyph: '⊘',
    label: 'Cancelled',
    meaning: 'commitment released; the journal asserts provider contact, not this label',
  },
};

export const MANDATE_PRESENTATION: Readonly<Record<MandateStatus, PresentationEntry>> = {
  active: {
    tone: 'info',
    glyph: '◆',
    label: 'Mandate active',
    meaning: 'spending authority currently in force (versioned; envelope + expiry enforced)',
  },
  superseded: {
    tone: 'neutral',
    glyph: '→',
    label: 'Superseded',
    meaning: 'replaced by a newer mandate version; dispatch re-checks and blocks',
  },
  expired: {
    tone: 'neutral',
    glyph: '⌛',
    label: 'Mandate expired',
    meaning: 'authority lapsed; re-authorization required before any spend',
  },
  revoked: {
    tone: 'danger',
    glyph: '↯',
    label: 'Mandate revoked',
    meaning: 'explicitly revoked; queued dispatch is blocked and journaled',
  },
};

export const APPROVAL_PRESENTATION: Readonly<Record<ApprovalStatus, PresentationEntry>> = {
  valid: {
    tone: 'info',
    glyph: '✓',
    label: 'Approval valid',
    meaning: 'binds exact plan digest + terms; single-use',
  },
  consumed: {
    tone: 'neutral',
    glyph: '◉',
    label: 'Consumed',
    meaning: 'used by its reservation; retries reuse the original request ID',
  },
  invalidated: {
    tone: 'danger',
    glyph: '✕',
    label: 'Invalidated',
    meaning: 'terms changed — structurally stale',
  },
  revoked: {
    tone: 'danger',
    glyph: '↯',
    label: 'Revoked',
    meaning: 'explicitly revoked; the dispatch gate re-checks',
  },
};

export function mandatePresentation(status: string): PresentationEntry {
  return (
    MANDATE_PRESENTATION[status as MandateStatus] ?? {
      tone: 'neutral',
      glyph: '·',
      label: status,
      meaning: 'unrecognized status — render raw, never guess',
    }
  );
}

export function operationPresentation(state: string): PresentationEntry {
  return (
    OPERATION_PRESENTATION[state as OperationState] ?? {
      tone: 'neutral',
      glyph: '·',
      label: state,
      meaning: 'unrecognized state — render raw, never guess',
    }
  );
}

/** What the presentation needs to tell INTERNAL completion from provider settlement. */
export interface OperationRailContext {
  readonly kind: string;
  /** Outbox truth; null before a dispatch row exists (never dispatched). */
  readonly dispatch: { rail: string | null; attempts: number; status: string } | null;
}

/**
 * Context-aware presentation: a RECONCILED/SETTLED state on an operation that
 * never left MOTERVA (internal hold, no provider dispatch) is a legitimate
 * completed lifecycle — but it must NOT borrow the provider-verified green
 * reserved for readback-attested settlement on a provider rail. Same ledger
 * truth, rail-appropriate words and tone.
 */
export function operationPresentationFor(
  state: string,
  rail: OperationRailContext,
): PresentationEntry {
  const base = operationPresentation(state);
  const providerRail = rail.dispatch !== null && rail.dispatch.rail !== null;
  if (providerRail || (state !== 'RECONCILED' && state !== 'SETTLED')) return base;
  return {
    tone: 'info',
    glyph: '◎',
    label: state === 'SETTLED' ? 'Completed internally' : 'Reconciled internally',
    meaning:
      'internal ' +
      (rail.kind === 'internal_hold' ? 'hold' : 'ledger step') +
      ' completed inside MOTERVA — no provider dispatch occurred; this is not an externally verified settlement',
  };
}
