/**
 * SQLite adapter over Node's built-in `node:sqlite` (ADR 0002).
 *
 * Concurrency model: WAL journal + `PRAGMA busy_timeout` + BEGIN IMMEDIATE.
 * Multiple processes/threads may hold connections; exactly one write
 * transaction runs at a time, which is what makes reservation read-modify-
 * write sequences atomic. Short transactions + busy timeout + bounded retry
 * keep contention from surfacing as failures.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LedgerDatabase, LedgerStatement, WriteResult } from './port.js';
import { LedgerError } from '../errors.js';

const BUSY_TIMEOUT_MS = 5_000;
const BEGIN_ATTEMPTS = 8;

function isBusyError(error: unknown): boolean {
  return error instanceof Error && /database is locked/i.test(error.message);
}

function blockingSleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

class SqliteStatement implements LedgerStatement {
  constructor(private readonly statement: StatementSync) {}

  run(...params: unknown[]): WriteResult {
    const result = this.statement.run(...(params as []));
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  get(...params: unknown[]): unknown | undefined {
    return this.statement.get(...(params as [])) as unknown | undefined;
  }

  all(...params: unknown[]): unknown[] {
    return this.statement.all(...(params as [])) as unknown[];
  }
}

class SqliteDatabase implements LedgerDatabase {
  private depth = 0;
  private readonly db: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // busy_timeout FIRST: it governs every later pragma (journal_mode takes a
    // brief write lock, which must wait for concurrent writers, not fail).
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (
      (this.db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string }).journal_mode !==
      'wal'
    ) {
      this.db.exec('PRAGMA journal_mode = WAL');
    }
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA synchronous = FULL');
  }

  get open(): boolean {
    return this.db.isOpen;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): LedgerStatement {
    return new SqliteStatement(this.db.prepare(sql));
  }

  /**
   * Runs `fn` inside a transaction. BEGIN IMMEDIATE grabs the write lock up
   * front (not lazily on first write) so no read inside the transaction can
   * become stale mid-flight. SQLITE_BUSY is retried with backoff beyond the
   * busy_timeout to survive bursts; anything else rolls back and propagates.
   */
  transaction<T>(fn: () => T, mode: 'deferred' | 'immediate' = 'immediate'): T {
    if (this.depth > 0) return fn(); // join the already-serialized outer transaction
    for (let attempt = 1; ; attempt += 1) {
      try {
        this.db.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN');
      } catch (error) {
        if (isBusyError(error) && attempt < BEGIN_ATTEMPTS) {
          blockingSleepMs(5 * attempt);
          continue;
        }
        throw error;
      }
      this.depth += 1;
      try {
        const result = fn();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      } finally {
        this.depth -= 1;
      }
    }
  }

  close(): void {
    this.db.close();
  }
}

export function openSqliteDatabase(path: string): LedgerDatabase {
  try {
    return new SqliteDatabase(path);
  } catch (error) {
    throw new LedgerError(
      'DB_CORRUPTED',
      `cannot open ledger database at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Online backup (safe under WAL). Used by ops/backup tooling and tests. */
export function backupSqliteDatabase(db: LedgerDatabase, targetPath: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
}

/** Deterministic-ish short unique token for outbox claims. */
export function newClaimToken(prefix: string): string {
  return `${prefix}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}
