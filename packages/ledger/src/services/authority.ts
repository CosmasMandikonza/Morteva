/**
 * AuthorityService — the trusted actor boundary (issue #7 Phase 2).
 *
 * Identity originates ONLY here: persisted actors with server-side scrypt
 * credential verification, expiring sessions referenced by hashed tokens,
 * and explicit per-mission grants for machine actors. Nothing a client
 * sends (actorId, role string, header) is ever treated as identity.
 *
 * Cryptography: Node's built-in scrypt (reputable primitive, no custom
 * protocol); random 16-byte salts; 32-byte tokens; constant-time compare.
 * Session bearer tokens and CSRF tokens are stored only as sha256 digests.
 */
import { randomBytes, scryptSync, createHash, timingSafeEqual } from 'node:crypto';
import type { LedgerDatabase } from '../db/port.js';
import { nullableText, text } from '../db/port.js';
import { LedgerError } from '../errors.js';
import type { Clock } from '../clock.js';
import { newId } from './identity.js';
import type { EvidenceService } from './evidence.js';
import type { OrganizationService } from './organizations.js';
import {
  canApproveFinancialActions,
  canManageAuthority,
  canOperate,
  canProposePlans,
  canReadFinancialState,
  isActorRole,
} from '@moterva/domain';
import type {
  ActorKind,
  ActorRole,
  ActorView,
  MissionGrantView,
  PolicyDecision,
  SessionContextView,
} from '@moterva/domain';
import { authorized, denied } from '@moterva/domain';

