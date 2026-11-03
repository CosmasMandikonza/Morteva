/**
 * Session authentication boundary (issue #7 Phase 2/6).
 *
 * Trust flows ONE way: the `moterva_session` HttpOnly cookie (set only by
 * /api/auth/login) resolves through the ledger's AuthorityService to a
 * persisted actor. Nothing else — no header, body field, or role string —
 * ever influences identity. Mutations additionally require the CSRF token
 * (X-CSRF-Token) bound to the session. All handlers run org-scoped from the
 * actor's own org; cross-org resources are indistinguishable from missing
 * ones (404).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ledger } from '@moterva/ledger';
import type { ActorRole, ActorView, PolicyDecision, SessionContextView } from '@moterva/domain';
import {
  canApproveFinancialActions,
  canManageAuthority,
  canOperate,
  canProposePlans,
  canReadFinancialState,
  denied,
} from '@moterva/domain';

export type AuthorityAction = 'manageAuthority' | 'approve' | 'operate' | 'read' | 'propose';

export const SESSION_COOKIE = 'moterva_session';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionContextView | null;
  }
}

/**
 * Attaches the session decorator + resolution hook DIRECTLY to the given
 * scope (not as a child plugin, whose encapsulated hook would not apply to
 * sibling routes).
 */
export function attachSession(app: FastifyInstance, ledger: Ledger): void {
  app.decorateRequest('session', null);
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const token = request.cookies[SESSION_COOKIE];
    request.session = token === undefined ? null : ledger.authority.resolveSession(token);
  });
}

/** Role policy — mirrors AuthorityService.requireRole so routes stay consistent. */
export function actorMay(actor: ActorView, action: AuthorityAction): PolicyDecision {
  if (actor.revokedAt !== null) return denied('ACTOR_REVOKED', 'actor is revoked');
  if (actor.kind === 'service') {
    if (action === 'manageAuthority' || action === 'approve') {
      return denied(
        'ROLE_FORBIDDEN',
        'machine actors can never manage authority or approve financial actions',
      );
    }
    return { outcome: 'AUTHORIZED', reason: 'OK' };
  }
  const role = actor.role as ActorRole;
  switch (action) {
    case 'manageAuthority':
      return canManageAuthority(role)
        ? { outcome: 'AUTHORIZED', reason: 'OK' }
        : denied('ROLE_FORBIDDEN', `role "${actor.role}" may not manage authority`);
    case 'approve':
      return canApproveFinancialActions(role)
        ? { outcome: 'AUTHORIZED', reason: 'OK' }
        : denied('ROLE_FORBIDDEN', `role "${actor.role}" may not approve financial actions`);
    case 'operate':
      return canOperate(role)
        ? { outcome: 'AUTHORIZED', reason: 'OK' }
        : denied('ROLE_FORBIDDEN', `role "${actor.role}" may not operate financial actions`);
    case 'propose':
      return canProposePlans(role)
        ? { outcome: 'AUTHORIZED', reason: 'OK' }
        : denied('ROLE_FORBIDDEN', `role "${actor.role}" may not propose plans`);
    case 'read':
      return canReadFinancialState(role)
        ? { outcome: 'AUTHORIZED', reason: 'OK' }
        : denied('ROLE_FORBIDDEN', `role "${actor.role}" may not read financial state`);
  }
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  ttlMs: number,
  secure: boolean,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: Math.floor(ttlMs / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** 401 with a machine-readable code — never a hint about which users exist. */
export function rejectUnauthenticated(reply: FastifyReply): void {
  void reply
    .code(401)
    .send({ error: { code: 'UNAUTHENTICATED', message: 'a valid session is required' } });
}

export function rejectForbidden(reply: FastifyReply, decision: PolicyDecision): void {
  void reply.code(403).send({
    error: {
      code: 'ROLE_FORBIDDEN',
      reason: decision.reason,
      message: decision.detail ?? 'role policy denied this action',
    },
  });
}

export function rejectCsrf(reply: FastifyReply): void {
  void reply.code(403).send({
    error: { code: 'CSRF_INVALID', message: 'missing or invalid X-CSRF-Token for this session' },
  });
}

/** Guard chain: authenticated session → role allowed. */
export function guard(
  request: FastifyRequest,
  reply: FastifyReply,
  action: AuthorityAction,
): { actor: ActorView } | { blocked: true } {
  if (request.session === null) {
    rejectUnauthenticated(reply);
    return { blocked: true };
  }
  const decision = actorMay(request.session.actor, action);
  if (decision.outcome !== 'AUTHORIZED') {
    rejectForbidden(reply, decision);
    return { blocked: true };
  }
  return { actor: request.session.actor };
}

/**
 * CSRF verification for mutations: the X-CSRF-Token header must hash-match
 * the session's stored CSRF secret. SameSite=Strict already blocks cross-site
 * cookie sends; the header requirement additionally defeats same-site
 * subpage injection.
 */
export function csrfOk(ledger: Ledger, request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.session === null) {
    rejectUnauthenticated(reply);
    return false;
  }
  const header = request.headers['x-csrf-token'];
  const token = Array.isArray(header) ? (header[0] ?? '') : header;
  if (typeof token !== 'string' || !ledger.authority.verifyCsrf(request.session.sessionId, token)) {
    rejectCsrf(reply);
    return false;
  }
  return true;
}

/** Tiny fixed-window limiter for login attempts (per username, in-process). */
export class LoginRateLimiter {
  private readonly failures = new Map<string, { count: number; blockedUntil: number }>();
  constructor(
    private readonly maxFailures = 5,
    private readonly cooldownMs = 60_000,
  ) {}

  isBlocked(key: string, now = Date.now()): boolean {
    const entry = this.failures.get(key);
    return entry !== undefined && entry.blockedUntil > now;
  }

  recordFailure(key: string, now = Date.now()): void {
    const entry = this.failures.get(key) ?? { count: 0, blockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= this.maxFailures) {
      entry.blockedUntil = now + this.cooldownMs;
      entry.count = 0;
    }
    this.failures.set(key, entry);
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }
}
