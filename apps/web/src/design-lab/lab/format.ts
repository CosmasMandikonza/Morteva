import type { LifecycleState, MoneyMinor } from './data';

/**
 * Boundary formatting for the design lab. Tabular alignment comes from the
 * candidate type stacks (every numeric face in both directions has verified
 * tabular figures); currency codes are ALWAYS explicit (docs/03).
 */
const formatters = new Map<string, Intl.NumberFormat>();

function fmt(currency: string): Intl.NumberFormat {
  let f = formatters.get(currency);
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'code',
      minimumFractionDigits: 2,
    });
    formatters.set(currency, f);
  }
  return f;
}

/** USD 2,150.00 — explicit code, tabular-stable digits. */
export function money(m: MoneyMinor): string {
  const major = m.amount / 100;
  return fmt(m.currency)
    .format(major)
    .replace(/^([A-Z]{3})\s?/, '$1 ') // "USD 2,150.00" with a single space
    .replace(/^([A-Z]{3})\u00A0?/, '$1 '); // normalize NBSP some ICU builds emit
}

/** Bare numeric part for table cells where the code is the column header. */
export function moneyAmount(m: MoneyMinor): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(m.amount / 100);
}

/**
 * Status semantics ladder — IDENTICAL in both candidates (research/mtv-08
 * visual-direction-proposals §3). Never color-only: every status carries an
 * icon glyph + text; green is reserved for provider-verified terminal states.
 */
export interface StatusSemantics {
  glyph: string;
  tone: 'neutral' | 'info' | 'hold' | 'transit' | 'verified' | 'danger';
  blurb: string;
}

const LADDER: Record<LifecycleState, StatusSemantics> = {
  PROPOSED: { glyph: '○', tone: 'neutral', blurb: 'draft — no funds touched' },
  RESERVED: { glyph: '◇', tone: 'info', blurb: 'internal hold — not provider escrow' },
  APPROVED: { glyph: '✓', tone: 'info', blurb: 'exact terms signed by digest' },
  SUBMITTING: { glyph: '▲', tone: 'transit', blurb: 'dispatching — do not close' },
  SUBMITTED: { glyph: '▲', tone: 'transit', blurb: 'in flight — NOT settled' },
  STATUS_UNKNOWN: {
    glyph: '⚠',
    tone: 'transit',
    blurb: 'commitment retained · verify by original ID',
  },
  SETTLED: { glyph: '●', tone: 'verified', blurb: 'provider-verified' },
  RECONCILED: { glyph: '◎', tone: 'verified', blurb: 'fees + outcome reconciled' },
  REJECTED: { glyph: '✕', tone: 'danger', blurb: 'blocked before spend' },
  EXPIRED: { glyph: '⌛', tone: 'neutral', blurb: 'authority lapsed' },
};

export function status(state: LifecycleState): StatusSemantics {
  return LADDER[state]!;
}
