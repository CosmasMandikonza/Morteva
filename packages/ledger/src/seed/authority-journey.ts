/**
 * MTV-05 reproducible local authority journey (issue #7 "required
 * adversarial integration proof"): bootstrap trusted actors → mandate +
 * plan + evidence → approval by a permitted actor → reserve → revoke →
 * denial with stable code → close/reopen (restart) → replay plan with
 * original evidence preserved. Runs on a throwaway SQLite file; prints
 * every decision. Providers are never contacted (stub-free, worker seam
 * disabled) — this demonstrates INTERNAL DB behavior, not provider truth.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, isLedgerError } from '../index.js';

const TEST_PASSWORD = ['dev', 'only', 'journey'].join('-');
const dir = mkdtempSync(join(tmpdir(), 'moterva-mtv05-journey-'));
const dbPath = join(dir, 'journey.sqlite');

function say(what: string): void {
  console.info(what);
}

function expectDenied(fn: () => unknown, expectedCode: string, label: string): void {
  try {
    fn();
    say(`✗ ${label}: UNEXPECTEDLY ALLOWED`);
    process.exitCode = 1;
  } catch (error) {
    if (isLedgerError(error) && error.code === expectedCode) {
      say(`✓ ${label}: denied [${error.code}] ${error.message.slice(0, 110)}`);
    } else {
      say(`✗ ${label}: wrong denial ${String(error)}`);
      process.exitCode = 1;
    }
  }
}

// --- 1. bootstrap trusted actors -------------------------------------------
const ledger = openLedger(dbPath);
ledger.migrate();
const org = ledger.organizations.createOrganization('Journey Robotics');
const mission = ledger.organizations.createMission(org.id, 'Harbor turbine inspection');
const owner = ledger.authority.createHumanActor({
  orgId: org.id,
  username: 'founder',
  displayName: 'Founder',
  role: 'owner',
  password: TEST_PASSWORD,
});
const approver = ledger.authority.createHumanActor({
  orgId: org.id,
  username: 'chief-approver',
  displayName: 'Chief Approver',
  role: 'approver',
  password: TEST_PASSWORD,
});
const operator = ledger.authority.createHumanActor({
  orgId: org.id,
  username: 'field-ops',
  displayName: 'Field Ops',
  role: 'operator',
  password: TEST_PASSWORD,
});
say(
  `1. actors: owner=${owner.username} approver=${approver.username} operator=${operator.username}`,
);

// --- 2. treasury, mandate, plan, evidence -----------------------------------
ledger.accounts.ensureTreasuryAccount({
  orgId: org.id,
  currency: 'USD',
  label: 'USD treasury',
  protectedFloorMinor: 50_000,
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
  maxAmountMinor: 80_000,
  totalBudgetMinor: 150_000,
  permittedOperationKinds: ['airwallex_transfer'],
  allowedBeneficiaries: ['harbor-diagnostics', 'harbor-marine'],
  byActorId: owner.id,
  expiresAt: new Date(ledger.clock.now().getTime() + 12 * 3_600_000).toISOString(),
});
say(
  `2. mandate ${mandate.id} v${mandate.version}: per-op ≤ ${mandate.maxAmountMinor}, cumulative ≤ ${mandate.totalBudgetMinor}, beneficiaries=${mandate.allowedBeneficiaries.join('|')}`,
);

const evidence = ledger.evidence.append({
  orgId: org.id,
  missionId: mission.id,
  topic: 'operational',
  type: 'inspection.finding',
  eventKey: 'journey:evidence:1',
  payload: { turbine: 'T-4', vibration: 'high', recommendation: 'diagnostic sweep' },
});

// The operator proposes (SoD proposer).
const plan = ledger.plans.recordVersion({
  orgId: org.id,
  missionId: mission.id,
  proposedBy: operator.id,
  terms: {
    amountMinor: 60_000,
    currency: 'USD',
    beneficiary: 'harbor-diagnostics',
    purpose: 'diagnostic sweep',
    quote: {
      id: 'q-1',
      validUntil: new Date(ledger.clock.now().getTime() + 1_800_000).toISOString(),
    },
  },
});
say(`3. operator proposed plan ${plan.id} v${plan.version} (60k USD → harbor-diagnostics)`);

// --- separation of duties: operator cannot approve own plan -----------------
expectDenied(
  () =>
    ledger.approvals.record({
      orgId: org.id,
      plan,
      decidedByActorId: operator.id,
      kind: 'airwallex_transfer',
      expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
    }),
  'AUTH_ROLE_FORBIDDEN',
  '4. operator (non-approver) approving own proposal',
);

// The permitted human approver approves exact terms + evidence digest.
const approval = ledger.approvals.record({
  orgId: org.id,
  plan,
  decidedByActorId: approver.id,
  kind: 'airwallex_transfer',
  mandateId: mandate.id,
  mandateVersion: mandate.version,
  evidenceDigest: evidence.payloadDigest,
  expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
});
say(`5. approver ${approver.username} approved exact terms (evidence digest bound)`);

// --- 3. reserve --------------------------------------------------------------
const reserved = ledger.reservations.reserve({
  orgId: org.id,
  missionId: mission.id,
  kind: 'airwallex_transfer',
  requestId: 'journey-op-1',
  planId: plan.id,
  planVersion: plan.version,
  approvalId: approval.id,
  evidenceDigest: evidence.payloadDigest,
});
say(
  `6. reserved ${reserved.operation.amountMinor} USD (${reserved.operation.id}); mandate consumed ${ledger.mandates.consumedBudget(org.id, mandate.id)}/${mandate.totalBudgetMinor}; outbox pending=${ledger.outbox.pendingCount()}`,
);

// Approval is single-use: reusing it for a second intent is refused.
expectDenied(
  () =>
    ledger.reservations.reserve({
      orgId: org.id,
      missionId: mission.id,
      kind: 'airwallex_transfer',
      requestId: 'journey-op-1b',
      planId: plan.id,
      planVersion: plan.version,
      approvalId: approval.id,
      evidenceDigest: evidence.payloadDigest,
    }),
  'APPROVAL_CONSUMED',
  '7. reusing the consumed approval for a second intent',
);

// --- 4. revocation halts the queued second operation -------------------------
const plan2 = ledger.plans.recordVersion({
  orgId: org.id,
  missionId: mission.id,
  proposedBy: operator.id,
  terms: {
    amountMinor: 40_000,
    currency: 'USD',
    beneficiary: 'harbor-marine',
    purpose: 'marine repair',
    quote: {
      id: 'q-2',
      validUntil: new Date(ledger.clock.now().getTime() + 1_800_000).toISOString(),
    },
  },
});
const approval2 = ledger.approvals.record({
  orgId: org.id,
  plan: plan2,
  decidedByActorId: approver.id,
  kind: 'airwallex_transfer',
  mandateId: mandate.id,
  mandateVersion: mandate.version,
  expiresAt: new Date(ledger.clock.now().getTime() + 3_600_000).toISOString(),
});
ledger.mandates.revoke(
  org.id,
  mission.id,
  mandate.id,
  owner.id,
  'mission suspended pending inspection review',
);
expectDenied(
  () =>
    ledger.reservations.reserve({
      orgId: org.id,
      missionId: mission.id,
      kind: 'airwallex_transfer',
      requestId: 'journey-op-2',
      planId: plan2.id,
      planVersion: plan2.version,
      approvalId: approval2.id,
    }),
  'MANDATE_REVOKED',
  '8. reserve after mandate revocation',
);
say(
  `9. revocation evidence + denial audit recorded (${ledger.evidence.list(org.id, {}).filter((e) => e.type === 'reservation.denied').length} denial event(s))`,
);

// --- 5. restart: close abruptly, reopen, replay ------------------------------
const integrityBefore = ledger.recovery.verify();
ledger.db.close(); // simulated crash: no graceful close path taken

const reopened = openLedger(dbPath);
const integrityAfter = reopened.recovery.verify();
const opAfter = reopened.reservations.getOperation(org.id, reserved.operation.id);
say(
  `10. restart: integrity ${integrityBefore.integrity}→${integrityAfter.integrity}; op ${opAfter.requestId} still ${opAfter.state}; replay plan = ${reopened.recovery.replayPlan().length} pending dispatch(es) (worker seam disabled — nothing dispatched)`,
);
const evidencePreserved = reopened.evidence.list(org.id, {}).map((e) => e.type);
say(
  `11. evidence preserved across restart: ${evidencePreserved.filter((t) => t !== 'reservation.denied').length} event(s) incl. ${evidencePreserved.includes('mandate.revoked') ? 'mandate.revoked' : 'MISSING revocation'}`,
);

// Budget survived restart.
say(
  `12. mandate budget after restart: consumed ${reopened.mandates.consumedBudget(org.id, mandate.id)} of ${reopened.mandates.effectiveTotalBudget(mandate)} (settled-style retention across restarts)`,
);
reopened.close();
say('providers contacted: NONE (MTV-05 ships no adapters; worker seam disabled by design)');
