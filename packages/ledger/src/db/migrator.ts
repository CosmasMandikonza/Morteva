/**
 * Forward-only migrations, applied transactionally one version at a time.
 * A failing migration rolls back completely and leaves the database at the
 * previous version; an applied version is never re-run. Downgrades (database
 * knows a version this build does not) are refused.
 *
 * Migrations that rebuild referenced tables (0002) must run with SQLite
 * foreign keys disabled for the swap; the runner therefore disables FKs
 * around each migration, re-enables them after commit, and verifies with
 * `PRAGMA foreign_key_check` — any violation fails the migration loudly.
 */
import type { LedgerDatabase } from './port.js';
import { LedgerError } from '../errors.js';
import { MIGRATION_0001_FINANCIAL_FOUNDATION } from './migrations-0001.js';
import { MIGRATION_0002_FINANCIAL_AUTHORITY } from './migrations-0002.js';
import { MIGRATION_0003_PROVIDER_RECEIPTS } from './migrations-0003.js';
import { MIGRATION_0004_PRODUCTION_IDENTITY } from './migrations-0004.js';
import { MIGRATION_0005_TOKEN_ASSETS } from './migrations-0005.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'financial_foundation', sql: MIGRATION_0001_FINANCIAL_FOUNDATION },
  { version: 2, name: 'financial_authority', sql: MIGRATION_0002_FINANCIAL_AUTHORITY },
  { version: 3, name: 'provider_receipts', sql: MIGRATION_0003_PROVIDER_RECEIPTS },
  { version: 4, name: 'production_identity', sql: MIGRATION_0004_PRODUCTION_IDENTITY },
  { version: 5, name: 'token_assets', sql: MIGRATION_0005_TOKEN_ASSETS },
];

export interface MigrationReport {
  readonly applied: readonly { version: number; name: string }[];
  readonly currentVersion: number;
}

export function migrate(
  db: LedgerDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationReport {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const known = new Map(migrations.map((m) => [m.version, m]));
  const present = db
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number; name: string }>;

  for (const row of present) {
    if (!known.has(row.version)) {
      throw new LedgerError(
        'MIGRATION_VERSION_CONFLICT',
        `database has schema version ${row.version} ("${row.name}") which this build does not know; refusing to run against a newer database`,
      );
    }
  }

  const applied: { version: number; name: string }[] = [];
  for (const migration of migrations) {
    const already = db
      .prepare('SELECT version FROM schema_migrations WHERE version = ?')
      .get(migration.version);
    if (already !== undefined) continue;
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        // FK validation MUST run before COMMIT: a post-commit failure can
        // leave the schema applied and recorded despite invalid references.
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new Error(
            `migration v${migration.version} left ${violations.length} foreign-key violation(s)`,
          );
        }
        db.prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        ).run(migration.version, migration.name, new Date().toISOString());
      });
    } catch (error) {
      throw new LedgerError(
        'MIGRATION_FAILED',
        `migration v${migration.version} ("${migration.name}") failed and rolled back: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new LedgerError(
        'MIGRATION_FAILED',
        `migration v${migration.version} left ${violations.length} foreign-key violation(s); refusing to continue (inspect PRAGMA foreign_key_check)`,
      );
    }
    applied.push({ version: migration.version, name: migration.name });
  }

  const currentRow = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null;
  };
  return { applied, currentVersion: currentRow.v ?? 0 };
}

export function currentSchemaVersion(db: LedgerDatabase): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null;
  };
  return row.v ?? 0;
}
