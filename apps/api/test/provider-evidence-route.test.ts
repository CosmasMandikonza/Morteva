import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openLedger, type Ledger } from '@moterva/ledger';
import { TEST_PASSWORD, tempDbPath } from '../../../packages/ledger/test/helpers.js';
import type { FastifyInstance } from 'fastify';

/**
 * Issue #5 / A4 — the REDACTED provider-evidence read route
 * (GET /api/operations/:id/provider-evidence): settlement truth per
 * operation (dispatch/readback/rejection/ambiguous/webhook receipts) with
 * identity + settlement-progress fields ONLY. Adversarial focus: the stored
 * receipt payload_json NEVER reaches the wire, tenant isolation is
 * 404-indistinguishable, and the read is pure (zero rows added).
 */

let app: FastifyInstance;
let ledger: Ledger;
let ownerCookie: string;
let foreignOwnerCookie: string;
let operationId = '';
let requestId = '';

function makeApp() {
  const path = tempDbPath('provider-evidence-');
  const l: Ledger = openLedger(path);
  l.migrate();
  const config = loadConfig({
    NODE_ENV: 'development',
    LOG_LEVEL: 'silent',
    MOTERVA_DEV_AUTH: '1',
    WEB_ORIGIN: 'http://localhost:5173',
  });
  const a = buildApp(config, undefined, l);
  return { app: a, ledger: l };
}

async function loginAs(username: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: TEST_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'] as unknown;
  const first = Array.isArray(setCookie) ? (setCookie[0] as string) : String(setCookie);
  return first.split(';')[0]!;
}

function seedOrgWithOperation(name: string): { orgId: string; opId: string; reqId: string } {
  const ledgerLocal = ledger;
  const org = ledgerLocal.organizations.createOrganization(name);
  const mission = ledgerLocal.organizations.createMission(org.id, `${name} mission`);
  const operator = ledgerLocal.authority.createHumanActor({
    orgId: org.id,
    username: `${name}-op`,
    displayName: 'Op',
    role: 'operator',
    password: TEST_PASSWORD,
  });
  const approver = ledgerLocal.authority.createHumanActor({
    orgId: org.id,
    username: `${name}-approver`,
    displayName: 'A',
    role: 'approver',
    password: TEST_PASSWORD,
  });
  ledgerLocal.accounts.ensureTreasuryAccount({
    orgId: org.id,
    currency: 'USD',
    label: 'USD',
    protectedFloorMinor: 0,
  });
  ledgerLocal.accounts.recordBalanceSnapshot({
    orgId: org.id,
    currency: 'USD',
    minorUnits: 1_000_000,
    source: 'manual-seed',
    observedAt: ledgerLocal.clock.iso(),
    expiresAt: new Date(ledgerLocal.clock.now().getTime() + 3_600_000).toISOString(),
  });
  const mandate = ledgerLocal.mandates.issue({
    orgId: org.id,
    missionId: mission.id,
    currency: 'USD',
    maxAmountMinor: 500_000,
    totalBudgetMinor: 500_000,
    permittedOperationKinds: ['airwallex_transfer'],
    byActorId: operator.id,
    expiresAt: new Date(ledgerLocal.clock.now().getTime() + 3_600_000).toISOString(),
  });
  const plan = ledgerLocal.plans.recordVersion({
    orgId: org.id,
    missionId: mission.id,
    proposedBy: operator.id,
    terms: {
      amountMinor: 120_000,
      currency: 'USD',
      beneficiary: 'benfixture',
      purpose: 'provider evidence journey',
    },
  });
  const approval = ledgerLocal.approvals.record({
    orgId: org.id,
    plan,
    decidedByActorId: approver.id,
    kind: 'airwallex_transfer',
    mandateId: mandate.id,
    mandateVersion: mandate.version,
    expiresAt: new Date(ledgerLocal.clock.now().getTime() + 3_600_000).toISOString(),
  });
  const reserved = ledgerLocal.reservations.reserve({
    orgId: org.id,
    missionId: mission.id,
    kind: 'airwallex_transfer',
    requestId: `${name}-req-1`,
    planId: plan.id,
    planVersion: plan.version,
    approvalId: approval.id,
  });
  return { orgId: org.id, opId: reserved.operation.id, reqId: `${name}-req-1` };
}

function appendReceipt(input: {
  orgId: string;
  operationId: string;
  requestId: string;
  kind: string;
  providerStatus: string | null;
  transferId?: string;
  payloadJson: string;
}): void {
  ledger.providerReceipts.append({
    provider: 'airwallex',
    orgId: input.orgId,
    operationId: input.operationId,
    requestId: input.requestId,
    providerResourceId: input.transferId ?? null,
    kind: input.kind as 'dispatch-create',
    environment: 'sandbox',
    httpStatus: 201,
    providerStatus: input.providerStatus,
    payloadJson: input.payloadJson,
    recordedAt: ledger.clock.iso(),
  });
}

