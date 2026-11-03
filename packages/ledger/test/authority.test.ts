import { describe, expect, it } from 'vitest';
import { LedgerError } from '../src/index.js';
import { TEST_PASSWORD, approvedPlan, ensureApprover, makeLedger, reserveCall } from './helpers.js';

/**
 * Issue #7 Phase 2/4: actor authenticity, roles, sessions, separation of
 * duties, single-use approvals and their revocation. A freeform `decidedBy`
 * string must never again be enough to grant financial authority.
 */

describe('actors and credentials', () => {
  it('creates human actors with scrypt credentials and unique usernames per org', () => {
    const { ledger } = makeLedger();
    const org = ledger.organizations.createOrganization('AuthOrg');
    const actor = ledger.authority.createHumanActor({
      orgId: org.id,
      username: 'Ada',
      displayName: 'Ada Approver',
      role: 'approver',
      password: TEST_PASSWORD,
    });
    expect(actor.role).toBe('approver');
    expect(actor.username).toBe('ada'); // normalized
    expect(() =>
      ledger.authority.createHumanActor({
        orgId: org.id,
        username: 'ada',
        displayName: 'dup',
        role: 'viewer',
        password: TEST_PASSWORD,
      }),
    ).toThrowError(/already exists/);
    // Passwords are never part of the view; hashes exist only server-side.
    const row = ledger.db
      .prepare('SELECT password_hash FROM actors WHERE id = ?')
      .get(actor.id) as {
      password_hash: string;
    };
    expect(row.password_hash).not.toContain(TEST_PASSWORD);
    ledger.close();
  });

  it('verifies credentials in constant time and rejects bad ones without an oracle', () => {
    const { ledger } = makeLedger();
    const org = ledger.organizations.createOrganization('CredOrg');
    ledger.authority.createHumanActor({
      orgId: org.id,
      username: 'operator1',
      displayName: 'Op',
      role: 'operator',
      password: TEST_PASSWORD,
    });
    expect(
      ledger.authority.verifyCredential({
        username: 'operator1',
        password: TEST_PASSWORD,
        orgId: org.id,
      })?.role,
    ).toBe('operator');
    expect(
      ledger.authority.verifyCredential({
        username: 'operator1',
        password: 'wrong',
        orgId: org.id,
      }),
    ).toBeNull();
    expect(
      ledger.authority.verifyCredential({
        username: 'ghost',
        password: 'x'.repeat(20),
        orgId: org.id,
      }),
    ).toBeNull();
    // Service actors have no password and can never log in.
    const service = ledger.authority.createServiceActor({
      orgId: org.id,
      username: 'mission-bot',
      displayName: 'Bot',
    });
    expect(
      ledger.authority.verifyCredential({
        username: 'mission-bot',
        password: TEST_PASSWORD,
        orgId: org.id,
      }),
    ).toBeNull();
    expect(service.kind).toBe('service');
    ledger.close();
  });

  it('short passwords are refused at creation', () => {
    const { ledger } = makeLedger();
    const org = ledger.organizations.createOrganization('PwOrg');
    expect(() =>
      ledger.authority.createHumanActor({
        orgId: org.id,
        username: 'shorty',
        displayName: 's',
        role: 'viewer',
        password: 'short',
      }),
    ).toThrowError(/at least 12 characters/);
    ledger.close();
  });
});

