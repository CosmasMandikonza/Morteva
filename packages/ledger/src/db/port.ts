/**
 * Storage port (ADR 0001): the narrow database interface the ledger depends
 * on. The SQLite implementation lives in ./sqlite.js; a later managed-Postgres
 * adapter implements the same surface without touching service code.
 *
 * Transaction semantics required by implementors:
 *  - `transaction(fn, 'immediate')` takes the database write lock for the
 *    whole callback (SQLite BEGIN IMMEDIATE) so read-modify-write sequences
 *    are serialized across processes and threads.
 *  - Nested `transaction` calls join the outer transaction.
 *  - A thrown error rolls the whole transaction back — no partial writes.
 */
export type WriteResult = { changes: number; lastInsertRowid: number | bigint };

export interface LedgerStatement {
  run(...params: unknown[]): WriteResult;
  get(...params: unknown[]): unknown | undefined;
  all(...params: unknown[]): unknown[];
}

export interface LedgerDatabase {
  readonly open: boolean;
  exec(sql: string): void;
  prepare(sql: string): LedgerStatement;
  transaction<T>(fn: () => T, mode?: 'deferred' | 'immediate'): T;
  close(): void;
}

/** Row field accessors — fail loudly on unexpected shapes instead of coercing. */
export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`corrupted row: expected text field "${field}", got ${typeof value}`);
  }
  return value;
}

export function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value, 'nullableText');
}

export function num(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`corrupted row: expected integer field "${field}", got ${String(value)}`);
  }
  return value;
}

export function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value, 'nullableNum');
}
