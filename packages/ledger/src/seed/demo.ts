/**
 * Demo script (npm run seed:demo -w @moterva/ledger): creates a temp ledger,
 * seeds the two-missions-one-pool world, executes the contention, and prints
 * the honest outcome — including that no provider was contacted. Used as PR
 * evidence; never run against a real database.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '../ledger.js';
import { seedCompetingMissions } from '../services/seed.js';
import { isLedgerError } from '../errors.js';

const dir = mkdtempSync(join(tmpdir(), 'moterva-seed-'));
const ledger = openLedger(join(dir, 'demo.sqlite'));
const report = ledger.migrate();
console.info(
  `migrations applied: ${report.applied.map((m: { version: number; name: string }) => `v${m.version} ${m.name}`).join(', ') || '(none, already current)'}`,
);

const world = seedCompetingMissions(ledger);
console.info(
  `org ${world.org.id}: balance ${world.balanceMinor} ${world.currency}, protected floor ${world.protectedFloorMinor}, spendable ${ledger.spendable.compute(world.org.id, world.currency).spendableMinor}`,
);

const attempts = world.missions.map((mission, index) => {
  const { plan, approval } = world.approvedPlans[index] as NonNullable<
    (typeof world.approvedPlans)[number]
  >;
  return ledger.reservations.reserve({
    orgId: world.org.id,
    missionId: mission.id,
    kind: 'airwallex_transfer',
    requestId: `demo-${mission.id}`,
    planId: plan.id,
    planVersion: plan.version,
    approvalId: approval.id,
  });
});

attempts.forEach((result, index) => {
  const mission = world.missions[index] as { title: string };
  if ('operation' in result) {
    console.info(
      `mission "${mission.title}" → RESERVED ${result.operation.amountMinor} ${result.operation.currency} (${result.operation.id})`,
    );
  } else {
    console.info(`mission "${mission.title}" → REJECTED`);
  }
});

try {
  const { plan, approval } = world.approvedPlans[1] as NonNullable<
    (typeof world.approvedPlans)[number]
  >;
  ledger.reservations.reserve({
    orgId: world.org.id,
    missionId: world.missions[1].id,
    kind: 'airwallex_transfer',
    requestId: 'demo-consumed-approval-retry',
    planId: plan.id,
    planVersion: plan.version,
    approvalId: approval.id,
  });
  console.info('unexpected: consumed approval accepted');
} catch (error) {
  if (isLedgerError(error)) {
    console.info(`retry with a consumed approval rejected: [${error.code}] ${error.message}`);
  } else {
    throw error;
  }
}

try {
  const plan = ledger.plans.recordVersion({
    orgId: world.org.id,
    missionId: world.missions[0].id,
    terms: {
      amountMinor: 450_000, // within the mandate cap, but the pool is fully committed
      currency: world.currency,
      beneficiary: 'acme-diagnostics',
      purpose: 'Try to spend the fully-committed pool',
    },
  });
  const approval = ledger.approvals.record({
    orgId: world.org.id,
    plan,
    decidedBy: 'seed:operator',
    expiresAt: new Date(ledger.clock.now().getTime() + 60_000).toISOString(),
  });
  ledger.reservations.reserve({
    orgId: world.org.id,
    missionId: world.missions[0].id,
    kind: 'airwallex_transfer',
    requestId: 'demo-overpool-attempt',
    planId: plan.id,
    planVersion: plan.version,
    approvalId: approval.id,
  });
  console.info('unexpected: over-pool reservation accepted');
} catch (error) {
  if (isLedgerError(error)) {
    console.info(`over-pool reservation rejected: [${error.code}] ${error.message}`);
  } else {
    throw error;
  }
}

const finalView = ledger.spendable.compute(world.org.id, world.currency);
console.info(
  `final spendable: ${finalView.spendableMinor} (balance ${finalView.balanceMinor} − floor ${finalView.protectedFloorMinor} − outstanding ${finalView.outstandingCommittedMinor})`,
);
const integrity = ledger.recovery.verify();
console.info(
  `integrity: ${integrity.integrity}; replay plan: ${ledger.recovery.replayPlan().length} pending dispatch(es)`,
);
console.info('providers contacted: NONE (MTV-02 ships no adapters by design)');
ledger.close();