describe('sessions', () => {
  it('issues expiring sessions with hashed tokens and resolves them to actors', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('SessOrg');
    const actor = ledger.authority.createHumanActor({
      orgId: org.id,
      username: 'approver1',
      displayName: 'A',
      role: 'approver',
      password: TEST_PASSWORD,
    });
    const session = ledger.authority.createSession(actor.id, { ttlMs: 60_000 });
    expect(session.token).not.toMatch(/,/); // opaque url-safe token
    const resolved = ledger.authority.resolveSession(session.token);
    expect(resolved?.actor.id).toBe(actor.id);
    // Token stored only as a digest.
    const row = ledger.db
      .prepare('SELECT token_hash FROM sessions WHERE id = ?')
      .get(resolved!.sessionId) as { token_hash: string };
    expect(row.token_hash).not.toBe(session.token);

    // Expiry: after TTL the session is dead.
    clock.advance(61_000);
    expect(ledger.authority.resolveSession(session.token)).toBeNull();
    ledger.close();
  });

  it('logout/invalidation and actor revocation kill sessions immediately', () => {
    const { ledger } = makeLedger();
    const org = ledger.organizations.createOrganization('KillOrg');
    const actor = ledger.authority.createHumanActor({
      orgId: org.id,
      username: 'owner1',
      displayName: 'O',
      role: 'owner',
      password: TEST_PASSWORD,
    });
    const s1 = ledger.authority.createSession(actor.id);
    const s2 = ledger.authority.createSession(actor.id);
    expect(ledger.authority.revokeSession(s1.token)).toBe(true);
    expect(ledger.authority.resolveSession(s1.token)).toBeNull();
    expect(ledger.authority.resolveSession(s2.token)?.actor.id).toBe(actor.id);

    ledger.authority.revokeActor(org.id, actor.id, actor.id);
    expect(ledger.authority.resolveSession(s2.token)).toBeNull(); // all sessions die with the actor
    expect(
      ledger.authority.verifyCredential({
        username: 'owner1',
        password: TEST_PASSWORD,
        orgId: org.id,
      }),
    ).toBeNull();
    ledger.close();
  });

  it('CSRF tokens are bound to the session and verified in constant time', () => {
    const { ledger } = makeLedger();
    const org = ledger.organizations.createOrganization('CsrfOrg');
    const actor = ledger.authority.createHumanActor({
      orgId: org.id,
      username: 'op1',
      displayName: 'O',
      role: 'operator',
      password: TEST_PASSWORD,
    });
    const session = ledger.authority.createSession(actor.id);
    const resolved = ledger.authority.resolveSession(session.token)!;
    expect(ledger.authority.verifyCsrf(resolved.sessionId, session.csrfToken)).toBe(true);
    expect(ledger.authority.verifyCsrf(resolved.sessionId, 'forged-token')).toBe(false);
    expect(ledger.authority.verifyCsrf('sess_nonexistent', session.csrfToken)).toBe(false);
    ledger.close();
  });
});

describe('role policy — the permission matrix', () => {
  it('viewer/operator/service can never approve or manage authority; approver cannot manage', () => {
    const { ledger } = makeLedger();
    const org = ledger.organizations.createOrganization('RoleOrg');
    const mk = (role: 'viewer' | 'operator' | 'approver' | 'admin') =>
      ledger.authority.createHumanActor({
        orgId: org.id,
        username: `u-${role}`,
        displayName: role,
        role,
        password: TEST_PASSWORD,
      });
    const viewer = mk('viewer');
    const operator = mk('operator');
    const approver = mk('approver');
    const admin = mk('admin');
    const service = ledger.authority.createServiceActor({
      orgId: org.id,
      username: 'svc-1',
      displayName: 'svc',
    });

    expect(ledger.authority.requireRole(viewer, 'read').outcome).toBe('AUTHORIZED');
    expect(ledger.authority.requireRole(viewer, 'approve').reason).toBe('ROLE_FORBIDDEN');
    expect(ledger.authority.requireRole(viewer, 'operate').reason).toBe('ROLE_FORBIDDEN');
    expect(ledger.authority.requireRole(operator, 'operate').outcome).toBe('AUTHORIZED');
    expect(ledger.authority.requireRole(operator, 'approve').reason).toBe('ROLE_FORBIDDEN');
    expect(ledger.authority.requireRole(operator, 'manageAuthority').reason).toBe('ROLE_FORBIDDEN');
    expect(ledger.authority.requireRole(approver, 'approve').outcome).toBe('AUTHORIZED');
    expect(ledger.authority.requireRole(approver, 'manageAuthority').reason).toBe('ROLE_FORBIDDEN');
    expect(ledger.authority.requireRole(admin, 'manageAuthority').outcome).toBe('AUTHORIZED');
    expect(ledger.authority.requireRole(service, 'propose').outcome).toBe('AUTHORIZED');
    expect(ledger.authority.requireRole(service, 'approve').reason).toBe('ROLE_FORBIDDEN');
    expect(ledger.authority.requireRole(service, 'manageAuthority').reason).toBe('ROLE_FORBIDDEN');
    ledger.close();
  });

  it('approvals recorded by non-approver actors are refused (no role spoofing)', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('SpoofOrg');
    const mission = ledger.organizations.createMission(org.id, 'm');
    const viewer = ledger.authority.createHumanActor({
      orgId: org.id,
      username: 'viewer1',
      displayName: 'v',
      role: 'viewer',
      password: TEST_PASSWORD,
    });
    const plan = ledger.plans.recordVersion({
      orgId: org.id,
      missionId: mission.id,
      terms: { amountMinor: 1_000, currency: 'USD', beneficiary: 'b', purpose: 'p' },
    });
    expect(() =>
      ledger.approvals.record({
        orgId: org.id,
        plan,
        decidedByActorId: viewer.id,
        kind: 'airwallex_transfer',
        expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
      }),
    ).toThrowError(/may not approve/);
    // A fabricated actor id is not identity at all.
    expect(() =>
      ledger.approvals.record({
        orgId: org.id,
        plan,
        decidedByActorId: 'act_forged',
        kind: 'airwallex_transfer',
        expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
      }),
    ).toThrowError(/not found/);
    ledger.close();
  });
});