beforeAll(async () => {
  ({ app, ledger } = makeApp());
  await app.ready();
  const ours = seedOrgWithOperation('evidence-org');
  operationId = ours.opId;
  requestId = ours.reqId;
  // A realistic receipt chain: dispatch + PAID readback, with hostile payload
  // fields that must NEVER surface (credentials, bank details, free text).
  appendReceipt({
    orgId: ours.orgId,
    operationId: ours.opId,
    requestId: ours.reqId,
    kind: 'dispatch-create',
    providerStatus: null,
    transferId: 'trf_x1',
    payloadJson: JSON.stringify({
      minimized: { id: 'trf_x1', status: 'SUBMITTED' },
      leaked_secret: 'AKIA_should_never_surface',
      bank_details: { account_number: 'SECRET-999' },
    }),
  });
  appendReceipt({
    orgId: ours.orgId,
    operationId: ours.opId,
    requestId: ours.reqId,
    kind: 'readback-by-request-id',
    providerStatus: 'PAID',
    transferId: 'trf_x1',
    payloadJson: JSON.stringify({
      minimized: { id: 'trf_x1', status: 'PAID' },
      failure_message: 'free text that must never surface',
    }),
  });
  const other = seedOrgWithOperation('foreign-org');
  const foreignOwner = ledger.authority.createHumanActor({
    orgId: other.orgId,
    username: 'foreign-owner',
    displayName: 'F',
    role: 'owner',
    password: TEST_PASSWORD,
  });
  // Foreign org has its own receipts over the SAME request-id shape collision
  // candidates; its owner must not see ours (org scoping + request-id scoping).
  appendReceipt({
    orgId: other.orgId,
    operationId: other.opId,
    requestId: other.reqId,
    kind: 'dispatch-create',
    providerStatus: null,
    payloadJson: JSON.stringify({ minimized: { id: 'trf_foreign' } }),
  });
  void foreignOwner;
  ownerCookie = await loginAs('evidence-org-op');
  foreignOwnerCookie = await loginAs('foreign-org-op');
});

afterAll(async () => {
  await app.close();
  if (ledger.db.open) ledger.close();
});

const countRows = (t: string) =>
  (ledger.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;

describe('A4 — GET /api/operations/:id/provider-evidence (redacted settlement truth)', () => {
  it('returns the operation receipt chain in seq order with identity fields only', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/operations/${operationId}/provider-evidence`,
      headers: { cookie: ownerCookie },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      operationId: string;
      requestId: string;
      evidence: {
        seq: number;
        provider: string;
        environment: string;
        kind: string;
        requestId: string;
        transferId: string | null;
        httpStatus: number | null;
        providerStatus: string | null;
        recordedAt: string;
      }[];
    };
    expect(body.operationId).toBe(operationId);
    expect(body.requestId).toBe(requestId);
    expect(body.evidence).toHaveLength(2);
    expect(body.evidence.map((e) => e.kind)).toEqual(['dispatch-create', 'readback-by-request-id']);
    expect(body.evidence[1]!.providerStatus).toBe('PAID');
    expect(body.evidence[1]!.transferId).toBe('trf_x1');
    expect(body.evidence[0]!.environment).toBe('sandbox');
    // The raw stored payload NEVER reaches the wire — only the projection.
    const text = r.body;
    expect(text).not.toContain('payload_json');
    expect(text).not.toContain('payloadJson');
    expect(text).not.toContain('AKIA_should_never_surface');
    expect(text).not.toContain('SECRET-999');
    expect(text).not.toContain('bank_details');
    expect(text).not.toContain('free text that must never surface');
  });

  it('is tenant-isolated: a foreign org sees 404 for our operation, never its evidence', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/operations/${operationId}/provider-evidence`,
      headers: { cookie: foreignOwnerCookie },
    });
    expect(r.statusCode).toBe(404);
  });

  it('unknown operation is 404-indistinguishable from a foreign one', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/operations/does-not-exist/provider-evidence',
      headers: { cookie: ownerCookie },
    });
    expect(r.statusCode).toBe(404);
  });

  it('is a pure read: GETs add zero rows anywhere', async () => {
    const before = {
      receipts: countRows('provider_receipts'),
      ops: countRows('operations'),
      evidence: countRows('evidence_events'),
    };
    for (let i = 0; i < 3; i += 1) {
      const r = await app.inject({
        method: 'GET',
        url: `/api/operations/${operationId}/provider-evidence`,
        headers: { cookie: ownerCookie },
      });
      expect(r.statusCode).toBe(200);
    }
    const after = {
      receipts: countRows('provider_receipts'),
      ops: countRows('operations'),
      evidence: countRows('evidence_events'),
    };
    expect(after).toEqual(before);
  });
});
