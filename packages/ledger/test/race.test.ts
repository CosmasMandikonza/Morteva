import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { openLedger } from '../src/index.js';
import { seedCompetingMissions } from '../src/index.js';

/**
 * Concurrency proofs (issue #4: "two missions contend for final funds",
 * handoff: "demonstrate actual concurrent contention, not sequential calls").
 * Each worker thread opens its own connection to the same SQLite file and
 * races for the same money through the real service code path.
 */

interface WorkerOutcome {
  ok: boolean;
  code?: string;
  operationId?: string;
  duplicate?: boolean;
}

function runWorkers(
  script: string,
  inputs: Array<Record<string, unknown>>,
): Promise<WorkerOutcome[]> {
  return Promise.all(
    inputs.map(
      (input) =>
        new Promise<WorkerOutcome>((resolve, reject) => {
          const worker = new Worker(script, { workerData: input });
          worker.once('message', (message: WorkerOutcome) => {
            resolve(message);
            void worker.terminate();
          });
          worker.once('error', (error) => reject(error));
        }),
    ),
  );
}

describe('two-worker reservation race over the final funds', () => {
  it('exactly one of two simultaneous 600k reservations on a 900k pool wins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moteva-race-'));
    const dbPath = join(dir, 'race.sqlite');
    const ledger = openLedger(dbPath);
    ledger.migrate();
    const world = seedCompetingMissions(ledger, {
      balanceMinor: 1_000_000,
      protectedFloorMinor: 100_000,
      planAmountMinor: 600_000,
    });
    // Mandates must allow 600k.
    for (const mission of world.missions) {
      ledger.mandates.issue({
        orgId: world.org.id,
        missionId: mission.id,
        currency: world.currency,
        maxAmountMinor: 600_000,
        permittedOperationKinds: ['airwallex_transfer', 'metal_order', 'internal_hold'],
        expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
      });
    }
    // Fresh 600k approved plans for both missions (seed's are 600k too, but be explicit).
    const inputs = world.missions.map((mission, index) => {
      const plan = ledger.plans.recordVersion({
        orgId: world.org.id,
        missionId: mission.id,
        terms: {
          amountMinor: 600_000,
          currency: world.currency,
          beneficiary: 'acme-diagnostics',
          purpose: 'race',
        },
      });
      const approval = ledger.approvals.record({
        orgId: world.org.id,
        plan,
        decidedByActorId: world.approver.id,
        kind: 'airwallex_transfer',
        expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
      });
      return {
        dbPath,
        orgId: world.org.id,
        missionId: mission.id,
        requestId: `race-${index}`,
        planId: plan.id,
        planVersion: plan.version,
        approvalId: approval.id,
      };
    });
    ledger.close();

    const outcomes = await runWorkers(join(import.meta.dirname, 'race.worker.mjs'), inputs);

    const winners = outcomes.filter((o) => o.ok);
    const losers = outcomes.filter((o) => !o.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as { code?: string }).code).toBe('INSUFFICIENT_SPENDABLE');

    const verify = openLedger(dbPath);
    const view = verify.spendable.compute(world.org.id, world.currency);
    expect(view.outstandingCommittedMinor).toBe(600_000);
    expect(view.spendableMinor).toBe(300_000);
    expect(verify.recovery.verify().integrity).toBe('ok');
    verify.close();
  }, 30_000);

  it('four workers racing for slices never overcommit the pool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moterva-race4-'));
    const dbPath = join(dir, 'race4.sqlite');
    const ledger = openLedger(dbPath);
    ledger.migrate();
    const world = seedCompetingMissions(ledger, {
      balanceMinor: 200_000,
      protectedFloorMinor: 50_000,
      planAmountMinor: 10_000,
    });
    // Re-issue mandates to permit the small slices, then build 4 missions × inputs.
    const missions = [...world.missions];
    for (let i = 0; i < 2; i += 1) {
      missions.push(ledger.organizations.createMission(world.org.id, `extra-race-mission-${i}`));
    }
    const slice = 37_500; // 150000 / 4 exactly
    const inputs = missions.map((mission, index) => {
      ledger.mandates.issue({
        orgId: world.org.id,
        missionId: mission.id,
        currency: world.currency,
        maxAmountMinor: 50_000,
        permittedOperationKinds: ['airwallex_transfer'],
        expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
      });
      const plan = ledger.plans.recordVersion({
        orgId: world.org.id,
        missionId: mission.id,
        terms: { amountMinor: slice, currency: world.currency, beneficiary: 'b', purpose: 'race4' },
      });
      const approval = ledger.approvals.record({
        orgId: world.org.id,
        plan,
        decidedByActorId: world.approver.id,
        kind: 'airwallex_transfer',
        expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
      });
      return {
        dbPath,
        orgId: world.org.id,
        missionId: mission.id,
        requestId: `race4-${index}`,
        planId: plan.id,
        planVersion: plan.version,
        approvalId: approval.id,
      };
    });
    ledger.close();

    const outcomes = await runWorkers(join(import.meta.dirname, 'race.worker.mjs'), inputs);
    const successes = outcomes.filter((o) => o.ok);
    // All four slices fit exactly; the invariant is that committed money never exceeds the pool.
    const verify = openLedger(dbPath);
    const view = verify.spendable.compute(world.org.id, world.currency);
    expect(view.outstandingCommittedMinor).toBe(successes.length * slice);
    expect(view.outstandingCommittedMinor).toBeLessThanOrEqual(150_000);
    expect(view.spendableMinor).toBe(150_000 - successes.length * slice);
    expect(verify.recovery.verify().integrity).toBe('ok');
    verify.close();
    await writeFile(join(dir, 'done.txt'), 'ok', 'utf8');
  }, 30_000);

  it('duplicate requestIds submitted concurrently produce ONE operation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moterva-race-dup-'));
    const dbPath = join(dir, 'dup.sqlite');
    const ledger = openLedger(dbPath);
    ledger.migrate();
    const world = seedCompetingMissions(ledger, {
      balanceMinor: 1_000_000,
      protectedFloorMinor: 100_000,
      planAmountMinor: 100_000,
    });
    const mission = world.missions[0] as { id: string };
    const plan = ledger.plans.recordVersion({
      orgId: world.org.id,
      missionId: mission.id,
      terms: { amountMinor: 100_000, currency: world.currency, beneficiary: 'b', purpose: 'dup' },
    });
    const approval = ledger.approvals.record({
      orgId: world.org.id,
      plan,
      decidedByActorId: world.approver.id,
      kind: 'airwallex_transfer',
      expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
    });
    const makeInput = () => ({
      dbPath,
      orgId: world.org.id,
      missionId: mission.id,
      requestId: 'concurrent-duplicate-id',
      planId: plan.id,
      planVersion: plan.version,
      approvalId: approval.id,
    });
    ledger.close();

    const outcomes = await runWorkers(join(import.meta.dirname, 'race.worker.mjs'), [
      makeInput(),
      makeInput(),
      makeInput(),
    ]);

    const oks = outcomes.filter((o) => o.ok);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    const uniqueOperationIds = new Set(oks.map((o) => o.operationId));
    expect(uniqueOperationIds.size).toBe(1);
    // Some may have lost the approval race; the ones that completed must agree on identity.
    const verify = openLedger(dbPath);
    const rows = verify.db
      .prepare('SELECT COUNT(*) AS c FROM operations WHERE request_id = ?')
      .get('concurrent-duplicate-id') as { c: number };
    expect(rows.c).toBe(1);
    const view = verify.spendable.compute(world.org.id, world.currency);
    expect(view.outstandingCommittedMinor).toBe(100_000); // committed exactly once
    verify.close();
  }, 30_000);
});
