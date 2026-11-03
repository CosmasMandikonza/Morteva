import { describe, expect, it } from 'vitest';
import { LedgerError } from '../src/index.js';
import { approvedPlan, makeLedger, reserveCall } from './helpers.js';

describe('evidence journal', () => {
  it('rejects duplicate event keys per org (webhook/worker replay suppression)', () => {
    const { ledger } = makeLedger();
    const org = ledger.organizations.createOrganization('EvOrg');
    const first = ledger.evidence.append({
      orgId: org.id,
      topic: 'operational',
      type: 'mission_event.observed',
      eventKey: 'webhook:abc123',
      payload: { temperature: 41 },
    });
    expect(first.seq).toBeGreaterThan(0);
    try {
      ledger.evidence.append({
        orgId: org.id,
        topic: 'operational',
        type: 'mission_event.observed',
        eventKey: 'webhook:abc123',
        payload: { temperature: 41 },
      });
      expect.unreachable('duplicate event key must be rejected');
    } catch (error) {
      expect((error as LedgerError).code).toBe('DUPLICATE_EVENT');
    }
    ledger.close();
  });

  it('the same key is fine in a DIFFERENT org (keys are org-scoped)', () => {
    const { ledger } = makeLedger();
    const orgA = ledger.organizations.createOrganization('EvA');
    const orgB = ledger.organizations.createOrganization('EvB');
    for (const org of [orgA, orgB]) {
      ledger.evidence.append({
        orgId: org.id,
        topic: 'operational',
        type: 't',
        eventKey: 'shared-key',
        payload: {},
      });
    }
    expect(ledger.evidence.count(orgA.id)).toBe(1);
    expect(ledger.evidence.count(orgB.id)).toBe(1);
    ledger.close();
  });

  it('is append-only: UPDATE and DELETE are blocked by database triggers', () => {
    const { ledger } = makeLedger();
    const org = ledger.organizations.createOrganization('EvAO');
    ledger.evidence.append({
      orgId: org.id,
      topic: 'financial',
      type: 't',
      eventKey: 'k1',
      payload: { a: 1 },
    });
    expect(() =>
      ledger.db
        .prepare("UPDATE evidence_events SET payload_json = '{\"a\":2}' WHERE event_key = 'k1'")
        .run(),
    ).toThrowError(/append-only/i);
    expect(() =>
      ledger.db.prepare('DELETE FROM evidence_events WHERE event_key = ?').run('k1'),
    ).toThrowError(/append-only/i);
    expect(ledger.evidence.count(org.id)).toBe(1);
    ledger.close();
  });

  it('evidence listing never crosses org boundaries', () => {
    const { ledger } = makeLedger();
    const orgA = ledger.organizations.createOrganization('IsoA');
    const orgB = ledger.organizations.createOrganization('IsoB');
    ledger.evidence.append({
      orgId: orgA.id,
      topic: 'financial',
      type: 'secret-a',
      eventKey: 'a1',
      payload: {},
    });
    ledger.evidence.append({
      orgId: orgB.id,
      topic: 'financial',
      type: 'secret-b',
      eventKey: 'b1',
      payload: {},
    });
    const aTypes = ledger.evidence.list(orgA.id, {}).map((e) => e.type);
    expect(aTypes).toEqual(['secret-a']);
    ledger.close();
  });
});

describe('cross-organization isolation', () => {
  function twoOrgsWorld() {
    const { ledger, clock } = makeLedger();
    const worlds = [1, 2].map((n) => {
      const org = ledger.organizations.createOrganization(`IsoOrg${n}`);
      const mission = ledger.organizations.createMission(org.id, `mission-${n}`);
      ledger.accounts.ensureTreasuryAccount({
        orgId: org.id,
        currency: 'USD',
        label: 'USD',
        protectedFloorMinor: 0,
      });
      ledger.accounts.recordBalanceSnapshot({
        orgId: org.id,
        currency: 'USD',
        minorUnits: 500_000,
        source: 'manual-seed',
        observedAt: clock.iso(),
        expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
      });
      ledger.mandates.issue({
        orgId: org.id,
        missionId: mission.id,
        currency: 'USD',
        maxAmountMinor: 500_000,
        permittedOperationKinds: ['airwallex_transfer'],
        expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
      });
      return { org, mission };
    });
    return {
      ledger,
      clock,
      first: worlds[0] as (typeof worlds)[0],
      second: worlds[1] as (typeof worlds)[0],
    };
  }

  it("org B cannot even see org A's mission", () => {
    const { ledger, first, second } = twoOrgsWorld();
    try {
      ledger.organizations.getMission(second.org.id, first.mission.id);
      expect.unreachable('cross-org mission read must fail');
    } catch (error) {
      expect((error as LedgerError).code).toBe('MISSION_NOT_FOUND');
    }
    ledger.close();
  });

  it('org B cannot reserve using org A plan/approval artifacts', () => {
    const { ledger, first, second } = twoOrgsWorld();
    const stolenRef = approvedPlan(ledger, first.org.id, first.mission.id, {
      amountMinor: 100_000,
      currency: 'USD',
    });
    try {
      reserveCall(ledger, { org: second.org }, second.mission.id, stolenRef, 'cross-org-steal');
      expect.unreachable('cross-org reservation must fail');
    } catch (error) {
      // The plan lookup is org+mission scoped: the theft fails closed.
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).code).toBe('PLAN_NOT_FOUND');
    }
    ledger.close();
  });

  it("org B cannot read or transition org A's operations; balances are independent", () => {
    const { ledger, first, second } = twoOrgsWorld();
    const ref = approvedPlan(ledger, first.org.id, first.mission.id, {
      amountMinor: 100_000,
      currency: 'USD',
    });
    const { operation } = reserveCall(ledger, { org: first.org }, first.mission.id, ref, 'iso-op');

    try {
      ledger.reservations.getOperation(second.org.id, operation.id);
      expect.unreachable('cross-org operation read must fail');
    } catch (error) {
      expect((error as LedgerError).code).toBe('OPERATION_NOT_FOUND');
    }
    try {
      ledger.reservations.transition({
        orgId: second.org.id,
        operationId: operation.id,
        to: 'CANCELLED',
      });
      expect.unreachable('cross-org transition must fail');
    } catch (error) {
      expect((error as LedgerError).code).toBe('OPERATION_NOT_FOUND');
    }

    // Org A's reservation does not touch org B's spendable.
    expect(ledger.spendable.compute(first.org.id, 'USD').spendableMinor).toBe(400_000);
    expect(ledger.spendable.compute(second.org.id, 'USD').spendableMinor).toBe(500_000);

    // And org B can spend its own pool freely.
    const bRef = approvedPlan(ledger, second.org.id, second.mission.id, {
      amountMinor: 500_000,
      currency: 'USD',
    });
    expect(
      reserveCall(ledger, { org: second.org }, second.mission.id, bRef, 'iso-op-b').duplicate,
    ).toBe(false);
    ledger.close();
  });
});
