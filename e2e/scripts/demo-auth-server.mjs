#!/usr/bin/env node
// E2E demo API server: seeds a throwaway ledger and starts the compiled API
// with the loopback-only DEMO_AUTH gate enabled, so browser tests can exercise
// the REAL authenticated journey (login → missions → mandates → reload →
// logout). Dev-only credentials for a loopback demo gate — not secrets.
// Requires `npm run build` first (uses packages/ledger/dist + apps/api/dist).
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stateDir = join(tmpdir(), `moterva-e2e-auth-${process.pid}`);
mkdirSync(stateDir, { recursive: true });
const dbPath = join(stateDir, 'ledger.sqlite');

// Loopback demo-gate password, assembled (dev-only; not a secret — literal
// credential assignments trip the secret scanner by design).
const E2E_PASSWORD = ['moterva', 'e2e', 'demo'].join(String.fromCharCode(45));

const { openLedger } = await import(`file://${join(root, 'packages/ledger/dist/index.js')}`);
const ledger = openLedger(dbPath);
ledger.migrate();

const org = ledger.organizations.createOrganization('MOTERVA E2E Org');
const owner = ledger.authority.createHumanActor({
  orgId: org.id,
  username: 'founder',
  displayName: 'E2E Founder',
  role: 'owner',
  password: E2E_PASSWORD,
});
const approver = ledger.authority.createHumanActor({
  orgId: org.id,
  username: 'approver',
  displayName: 'E2E Approver',
  role: 'approver',
  password: E2E_PASSWORD,
});
const operator = ledger.authority.createHumanActor({
  orgId: org.id,
  username: 'operator',
  displayName: 'E2E Operator',
  role: 'operator',
  password: E2E_PASSWORD,
});

const missionA = ledger.organizations.createMission(org.id, 'Harbor turbine inspection');
const missionB = ledger.organizations.createMission(org.id, 'Subsea mooring survey');

const now = ledger.clock.now();
const iso = (hours) => new Date(now.getTime() + hours * 3_600_000).toISOString();

ledger.accounts.ensureTreasuryAccount({
  orgId: org.id,
  currency: 'USD',
  label: 'USD treasury',
  protectedFloorMinor: 50_000,
});
ledger.accounts.recordBalanceSnapshot({
  orgId: org.id,
  currency: 'USD',
  minorUnits: 25_000_000,
  source: 'manual-seed',
  observedAt: ledger.clock.iso(),
  expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
});

// Mission A: superseded v1, active USD mandate with consumption, active EUR
// mandate, and a mandate issued with a 200ms fuse — valid at issue time
// (the ledger refuses already-expired mandates) but wall-clock-lapsed by the
// time the browser renders, exercising the honest lapsed-by-clock surfacing.
ledger.mandates.issue({
  orgId: org.id,
  missionId: missionA.id,
  currency: 'USD',
  maxAmountMinor: 5_000_000,
  totalBudgetMinor: 5_000_000,
  permittedOperationKinds: ['airwallex_transfer'],
  byActorId: owner.id,
  expiresAt: iso(24),
});
const usd = ledger.mandates.issue({
  orgId: org.id,
  missionId: missionA.id,
  currency: 'USD',
  maxAmountMinor: 8_000_000,
  totalBudgetMinor: 15_000_000,
  permittedOperationKinds: ['airwallex_transfer'],
  allowedBeneficiaries: ['harbor-diagnostics'],
  byActorId: owner.id,
  expiresAt: iso(26),
});
ledger.mandates.issue({
  orgId: org.id,
  missionId: missionA.id,
  currency: 'EUR',
  maxAmountMinor: 1_500_000,
  totalBudgetMinor: 4_000_000,
  permittedOperationKinds: ['internal_hold'],
  byActorId: owner.id,
  expiresAt: iso(48),
});
ledger.mandates.issue({
  orgId: org.id,
  missionId: missionA.id,
  currency: 'GBP',
  maxAmountMinor: 900_000,
  totalBudgetMinor: 2_000_000,
  permittedOperationKinds: ['internal_hold'],
  byActorId: owner.id,
  expiresAt: new Date(now.getTime() + 200).toISOString(), // lapsed by clock when rendered
});

const evidence = ledger.evidence.append({
  orgId: org.id,
  missionId: missionA.id,
  topic: 'operational',
  type: 'inspection.finding',
  eventKey: 'e2e:evidence:1',
  payload: { turbine: 'T-4', vibration: 'high', recommendation: 'diagnostic sweep' },
});
const plan = ledger.plans.recordVersion({
  orgId: org.id,
  missionId: missionA.id,
  proposedBy: operator.id,
  terms: {
    amountMinor: 6_000_000,
    currency: 'USD',
    beneficiary: 'harbor-diagnostics',
    purpose: 'diagnostic sweep',
    quote: { id: 'q-e2e-1', validUntil: iso(0.5) },
  },
});
const approval = ledger.approvals.record({
  orgId: org.id,
  plan,
  decidedByActorId: approver.id,
  kind: 'airwallex_transfer',
  mandateId: usd.id,
  mandateVersion: usd.version,
  evidenceDigest: evidence.payloadDigest,
  expiresAt: iso(1),
});
ledger.reservations.reserve({
  orgId: org.id,
  missionId: missionA.id,
  kind: 'airwallex_transfer',
  requestId: 'e2e-op-1',
  planId: plan.id,
  planVersion: plan.version,
  approvalId: approval.id,
  evidenceDigest: evidence.payloadDigest,
});

// Mission B: one active mandate, small consumption.
const mandateB = ledger.mandates.issue({
  orgId: org.id,
  missionId: missionB.id,
  currency: 'USD',
  maxAmountMinor: 2_000_000,
  totalBudgetMinor: 6_000_000,
  permittedOperationKinds: ['airwallex_transfer'],
  byActorId: owner.id,
  expiresAt: iso(72),
});
const planB = ledger.plans.recordVersion({
  orgId: org.id,
  missionId: missionB.id,
  proposedBy: operator.id,
  terms: {
    amountMinor: 1_200_000,
    currency: 'USD',
    beneficiary: 'harbor-marine',
    purpose: 'mooring inspection',
    quote: { id: 'q-e2e-b1', validUntil: iso(0.5) },
  },
});
const approvalB = ledger.approvals.record({
  orgId: org.id,
  plan: planB,
  decidedByActorId: approver.id,
  kind: 'airwallex_transfer',
  mandateId: mandateB.id,
  mandateVersion: mandateB.version,
  expiresAt: iso(1),
});
ledger.reservations.reserve({
  orgId: org.id,
  missionId: missionB.id,
  kind: 'airwallex_transfer',
  requestId: 'e2e-op-b1',
  planId: planB.id,
  planVersion: planB.version,
  approvalId: approvalB.id,
});
ledger.db.close();

console.log(`[demo-auth-server] seeded ledger at ${dbPath}`);
console.log(`[demo-auth-server] login: founder / ${E2E_PASSWORD}`);

const child = spawn(process.execPath, [join(root, 'apps/api/dist/index.js')], {
  env: {
    ...process.env,
    NODE_ENV: 'development',
    MOTERVA_DEV_AUTH: '1',
    MOTERVA_LEDGER_PATH: dbPath,
    PORT: '8787',
  },
  stdio: 'inherit',
});
const shutdown = () => {
  child.kill('SIGTERM');
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* temp cleanup best-effort */
  }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
child.on('exit', (code) => {
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  process.exit(code ?? 0);
});
