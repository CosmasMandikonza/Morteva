/**
 * Financial display formatting (ADR 0004): explicit currency codes always,
 * tabular mono numerals (the .mv-num class), integer minor units in, major
 * units out. No bare symbols, no floating-point money math.
 */

export function money(currency: string, minor: number): string {
  const major = minor / 100;
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(major);
  return `${currency} ${formatted}`;
}

export function moneyAmount(minor: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.round((part / whole) * 100));
}

export function parseJsonArray(raw: string | null): readonly string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return (
    new Intl.DateTimeFormat('en-GB', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    }).format(date) + ' UTC'
  );
}

/** Compact display form for long ledger IDs; the full ID stays one hover away. */
export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 11)}…` : id;
}
