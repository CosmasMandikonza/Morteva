import { describe, expect, it } from 'vitest';
import {
  currentSchemaVersion,
  migrate,
  openLedger,
  openSqliteDatabase,
  MIGRATIONS,
} from '../src/index.js';
import { tempDbPath } from './helpers.js';

/**
 * Issue #7 Phase 8: a REAL v1 (PR #23-era) database with historical rows must
 * upgrade to v2 in place — preserving every row, its semantics and its
 * constraints — without regeneration.
 */

describe('v1 → v2 upgrade on an existing ledger', () => {
  it('migrates a populated v1 database in place, preserving rows and legacy authority semantics', () => {
    const path = tempDbPath('mtv05-v1-upgrade-');
    const db = openSqliteDatabase(path);
    // Build a v1 world with exactly the v1 schema and v1-era rows.
    migrate(db, [MIGRATIONS[0]!]);
    const clock = '2026-11-03T12:00:00.000Z';
    db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)').run(
      'org_v1',
      'Legacy Org',
      clock,
    );
    db.prepare(
      'INSERT INTO missions (id, org_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('msn_v1', 'org_v1', 'legacy', 'active', clock);
    db.prepare(
      "INSERT INTO accounts (id, org_id, currency, kind, label, protected_floor_minor, created_at) VALUES ('acct_v1','org_v1','USD','treasury','USD',0,?)",
    ).run(clock);
    db.prepare(
      "INSERT INTO balance_snapshots (id, account_id, org_id, currency, minor_units, source, observed_at, expires_at, recorded_at) VALUES ('bal_v1','acct_v1','org_v1','USD', 1000000, 'manual-seed', ?, ?, ?)",
    ).run(clock, '2026-11-03T20:00:00.000Z', clock);
    db.prepare(
      "INSERT INTO mandates (id, org_id, mission_id, version, status, currency, max_amount_minor, permitted_kinds_json, expires_at, created_at) VALUES ('mnd_v1','org_v1','msn_v1',1,'active','USD', 250000, '[\"airwallex_transfer\"]', '2026-11-04T12:00:00.000Z', ?)",
    ).run(clock);
    db.prepare(
      'INSERT INTO candidate_plans (id, org_id, mission_id, version, terms_json, digest, created_at) VALUES (\'plan_v1\',\'org_v1\',\'msn_v1\',1, \'{"amountMinor":100000,"currency":"USD","beneficiary":"legacy-vendor","purpose":"legacy repair"}\', \'deadbeefdeadbeef\', ?)',
    ).run(clock);
    db.prepare(
      "INSERT INTO approvals (id, org_id, plan_id, plan_version, plan_digest, amount_minor, currency, beneficiary, purpose, decided_by, decided_at, expires_at, status) VALUES ('apv_v1','org_v1','plan_v1',1,'deadbeefdeadbeef',100000,'USD','legacy-vendor','legacy repair','seed:operator', ?, '2026-11-04T00:00:00.000Z','consumed')",
    ).run(clock);
    db.prepare(
      "INSERT INTO operations (id, org_id, mission_id, kind, request_id, state, plan_id, plan_version, plan_digest, approval_id, mandate_id, mandate_version, amount_minor, currency, beneficiary, purpose, created_at, updated_at) VALUES ('op_v1','org_v1','msn_v1','airwallex_transfer','legacy-1','RESERVED','plan_v1',1,'deadbeefdeadbeef','apv_v1','mnd_v1',1,100000,'USD','legacy-vendor','legacy repair', ?, ?)",
    ).run(clock, clock);
    db.prepare(
      "INSERT INTO commitments (id, org_id, mission_id, operation_id, currency, amount_minor, state, finalized_at, created_at, updated_at) VALUES ('cmt_v1','org_v1','msn_v1','op_v1','USD',100000,'reserved',NULL,?, ?)",
    ).run(clock, clock);
    db.prepare(
      "INSERT INTO outbox_dispatches (id, operation_id, org_id, rail, request_id, status, attempts, claim_token, created_at, updated_at) VALUES ('obx_v1','op_v1','org_v1','airwallex','legacy-1','pending',0,NULL,?, ?)",
    ).run(clock, clock);
    db.prepare(
      "INSERT INTO evidence_events (id, org_id, mission_id, topic, type, event_key, payload_digest, payload_json, recorded_at) VALUES ('evt_v1','org_v1','msn_v1','financial','operation.reserved','operation:op_v1:reserved','x','{}', ?)",
    ).run(clock);
    db.close();

    // Upgrade in place with the full migration set.
    const upgraded = openLedger(path);
    const report = upgraded.migrate();
    expect(report.applied.map((m) => m.version)).toEqual([2]);
    expect(upgraded.schemaVersion()).toBe(2);
    expect(upgraded.migrate().applied).toEqual([]);

    // Historical rows survive verbatim.
    const op = upgraded.reservations.getOperation('org_v1', 'op_v1');
    expect(op.state).toBe('RESERVED');
    expect(op.amountMinor).toBe(100_000);
    const legacyApproval = upgraded.approvals.get('org_v1', 'apv_v1');
    expect(legacyApproval.status).toBe('consumed');
    expect(legacyApproval.evidenceDigest).toBe(''); // legacy default
    const legacyMandate = upgraded.mandates.latest('org_v1', 'msn_v1', 'mnd_v1');
    expect(legacyMandate.totalBudgetMinor).toBe(-1); // legacy: envelope = per-op max
    expect(upgraded.mandates.effectiveTotalBudget(legacyMandate)).toBe(250_000);
    expect(legacyMandate.rails).toEqual(['airwallex']);
    expect(legacyMandate.allowedBeneficiaries).toEqual([]);
    // Legacy budget consumption counts the historical RESERVED operation.
    expect(upgraded.mandates.consumedBudget('org_v1', 'mnd_v1')).toBe(100_000);
    // Evidence journal untouched.
    expect(upgraded.evidence.count('org_v1')).toBe(1);
    // New authority tables exist and are empty.
    expect((upgraded.db.prepare('SELECT COUNT(*) AS c FROM actors').get() as { c: number }).c).toBe(
      0,
    );
    expect(upgraded.recovery.verify().integrity).toBe('ok');

    // Restart survival after upgrade.
    upgraded.close();
    const reopened = openLedger(path);
    expect(reopened.schemaVersion()).toBe(2);
    expect(reopened.reservations.getOperation('org_v1', 'op_v1').requestId).toBe('legacy-1');
    reopened.close();
  });

  it('the v2 upgrade enforces the one-approval-per-plan-version uniqueness going forward', () => {
    const path = tempDbPath('mtv05-v1-dup-');
    const db = openSqliteDatabase(path);
    migrate(db, [MIGRATIONS[0]!]);
    db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)').run(
      'org_d',
      'D',
      '2026-11-03T12:00:00.000Z',
    );
    db.prepare(
      'INSERT INTO missions (id, org_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('msn_d', 'org_d', 'm', 'active', '2026-11-03T12:00:00.000Z');
    db.prepare(
      'INSERT INTO candidate_plans (id, org_id, mission_id, version, terms_json, digest, created_at) VALUES (\'plan_d\',\'org_d\',\'msn_d\',1,\'{"amountMinor":1,"currency":"USD","beneficiary":"b","purpose":"p"}\',\'aa\', \'2026-11-03T12:00:00.000Z\')',
    ).run();
    // Two v1 approvals for the same plan version (legal in v1).
    for (const id of ['apv_d1', 'apv_d2']) {
      db.prepare(
        "INSERT INTO approvals (id, org_id, plan_id, plan_version, plan_digest, amount_minor, currency, beneficiary, purpose, decided_by, decided_at, expires_at, status) VALUES (?, 'org_d','plan_d',1,'aa',1,'USD','b','p','x','2026-11-03T12:00:00.000Z','2026-11-04T00:00:00.000Z','valid')",
      ).run(id);
    }
    db.close();

    const upgraded = openLedger(path);
    expect(() => upgraded.migrate()).toThrowError(/unique|UNIQUE/i);
    upgraded.close();
  });

  it('fresh databases reach v2 directly and pass foreign-key verification', () => {
    const path = tempDbPath('mtv05-fresh-');
    const db = openSqliteDatabase(path);
    const report = migrate(db);
    expect(report.applied.map((m) => m.version)).toEqual([1, 2]);
    expect(currentSchemaVersion(db)).toBe(2);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
});