export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface SessionTokens {
  readonly session: SessionContextView;
  /** Bearer token for the cookie; stored server-side only as a sha256 digest. */
  readonly token: string;
  /** CSRF token the client must echo in the X-CSRF-Token header on mutations. */
  readonly csrfToken: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export class AuthorityService {
  constructor(
    private readonly db: LedgerDatabase,
    private readonly clock: Clock,
    private readonly orgs: OrganizationService,
    private readonly evidence: EvidenceService,
  ) {}

  // ---------------------------------------------------------------- actors

  createHumanActor(input: {
    orgId: string;
    username: string;
    displayName: string;
    role: Exclude<ActorRole, 'service'>;
    password: string;
  }): ActorView {
    this.orgs.requireOrganization(input.orgId);
    if (input.password.length < 12) {
      throw new LedgerError('INVALID_INPUT', 'password must be at least 12 characters');
    }
    const actor = this.insertActor(
      input.orgId,
      input.username,
      input.displayName,
      input.role,
      'human',
    );
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(input.password, salt, 64).toString('hex');
    this.db
      .prepare('UPDATE actors SET password_hash = ?, password_salt = ? WHERE id = ?')
      .run(hash, salt, actor.id);
    this.evidence.append({
      orgId: input.orgId,
      topic: 'financial',
      type: 'actor.created',
      eventKey: `actor:${actor.id}:created`,
      payload: { actorId: actor.id, username: actor.username, role: actor.role, kind: 'human' },
    });
    return actor;
  }

  createServiceActor(input: { orgId: string; username: string; displayName: string }): ActorView {
    this.orgs.requireOrganization(input.orgId);
    const actor = this.insertActor(
      input.orgId,
      input.username,
      input.displayName,
      'service',
      'service',
    );
    this.evidence.append({
      orgId: input.orgId,
      topic: 'financial',
      type: 'actor.created',
      eventKey: `actor:${actor.id}:created`,
      payload: { actorId: actor.id, username: actor.username, role: 'service', kind: 'service' },
    });
    return actor;
  }

  private insertActor(
    orgId: string,
    username: string,
    displayName: string,
    role: ActorRole,
    kind: ActorKind,
  ): ActorView {
    if (!isActorRole(role))
      throw new LedgerError('INVALID_INPUT', `unknown role "${String(role)}"`);
    if (kind === 'service' && role !== 'service') {
      throw new LedgerError('AUTH_ROLE_FORBIDDEN', 'machine actors must have the service role');
    }
    const normalized = username.trim().toLowerCase();
    if (normalized.length < 3)
      throw new LedgerError('INVALID_INPUT', 'username must be at least 3 characters');
    const existing = this.db
      .prepare('SELECT id FROM actors WHERE org_id = ? AND username = ?')
      .get(orgId, normalized);
    if (existing !== undefined) {
      throw new LedgerError(
        'AUTH_USERNAME_TAKEN',
        `username "${normalized}" already exists in this organization`,
      );
    }
    const actor: ActorView = {
      id: newId('act'),
      orgId,
      username: normalized,
      displayName: displayName.trim(),
      role,
      kind,
      revokedAt: null,
      createdAt: this.clock.iso(),
    };
    this.db
      .prepare(
        'INSERT INTO actors (id, org_id, username, display_name, role, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        actor.id,
        actor.orgId,
        actor.username,
        actor.displayName,
        actor.role,
        actor.kind,
        actor.createdAt,
      );
    return actor;
  }

  getActor(orgId: string, actorId: string): ActorView {
    const row = this.db
      .prepare(
        'SELECT id, org_id, username, display_name, role, kind, revoked_at, created_at FROM actors WHERE id = ? AND org_id = ?',
      )
      .get(actorId, orgId);
    if (row === undefined) {
      throw new LedgerError(
        'AUTH_ACTOR_NOT_FOUND',
        `actor ${actorId} not found in organization ${orgId}`,
      );
    }
    return this.mapActor(row);
  }

  getActorByUsername(orgId: string, username: string): ActorView | undefined {
    const normalized = username.trim().toLowerCase();
    const row = this.db
      .prepare(
        'SELECT id, org_id, username, display_name, role, kind, revoked_at, created_at FROM actors WHERE org_id = ? AND username = ?',
      )
      .get(orgId, normalized);
    return row === undefined ? undefined : this.mapActor(row);
  }

  revokeActor(orgId: string, actorId: string, byActorId: string): void {
    const actor = this.getActor(orgId, actorId);
    this.db
      .prepare('UPDATE actors SET revoked_at = ? WHERE id = ? AND org_id = ?')
      .run(this.clock.iso(), actorId, orgId);
    this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE actor_id = ? AND revoked_at IS NULL')
      .run(this.clock.iso(), actorId);
    this.evidence.append({
      orgId,
      topic: 'financial',
      type: 'actor.revoked',
      eventKey: `actor:${actorId}:revoked`,
      payload: { actorId, by: byActorId, username: actor.username },
    });
  }

  // ------------------------------------------------------------ credentials

  /**
   * Verifies a username/password pair against the persisted scrypt hash.
   * Returns the actor, or null for any failure (no username oracle).
   * Revoked actors never authenticate.
   */
  verifyCredential(input: {
    username: string;
    password: string;
    orgId?: string;
  }): ActorView | null {
    const normalized = input.username.trim().toLowerCase();
    const rows = (
      input.orgId !== undefined
        ? this.db
            .prepare('SELECT id FROM actors WHERE username = ? AND org_id = ?')
            .all(normalized, input.orgId)
        : this.db.prepare('SELECT id FROM actors WHERE username = ?').all(normalized)
    ) as Array<{ id: string }>;
    if (rows.length !== 1) {
      // Burn comparable time so missing users are indistinguishable by latency.
      scryptSync(input.password, randomBytes(16).toString('hex'), 64);
      return null;
    }
    const actor = this.getActorForRowId((rows[0] as { id: string }).id);
    if (actor === null || actor.revokedAt !== null || actor.kind !== 'human') return null;
    const row = this.db
      .prepare('SELECT password_hash, password_salt FROM actors WHERE id = ?')
      .get(actor.id) as { password_hash: string | null; password_salt: string | null } | undefined;
    if (row === undefined || row.password_hash === null || row.password_salt === null) return null;
    const candidate = scryptSync(input.password, row.password_salt, 64);
    const stored = Buffer.from(row.password_hash, 'hex');
    if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) return null;
    return actor;
  }

  private getActorForRowId(actorId: string): ActorView | null {
    const row = this.db
      .prepare(
        'SELECT id, org_id, username, display_name, role, kind, revoked_at, created_at FROM actors WHERE id = ?',
      )
      .get(actorId);
    return row === undefined ? null : this.mapActor(row);
  }

  // --------------------------------------------------------------- sessions

  createSession(actorId: string, options: { ttlMs?: number } = {}): SessionTokens {
    const actorRow = this.db.prepare('SELECT org_id FROM actors WHERE id = ?').get(actorId) as
      { org_id: string } | undefined;
    if (actorRow === undefined)
      throw new LedgerError('AUTH_ACTOR_NOT_FOUND', `actor ${actorId} not found`);
    const actor = this.getActor(actorRow.org_id, actorId);
    if (actor.revokedAt !== null) {
      throw new LedgerError('AUTH_ACTOR_NOT_FOUND', 'revoked actors cannot open sessions');
    }
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + (options.ttlMs ?? DEFAULT_SESSION_TTL_MS));
    const sessionId = newId('sess');
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    this.db
      .prepare(
        `INSERT INTO sessions (id, org_id, actor_id, token_hash, csrf_hash, created_at, expires_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        actor.orgId,
        actor.id,
        sha256(token),
        sha256(csrfToken),
        now.toISOString(),
        expiresAt.toISOString(),
        now.toISOString(),
      );
    this.evidence.append({
      orgId: actor.orgId,
      topic: 'financial',
      type: 'session.created',
      eventKey: `session:${sessionId}:created`,
      payload: { actorId: actor.id, expiresAt: expiresAt.toISOString() },
    });
    return {
      session: { sessionId, actor, expiresAt: expiresAt.toISOString() },
      token,
      csrfToken,
    };
  }

  /** Resolves a bearer token to a live session context, or null. Never throws for bad tokens. */
  resolveSession(token: string): SessionContextView | null {
    if (typeof token !== 'string' || token === '') return null;
    const row = this.db
      .prepare(
        'SELECT id, org_id, actor_id, expires_at, revoked_at FROM sessions WHERE token_hash = ?',
      )
      .get(sha256(token)) as
      | {
          id: string;
          org_id: string;
          actor_id: string;
          expires_at: string;
          revoked_at: string | null;
        }
      | undefined;
    if (row === undefined) return null;
    if (row.revoked_at !== null) return null;
    if (new Date(row.expires_at) <= this.clock.now()) return null;
    const actor = this.getActorForRowId(row.actor_id);
    if (actor === null || actor.revokedAt !== null) return null;
    this.db
      .prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?')
      .run(this.clock.iso(), row.id);
    return { sessionId: row.id, actor, expiresAt: row.expires_at };
  }

  verifyCsrf(sessionId: string, csrfToken: string): boolean {
    if (typeof csrfToken !== 'string' || csrfToken === '') return false;
    const row = this.db
      .prepare('SELECT csrf_hash FROM sessions WHERE id = ? AND revoked_at IS NULL')
      .get(sessionId) as { csrf_hash: string } | undefined;
    if (row === undefined) return false;
    const a = Buffer.from(sha256(csrfToken), 'hex');
    const b = Buffer.from(row.csrf_hash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  revokeSession(token: string): boolean {
    const result = this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(this.clock.iso(), sha256(token));
    return result.changes === 1;
  }

  // ----------------------------------------------------------- role policy

  /** The single policy check every sensitive action funnels through. */
  requireRole(
    actor: ActorView,
    action: 'manageAuthority' | 'approve' | 'operate' | 'read' | 'propose',
  ): PolicyDecision {
    if (actor.revokedAt !== null) return denied('ACTOR_REVOKED', 'actor is revoked');
    if (actor.kind === 'service') {
      // Machine actors can never manage authority or approve, regardless of grants.
      if (action === 'manageAuthority' || action === 'approve') {
        return denied(
          'ROLE_FORBIDDEN',
          'machine actors can never manage authority or approve financial actions',
        );
      }
      if (action === 'propose') return authorized();
      if (action === 'operate' || action === 'read') return authorized(); // grant checked separately for operate
    }
    switch (action) {
      case 'manageAuthority':
        return canManageAuthority(actor.role as ActorRole)
          ? authorized()
          : denied('ROLE_FORBIDDEN', `role "${actor.role}" may not manage authority`);
      case 'approve':
        return canApproveFinancialActions(actor.role as ActorRole)
          ? authorized()
          : denied('ROLE_FORBIDDEN', `role "${actor.role}" may not approve financial actions`);
      case 'operate':
        return canOperate(actor.role as ActorRole)
          ? authorized()
          : denied('ROLE_FORBIDDEN', `role "${actor.role}" may not operate financial actions`);
      case 'propose':
        return canProposePlans(actor.role as ActorRole)
          ? authorized()
          : denied('ROLE_FORBIDDEN', `role "${actor.role}" may not propose plans`);
      case 'read':
        return canReadFinancialState(actor.role as ActorRole)
          ? authorized()
          : denied('ROLE_FORBIDDEN', `role "${actor.role}" may not read financial state`);
    }
  }

  // -------------------------------------------------------- mission grants

  grantMissionAccess(input: {
    orgId: string;
    missionId: string;
    actorId: string;
    byActorId: string;
  }): MissionGrantView {
    this.orgs.requireActiveMission(input.orgId, input.missionId);
    const actor = this.getActor(input.orgId, input.actorId);
    if (actor.kind !== 'service') {
      throw new LedgerError('INVALID_INPUT', 'mission grants are for machine (service) actors');
    }
    const existing = this.db
      .prepare(
        'SELECT id FROM mission_grants WHERE mission_id = ? AND actor_id = ? AND revoked_at IS NULL',
      )
      .get(input.missionId, input.actorId);
    if (existing !== undefined) {
      throw new LedgerError(
        'INVALID_INPUT',
        'actor already holds an active grant for this mission',
      );
    }
    const grant: MissionGrantView = {
      id: newId('mgr'),
      orgId: input.orgId,
      missionId: input.missionId,
      actorId: input.actorId,
      grantedBy: input.byActorId,
      grantedAt: this.clock.iso(),
      revokedAt: null,
    };
    this.db
      .prepare(
        'INSERT INTO mission_grants (id, org_id, mission_id, actor_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(grant.id, grant.orgId, grant.missionId, grant.actorId, grant.grantedBy, grant.grantedAt);
    this.evidence.append({
      orgId: input.orgId,
      missionId: input.missionId,
      topic: 'financial',
      type: 'grant.created',
      eventKey: `grant:${grant.id}:created`,
      payload: { grantId: grant.id, actorId: grant.actorId, by: grant.grantedBy },
    });
    return grant;
  }

  revokeMissionAccess(
    orgId: string,
    missionId: string,
    actorId: string,
    byActorId: string,
  ): boolean {
    const result = this.db
      .prepare(
        'UPDATE mission_grants SET revoked_at = ? WHERE mission_id = ? AND actor_id = ? AND org_id = ? AND revoked_at IS NULL',
      )
      .run(this.clock.iso(), missionId, actorId, orgId);
    if (result.changes === 1) {
      this.evidence.append({
        orgId,
        missionId,
        topic: 'financial',
        type: 'grant.revoked',
        eventKey: `grant:${missionId}:${actorId}:revoked:${this.clock.iso()}`,
        payload: { missionId, actorId, by: byActorId },
      });
    }
    return result.changes === 1;
  }

  hasMissionGrant(orgId: string, missionId: string, actorId: string): boolean {
    const row = this.db
      .prepare(
        'SELECT id FROM mission_grants WHERE org_id = ? AND mission_id = ? AND actor_id = ? AND revoked_at IS NULL',
      )
      .get(orgId, missionId, actorId);
    return row !== undefined;
  }

  private mapActor(row: unknown): ActorView {
    const r = row as Record<string, unknown>;
    return {
      id: text(r.id, 'id'),
      orgId: text(r.org_id, 'org_id'),
      username: text(r.username, 'username'),
      displayName: text(r.display_name, 'display_name'),
      role: text(r.role, 'role'),
      kind: text(r.kind, 'kind') as ActorKind,
      revokedAt: nullableText(r.revoked_at),
      createdAt: text(r.created_at, 'created_at'),
    };
  }
}
