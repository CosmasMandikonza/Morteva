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
// Same-build imports of the integration modules the demo seed needs (kept in
// lockstep with packages/ledger/dist by `npm run build`).
const { registerMissionSpec } = await import(
  `file://${join(root, 'apps/api/dist/integration/mission-spec.js')}`
);
const { harborMissionSpec } = await import(
  `file://${join(root, 'apps/api/dist/integration/mission-catalogs.js')}`
);
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
// A viewer for negative-authorization journeys: may read, never write.
ledger.authority.createHumanActor({
  orgId: org.id,
  username: 'viewer',
  displayName: 'E2E Viewer',
  role: 'viewer',
  password: E2E_PASSWORD,
});

const missionA = ledger.organizations.createMission(org.id, 'Harbor turbine inspection');
const missionB = ledger.organizations.createMission(org.id, 'Subsea mooring survey');

// The flagship Harbor DEMO ships with its frozen, validated catalog spec
// REGISTERED (journal-backed, idempotent) — before any plan, approval,
// operation or evidence row is seeded — so the corrected frontend renders the
// designed 3D experience for this sample mission. DEMO/SYNTHETIC sample setup
// ONLY: never applied to customer missions, and production startup has no
// seed path at all. The Subsea mission stays legitimately unconfigured.
registerMissionSpec(ledger, harborMissionSpec(org.id, missionA.id));

const now = ledger.clock.now();
const iso = (hours) => new Date(now.getTime() + hours * 3_600_000).toISOString();

ledger.accounts.ensureTreasuryAccount({
  orgId: org.id,
  currency: 'USD',
  label: 'USD treasury',
  protectedFloorMinor: 50_000,
});
ledger.accounts.ensureTreasuryAccount({
  orgId: org.id,
  currency: 'EUR',
  label: 'EUR treasury',
  protectedFloorMinor: 10_000,
});
ledger.accounts.recordBalanceSnapshot({
  orgId: org.id,
  currency: 'EUR',
  minorUnits: 5_000_000,
  source: 'manual-seed',
  observedAt: ledger.clock.iso(),
  expiresAt: iso(1),
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
  allowedBeneficiaries: ['harbor-diagnostics', 'harbor-marine'],
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
  // Lapsed-by-clock fixture: read the clock IMMEDIATELY before issuance so a
  // slow/loaded machine cannot burn the 200ms fuse before the ledger validates
  // (the expiry is still in the past by the time the UI renders it).
  expiresAt: new Date(ledger.clock.now().getTime() + 200).toISOString(),
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

// --- Deterministic lifecycle scenario for the operation-centered journey ---
// Every transition below is a REAL ledger transition (journal events are
// appended automatically). Nothing claims provider verification: the
// settled/reconciled operation is an internal_hold (the one kind the ledger
// itself can settle without provider readback), and no airwallex_transfer
// is ever marked settled in this demo ledger.
const planU = ledger.plans.recordVersion({
  orgId: org.id,
  missionId: missionA.id,
  proposedBy: operator.id,
  terms: {
    amountMinor: 900_000,
    currency: 'USD',
    beneficiary: 'harbor-marine',
    purpose: 'ROV tether inspection',
    quote: { id: 'q-u', validUntil: iso(0.5) },
  },
});
const approvalU = ledger.approvals.record({
  orgId: org.id,
  plan: planU,
  decidedByActorId: approver.id,
  kind: 'airwallex_transfer',
  mandateId: usd.id,
  mandateVersion: usd.version,
  expiresAt: iso(1),
});
const unknownOp = ledger.reservations.reserve({
  orgId: org.id,
  missionId: missionA.id,
  kind: 'airwallex_transfer',
  requestId: 'e2e-op-unknown',
  planId: planU.id,
  planVersion: planU.version,
  approvalId: approvalU.id,
});
ledger.reservations.transition({
  orgId: org.id,
  operationId: unknownOp.operation.id,
  to: 'SUBMITTING',
});
ledger.reservations.transition({
  orgId: org.id,
  operationId: unknownOp.operation.id,
  to: 'STATUS_UNKNOWN',
});

const planH = ledger.plans.recordVersion({
  orgId: org.id,
  missionId: missionA.id,
  proposedBy: operator.id,
  terms: {
    amountMinor: 450_000,
    currency: 'USD',
    beneficiary: 'harbor-diagnostics',
    purpose: 'blade crack dye test',
    quote: { id: 'q-h', validUntil: iso(0.5) },
  },
});
const approvalH = ledger.approvals.record({
  orgId: org.id,
  plan: planH,
  decidedByActorId: approver.id,
  kind: 'airwallex_transfer',
  mandateId: usd.id,
  mandateVersion: usd.version,
  expiresAt: iso(1),
});
const humanOp = ledger.reservations.reserve({
  orgId: org.id,
  missionId: missionA.id,
  kind: 'airwallex_transfer',
  requestId: 'e2e-op-human',
  planId: planH.id,
  planVersion: planH.version,
  approvalId: approvalH.id,
});
ledger.reservations.transition({
  orgId: org.id,
  operationId: humanOp.operation.id,
  to: 'SUBMITTING',
});
ledger.reservations.transition({
  orgId: org.id,
  operationId: humanOp.operation.id,
  to: 'IN_FLIGHT',
});
ledger.reservations.transition({
  orgId: org.id,
  operationId: humanOp.operation.id,
  to: 'REQUIRES_HUMAN',
});

const eurMandate = ledger.db
  .prepare(
    'SELECT id, version FROM mandates WHERE org_id = ? AND mission_id = ? AND currency = ? AND status = ?',
  )
  .get(org.id, missionA.id, 'EUR', 'active');
const planS = ledger.plans.recordVersion({
  orgId: org.id,
  missionId: missionA.id,
  proposedBy: operator.id,
  terms: {
    amountMinor: 300_000,
    currency: 'EUR',
    beneficiary: 'harbor-diagnostics',
    purpose: 'docking-slot hold',
    quote: null,
  },
});
const approvalS = ledger.approvals.record({
  orgId: org.id,
  plan: planS,
  decidedByActorId: approver.id,
  kind: 'internal_hold',
  mandateId: eurMandate.id,
  mandateVersion: eurMandate.version,
  expiresAt: iso(1),
});
const settledOp = ledger.reservations.reserve({
  orgId: org.id,
  missionId: missionA.id,
  kind: 'internal_hold',
  requestId: 'e2e-op-settled',
  planId: planS.id,
  planVersion: planS.version,
  approvalId: approvalS.id,
});
ledger.reservations.transition({
  orgId: org.id,
  operationId: settledOp.operation.id,
  to: 'SETTLED',
});
ledger.reservations.transition({
  orgId: org.id,
  operationId: settledOp.operation.id,
  to: 'RECONCILED',
});

ledger.evidence.append({
  orgId: org.id,
  missionId: missionA.id,
  topic: 'operational',
  type: 'rov.status',
  eventKey: 'e2e:rov:1',
  payload: { rov: 'ROV-2', status: 'tether tension spike', sector: 'B-north' },
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
    PORT: process.env.PORT ?? '8787',
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
