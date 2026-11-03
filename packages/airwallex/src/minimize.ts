/**
 * Receipt payload minimization (R3 review P1-7).
 *
 * Regex redaction alone cannot prove a receipt is safe. Receipts persist an
 * ALLOWLISTED projection of provider responses: only the fields required for
 * reconciliation and audit are kept; everything else — raw beneficiary
 * details, nested objects, tokens, authorization echoes, arbitrary provider
 * payloads — is dropped before persistence. Unknown/nested fields are never
 * passed through "just in case".
 */

export interface MinimizedTransfer {
  readonly id: string;
  readonly request_id: string | null;
  readonly status: string;
  readonly transfer_currency: string | null;
  readonly transfer_amount: number | null;
  readonly beneficiary_id: string | null;
  readonly short_reference_id: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  /** Provider failure CODE only — free-text failure messages may hold PII. */
  readonly failure_code: string | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function minimizeTransfer(raw: unknown): MinimizedTransfer {
  const record = (raw ?? {}) as Record<string, unknown>;
  const failure = (record.failure ?? null) as { code?: unknown } | null;
  return {
    id: str(record.id) ?? '(missing-id)',
    request_id: str(record.request_id),
    status: str(record.status) ?? 'UNKNOWN',
    transfer_currency: str(record.transfer_currency),
    transfer_amount: typeof record.transfer_amount === 'number' ? record.transfer_amount : null,
    beneficiary_id: str(record.beneficiary_id),
    short_reference_id: str(record.short_reference_id),
    created_at: str(record.created_at),
    updated_at: str(record.updated_at),
    failure_code: failure !== null && typeof failure.code === 'string' ? failure.code : null,
  };
}

export function minimizeList(raw: unknown): {
  items: MinimizedTransfer[];
  page_after: string | null;
} {
  const body = (raw ?? {}) as Record<string, unknown>;
  const items = Array.isArray(body.items) ? body.items : [];
  return {
    items: items.map((item) => minimizeTransfer(item)),
    page_after: str(body.page_after),
  };
}

export function minimizeError(raw: unknown): { code: string | null } {
  const body = (raw ?? {}) as Record<string, unknown>;
  return { code: str(body.code) };
}

export function minimizeBalances(raw: unknown): { currency: string; available_amount: number }[] {
  const body = raw as { items?: unknown } | Array<unknown> | null;
  const items: unknown[] = Array.isArray(body)
    ? (body as unknown[])
    : Array.isArray((body as { items?: unknown } | null)?.items)
      ? (body as { items: unknown[] }).items
      : [];
  return items.flatMap((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    if (typeof record.currency !== 'string') return [];
    return [
      {
        currency: record.currency,
        available_amount: typeof record.available_amount === 'number' ? record.available_amount : 0,
      },
    ];
  });
}
