import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { openLedger } from '../src/index.js';
import { ensureApprover } from './helpers.js';

/**
 * Issue #7 adversarial proof: two REAL worker threads (separate SQLite
 * connections, real BEGIN IMMEDIATE contention) compete for the last of a
 * cumulative mandate budget. Exactly one reservation may win.
 */

interface WorkerOutcome {
  ok: boolean;
  code?: string;
  operationId?: string;
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

describe('two-worker race over the remaining mandate budget', () => {
  it('exactly one of two simultaneous under-cap reservations wins the last budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moterva-budget-race-'));
    const dbPath = join(dir, 'budget-race.sqlite');
    const ledger = openLedger(dbPath);
    ledger.migrate();
    const org = ledger.organizations.createOrganization('BudgetRaceOrg');
    const mission = ledger.organizations.createMission(org.id, 'm');
    const approver = ensureApprover(ledger, org.id);
    ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'USD',
      label: 'USD',
      protectedFloorMinor: 0,
    });
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 1_000_000,
      source: 'manual-seed',
      observedAt: ledger.clock.iso(),
      expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
    });
    const mandate = ledger.mandates.issue({
      orgId: org.id,
      missionId: mission.id,
      currency: 'USD',
      maxAmountMinor: 60_000,
      totalBudgetMinor: 100_000,
      permittedOperationKinds: ['airwallex_transfer'],
      expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
    });

    const inputs = [1, 2].map((index) => {
      const plan = ledger.plans.recordVersion({
        orgId: org.id,
        missionId: mission.id,
        terms: { amountMinor: 60_000, currency: 'USD', beneficiary: 'acme', purpose: 'race' },
      });
      const approval = ledger.approvals.record({
        orgId: org.id,
        plan,
        decidedByActorId: approver.id,
        kind: 'airwallex_transfer',
        expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
      });
      return {
        dbPath,
        orgId: org.id,
        missionId: mission.id,
        requestId: `budget-race-${index}`,
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
    expect((losers[0] as { code?: string }).code).toBe('MANDATE_BUDGET_EXCEEDED');

    const verify = openLedger(dbPath);
    const status = verify.mandates.budgetStatus(org.id, mission.id, mandate.id);
    expect(status.consumedMinor).toBe(60_000);
    expect(status.remainingMinor).toBe(40_000);
    expect(verify.recovery.verify().integrity).toBe('ok');
    verify.close();
  }, 30_000);

  it('four workers racing slices never exceed the envelope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moterva-budget-race4-'));
    const dbPath = join(dir, 'race.sqlite');
    const ledger = openLedger(dbPath);
    ledger.migrate();
    const org = ledger.organizations.createOrganization('BudgetRace4Org');
    const mission = ledger.organizations.createMission(org.id, 'm');
    const approver = ensureApprover(ledger, org.id);
    ledger.accounts.ensureTreasuryAccount({
      orgId: org.id,
      currency: 'USD',
      label: 'USD',
      protectedFloorMinor: 0,
    });
    ledger.accounts.recordBalanceSnapshot({
      orgId: org.id,
      currency: 'USD',
      minorUnits: 1_000_000,
      source: 'manual-seed',
      observedAt: ledger.clock.iso(),
      expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
    });
    const mandate = ledger.mandates.issue({
      orgId: org.id,
      missionId: mission.id,
      currency: 'USD',
      maxAmountMinor: 30_000,
      totalBudgetMinor: 100_000,
      permittedOperationKinds: ['airwallex_transfer'],
      expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
    });
    const slice = 30_000;
    const inputs = [1, 2, 3, 4].map((index) => {
      const plan = ledger.plans.recordVersion({
        orgId: org.id,
        missionId: mission.id,
        terms: { amountMinor: slice, currency: 'USD', beneficiary: 'b', purpose: 'race4' },
      });
      const approval = ledger.approvals.record({
        orgId: org.id,
        plan,
        decidedByActorId: approver.id,
        kind: 'airwallex_transfer',
        expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
      });
      return {
        dbPath,
        orgId: org.id,
        missionId: mission.id,
        requestId: `budget-race4-${index}`,
        planId: plan.id,
        planVersion: plan.version,
        approvalId: approval.id,
      };
    });
    ledger.close();

    const outcomes = await runWorkers(join(import.meta.dirname, 'race.worker.mjs'), inputs);
    const successes = outcomes.filter((o) => o.ok);
    expect(successes.length).toBe(3); // 3×30k fits; the 4th exceeds 100k
    expect(outcomes.filter((o) => !o.ok).every((o) => o.code === 'MANDATE_BUDGET_EXCEEDED')).toBe(
      true,
    );

    const verify = openLedger(dbPath);
    expect(verify.mandates.consumedBudget(org.id, mandate.id)).toBe(successes.length * slice);
    expect(verify.mandates.consumedBudget(org.id, mandate.id)).toBeLessThanOrEqual(100_000);
    expect(verify.recovery.verify().integrity).toBe('ok');
    verify.close();
  }, 30_000);
});
