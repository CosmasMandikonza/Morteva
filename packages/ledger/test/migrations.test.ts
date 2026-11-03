import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import {
  LedgerError,
  MIGRATIONS,
  currentSchemaVersion,
  migrate,
  openLedger,
  openSqliteDatabase,
} from '../src/index.js';
import { makeLedger, tempDbPath } from './helpers.js';

describe('migrations', () => {
  it('applies the financial foundation from a clean database and is idempotent', () => {
    const path = tempDbPath();
    const db = openSqliteDatabase(path);
    const first = migrate(db);
    expect(first.applied.map((m) => m.version)).toEqual([1]);
    expect(currentSchemaVersion(db)).toBe(1);

    const second = migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.currentVersion).toBe(1);
    db.close();
  });

  it('a failing migration rolls back completely and leaves the previous schema intact', () => {
    const path = tempDbPath();
    const db = openSqliteDatabase(path);
    migrate(db, MIGRATIONS);
    const beforeVersion = currentSchemaVersion(db);

    const broken = [
      ...MIGRATIONS,
      {
        version: 2,
        name: 'deliberately_broken',
        sql: "CREATE TABLE half_table (id TEXT PRIMARY KEY); INSERT INTO half_table VALUES ('dup'); INSERT INTO half_table VALUES ('dup');",
      },
    ];
    expect(() => migrate(db, broken)).toThrowError(/UNIQUE constraint failed/i);

    // Nothing from the failed migration survived.
    expect(currentSchemaVersion(db)).toBe(beforeVersion);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half_table'")
      .all();
    expect(tables).toEqual([]);
    db.close();
  });

  it('refuses to run against a database from a newer schema (downgrade protection)', () => {
    const path = tempDbPath();
    const db = openSqliteDatabase(path);
    migrate(db, [
      ...MIGRATIONS,
      {
        version: 2,
        name: 'future_addition',
        sql: 'CREATE TABLE future_thing (id TEXT PRIMARY KEY);',
      },
    ]);
    expect(() => migrate(db, MIGRATIONS)).toThrowError(LedgerError);
    expect(() => migrate(db, MIGRATIONS)).toThrowError(/refusing to run against a newer database/);
    db.close();
  });

  it('re-opens an existing database with its data intact (restart)', () => {
    const path = tempDbPath();
    const first = openLedger(path);
    first.migrate();
    const org = first.organizations.createOrganization('Persisted');
    first.close();

    const second = openLedger(path);
    expect(second.schemaVersion()).toBe(1);
    const row = second.db
      .prepare('SELECT id, name FROM organizations WHERE id = ?')
      .get(org.id) as {
      id: string;
      name: string;
    };
    expect(row.name).toBe('Persisted');
    second.close();
  });

  it('reports a clear error opening a corrupted (garbage) database file', () => {
    const path = tempDbPath();
    writeFileSync(path, 'this is definitely not a sqlite database file'.repeat(50), 'utf8');
    expect(() => openSqliteDatabase(path)).toThrowError(LedgerError);
    expect(() => openSqliteDatabase(path)).toThrowError(/cannot open ledger database/);
  });

  it('CHECK constraints stop corrupted money values from entering persistence', () => {
    const { ledger } = makeLedger();
    const org = ledger.organizations.createOrganization('ConstraintOrg');
    const mission = ledger.organizations.createMission(org.id, 'm');
    const plan = ledger.plans.recordVersion({
      orgId: org.id,
      missionId: mission.id,
      terms: { amountMinor: 100, currency: 'USD', beneficiary: 'b', purpose: 'p' },
    });
    const approval = ledger.approvals.record({
      orgId: org.id,
      plan,
      decidedBy: 't',
      expiresAt: '2026-11-03T13:00:00.000Z',
    });
    // Direct SQL bypassing the service must still be stopped by the schema.
    expect(() =>
      ledger.db
        .prepare(
          `INSERT INTO operations (id, org_id, mission_id, kind, request_id, state, plan_id, plan_version, plan_digest,
             approval_id, mandate_id, mandate_version, amount_minor, currency, beneficiary, purpose, created_at, updated_at)
           VALUES ('op_bad', ?, ?, 'airwallex_transfer', 'rq_bad', 'RESERVED', ?, ?, ?, ?, 'mnd_x', 1, -500, 'USD', 'b', 'p', ?, ?)`,
        )
        .run(
          org.id,
          mission.id,
          plan.id,
          plan.version,
          plan.digest,
          approval.id,
          '2026-11-03T12:00:00Z',
          '2026-11-03T12:00:00Z',
        ),
    ).toThrowError(/CHECK constraint failed/i);
    expect(() =>
      ledger.db
        .prepare(
          `INSERT INTO commitments (id, org_id, mission_id, operation_id, currency, amount_minor, state, created_at, updated_at)
        VALUES ('cmt_bad', ?, ?, 'op_missing', 'USD', 100, 'bogus-state', ?, ?)`,
        )
        .run(org.id, mission.id, '2026-11-03T12:00:00Z', '2026-11-03T12:00:00Z'),
    ).toThrowError(/CHECK constraint failed/i);
    ledger.close();
  });

  it('VACUUM INTO backup produces a working copy', () => {
    const { ledger, path } = makeLedger();
    ledger.organizations.createOrganization('BackupOrg');
    const backupPath = path.replace('.sqlite', '.backup.sqlite');
    ledger.backupTo(backupPath);
    ledger.close();
    expect(existsSync(backupPath)).toBe(true);
    const restored = openLedger(backupPath);
    expect(restored.schemaVersion()).toBe(1);
    restored.close();
  });
});
