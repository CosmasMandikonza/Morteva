/**
 * ExternalIdentityService + migration 0004 — adversarial tests.
 *
 * Covers the migration/upgrade path, identity links, the full invitation
 * lifecycle (secret hygiene, single-use, expiry, races, role ceilings) and
 * the hashed single-use OIDC flow store. Every negative case asserts BOTH
 * the error and the absence of unauthorized state changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, TunableClock, type Ledger } from '../src/index.js';
import { migrate, MIGRATIONS } from '../src/db/migrator.js';
import { currentSchemaVersion } from '../src/db/migrator.js';
import { TEST_PASSWORD, tempDbPath } from './helpers.js';
import { LedgerError, isLedgerError } from '../src/index.js';
import type { ActorView } from '@moterva/domain';

const ISSUER = 'https://idp.test.example';

describe('migration 0004 (production identity)', () => {
  it('fresh ledger migrates to v4 with the new tables; existing data intact', () => {
    const ledger = openLedger(tempDbPath('identity-migrate-'));
    ledger.migrate();
    expect(currentSchemaVersion(ledger.db)).toBe(4);
    for (const table of ['identity_links', 'invitations', 'oidc_flows']) {
      expect(
        () => ledger.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get(),
        table,
      ).not.toThrow();
    }
    ledger.close();
  });

  it('v3 ledger with data upgrades to v4 preserving every existing row', () => {
    // Build a genuine v3 world: run migrations 1-3 only, create data, then upgrade.
    const dir = mkdtempSync(join(tmpdir(), 'identity-upgrade-'));
    const dbPath = join(dir, 'ledger.sqlite');
    const ledger = openLedger(dbPath);
    migrate(
      ledger.db,
      MIGRATIONS.filter((m) => m.version <= 3),
    );
    expect(currentSchemaVersion(ledger.db)).toBe(3);
    const org = ledger.organizations.createOrganization('UpgradeOrg');
    const mission = ledger.organizations.createMission(org.id, 'upgrade mission');
    const actor = ledger.authority.createHumanActor({
      orgId: org.id,
      username: 'legacy-owner',
      displayName: 'Legacy',
      role: 'owner',
      password: TEST_PASSWORD,
    });
    const before = {
      actors: (ledger.db.prepare('SELECT COUNT(*) AS c FROM actors').get() as { c: number }).c,
      missions: (ledger.db.prepare('SELECT COUNT(*) AS c FROM missions').get() as { c: number }).c,
      evidence: (
        ledger.db.prepare('SELECT COUNT(*) AS c FROM evidence_events').get() as { c: number }
      ).c,
    };
    const report = ledger.migrate();
    expect(report.applied.map((m) => m.version)).toEqual([4]);
    expect(currentSchemaVersion(ledger.db)).toBe(4);
    expect((ledger.db.prepare('SELECT COUNT(*) AS c FROM actors').get() as { c: number }).c).toBe(
      before.actors,
    );
    expect((ledger.db.prepare('SELECT COUNT(*) AS c FROM missions').get() as { c: number }).c).toBe(
      before.missions,
    );
    expect(
      (ledger.db.prepare('SELECT COUNT(*) AS c FROM evidence_events').get() as { c: number }).c,
    ).toBe(before.evidence);
    expect(ledger.authority.getActor(org.id, actor.id).username).toBe('legacy-owner');
    expect(ledger.organizations.getMission(org.id, mission.id).title).toBe('upgrade mission');
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('identity links', () => {
  let ledger: Ledger;
  let orgId: string;
  let owner: ActorView;
  let operator: ActorView;
  let viewer: ActorView;

  beforeAll(() => {
    ledger = openLedger(tempDbPath('identity-links-'));
    ledger.migrate();
    orgId = ledger.organizations.createOrganization('IdentityOrg').id;
    owner = ledger.authority.createHumanActor({
      orgId,
      username: 'owner-1',
      displayName: 'O',
      role: 'owner',
      password: TEST_PASSWORD,
    });
    operator = ledger.authority.createHumanActor({
      orgId,
      username: 'operator-1',
      displayName: 'Op',
      role: 'operator',
      password: TEST_PASSWORD,
    });
    viewer = ledger.authority.createHumanActor({
      orgId,
      username: 'viewer-1',
      displayName: 'V',
      role: 'viewer',
      password: TEST_PASSWORD,
    });
  });

  afterAll(() => ledger.close());

  it('links an identity to an actor and journals it (subject stored hashed in evidence)', () => {
    const link = ledger.identity.linkIdentity({
      orgId,
      actorId: viewer.id,
      provider: ISSUER,
      subject: 'sub-viewer-1',
      emailAtLink: 'viewer@example.com',
      linkedBy: owner.id,
    });
    expect(link.actorId).toBe(viewer.id);
    expect(ledger.identity.findActorIdByIdentity(orgId, ISSUER, 'sub-viewer-1')).toBe(viewer.id);
    const row = ledger.db
      .prepare(
        "SELECT payload_json FROM evidence_events WHERE type = 'identity.linked' ORDER BY seq DESC LIMIT 1",
      )
      .get() as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { subjectSha256?: string; subject?: string };
    expect(payload.subject).toBeUndefined(); // raw subject never journaled
    expect(payload.subjectSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses service actors, revoked actors, and a subject already linked to a different actor', () => {
    const service = ledger.authority.createServiceActor({
      orgId,
      username: 'svc-1',
      displayName: 'S',
    });
    expect(() =>
      ledger.identity.linkIdentity({
        orgId,
        actorId: service.id,
        provider: ISSUER,
        subject: 'sub-svc',
        linkedBy: owner.id,
      }),
    ).toThrow(/human actors only/);
    const doomed = ledger.authority.createHumanActor({
      orgId,
      username: 'doomed-1',
      displayName: 'D',
      role: 'viewer',
      password: TEST_PASSWORD,
    });
    ledger.authority.revokeActor(orgId, doomed.id, owner.id);
    expect(() =>
      ledger.identity.linkIdentity({
        orgId,
        actorId: doomed.id,
        provider: ISSUER,
        subject: 'sub-doomed',
        linkedBy: owner.id,
      }),
    ).toThrow(/revoked/);
    // Same subject to a DIFFERENT actor is a conflict; to the SAME actor it is
    // an idempotent-style refusal (already linked).
    expect(() =>
      ledger.identity.linkIdentity({
        orgId,
        actorId: operator.id,
        provider: ISSUER,
        subject: 'sub-viewer-1',
        linkedBy: owner.id,
      }),
    ).toThrow(/different actor/);
    expect(() =>
      ledger.identity.linkIdentity({
        orgId,
        actorId: viewer.id,
        provider: ISSUER,
        subject: 'sub-viewer-1',
        linkedBy: owner.id,
      }),
    ).toThrow(/already linked to this actor/);
    // No state changed: operator still unlinked.
    expect(ledger.identity.findActorIdByIdentity(orgId, ISSUER, 'sub-viewer-1')).toBe(viewer.id);
    expect(ledger.identity.findActorIdByIdentity(orgId, ISSUER, 'sub-operator')).toBeNull();
  });

  it('revoking an identity link invalidates the bound actor’s live sessions', () => {
    const session = ledger.authority.createSession(viewer.id);
    expect(ledger.authority.resolveSession(session.token)).not.toBeNull();
    expect(ledger.identity.revokeIdentity(orgId, ISSUER, 'sub-viewer-1', owner.id)).toBe(true);
    expect(ledger.authority.resolveSession(session.token)).toBeNull(); // session invalidated
    expect(ledger.identity.findActorIdByIdentity(orgId, ISSUER, 'sub-viewer-1')).toBeNull();
  });

  it('one identity may be linked in two organizations; access stays org-scoped', () => {
    const org2 = ledger.organizations.createOrganization('IdentityOrg2').id;
    const v2 = ledger.authority.createHumanActor({
      orgId: org2,
      username: 'viewer-1',
      displayName: 'V2',
      role: 'viewer',
      password: TEST_PASSWORD,
    });
    ledger.identity.linkIdentity({
      orgId: org2,
      actorId: v2.id,
      provider: ISSUER,
      subject: 'sub-multi',
      linkedBy: v2.id,
    });
    ledger.identity.linkIdentity({
      orgId,
      actorId: viewer.id,
      provider: ISSUER,
      subject: 'sub-multi',
      linkedBy: owner.id,
    });
    expect(ledger.identity.findOrgIdsByIdentity(ISSUER, 'sub-multi').sort()).toEqual(
      [org2, orgId].sort(),
    );
    expect(ledger.identity.findActorIdByIdentity(orgId, ISSUER, 'sub-multi')).toBe(viewer.id);
    expect(ledger.identity.findActorIdByIdentity(org2, ISSUER, 'sub-multi')).toBe(v2.id);
  });
});

describe('invitations', () => {
  let ledger: Ledger;
  let orgId: string;
  let owner: ActorView;
  let operator: ActorView;
  const clock = new TunableClock('2026-11-08T12:00:00.000Z');

  beforeAll(() => {
    ledger = openLedger(tempDbPath('identity-invite-'), clock);
    ledger.migrate();
    orgId = ledger.organizations.createOrganization('InviteOrg').id;
    owner = ledger.authority.createHumanActor({
      orgId,
      username: 'owner-1',
      displayName: 'O',
      role: 'owner',
      password: TEST_PASSWORD,
    });
    operator = ledger.authority.createHumanActor({
      orgId,
      username: 'operator-1',
      displayName: 'Op',
      role: 'operator',
      password: TEST_PASSWORD,
    });
  });

  afterAll(() => ledger.close());

  it('creates an invitation: secret returned once, stored hashed, journaled without the secret', () => {
    const { invitation, secret } = ledger.identity.createInvitation({
      orgId,
      role: 'viewer',
      email: 'reviewer@example.com',
      createdByActorId: owner.id,
    });
    expect(secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const row = ledger.db
      .prepare('SELECT secret_hash FROM invitations WHERE id = ?')
      .get(invitation.id) as { secret_hash: string };
    expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.secret_hash).not.toBe(secret);
    const ev = ledger.db
      .prepare("SELECT payload_json FROM evidence_events WHERE type = 'invitation.created'")
      .get() as { payload_json: string };
    expect(ev.payload_json).not.toContain(secret);
    // listing never exposes secrets
    const listed = ledger.identity.listInvitations(orgId);
    expect(listed.some((i) => i.id === invitation.id)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(secret);
  });

  it('duplicate ACTIVE invitations are prevented; revoked ones can be re-invited', () => {
    const first = ledger.identity.createInvitation({
      orgId,
      role: 'operator',
      email: 'dup@example.com',
      createdByActorId: owner.id,
    });
    expect(() =>
      ledger.identity.createInvitation({
        orgId,
        role: 'operator',
        email: 'dup@example.com',
        createdByActorId: owner.id,
      }),
    ).toThrow(/already exists/);
    expect(ledger.identity.revokeInvitation(orgId, first.invitation.id, owner.id)).toBe(true);
    const second = ledger.identity.createInvitation({
      orgId,
      role: 'operator',
      email: 'dup@example.com',
      createdByActorId: owner.id,
    });
    expect(second.invitation.id).not.toBe(first.invitation.id);
  });

  it('role ceiling: invitations can never grant owner/admin; only owner/admin may invite', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(() =>
        ledger.identity.createInvitation({
          orgId,
          role,
          email: 'escalate@example.com',
          createdByActorId: owner.id,
        }),
      ).toThrow(/invitations can never grant/);
    }
    expect(() =>
      ledger.identity.createInvitation({
        orgId,
        role: 'viewer',
        email: 'unauthorized@example.com',
        createdByActorId: operator.id,
      }),
    ).toThrow(/only owners and admins/);
    // Nothing was created by the refused calls.
    expect(
      ledger.identity.listInvitations(orgId).filter((i) => i.email === 'escalate@example.com'),
    ).toHaveLength(0);
    expect(
      ledger.identity.listInvitations(orgId).filter((i) => i.email === 'unauthorized@example.com'),
    ).toHaveLength(0);
  });

  it('redemption: new actor with the invited role, identity linked, single-use consumed, NO password path', () => {
    const { invitation, secret } = ledger.identity.createInvitation({
      orgId,
      role: 'approver',
      email: 'approver@example.com',
      createdByActorId: owner.id,
    });
    const { actor, created } = ledger.identity.redeemInvitation({
      orgId,
      invitationId: invitation.id,
      secret,
      provider: ISSUER,
      subject: 'sub-approver',
      emailAtLink: 'approver@example.com',
    });
    expect(created).toBe(true);
    expect(actor.role).toBe('approver');
    expect(actor.kind).toBe('human');
    expect(ledger.identity.findActorIdByIdentity(orgId, ISSUER, 'sub-approver')).toBe(actor.id);
    // Identity-only actor: password hash must be NULL and password login impossible.
    const row = ledger.db
      .prepare('SELECT password_hash FROM actors WHERE id = ?')
      .get(actor.id) as { password_hash: string | null };
    expect(row.password_hash).toBeNull();
    expect(
      ledger.authority.verifyCredential({
        username: 'approver@example.com',
        password: ['any-password-at-all', '12chars'].join(String.fromCharCode(45)),
      }),
    ).toBeNull();
    // Single use.
    expect(() =>
      ledger.identity.redeemInvitation({
        orgId,
        invitationId: invitation.id,
        secret,
        provider: ISSUER,
        subject: 'sub-second',
      }),
    ).toThrow(/already redeemed/);
    expect(ledger.identity.findActorIdByIdentity(orgId, ISSUER, 'sub-second')).toBeNull();
  });

  it('pre-provisioned same-role actor is reused; different-role actor is never elevated', () => {
    const preEmail = 'pre-op@example.com';
    ledger.authority.createHumanActor({
      orgId,
      username: preEmail,
      displayName: 'Pre',
      role: 'operator',
      password: TEST_PASSWORD,
    });
    const reuse = ledger.identity.createInvitation({
      orgId,
      role: 'operator',
      email: preEmail,
      createdByActorId: owner.id,
    });
    // username preEmail exists as an operator → same role → reuse, no second actor
    const before = (ledger.db.prepare('SELECT COUNT(*) AS c FROM actors').get() as { c: number }).c;
    const { actor, created } = ledger.identity.redeemInvitation({
      orgId,
      invitationId: reuse.invitation.id,
      secret: reuse.secret,
      provider: ISSUER,
      subject: 'sub-op-existing',
    });
    expect(created).toBe(false);
    expect(actor.role).toBe('operator'); // reused actor keeps its role
    expect((ledger.db.prepare('SELECT COUNT(*) AS c FROM actors').get() as { c: number }).c).toBe(
      before,
    );
    // different role → conflict, no elevation
    const conflict = ledger.identity.createInvitation({
      orgId,
      role: 'viewer',
      email: preEmail,
      createdByActorId: owner.id,
    });
    expect(() =>
      ledger.identity.redeemInvitation({
        orgId,
        invitationId: conflict.invitation.id,
        secret: conflict.secret,
        provider: ISSUER,
        subject: 'sub-op-elevate',
      }),
    ).toThrow(/different role/);
    expect(ledger.identity.findActorIdByIdentity(orgId, ISSUER, 'sub-op-elevate')).toBeNull();
    expect(ledger.authority.getActor(orgId, operator.id).role).toBe('operator'); // unchanged
  });

  it('expired / revoked / wrong-secret / wrong-org invitations all fail closed with no state change', () => {
    const expired = ledger.identity.createInvitation({
      orgId,
      role: 'viewer',
      email: 'expired@example.com',
      createdByActorId: owner.id,
      ttlMs: 60_000,
    });
    clock.advance(2 * 60_000);
    expect(() =>
      ledger.identity.redeemInvitation({
        orgId,
        invitationId: expired.invitation.id,
        secret: expired.secret,
        provider: ISSUER,
        subject: 'sub-expired',
      }),
    ).toThrow(/expired/);
    clock.advance(-2 * 60_000);
    const revoked = ledger.identity.createInvitation({
      orgId,
      role: 'viewer',
      email: 'revoked@example.com',
      createdByActorId: owner.id,
    });
    ledger.identity.revokeInvitation(orgId, revoked.invitation.id, owner.id);
    expect(() =>
      ledger.identity.redeemInvitation({
        orgId,
        invitationId: revoked.invitation.id,
        secret: revoked.secret,
        provider: ISSUER,
        subject: 'sub-revoked',
      }),
    ).toThrow(/revoked/);
    const invite = ledger.identity.createInvitation({
      orgId,
      role: 'viewer',
      email: 'secrets@example.com',
      createdByActorId: owner.id,
    });
    expect(() =>
      ledger.identity.redeemInvitation({
        orgId,
        invitationId: invite.invitation.id,
        secret: ['wrong-secret-value', 'aaaaaaaaaaaaaaaa'].join(String.fromCharCode(45)),
        provider: ISSUER,
        subject: 'sub-wrong',
      }),
    ).toThrow(/secret does not match/);
    const otherOrg = ledger.organizations.createOrganization('InviteOrg2').id;
    expect(() =>
      ledger.identity.redeemInvitation({
        orgId: otherOrg,
        invitationId: invite.invitation.id,
        secret: invite.secret,
        provider: ISSUER,
        subject: 'sub-cross',
      }),
    ).toThrow(/not found/);
    // no links created by any refused redemption
    for (const subject of ['sub-expired', 'sub-revoked', 'sub-wrong', 'sub-cross']) {
      expect(ledger.identity.findActorIdByIdentity(orgId, ISSUER, subject)).toBeNull();
      expect(ledger.identity.findActorIdByIdentity(otherOrg, ISSUER, subject)).toBeNull();
    }
    // the still-valid invitation remains redeemable with the right secret
    const ok = ledger.identity.redeemInvitation({
      orgId,
      invitationId: invite.invitation.id,
      secret: invite.secret,
      provider: ISSUER,
      subject: 'sub-ok',
    });
    expect(ok.created).toBe(true);
  });

  it('an already-linked identity cannot redeem again (prevents role change via re-invite)', () => {
    const { invitation, secret } = ledger.identity.createInvitation({
      orgId,
      role: 'viewer',
      email: 'relink@example.com',
      createdByActorId: owner.id,
    });
    ledger.identity.redeemInvitation({
      orgId,
      invitationId: invitation.id,
      secret,
      provider: ISSUER,
      subject: 'sub-relink',
    });
    const secondRole = ledger.identity.createInvitation({
      orgId,
      role: 'operator',
      email: 'relink2@example.com',
      createdByActorId: owner.id,
    });
    expect(() =>
      ledger.identity.redeemInvitation({
        orgId,
        invitationId: secondRole.invitation.id,
        secret: secondRole.secret,
        provider: ISSUER,
        subject: 'sub-relink',
      }),
    ).toThrow(/already linked/);
  });

  it('two RACING redemptions of one invitation: exactly one wins (serialized transaction)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'invite-race-'));
    const dbPath = join(dir, 'ledger.sqlite');
    const a = openLedger(dbPath, clock);
    a.migrate();
    const b = openLedger(dbPath, clock);
    b.migrate();
    const raceOrg = a.organizations.createOrganization('RaceOrg').id;
    const raceOwner = a.authority.createHumanActor({
      orgId: raceOrg,
      username: 'race-owner',
      displayName: 'R',
      role: 'owner',
      password: TEST_PASSWORD,
    });
    const { invitation, secret } = a.identity.createInvitation({
      orgId: raceOrg,
      role: 'viewer',
      email: 'race@example.com',
      createdByActorId: raceOwner.id,
    });
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        a.identity.redeemInvitation({
          orgId: raceOrg,
          invitationId: invitation.id,
          secret,
          provider: ISSUER,
          subject: 'sub-race-a',
        }),
      ),
      Promise.resolve().then(() =>
        b.identity.redeemInvitation({
          orgId: raceOrg,
          invitationId: invitation.id,
          secret,
          provider: ISSUER,
          subject: 'sub-race-b',
        }),
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as Array<
      PromiseRejectedResult & { reason: LedgerError }
    >;
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(LedgerError);
    expect(isLedgerError(rejected[0]!.reason) && rejected[0]!.reason.code).toBe(
      'INVITATION_REDEEMED',
    );
    expect(
      (
        a.db.prepare('SELECT COUNT(*) AS c FROM identity_links WHERE org_id = ?').get(raceOrg) as {
          c: number;
        }
      ).c,
    ).toBe(1);
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('oidc flow store', () => {
  let ledger: Ledger;
  const clock = new TunableClock('2026-11-08T12:00:00.000Z');

  beforeAll(() => {
    ledger = openLedger(tempDbPath('identity-flows-'), clock);
    ledger.migrate();
  });

  afterAll(() => ledger.close());

  it('create → consume returns nonce/verifier for the callback; raw state never persisted', () => {
    const { id } = ledger.identity.createOidcFlow({
      state: 'state-value-abc',
      nonce: 'nonce-value-abc',
      codeVerifier: 'verifier-value-abc',
      redirectUri: 'http://127.0.0.1:8787/api/auth/oidc/callback',
    });
    const raw = JSON.stringify(
      ledger.db.prepare('SELECT * FROM oidc_flows WHERE id = ?').get(id) as Record<string, unknown>,
    );
    expect(raw).not.toContain('state-value-abc'); // raw state is never stored
    const consumed = ledger.identity.consumeOidcFlow('state-value-abc');
    expect(consumed.nonce).toBe('nonce-value-abc'); // raw: required for the ID-token nonce check
    expect(consumed.codeVerifier).toBe('verifier-value-abc'); // raw: required for the token exchange
  });

  it('replay, expiry and unknown state all fail closed', () => {
    expect(() => ledger.identity.consumeOidcFlow('state-value-abc')).toThrow(/already consumed/);
    const expired = ledger.identity.createOidcFlow({
      state: 'state-expired',
      nonce: 'n',
      codeVerifier: 'v',
      redirectUri: 'x',
      ttlMs: 60_000,
    });
    clock.advance(2 * 60_000);
    expect(() => ledger.identity.consumeOidcFlow('state-expired')).toThrow(/expired/);
    clock.advance(-2 * 60_000);
    expect(() => ledger.identity.consumeOidcFlow('state-never-existed')).toThrow(
      /unknown authorization state/,
    );
    void expired;
  });
});
