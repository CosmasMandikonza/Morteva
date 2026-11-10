/**
 * Production identity routes (MTV-19) — mounted ONLY when a complete OIDC
 * configuration exists (config.fail-closed) inside the authenticated scope.
 *
 * Flow (Authorization Code + PKCE, server-managed sessions):
 *   GET  /api/auth/oidc/login      start a flow (state/nonce/verifier live
 *                                  SERVER-SIDE in the oidc_flows table; no
 *                                  identity data ever touches a cookie)
 *   POST /api/auth/invitations/accept
 *                                  pre-authenticated: verifies the invitation
 *                                  secret, then starts the SAME OIDC flow
 *                                  with a pre-verified invitation intent
 *   GET  /api/auth/oidc/callback   consume flow ONCE, exchange + validate the
 *                                  code (state/nonce/PKCE/issuer/aud/alg/exp),
 *                                  resolve or redeem-then-link the identity,
 *                                  create a fresh session, set the cookie
 *   POST /api/invitations          owner/admin create (CSRF)
 *   GET  /api/invitations          owner/admin list (no secrets, ever)
 *   POST /api/invitations/:id/revoke
 *
 * Unlinked identities NEVER gain access and are never auto-provisioned
 * (IDENTITY_NOT_LINKED). Owner/admin authority can NEVER be created through
 * any public route — only the separately authorized server-side provisioning
 * step (see ExternalIdentityService.provisionIdentityActor).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Ledger } from '@moterva/ledger';
import { isLedgerError } from '@moterva/ledger';
import type { AppConfig } from '../config.js';
import { csrfOk, guard, setSessionAndCsrfCookies, LoginRateLimiter } from '../auth.js';
import type { OidcClient, OidcProtocolError } from './oidc-client.js';

export function registerProductionIdentityRoutes(
  app: FastifyInstance,
  config: AppConfig,
  ledger: Ledger,
  client: OidcClient,
): void {
  const secureCookies = config.nodeEnv === 'production';
  const loginLimiter = new LoginRateLimiter(10, 60_000);

  function redirect(reply: FastifyReply, url: string): unknown {
    return reply.redirect(url, 303);
  }

  function protocolStatus(error: OidcProtocolError): number {
    switch (error.code) {
      case 'OIDC_UNAVAILABLE':
      case 'OIDC_ISSUER_UNAVAILABLE':
        return 503;
      case 'OIDC_PROVIDER_ERROR':
        return 502;
      default:
        return 400;
    }
  }

  async function startFlow(
    reply: FastifyReply,
    options: { orgId?: string | null; invitationId?: string | null },
    wantsJson = false,
  ): Promise<unknown> {
    const redirectUri = config.identity?.redirectUri;
    if (redirectUri === undefined) {
      return reply.code(500).send({ error: { code: 'IDENTITY_NOT_CONFIGURED' } });
    }
    const flow = await client.beginFlow(redirectUri);
    ledger.identity.createOidcFlow({
      state: flow.state,
      nonce: flow.nonce,
      codeVerifier: flow.codeVerifier,
      redirectUri,
      orgId: options.orgId ?? null,
      invitationId: options.invitationId ?? null,
      ttlMs: config.identity?.flowTtlMs,
    });
    // COORDINATED CONTRACT ADDITION (Agent A review requested, MTV-20 R3 P0-3):
    // a caller that POSTs the invitation secret via fetch cannot follow a 303
    // (the browser hides Location for opaque redirects), and a native second
    // form POST would resubmit the secret. When the client explicitly asks
    // for JSON, return the exact redirect target as data — the flow row is
    // still created exactly ONCE here, and default behavior (303) is
    // unchanged for every other caller.
    if (wantsJson) {
      return void reply.code(200).send({ redirectUrl: flow.authorizationUrl });
    }
    return redirect(reply, flow.authorizationUrl);
  }

  // ------------------------------------------------------------- login start

  app.get('/api/auth/oidc/login', async (request, reply) => {
    if (loginLimiter.isBlocked(`login:${request.ip}`)) {
      return void reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: 'too many attempts; wait before retrying' },
      });
    }
    const orgId = (request.query as { orgId?: string } | null)?.orgId;
    if (typeof orgId === 'string' && orgId !== '') {
      // Only a REAL org id may scope the login; anything else is ignored so
      // the response never distinguishes orgs the caller may not know.
      try {
        ledger.organizations.requireOrganization(orgId);
      } catch {
        return void reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      }
      return startFlow(reply, { orgId });
    }
    return startFlow(reply, {});
  });

  // ------------------------------------------------------- invitation accept

  /**
   * PRE-AUTHENTICATION by design: the caller holds only the invitation
   * secret (delivered out-of-band), not a session. Rate-limited; the secret
   * is verified constant-time and never persisted. On success the caller is
   * redirected to the identity provider; the redemption completes only after
   * the IdP proves the identity at the callback.
   */
  app.post('/api/auth/invitations/accept', async (request, reply) => {
    if (loginLimiter.isBlocked(`invite:${request.ip}`)) {
      return void reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: 'too many attempts; wait before retrying' },
      });
    }
    const body = (request.body ?? {}) as { invitationId?: unknown; secret?: unknown };
    const invitationId = typeof body.invitationId === 'string' ? body.invitationId : '';
    const secret = typeof body.secret === 'string' ? body.secret : '';
    if (invitationId === '' || secret === '') {
      return void reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'invitationId and secret are required' },
      });
    }
    try {
      const invitation = ledger.identity.preverifyInvitation(invitationId, secret);
      loginLimiter.recordSuccess(`invite:${request.ip}`);
      const wantsJson = String(request.headers['accept'] ?? '').includes('application/json');
      return startFlow(reply, { invitationId: invitation.id }, wantsJson);
    } catch (error) {
      if (isLedgerError(error)) {
        // Failed secret guesses feed the per-IP limiter: 10 failures earn a
        // 60s cooldown (recordSuccess clears it on a valid accept).
        loginLimiter.recordFailure(`invite:${request.ip}`);
        return void reply.code(mapInvitationStatus(error.code)).send({
          error: { code: error.code, message: 'invitation cannot be accepted' },
        });
      }
      request.log.error({ err: error }, 'invitation accept failed');
      return void reply.code(500).send({ error: { code: 'INTERNAL' } });
    }
  });

  // ---------------------------------------------------------------- callback

  app.get('/api/auth/oidc/callback', async (request, reply) => {
    if (loginLimiter.isBlocked(`callback:${request.ip}`)) {
      return void reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: 'too many attempts; wait before retrying' },
      });
    }
    const query = request.query as Record<string, string | string[] | undefined>;
    const state = typeof query['state'] === 'string' ? query['state'] : '';
    if (state === '') {
      return void reply
        .code(400)
        .send({ error: { code: 'OIDC_STATE_INVALID', message: 'missing state' } });
    }
    // Single-use consume: replayed/expired states fail BEFORE any exchange.
    let flow: ReturnType<typeof ledger.identity.consumeOidcFlow>;
    try {
      flow = ledger.identity.consumeOidcFlow(state);
    } catch (error) {
      if (isLedgerError(error)) {
        return void reply.code(400).send({ error: { code: error.code, message: 'flow rejected' } });
      }
      throw error;
    }
    if (config.identity === null || flow.redirectUri !== config.identity.redirectUri) {
      return void reply
        .code(400)
        .send({ error: { code: 'OIDC_CALLBACK_INVALID', message: 'redirect mismatch' } });
    }
    try {
      const identity = await client.completeFlow({
        callbackQuery: query,
        expectedState: state,
        expectedNonce: flow.nonce,
        codeVerifier: flow.codeVerifier,
        redirectUri: flow.redirectUri,
      });
      // The identity is now VERIFIED by the IdP. Resolve the actor.
      if (flow.invitationId !== null) {
        // Pre-verified invitation: redeem for this identity (org comes from
        // the invitation row; secret was checked at the accept endpoint).
        const invitation = ledger.identity.findInvitationById(flow.invitationId);
        if (invitation === null) {
          return void reply.code(409).send({
            error: { code: 'INVITATION_NOT_FOUND', message: 'invitation no longer exists' },
          });
        }
        const { actor } = ledger.identity.redeemPreverifiedInvitation({
          orgId: invitation.orgId,
          invitationId: invitation.id,
          provider: identity.issuer,
          subject: identity.subject,
          emailAtLink: identity.email,
        });
        return finishSignIn(reply, actor.id);
      }
      const linkedOrgs = ledger.identity.findOrgIdsByIdentity(identity.issuer, identity.subject);
      if (linkedOrgs.length === 0) {
        return void reply.code(403).send({
          error: {
            code: 'IDENTITY_NOT_LINKED',
            message:
              'this identity is not a member of any organization. Accept an invitation from an organization admin.',
          },
        });
      }
      if (flow.orgId !== null) {
        if (!linkedOrgs.includes(flow.orgId)) {
          return void reply.code(403).send({
            error: { code: 'IDENTITY_NOT_LINKED', message: 'not a member of that organization' },
          });
        }
        return finishSignInForActor(
          reply,
          flow.orgId,
          ledger.identity.findActorIdByIdentity(flow.orgId, identity.issuer, identity.subject)!,
        );
      }
      if (linkedOrgs.length === 1) {
        return finishSignInForActor(
          reply,
          linkedOrgs[0]!,
          ledger.identity.findActorIdByIdentity(linkedOrgs[0]!, identity.issuer, identity.subject)!,
        );
      }
      return void reply.code(409).send({
        error: {
          code: 'ORG_SELECTION_REQUIRED',
          message:
            'this identity is linked in multiple organizations; pass ?orgId= to /api/auth/oidc/login',
          orgIds: linkedOrgs,
        },
      });
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'name' in error &&
        (error as { name: string }).name === 'OidcProtocolError'
      ) {
        const protocol = error as OidcProtocolError;
        return void reply
          .code(protocolStatus(protocol))
          .send({ error: { code: protocol.code, message: 'authentication failed' } });
      }
      if (isLedgerError(error)) {
        return void reply.code(mapInvitationStatus(error.code)).send({
          error: { code: error.code, message: 'authentication cannot complete' },
        });
      }
      request.log.error({ err: error }, 'oidc callback failed');
      return void reply.code(500).send({ error: { code: 'INTERNAL' } });
    }
  });

  function finishSignIn(reply: FastifyReply, actorId: string): unknown {
    const session = ledger.authority.createSession(actorId, { ttlMs: config.sessionTtlMs });
    setSessionAndCsrfCookies(reply, session, config.sessionTtlMs, secureCookies);
    // Always land on the configured web origin — never a caller-supplied path
    // (open-redirect safe).
    return reply.redirect(config.webOrigin, 303);
  }

  /**
   * Signs a LINKED identity in after verifying the bound actor is still live.
   * A revoked account gets an explicit 403 (distinct machine code) and NO
   * session — the link itself survives so re-onboarding can re-bind later.
   */
  function finishSignInForActor(reply: FastifyReply, orgId: string, actorId: string): unknown {
    const actor = ledger.authority.getActor(orgId, actorId);
    if (actor.revokedAt !== null) {
      return void reply
        .code(403)
        .send({ error: { code: 'AUTH_ACTOR_REVOKED', message: 'this account has been revoked' } });
    }
    return finishSignIn(reply, actorId);
  }

  // -------------------------------------------------- invitation management

  app.post('/api/invitations', async (request, reply) => {
    const g = guard(request, reply, 'manageAuthority');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const body = (request.body ?? {}) as { role?: unknown; email?: unknown; ttlMs?: unknown };
    const role = typeof body.role === 'string' ? body.role : '';
    const email = typeof body.email === 'string' ? body.email : '';
    const ttlMs =
      typeof body.ttlMs === 'number' && Number.isSafeInteger(body.ttlMs) ? body.ttlMs : undefined;
    if (role === '' || email === '') {
      return void reply
        .code(400)
        .send({ error: { code: 'INVALID_INPUT', message: 'role and email are required' } });
    }
    try {
      const { invitation, secret } = ledger.identity.createInvitation({
        orgId: g.actor.orgId,
        role: role as 'approver' | 'operator' | 'viewer',
        email,
        createdByActorId: g.actor.id,
        ttlMs,
      });
      // The secret is returned EXACTLY ONCE to the authorized admin (who
      // delivers it out-of-band). It is never retrievable again.
      return { invitation, secret };
    } catch (error) {
      if (isLedgerError(error)) {
        const status =
          error.code === 'INVITATION_DUPLICATE'
            ? 409
            : error.code === 'AUTH_ROLE_FORBIDDEN'
              ? 403
              : 400;
        return void reply
          .code(status)
          .send({ error: { code: error.code, message: 'invitation refused' } });
      }
      throw error;
    }
  });

  app.get('/api/invitations', async (request, reply) => {
    const g = guard(request, reply, 'manageAuthority');
    if ('blocked' in g) return reply;
    return { invitations: ledger.identity.listInvitations(g.actor.orgId) };
  });

  app.post('/api/invitations/:id/revoke', async (request, reply) => {
    const g = guard(request, reply, 'manageAuthority');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const id = (request.params as { id: string }).id;
    const revoked = ledger.identity.revokeInvitation(g.actor.orgId, id, g.actor.id);
    if (!revoked) {
      return void reply.code(404).send({
        error: { code: 'INVITATION_NOT_FOUND', message: 'no active invitation with that id' },
      });
    }
    return { ok: true };
  });
}

function mapInvitationStatus(code: string): number {
  switch (code) {
    case 'INVITATION_NOT_FOUND':
      return 404;
    case 'INVITATION_EXPIRED':
    case 'INVITATION_REDEEMED':
    case 'INVITATION_REVOKED':
    case 'INVITATION_ROLE_CONFLICT':
    case 'IDENTITY_ALREADY_LINKED':
      return 409;
    case 'INVITATION_SECRET_INVALID':
    case 'AUTH_ACTOR_REVOKED':
    case 'AUTH_ACTOR_NOT_FOUND':
      return 403;
    default:
      return 400;
  }
}
