/**
 * Identity edge-case gaps (MTV-19): the membership-matrix cases not covered
 * by the other suites — same email across different provider subjects,
 * subject collisions across organizations, email change at link time,
 * concurrent logins for one identity, and service-actor login refusal.
 * Service-level for determinism; the HTTP surface is covered elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLedger, TunableClock, type Ledger } from '@moterva/ledger';
import { TEST_PASSWORD, tempDbPath } from '../../../../packages/ledger/test/helpers.js';
import type { ActorView } from '@moterva/domain';

const ISSUER = 'https://idp.test.example';
const clock = new TunableClock('2026-11-08T12:00:00.000Z');
let ledger: Ledger;
let orgA: string;
let orgB: string;
let ownerA: ActorView;
let ownerB: ActorView;

beforeAll(() => {
  ledger = openLedger(tempDbPath('identity-edge-'), clock);
  ledger.migrate();
  orgA = ledger.organizations.createOrganization('EdgeOrgA').id;
  orgB = ledger.organizations.createOrganization('EdgeOrgB').id;
  ownerA = ledger.authority.createHumanActor({
    orgId: orgA,
    username: 'owner-a',
    displayName: 'A',
    role: 'owner',
    password: TEST_PASSWORD,
  });
  ownerB = ledger.authority.createHumanActor({
    orgId: orgB,
    username: 'owner-b',
    displayName: 'B',
    role: 'owner',
    password: TEST_PASSWORD,
  });
});

afterAll(() => ledger.close());

describe('email/subject identity collisions', () => {
  it('SAME email attached to DIFFERENT provider subjects: each is its own member', () => {
    const { invitation: invA, secret: secretA } = ledger.identity.createInvitation({
      orgId: orgA,
      role: 'viewer',
      email: 'twin@example.com',
      createdByActorId: ownerA.id,
    });
    const a = ledger.identity.redeemInvitation({
      orgId: orgA,
      invitationId: invA.id,
      secret: secretA,
      provider: ISSUER,
      subject: 'twin-sub-A',
      emailAtLink: 'twin@example.com',
    });
    const { invitation: invB, secret: secretB } = ledger.identity.createInvitation({
      orgId: orgB,
      role: 'viewer',
      email: 'twin@example.com',
      createdByActorId: ownerB.id,
    });
    const b = ledger.identity.redeemInvitation({
      orgId: orgB,
      invitationId: invB.id,
      secret: secretB,
      provider: ISSUER,
      subject: 'twin-sub-B',
      emailAtLink: 'twin@example.com',
    });
    expect(a.actor.id).not.toBe(b.actor.id);
    expect(ledger.identity.findActorIdByIdentity(orgA, ISSUER, 'twin-sub-A')).toBe(a.actor.id);
    expect(ledger.identity.findActorIdByIdentity(orgB, ISSUER, 'twin-sub-B')).toBe(b.actor.id);
    // subject-A cannot pass org B's lookup and vice versa
    expect(ledger.identity.findActorIdByIdentity(orgB, ISSUER, 'twin-sub-A')).toBeNull();
    expect(ledger.identity.findActorIdByIdentity(orgA, ISSUER, 'twin-sub-B')).toBeNull();
  });

  it('SAME subject across two organizations is a legitimate multi-org identity', () => {
    const { invitation: invA, secret: secretA } = ledger.identity.createInvitation({
      orgId: orgA,
      role: 'operator',
      email: 'multi@example.com',
      createdByActorId: ownerA.id,
    });
    const a = ledger.identity.redeemInvitation({
      orgId: orgA,
      invitationId: invA.id,
      secret: secretA,
      provider: ISSUER,
      subject: 'multi-sub',
    });
    const { invitation: invB, secret: secretB } = ledger.identity.createInvitation({
      orgId: orgB,
      role: 'operator',
      email: 'multi-b@example.com',
      createdByActorId: ownerB.id,
    });
    const b = ledger.identity.redeemInvitation({
      orgId: orgB,
      invitationId: invB.id,
      secret: secretB,
      provider: ISSUER,
      subject: 'multi-sub',
    });
    expect(a.actor.id).not.toBe(b.actor.id); // different actors per org
    expect(ledger.identity.findOrgIdsByIdentity(ISSUER, 'multi-sub').sort()).toEqual(
      [orgA, orgB].sort(),
    );
  });

  it('email CHANGE at link time: the IdP email is recorded, never an authority input', () => {
    const { invitation, secret } = ledger.identity.createInvitation({
      orgId: orgA,
      role: 'viewer',
      email: 'original@example.com',
      createdByActorId: ownerA.id,
    });
    const { actor } = ledger.identity.redeemInvitation({
      orgId: orgA,
      invitationId: invitation.id,
      secret,
      provider: ISSUER,
      subject: 'changed-sub',
      emailAtLink: 'renamed@example.com', // IdP says something different from the invited email
    });
    const link = ledger.identity.listIdentityLinks(orgA).find((l) => l.subject === 'changed-sub');
    expect(link?.emailAtLink).toBe('renamed@example.com'); // recorded for humans
    // Authorization still resolves by subject, not by either email:
    expect(ledger.identity.findActorIdByIdentity(orgA, ISSUER, 'changed-sub')).not.toBeNull();
  });
});

describe('session/actor collisions', () => {
  it('CONCURRENT logins for one identity: each session independent; revocation kills all', () => {
    const { invitation, secret } = ledger.identity.createInvitation({
      orgId: orgA,
      role: 'viewer',
      email: 'concurrent@example.com',
      createdByActorId: ownerA.id,
    });
    const { actor } = ledger.identity.redeemInvitation({
      orgId: orgA,
      invitationId: invitation.id,
      secret,
      provider: ISSUER,
      subject: 'concurrent-sub',
    });
    const s1 = ledger.authority.createSession(actor.id);
    const s2 = ledger.authority.createSession(actor.id);
    expect(s1.session.sessionId).not.toBe(s2.session.sessionId);
    expect(ledger.authority.resolveSession(s1.token)).not.toBeNull();
    expect(ledger.authority.resolveSession(s2.token)).not.toBeNull();
    // Revoking the ACTOR invalidates every live session at once.
    ledger.authority.revokeActor(orgA, actor.id, ownerA.id);
    expect(ledger.authority.resolveSession(s1.token)).toBeNull();
    expect(ledger.authority.resolveSession(s2.token)).toBeNull();
  });

  it('SERVICE actor attempts human login: no credential path; machine sessions stay authority-limited', () => {
    const svc = ledger.authority.createServiceActor({
      orgId: orgA,
      username: 'svc-edge',
      displayName: 'S',
    });
    // Human login is the credential path — service actors have NO password.
    expect(
      ledger.authority.verifyCredential({ username: 'svc-edge', password: TEST_PASSWORD }),
    ).toBeNull();
    // A machine session (how service integrations authenticate) can
    // propose/read but can NEVER approve or manage authority.
    const machine = ledger.authority.createSession(svc.id);
    expect(machine.session.actor.role).toBe('service');
    expect(ledger.authority.requireRole(machine.session.actor, 'approve').outcome).toBe('DENIED');
    expect(ledger.authority.requireRole(machine.session.actor, 'manageAuthority').outcome).toBe(
      'DENIED',
    );
    expect(ledger.authority.requireRole(machine.session.actor, 'propose').outcome).toBe(
      'AUTHORIZED',
    );
  });

  it('wrong organization and mission identifiers stay 404-indistinguishable at the service layer', () => {
    expect(ledger.identity.findActorIdByIdentity(orgB, ISSUER, 'concurrent-sub')).toBeNull();
    expect(() =>
      ledger.authority.getActor(
        orgB,
        ledger.identity.findActorIdByIdentity(orgA, ISSUER, 'concurrent-sub')!,
      ),
    ).toThrow(/not found in organization/);
    expect(() => ledger.organizations.getMission(orgB, 'msn_missing')).toThrow(
      /not found in organization/,
    );
  });
});
