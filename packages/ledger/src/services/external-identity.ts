/**
 * ExternalIdentityService — production-identity trust layer (MTV-19).
 *
 * Persists (identity provider, subject) → actor bindings and the invitation
 * lifecycle. THE AUTHORITY MODEL DOES NOT CHANGE: an identity link points at
 * a regular actor whose role was chosen by an authorized owner/admin
 * (provisioning) or fixed by the invitation allowlist (approver/operator/
 * viewer — owner/admin are schema-refused in invitations). An IdP claim never
 * creates or elevates authority; an email address is recorded for humans and
 * is never an authorization input.
 *
 * Secrets: invitation secrets are returned exactly once by createInvitation
 * and stored only as sha256 digests. Every state change journals to the
 * append-only evidence journal (subjects stored hashed in payloads).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { LedgerDatabase } from '../db/port.js';
import { nullableText, text } from '../db/port.js';
import { LedgerError } from '../errors.js';
import type { Clock } from '../clock.js';
import { newId } from './identity.js';
import type { EvidenceService } from './evidence.js';
import type { OrganizationService } from './organizations.js';
import type { ActorRole, ActorView, IdentityLinkView, InvitationView } from '@moterva/domain';
import { isActorRole } from '@moterva/domain';

/** Roles an invitation may ever grant — deliberately excludes owner/admin. */
export const INVITABLE_ROLES: readonly ActorRole[] = ['approver', 'operator', 'viewer'];