describe('separation of duties', () => {
  function sodWorld() {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('SoDOrg');
    const mission = ledger.organizations.createMission(org.id, 'm');
    const operator = ledger.authority.createHumanActor({
      orgId: org.id,
      username: 'op-so',
      displayName: 'op',
      role: 'operator',
      password: TEST_PASSWORD,
    });
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
    return { ledger, clock, org, mission, operator, approver };
  }

  it('an operator who proposed the plan cannot approve it; a different approver can', () => {
    const ctx = sodWorld();
    const plan = ctx.ledger.plans.recordVersion({
      orgId: ctx.org.id,
      missionId: ctx.mission.id,
      terms: { amountMinor: 10_000, currency: 'USD', beneficiary: 'b', purpose: 'p' },
      proposedBy: ctx.operator.id,
    });
    // The operator has approver rights? No — role check fails first.
    expect(() =>
      ctx.ledger.approvals.record({
        orgId: ctx.org.id,
        plan,
        decidedByActorId: ctx.operator.id,
        kind: 'airwallex_transfer',
        expiresAt: new Date(ctx.clock.now().getTime() + 3_600_000).toISOString(),
      }),
    ).toThrowError(/may not approve/);

    // Even an approver-role actor cannot self-approve their own proposal.
    const ownPlan = ctx.ledger.plans.recordVersion({
      orgId: ctx.org.id,
      missionId: ctx.mission.id,
      terms: { amountMinor: 10_000, currency: 'USD', beneficiary: 'b2', purpose: 'p2' },
      proposedBy: ctx.approver.id,
    });
    expect(() =>
      ctx.ledger.approvals.record({
        orgId: ctx.org.id,
        plan: ownPlan,
        decidedByActorId: ctx.approver.id,
        kind: 'airwallex_transfer',
        expiresAt: new Date(ctx.clock.now().getTime() + 3_600_000).toISOString(),
      }),
    ).toThrowError(/separation of duties/);

    // A different approver approves the operator's proposal: allowed, single-use.
    const approval = ctx.ledger.approvals.record({
      orgId: ctx.org.id,
      plan,
      decidedByActorId: ctx.approver.id,
      kind: 'airwallex_transfer',
      expiresAt: new Date(ctx.clock.now().getTime() + 3_600_000).toISOString(),
    });
    const result = reserveCall(
      ctx.ledger,
      { org: ctx.org },
      ctx.mission.id,
      {
        planId: plan.id,
        planVersion: plan.version,
        approvalId: approval.id,
      },
      'sod-ok',
    );
    expect(result.duplicate).toBe(false);
    ctx.ledger.close();
  });

  it('double approval clicks are idempotent; another approver sees ALREADY_APPROVED', () => {
    const ctx = sodWorld();
    const plan = ctx.ledger.plans.recordVersion({
      orgId: ctx.org.id,
      missionId: ctx.mission.id,
      terms: { amountMinor: 5_000, currency: 'USD', beneficiary: 'b', purpose: 'p' },
      proposedBy: ctx.operator.id,
    });
    const first = ctx.ledger.approvals.record({
      orgId: ctx.org.id,
      plan,
      decidedByActorId: ctx.approver.id,
      kind: 'airwallex_transfer',
      expiresAt: new Date(ctx.clock.now().getTime() + 3_600_000).toISOString(),
    });
    const second = ctx.ledger.approvals.record({
      orgId: ctx.org.id,
      plan,
      decidedByActorId: ctx.approver.id,
      kind: 'airwallex_transfer',
      expiresAt: new Date(ctx.clock.now().getTime() + 3_600_000).toISOString(),
    });
    expect(second.id).toBe(first.id); // same approval, not a second authority
    const otherApprover = ctx.ledger.authority.createHumanActor({
      orgId: ctx.org.id,
      username: 'approver2',
      displayName: 'A2',
      role: 'approver',
      password: TEST_PASSWORD,
    });
    expect(() =>
      ctx.ledger.approvals.record({
        orgId: ctx.org.id,
        plan,
        decidedByActorId: otherApprover.id,
        kind: 'airwallex_transfer',
        expiresAt: new Date(ctx.clock.now().getTime() + 3_600_000).toISOString(),
      }),
    ).toThrowError(LedgerError);
    ctx.ledger.close();
  });

  it('approvals can be revoked before use and then never authorize', () => {
    const ctx = sodWorld();
    const plan = ctx.ledger.plans.recordVersion({
      orgId: ctx.org.id,
      missionId: ctx.mission.id,
      terms: { amountMinor: 5_000, currency: 'USD', beneficiary: 'b', purpose: 'p' },
      proposedBy: ctx.operator.id,
    });
    const approval = ctx.ledger.approvals.record({
      orgId: ctx.org.id,
      plan,
      decidedByActorId: ctx.approver.id,
      kind: 'airwallex_transfer',
      expiresAt: new Date(ctx.clock.now().getTime() + 3_600_000).toISOString(),
    });
    const revoked = ctx.ledger.approvals.revoke(
      ctx.org.id,
      approval.id,
      ctx.approver.id,
      'operator changed mind',
    );
    expect(revoked.status).toBe('revoked');
    try {
      reserveCall(
        ctx.ledger,
        { org: ctx.org },
        ctx.mission.id,
        {
          planId: plan.id,
          planVersion: plan.version,
          approvalId: approval.id,
        },
        'revoked-approval',
      );
      expect.unreachable('revoked approval must not authorize');
    } catch (error) {
      expect((error as LedgerError).code).toBe('APPROVAL_REVOKED');
    }
    ctx.ledger.close();
  });
});

