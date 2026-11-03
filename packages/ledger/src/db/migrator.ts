/**
 * Forward-only migrations, applied transactionally one version at a time.
 * A failing migration rolls back completely and leaves the database at the
 * previous version; an applied version is never re-run. Downgrades (database
 * knows a version this build does not) are refused.
 */
import type { LedgerDatabase } from './port.js';
import { LedgerError } from '../errors.js';
import { MIGRATION_0001_FINANCIAL_FOUNDATION } from './migrations-0001.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'financial_foundation', sql: MIGRATION_0001_FINANCIAL_FOUNDATION },
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
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });
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