export const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 3_600_000;
export const MAX_INVITATION_TTL_MS = 30 * 24 * 3_600_000;
export const DEFAULT_OIDC_FLOW_TTL_MS = 10 * 60_000;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export class ExternalIdentityService {
  constructor(
    private readonly db: LedgerDatabase,
    private readonly clock: Clock,
    private readonly orgs: OrganizationService,
    private readonly evidence: EvidenceService,
  ) {}

  // ------------------------------------------------------------- oidc flows

  /**
   * Creates a single-use authorization-code flow record. State, nonce and
   * is stored ONLY as a sha256 digest (the raw state never touches the DB);
   * nonce and PKCE verifier are stored raw because the OIDC protocol requires
   * them at the callback, protected by single-use consumption and a short TTL. `invitationId` may reference a PRE-VERIFIED
   * invitation (secret already checked over HTTP before the redirect); only
   * its id is carried — the secret is never persisted again.
   */
  createOidcFlow(input: {
    state: string;
    nonce: string;
    codeVerifier: string;
    redirectUri: string;
    orgId?: string | null;
    invitationId?: string | null;
    ttlMs?: number;
  }): { id: string; expiresAt: string } {
    const now = this.clock.now();
    const ttl = input.ttlMs ?? DEFAULT_OIDC_FLOW_TTL_MS;
    const id = newId('flow');
    const expiresAt = new Date(now.getTime() + ttl).toISOString();
    this.db
      .prepare(
        `INSERT INTO oidc_flows (id, state_hash, nonce, code_verifier, redirect_uri, org_id, invitation_id, invitation_preverified, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sha256(input.state),
        input.nonce,
        input.codeVerifier,
        input.redirectUri,
        input.orgId ?? null,
        input.invitationId ?? null,
        input.invitationId === null || input.invitationId === undefined ? 0 : 1,
        now.toISOString(),
        expiresAt,
      );
    return { id, expiresAt };
  }

  /**
   * Consumes a flow by state. Single-use and expiry-checked: the first
   * consume wins, any later presentation of the same state fails (callback
   * replay). Returns the raw nonce and PKCE verifier the callback needs for
   * the ID-token nonce check and the token exchange.
   */
  consumeOidcFlow(state: string): {
    id: string;
    nonce: string;
    codeVerifier: string;
    redirectUri: string;
    orgId: string | null;
    invitationId: string | null;
  } {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM oidc_flows WHERE state_hash = ?')
        .get(sha256(state)) as Record<string, unknown> | undefined;
      if (row === undefined)
        throw new LedgerError('OIDC_STATE_INVALID', 'unknown authorization state');
      if (row.consumed_at !== null) {
        throw new LedgerError('OIDC_STATE_REPLAYED', 'authorization state was already consumed');
      }
      if (new Date(text(row.expires_at, 'expires_at')) <= this.clock.now()) {
        throw new LedgerError('OIDC_STATE_EXPIRED', 'authorization state has expired');
      }
      const updated = this.db
        .prepare('UPDATE oidc_flows SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
        .run(this.clock.iso(), text(row.id, 'id'));
      if (updated.changes !== 1) {
        throw new LedgerError('OIDC_STATE_REPLAYED', 'authorization state was already consumed');
      }
      return {
        id: text(row.id, 'id'),
        nonce: text(row.nonce, 'nonce'),
        codeVerifier: text(row.code_verifier, 'code_verifier'),
        redirectUri: text(row.redirect_uri, 'redirect_uri'),
        orgId: nullableText(row.org_id),
        invitationId: nullableText(row.invitation_id),
      };
    }, 'immediate');
  }

  // ---------------------------------------------------------- identity links

  /**
   * Binds (provider, subject) to an actor within one organization. The actor
   * must already exist (provisioning or invitation redemption — this call
   * never creates authority). Rejects service actors, revoked actors and a
   * subject already linked to a DIFFERENT actor in the same org.
   */
  linkIdentity(input: {
    orgId: string;
    actorId: string;
    provider: string;
    subject: string;
    emailAtLink?: string | null;
    linkedBy: string;
  }): IdentityLinkView {
    this.orgs.requireOrganization(input.orgId);
    if (input.provider === '' || input.subject === '') {
      throw new LedgerError('INVALID_INPUT', 'identity provider and subject are required');
    }
    const actor = this.db
      .prepare('SELECT id, kind, revoked_at FROM actors WHERE id = ? AND org_id = ?')
      .get(input.actorId, input.orgId) as
      { id: string; kind: string; revoked_at: string | null } | undefined;
    if (actor === undefined) {
      throw new LedgerError(
        'AUTH_ACTOR_NOT_FOUND',
        'identity target actor not found in this organization',
      );
    }
    if (actor.kind !== 'human') {
      throw new LedgerError('AUTH_ROLE_FORBIDDEN', 'identities link to human actors only');
    }
    if (actor.revoked_at !== null) {
      throw new LedgerError('AUTH_ACTOR_REVOKED', 'revoked actors cannot receive identity links');
    }
    const existing = this.db
      .prepare(
        'SELECT id, actor_id FROM identity_links WHERE provider = ? AND subject = ? AND org_id = ? AND revoked_at IS NULL',
      )
      .get(input.provider, input.subject, input.orgId) as
      { id: string; actor_id: string } | undefined;
    if (existing !== undefined) {
      if (existing.actor_id === input.actorId) {
        throw new LedgerError(
          'IDENTITY_ALREADY_LINKED',
          'identity is already linked to this actor',
        );
      }
      throw new LedgerError(
        'IDENTITY_CONFLICT',
        'identity is already linked to a different actor in this organization',
      );
    }
    const linkedBy = this.db
      .prepare('SELECT id FROM actors WHERE id = ? AND org_id = ?')
      .get(input.linkedBy, input.orgId) as { id: string } | undefined;
    if (linkedBy === undefined) {
      throw new LedgerError('AUTH_ACTOR_NOT_FOUND', 'linking actor not found in this organization');
    }
    const link: IdentityLinkView = {
      id: newId('idl'),
      orgId: input.orgId,
      actorId: input.actorId,
      provider: input.provider,
      subject: input.subject,
      emailAtLink: input.emailAtLink ?? null,
      linkedBy: input.linkedBy,
      linkedAt: this.clock.iso(),
      revokedAt: null,
    };
    this.db
      .prepare(
        'INSERT INTO identity_links (id, org_id, actor_id, provider, subject, email_at_link, linked_by, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        link.id,
        link.orgId,
        link.actorId,
        link.provider,
        link.subject,
        link.emailAtLink,
        link.linkedBy,
        link.linkedAt,
      );
    this.evidence.append({
      orgId: input.orgId,
      topic: 'financial',
      type: 'identity.linked',
      eventKey: `identity:${link.id}:linked`,
      payload: {
        linkId: link.id,
        actorId: link.actorId,
        provider: link.provider,
        subjectSha256: sha256(link.subject),
        linkedBy: link.linkedBy,
      },
    });
    return link;
  }

  /** Live link lookup (provider, subject) scoped to one org, or null. */
  findActorIdByIdentity(orgId: string, provider: string, subject: string): string | null {
    const row = this.db
      .prepare(
        'SELECT actor_id FROM identity_links WHERE org_id = ? AND provider = ? AND subject = ? AND revoked_at IS NULL',
      )
      .get(orgId, provider, subject) as { actor_id: string } | undefined;
    return row === undefined ? null : row.actor_id;
  }

  /** All org ids the identity is linked in (ids only — no authority data). */
  findOrgIdsByIdentity(provider: string, subject: string): string[] {
    return (
      this.db
        .prepare(
          'SELECT org_id FROM identity_links WHERE provider = ? AND subject = ? AND revoked_at IS NULL',
        )
        .all(provider, subject) as Array<{ org_id: string }>
    ).map((r) => r.org_id);
  }

  /** Revokes an identity link AND invalidates the bound actor's live sessions. */
  revokeIdentity(orgId: string, provider: string, subject: string, byActorId: string): boolean {
    const row = this.db
      .prepare(
        'SELECT id, actor_id FROM identity_links WHERE org_id = ? AND provider = ? AND subject = ? AND revoked_at IS NULL',
      )
      .get(orgId, provider, subject) as { id: string; actor_id: string } | undefined;
    if (row === undefined) return false;
    this.db
      .prepare('UPDATE identity_links SET revoked_at = ? WHERE id = ?')
      .run(this.clock.iso(), row.id);
    this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE actor_id = ? AND revoked_at IS NULL')
      .run(this.clock.iso(), row.actor_id);
    this.evidence.append({
      orgId,
      topic: 'financial',
      type: 'identity.revoked',
      eventKey: `identity:${row.id}:revoked:${this.clock.iso()}`,
      payload: {
        linkId: row.id,
        actorId: row.actor_id,
        subjectSha256: sha256(subject),
        by: byActorId,
      },
    });
    return true;
  }

  listIdentityLinks(orgId: string): IdentityLinkView[] {
    return (
      this.db
        .prepare('SELECT * FROM identity_links WHERE org_id = ? ORDER BY linked_at DESC')
        .all(orgId) as unknown[]
    ).map((r) => this.mapLink(r));
  }

  private mapLink(row: unknown): IdentityLinkView {
    const r = row as Record<string, unknown>;
    return {
      id: text(r.id, 'id'),
      orgId: text(r.org_id, 'org_id'),
      actorId: text(r.actor_id, 'actor_id'),
      provider: text(r.provider, 'provider'),
      subject: text(r.subject, 'subject'),
      emailAtLink: nullableText(r.email_at_link),
      linkedBy: text(r.linked_by, 'linked_by'),
      linkedAt: text(r.linked_at, 'linked_at'),
      revokedAt: nullableText(r.revoked_at),
    };
  }

  // ------------------------------------------------------------- invitations

  /**
   * Creates an expiring single-use invitation. The secret is returned EXACTLY
   * ONCE; the database stores only its sha256. Duplicate prevention: one
   * ACTIVE invitation per (org, email, role). Only owner/admin creators;
   * roles restricted to the invitable allowlist (schema CHECK is the backstop).
   */
  createInvitation(input: {
    orgId: string;
    role: ActorRole;
    email: string;
    createdByActorId: string;
    ttlMs?: number;
  }): { invitation: InvitationView; secret: string } {
    this.orgs.requireOrganization(input.orgId);
    if (!isActorRole(input.role) || !INVITABLE_ROLES.includes(input.role)) {
      throw new LedgerError(
        'AUTH_ROLE_FORBIDDEN',
        `invitations can never grant "${String(input.role)}"; invitable roles are ${INVITABLE_ROLES.join(', ')}`,
      );
    }
    const creator = this.db
      .prepare('SELECT role, revoked_at FROM actors WHERE id = ? AND org_id = ?')
      .get(input.createdByActorId, input.orgId) as
      { role: string; revoked_at: string | null } | undefined;
    if (creator === undefined || creator.revoked_at !== null) {
      throw new LedgerError(
        'AUTH_ACTOR_NOT_FOUND',
        'invitation creator not found in this organization',
      );
    }
    if (creator.role !== 'owner' && creator.role !== 'admin') {
      throw new LedgerError('AUTH_ROLE_FORBIDDEN', 'only owners and admins may invite members');
    }
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length < 3) {
      throw new LedgerError('INVALID_INPUT', 'a valid email address is required');
    }
    const active = this.db
      .prepare(
        'SELECT id FROM invitations WHERE org_id = ? AND email = ? AND role = ? AND redeemed_at IS NULL AND revoked_at IS NULL',
      )
      .get(input.orgId, email, input.role);
    if (active !== undefined) {
      throw new LedgerError(
        'INVITATION_DUPLICATE',
        'an active invitation for this email and role already exists',
      );
    }
    const ttl = input.ttlMs ?? DEFAULT_INVITATION_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > MAX_INVITATION_TTL_MS) {
      throw new LedgerError('INVALID_INPUT', 'invitation ttl must be between 1 minute and 30 days');
    }
    const now = this.clock.now();
    const invitation: InvitationView = {
      id: newId('inv'),
      orgId: input.orgId,
      role: input.role,
      email,
      createdBy: input.createdByActorId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      redeemedAt: null,
      revokedAt: null,
    };
    const secret = randomBytes(32).toString('base64url');
    this.db
      .prepare(
        'INSERT INTO invitations (id, org_id, role, email, secret_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        invitation.id,
        invitation.orgId,
        invitation.role,
        invitation.email,
        sha256(secret),
        invitation.createdBy,
        invitation.createdAt,
        invitation.expiresAt,
      );
    this.evidence.append({
      orgId: input.orgId,
      topic: 'financial',
      type: 'invitation.created',
      eventKey: `invitation:${invitation.id}:created`,
      payload: {
        invitationId: invitation.id,
        role: invitation.role,
        emailSha256: sha256(email),
        by: invitation.createdBy,
        expiresAt: invitation.expiresAt,
      },
    });
    return { invitation, secret };
  }

  listInvitations(orgId: string): InvitationView[] {
    return (
      this.db
        .prepare('SELECT * FROM invitations WHERE org_id = ? ORDER BY created_at DESC')
        .all(orgId) as unknown[]
    ).map((r) => this.mapInvitation(r));
  }

  getInvitation(orgId: string, invitationId: string): InvitationView | null {
    const row = this.db
      .prepare('SELECT * FROM invitations WHERE id = ? AND org_id = ?')
      .get(invitationId, orgId) as unknown;
    return row === undefined ? null : this.mapInvitation(row);
  }

  revokeInvitation(orgId: string, invitationId: string, byActorId: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE invitations SET revoked_at = ?, revoked_by = ? WHERE id = ? AND org_id = ? AND redeemed_at IS NULL AND revoked_at IS NULL',
      )
      .run(this.clock.iso(), byActorId, invitationId, orgId);
    if (result.changes === 1) {
      this.evidence.append({
        orgId,
        topic: 'financial',
        type: 'invitation.revoked',
        eventKey: `invitation:${invitationId}:revoked:${this.clock.iso()}`,
        payload: { invitationId, by: byActorId },
      });
    }
    return result.changes === 1;
  }

  /**
   * Redeems an invitation for a VERIFIED identity, inside ONE serialized
   * transaction. The conditional single-use UPDATE is the race guard (two
   * concurrent redemptions: exactly one wins; the loser fails closed).
   * Creates the human actor with the INVITED role when the invited email has
   * no actor yet (password stays NULL — identity-only actors have no password
   * path); a pre-provisioned actor keeps its role and is never elevated.
   */
  redeemInvitation(input: {
    orgId: string;
    invitationId: string;
    secret: string;
    provider: string;
    subject: string;
    emailAtLink?: string | null;
  }): { actor: ActorView; created: boolean } {
    if (input.provider === '' || input.subject === '') {
      throw new LedgerError('INVALID_INPUT', 'a verified identity (provider, subject) is required');
    }
    return this.redeemWithRoleRules({ ...input, emailAtLink: input.emailAtLink ?? null });
  }

  /**
   * Shared redemption transaction. A null secret is ONLY reachable through
   * redeemPreverifiedInvitation (the consumed OIDC flow row already proved
   * the secret was checked before the authorization redirect).
   */
  private redeemWithRoleRules(input: {
    orgId: string;
    invitationId: string;
    secret: string | null;
    provider: string;
    subject: string;
    emailAtLink: string | null;
  }): { actor: ActorView; created: boolean } {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM invitations WHERE id = ? AND org_id = ?')
        .get(input.invitationId, input.orgId) as Record<string, unknown> | undefined;
      if (row === undefined) {
        throw new LedgerError('INVITATION_NOT_FOUND', 'invitation not found in this organization');
      }
      if (row.revoked_at !== null)
        throw new LedgerError('INVITATION_REVOKED', 'invitation was revoked');
      if (row.redeemed_at !== null) {
        throw new LedgerError('INVITATION_REDEEMED', 'invitation was already redeemed');
      }
      if (new Date(text(row.expires_at, 'expires_at')) <= this.clock.now()) {
        throw new LedgerError('INVITATION_EXPIRED', 'invitation has expired');
      }
      if (input.secret !== null) {
        const provided = Buffer.from(sha256(input.secret), 'hex');
        const stored = Buffer.from(text(row.secret_hash, 'secret_hash'), 'hex');
        if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) {
          throw new LedgerError('INVITATION_SECRET_INVALID', 'invitation secret does not match');
        }
      }
      if (this.findActorIdByIdentity(input.orgId, input.provider, input.subject) !== null) {
        throw new LedgerError(
          'IDENTITY_ALREADY_LINKED',
          'this identity is already linked in this organization',
        );
      }
      const email = text(row.email, 'email');
      const role = text(row.role, 'role') as ActorRole;
      if (!isActorRole(role) || !INVITABLE_ROLES.includes(role)) {
        throw new LedgerError('AUTH_ROLE_FORBIDDEN', 'invitation role is not invitable');
      }
      const existingRow = this.db
        .prepare('SELECT * FROM actors WHERE org_id = ? AND username = ?')
        .get(input.orgId, email) as Record<string, unknown> | undefined;
      let actorRow: Record<string, unknown>;
      let created = false;
      if (existingRow === undefined) {
        const id = newId('act');
        this.db
          .prepare(
            'INSERT INTO actors (id, org_id, username, display_name, role, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            id,
            input.orgId,
            email,
            String(email).split('@')[0] ?? email,
            role,
            'human',
            this.clock.iso(),
          );
        created = true;
        this.evidence.append({
          orgId: input.orgId,
          topic: 'financial',
          type: 'actor.created',
          eventKey: `actor:${id}:created`,
          payload: { actorId: id, username: email, role, kind: 'human', via: 'invitation' },
        });
        actorRow = this.db.prepare('SELECT * FROM actors WHERE id = ?').get(id) as Record<
          string,
          unknown
        >;
      } else {
        if (existingRow.kind !== 'human') {
          throw new LedgerError(
            'AUTH_USERNAME_TAKEN',
            'the invited email collides with a non-invitable actor',
          );
        }
        if (existingRow.revoked_at !== null) {
          throw new LedgerError('AUTH_ACTOR_REVOKED', 'the invited account has been revoked');
        }
        if (existingRow.role !== role) {
          // A pre-provisioned actor keeps ITS role; an invitation never
          // elevates an existing actor (no self-service escalation path).
          throw new LedgerError(
            'INVITATION_ROLE_CONFLICT',
            'the invited email already has a different role in this organization',
          );
        }
        actorRow = existingRow;
      }
      const actor = this.mapActorRow(actorRow);
      this.linkIdentity({
        orgId: input.orgId,
        actorId: actor.id,
        provider: input.provider,
        subject: input.subject,
        emailAtLink: input.emailAtLink ?? email,
        linkedBy: text(row.created_by, 'created_by'),
      });
      const redeemed = this.db
        .prepare(
          'UPDATE invitations SET redeemed_at = ?, redeemed_by = ? WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL',
        )
        .run(this.clock.iso(), input.subject, input.invitationId);
      if (redeemed.changes !== 1) {
        throw new LedgerError(
          'INVITATION_REDEEMED',
          'invitation was already redeemed (racing redemption lost)',
        );
      }
      this.evidence.append({
        orgId: input.orgId,
        topic: 'financial',
        type: 'invitation.redeemed',
        eventKey: `invitation:${input.invitationId}:redeemed`,
        payload: {
          invitationId: input.invitationId,
          actorId: actor.id,
          subjectSha256: sha256(input.subject),
          role,
        },
      });
      return { actor, created };
    }, 'immediate');
  }

  /** Looks an invitation up by id alone (org-scoping is applied at redemption). */
  findInvitationById(invitationId: string): InvitationView | null {
    const row = this.db
      .prepare('SELECT * FROM invitations WHERE id = ?')
      .get(invitationId) as unknown;
    return row === undefined ? null : this.mapInvitation(row);
  }

  // -------------------------------------------------------------- provisioning

  /**
   * Separately authorized provisioning: creates an organization's initial
   * privileged actor (owner/admin) and binds the verified identity in one
   * step. This is a SERVER-SIDE operation (direct ledger access IS the
   * authorization) — there is deliberately NO HTTP route that can reach it,
   * so no public registration flow can ever mint owner/admin authority.
   * The actor is identity-only: password stays NULL, so no password path
   * exists for the provisioned owner.
   */
  provisionIdentityActor(input: {
    orgId?: string;
    orgTitle?: string;
    username: string;
    displayName: string;
    role: ActorRole;
    provider: string;
    subject: string;
    emailAtLink?: string | null;
    provisioningNote?: string;
  }): { orgId: string; actor: ActorView; created: boolean } {
    if (input.role !== 'owner' && input.role !== 'admin') {
      throw new LedgerError(
        'AUTH_ROLE_FORBIDDEN',
        'provisioning is for the initial owner/admin only; use invitations for member roles',
      );
    }
    const username = input.username.trim().toLowerCase();
    if (username.length < 3) {
      throw new LedgerError('INVALID_INPUT', 'username must be at least 3 characters');
    }
    return this.db.transaction(() => {
      let orgId = input.orgId;
      let created = false;
      if (orgId === undefined) {
        if (input.orgTitle === undefined || input.orgTitle.trim() === '') {
          throw new LedgerError(
            'INVALID_INPUT',
            'orgTitle is required when creating a new organization',
          );
        }
        orgId = this.orgs.createOrganization(input.orgTitle).id;
      } else {
        this.orgs.requireOrganization(orgId);
      }
      const existing = this.db
        .prepare('SELECT * FROM actors WHERE org_id = ? AND username = ?')
        .get(orgId, username) as Record<string, unknown> | undefined;
      if (existing === undefined) {
        const id = newId('act');
        this.db
          .prepare(
            'INSERT INTO actors (id, org_id, username, display_name, role, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(id, orgId, username, input.displayName, input.role, 'human', this.clock.iso());
        this.evidence.append({
          orgId,
          topic: 'financial',
          type: 'actor.created',
          eventKey: `actor:${id}:created`,
          payload: {
            actorId: id,
            username,
            role: input.role,
            kind: 'human',
            via: 'provisioning',
            note: input.provisioningNote ?? null,
          },
        });
        created = true;
      } else {
        if (existing.kind !== 'human' || existing.revoked_at !== null) {
          throw new LedgerError(
            'AUTH_USERNAME_TAKEN',
            'provisioning target is not a live human actor',
          );
        }
        if (existing.role !== input.role) {
          throw new LedgerError(
            'AUTH_ROLE_FORBIDDEN',
            'provisioning cannot change an existing actor role',
          );
        }
      }
      const actorRow = this.db
        .prepare('SELECT * FROM actors WHERE org_id = ? AND username = ?')
        .get(orgId, username) as Record<string, unknown>;
      const actor = this.mapActorRow(actorRow);
      const already = this.findActorIdByIdentity(orgId, input.provider, input.subject);
      if (already === null) {
        this.linkIdentity({
          orgId,
          actorId: actor.id,
          provider: input.provider,
          subject: input.subject,
          emailAtLink: input.emailAtLink ?? null,
          linkedBy: actor.id, // provisioning step is self-attested server-side
        });
        this.evidence.append({
          orgId,
          topic: 'financial',
          type: 'identity.provisioned',
          eventKey: `identity:${actor.id}:provisioned:${this.clock.iso()}`,
          payload: {
            actorId: actor.id,
            role: actor.role,
            provider: input.provider,
            subjectSha256: sha256(input.subject),
            note: input.provisioningNote ?? null,
          },
        });
      } else if (already !== actor.id) {
        throw new LedgerError(
          'IDENTITY_CONFLICT',
          'identity is already linked to a different actor',
        );
      }
      return { orgId, actor, created };
    }, 'immediate');
  }

  /**
   * Pre-verifies an invitation at the accept endpoint: existence, single-use,
   * expiry and constant-time secret check. Returns the invitation so the OIDC
   * flow can carry its id as a PRE-VERIFIED intent. The secret is never
   * persisted again after this check.
   */
  preverifyInvitation(invitationId: string, secret: string): InvitationView {
    const row = this.db.prepare('SELECT * FROM invitations WHERE id = ?').get(invitationId) as
      Record<string, unknown> | undefined;
    if (row === undefined) throw new LedgerError('INVITATION_NOT_FOUND', 'invitation not found');
    if (row.revoked_at !== null)
      throw new LedgerError('INVITATION_REVOKED', 'invitation was revoked');
    if (row.redeemed_at !== null)
      throw new LedgerError('INVITATION_REDEEMED', 'invitation was already redeemed');
    if (new Date(text(row.expires_at, 'expires_at')) <= this.clock.now()) {
      throw new LedgerError('INVITATION_EXPIRED', 'invitation has expired');
    }
    const provided = Buffer.from(sha256(secret), 'hex');
    const stored = Buffer.from(text(row.secret_hash, 'secret_hash'), 'hex');
    if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) {
      throw new LedgerError('INVITATION_SECRET_INVALID', 'invitation secret does not match');
    }
    return this.mapInvitation(row);
  }

  /**
   * Redeems a PRE-VERIFIED invitation (the secret was checked at the accept
   * endpoint and the consumed single-use OIDC flow row proves it) for the now
   * cryptographically verified identity. Same transaction/single-use/role
   * rules as redeemInvitation; the secret is not re-presented because it was
   * never persisted.
   */
  redeemPreverifiedInvitation(input: {
    orgId: string;
    invitationId: string;
    provider: string;
    subject: string;
    emailAtLink?: string | null;
  }): { actor: ActorView; created: boolean } {
    if (input.provider === '' || input.subject === '') {
      throw new LedgerError('INVALID_INPUT', 'a verified identity (provider, subject) is required');
    }
    const flow = this.db
      .prepare(
        'SELECT invitation_preverified FROM oidc_flows WHERE invitation_id = ? AND consumed_at IS NOT NULL ORDER BY created_at DESC LIMIT 1',
      )
      .get(input.invitationId) as { invitation_preverified: number } | undefined;
    if (flow === undefined || flow.invitation_preverified !== 1) {
      throw new LedgerError(
        'INVITATION_SECRET_INVALID',
        'no pre-verified invitation intent for this flow',
      );
    }
    return this.redeemWithRoleRules({
      orgId: input.orgId,
      invitationId: input.invitationId,
      secret: null,
      provider: input.provider,
      subject: input.subject,
      emailAtLink: input.emailAtLink ?? null,
    });
  }

  private mapInvitation(row: unknown): InvitationView {
    const r = row as Record<string, unknown>;
    return {
      id: text(r.id, 'id'),
      orgId: text(r.org_id, 'org_id'),
      role: text(r.role, 'role') as ActorRole,
      email: text(r.email, 'email'),
      createdBy: text(r.created_by, 'created_by'),
      createdAt: text(r.created_at, 'created_at'),
      expiresAt: text(r.expires_at, 'expires_at'),
      redeemedAt: nullableText(r.redeemed_at),
      revokedAt: nullableText(r.revoked_at),
    };
  }

  private mapActorRow(r: Record<string, unknown>): ActorView {
    return {
      id: text(r.id, 'id'),
      orgId: text(r.org_id, 'org_id'),
      username: text(r.username, 'username'),
      displayName: text(r.display_name, 'display_name'),
      role: text(r.role, 'role'),
      kind: text(r.kind, 'kind') as ActorView['kind'],
      revokedAt: nullableText(r.revoked_at),
      createdAt: text(r.created_at, 'created_at'),
    };
  }
}