describe('mission grants for machine actors', () => {
  it('service actors operate only with an explicit per-mission grant', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('GrantOrg');
    const mission = ledger.organizations.createMission(org.id, 'm');
    const admin = ledger.authority.createHumanActor({
      orgId: org.id,
      username: 'adm',
      displayName: 'A',
      role: 'admin',
      password: TEST_PASSWORD,
    });
    const service = ledger.authority.createServiceActor({
      orgId: org.id,
      username: 'svc-bot',
      displayName: 'Bot',
    });
    expect(ledger.authority.hasMissionGrant(org.id, mission.id, service.id)).toBe(false);
    const grant = ledger.authority.grantMissionAccess({
      orgId: org.id,
      missionId: mission.id,
      actorId: service.id,
      byActorId: admin.id,
    });
    expect(grant.actorId).toBe(service.id);
    expect(ledger.authority.hasMissionGrant(org.id, mission.id, service.id)).toBe(true);
    expect(ledger.authority.revokeMissionAccess(org.id, mission.id, service.id, admin.id)).toBe(
      true,
    );
    expect(ledger.authority.hasMissionGrant(org.id, mission.id, service.id)).toBe(false);
    // Grants are for machine actors only.
    expect(() =>
      ledger.authority.grantMissionAccess({
        orgId: org.id,
        missionId: mission.id,
        actorId: admin.id,
        byActorId: admin.id,
      }),
    ).toThrowError(/machine/);
    void clock;
    ledger.close();
  });
});

describe('denial audit trail', () => {
  it('material denials are journaled with machine-readable codes even though the reservation rolled back', () => {
    const { ledger, clock } = makeLedger();
    const org = ledger.organizations.createOrganization('AuditOrg');
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
      observedAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const mandate = ledger.mandates.issue({
      orgId: org.id,
      missionId: mission.id,
      currency: 'USD',
      maxAmountMinor: 5_000,
      permittedOperationKinds: ['airwallex_transfer'],
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const ref = approvedPlan(ledger, org.id, mission.id, { amountMinor: 1_000, currency: 'USD' });
    ledger.mandates.revoke(org.id, mission.id, mandate.id, approver.id, 'test revocation');
    try {
      reserveCall(ledger, { org }, mission.id, ref, 'audit-denied');
      expect.unreachable();
    } catch {
      // expected
    }
    const denials = ledger.evidence
      .list(org.id, { topic: 'financial' })
      .filter((e) => e.type === 'reservation.denied');
    expect(denials.length).toBe(1);
    ledger.close();
  });
});
