/**
 * Authenticated financial routes (issue #7 Phase 2/6).
 *
 * Identity comes only from the session cookie → ledger AuthorityService.
 * Every handler is org-scoped by the ACTOR's org; every mutation requires
 * the session-bound CSRF header. The login and one-time dev-bootstrap
 * endpoints are only registered when DEMO_AUTH is explicitly enabled in a
 * non-production configuration (config refuses production+devAuth at boot).
 * No provider-write routes exist (issues #5/#6).
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ledger } from '@moterva/ledger';
import { isLedgerError } from '@moterva/ledger';
import type { AppConfig } from './config.js';
import { clearSessionCookie, csrfOk, guard, LoginRateLimiter, setSessionCookie } from './auth.js';

export function registerAuthAndFinancialRoutes(
  app: FastifyInstance,
  config: AppConfig,
  ledger: Ledger,
): void {
  const secureCookies = config.nodeEnv === 'production';
  const loginLimiter = new LoginRateLimiter(5, 60_000);

  // ------------------------------------------------------------------ auth

  app.post('/api/auth/login', async (request, reply) => {
    const body = (request.body ?? {}) as {
      username?: unknown;
      password?: unknown;
      orgId?: unknown;
    };
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const orgId = typeof body.orgId === 'string' ? body.orgId : undefined;
    if (username === '' || password === '') {
      return void reply
        .code(400)
        .send({ error: { code: 'INVALID_INPUT', message: 'username and password are required' } });
    }
    const limiterKey = `${request.ip}:${username}`;
    if (loginLimiter.isBlocked(limiterKey)) {
      return void reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: 'too many failed logins; wait before retrying' },
      });
    }
    const actor = ledger.authority.verifyCredential({ username, password, orgId });
    if (actor === null) {
      loginLimiter.recordFailure(limiterKey);
      return void reply
        .code(401)
        .send({ error: { code: 'UNAUTHENTICATED', message: 'invalid credentials' } });
    }
    loginLimiter.recordSuccess(limiterKey);
    const session = ledger.authority.createSession(actor.id, { ttlMs: config.sessionTtlMs });
    setSessionCookie(reply, session.token, config.sessionTtlMs, secureCookies);
    return {
      actor: {
        id: actor.id,
        username: actor.username,
        displayName: actor.displayName,
        role: actor.role,
        kind: actor.kind,
      },
      csrfToken: session.csrfToken,
      demoAuth: config.devAuth,
    };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (request.session === null) {
      return void reply
        .code(401)
        .send({ error: { code: 'UNAUTHENTICATED', message: 'a valid session is required' } });
    }
    if (!csrfOk(ledger, request, reply)) return reply;
    const token = request.cookies['moterva_session'] ?? '';
    ledger.authority.revokeSession(token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/session', async (request, reply) => {
    if (request.session === null) {
      return void reply
        .code(401)
        .send({ error: { code: 'UNAUTHENTICATED', message: 'a valid session is required' } });
    }
    const actor = request.session.actor;
    return {
      actor: {
        id: actor.id,
        username: actor.username,
        displayName: actor.displayName,
        role: actor.role,
        kind: actor.kind,
        orgId: actor.orgId,
      },
      expiresAt: request.session.expiresAt,
      demoAuth: config.devAuth,
    };
  });

  // DEMO_AUTH one-time bootstrap: local/test only (config-gated), only when
  // the ledger has NO actors at all, prints generated dev passwords once.
  if (config.devAuth) {
    app.post('/api/auth/dev-bootstrap', async (_request, reply) => {
      const actorCount = (
        ledger.db.prepare('SELECT COUNT(*) AS c FROM actors').get() as { c: number }
      ).c;
      if (actorCount > 0) {
        return void reply.code(409).send({
          error: {
            code: 'ALREADY_BOOTSTRAPPED',
            message: 'dev bootstrap works exactly once per ledger; actors already exist',
          },
        });
      }
      const org = ledger.organizations.createOrganization('DEMO_AUTH Local Org');
      const passwordFor = (username: string) =>
        `dev-${username}-${randomBytes(24).toString('base64url')}`;
      const roles = ['owner', 'admin', 'approver', 'operator', 'viewer'] as const;
      const created = roles.map((role) => {
        const password = passwordFor(role);
        const actor = ledger.authority.createHumanActor({
          orgId: org.id,
          username: role,
          displayName: `DEMO ${role}`,
          role,
          password,
        });
        return { username: actor.username, role: actor.role, password };
      });
      const servicePasswordNote =
        'service actor: create via ledger.authority.createServiceActor with an explicit mission grant';
      return { orgId: org.id, actors: created, note: servicePasswordNote, demoAuth: true };
    });
  }

  // ------------------------------------------------------------ financial

  app.get('/api/missions', async (request, reply) => {
    const g = guard(request, reply, 'read');
    if ('blocked' in g) return reply;
    const rows = ledger.db
      .prepare(
        'SELECT id, org_id, title, status, created_at FROM missions WHERE org_id = ? ORDER BY created_at',
      )
      .all(g.actor.orgId);
    return { missions: rows };
  });

  app.post('/api/missions', async (request, reply) => {
    const g = guard(request, reply, 'operate');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const body = (request.body ?? {}) as { title?: unknown };
    if (typeof body.title !== 'string' || body.title.trim() === '') {
      return void reply
        .code(400)
        .send({ error: { code: 'INVALID_INPUT', message: 'title is required' } });
    }
    return ledger.organizations.createMission(g.actor.orgId, body.title);
  });

  app.get('/api/mandates', async (request, reply) => {
    const g = guard(request, reply, 'read');
    if ('blocked' in g) return reply;
    const missionId =
      typeof (request.query as { missionId?: unknown }).missionId === 'string'
        ? (request.query as { missionId: string }).missionId
        : undefined;
    if (missionId === undefined) {
      return void reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'missionId query parameter is required' },
      });
    }
    try {
      const orgId = g.actor.orgId;
      ledger.organizations.getMission(orgId, missionId); // org scoping
      const rows = ledger.db
        .prepare(
          `SELECT id, mission_id, version, status, currency, max_amount_minor, total_budget_minor, permitted_kinds_json,
             rails_json, allowed_beneficiaries_json, allowed_purposes_json, require_separate_approver, expires_at, revoked_at, created_at
           FROM mandates WHERE org_id = ? AND mission_id = ? ORDER BY version DESC`,
        )
        .all(orgId, missionId) as unknown as Record<string, unknown>[];
      return { mandates: rows.map((row) => enrichBudget(row)) };
    } catch (error) {
      return notFoundOrRethrow(error, reply, 'mission not found');
    }

    function enrichBudget(row: Record<string, unknown>): Record<string, unknown> {
      const mandateId = String(row.id);
      const orgId = (request.session as { actor: { orgId: string } } | null)?.actor.orgId ?? '';
      const consumed = ledger.mandates.consumedMissionBudget(
        orgId,
        String(row.mission_id),
        String(row.currency),
      );
      const total =
        typeof row.total_budget_minor === 'number' && (row.total_budget_minor as number) !== -1
          ? (row.total_budget_minor as number)
          : (row.max_amount_minor as number);
      return { ...row, consumed_minor: consumed, remaining_minor: Math.max(0, total - consumed) };
    }
  });

  app.post('/api/mandates', async (request, reply) => {
    const g = guard(request, reply, 'manageAuthority');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const mandate = ledger.mandates.issue({
        orgId: g.actor.orgId,
        missionId: requireString(body, 'missionId'),
        currency: requireString(body, 'currency'),
        maxAmountMinor: requireNumber(body, 'maxAmountMinor'),
        totalBudgetMinor: optionalNumber(body, 'totalBudgetMinor'),
        permittedOperationKinds: requireStringArray(body, 'permittedOperationKinds'),
        rails: optionalStringArray(body, 'rails'),
        allowedBeneficiaries: optionalStringArray(body, 'allowedBeneficiaries'),
        allowedPurposes: optionalStringArray(body, 'allowedPurposes'),
        expiresAt: requireString(body, 'expiresAt'),
        byActorId: g.actor.id,
      });
      return { mandate: { ...mandate, consumedMinor: 0 } };
    } catch (error) {
      return ledgerFailure(error, reply);
    }
  });

  app.post('/api/mandates/:id/revoke', async (request, reply) => {
    const g = guard(request, reply, 'manageAuthority');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const mandateId = (request.params as { id: string }).id;
    const missionId = requireString((request.body ?? {}) as Record<string, unknown>, 'missionId');
    const reason = requireString((request.body ?? {}) as Record<string, unknown>, 'reason');
    try {
      const mandate = ledger.mandates.revoke(
        g.actor.orgId,
        missionId,
        mandateId,
        g.actor.id,
        reason,
      );
      return { mandate };
    } catch (error) {
      return ledgerFailure(error, reply);
    }
  });

  app.post('/api/plans', async (request, reply) => {
    const g = guard(request, reply, 'propose');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const terms = (body.terms ?? {}) as Record<string, unknown>;
      const plan = ledger.plans.recordVersion({
        orgId: g.actor.orgId,
        missionId: requireString(body, 'missionId'),
        // The proposer identity is ALWAYS the session actor — never a body field.
        proposedBy: g.actor.id,
        terms: {
          amountMinor: requireNumber(terms, 'amountMinor'),
          currency: requireString(terms, 'currency'),
          beneficiary: requireString(terms, 'beneficiary'),
          purpose: requireString(terms, 'purpose'),
          ...(terms.quote !== undefined ? { quote: terms.quote } : {}),
        },
      });
      return { plan: { id: plan.id, version: plan.version, digest: plan.digest } };
    } catch (error) {
      return ledgerFailure(error, reply);
    }
  });

  app.post('/api/approvals', async (request, reply) => {
    const g = guard(request, reply, 'approve');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const missionId = requireString(body, 'missionId');
      const plan = ledger.plans.getVersion(
        g.actor.orgId,
        missionId,
        requireString(body, 'planId'),
        requireNumber(body, 'planVersion'),
      );
      const kind = requireString(body, 'kind') as
        'airwallex_transfer' | 'metal_order' | 'internal_hold';
      const mandateId = optionalString(body, 'mandateId');
      const mandateVersion = optionalNumber(body, 'mandateVersion');
      const approval = ledger.approvals.record({
        orgId: g.actor.orgId,
        plan,
        decidedByActorId: g.actor.id,
        kind,
        mandateId,
        mandateVersion,
        evidenceDigest: optionalString(body, 'evidenceDigest'),
        expiresAt: requireString(body, 'expiresAt'),
      });
      return {
        approval: { id: approval.id, status: approval.status, expiresAt: approval.expiresAt },
      };
    } catch (error) {
      return ledgerFailure(error, reply);
    }
  });

  app.post('/api/approvals/:id/revoke', async (request, reply) => {
    const g = guard(request, reply, 'approve');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const approvalId = (request.params as { id: string }).id;
    const reason = requireString((request.body ?? {}) as Record<string, unknown>, 'reason');
    try {
      const approval = ledger.approvals.revoke(g.actor.orgId, approvalId, g.actor.id, reason);
      return { approval: { id: approval.id, status: approval.status } };
    } catch (error) {
      return ledgerFailure(error, reply);
    }
  });

  app.post('/api/operations/reserve', async (request, reply) => {
    const g = guard(request, reply, 'operate');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const missionId = requireString(body, 'missionId');
    // Machine actors need an explicit per-mission grant to operate.
    if (
      g.actor.kind === 'service' &&
      !ledger.authority.hasMissionGrant(g.actor.orgId, missionId, g.actor.id)
    ) {
      return void reply.code(403).send({
        error: {
          code: 'MISSION_GRANT_MISSING',
          reason: 'MISSION_GRANT_MISSING',
          message: 'service actor has no active grant for this mission',
        },
      });
    }
    try {
      const result = ledger.reservations.reserve({
        orgId: g.actor.orgId,
        missionId,
        kind: requireString(body, 'kind') as 'airwallex_transfer' | 'metal_order' | 'internal_hold',
        requestId: requireString(body, 'requestId'),
        planId: requireString(body, 'planId'),
        planVersion: requireNumber(body, 'planVersion'),
        approvalId: requireString(body, 'approvalId'),
        evidenceDigest: optionalString(body, 'evidenceDigest'),
      });
      return {
        duplicate: result.duplicate,
        operation: result.operation,
        commitment: result.commitment,
        spendableAfter: result.spendableAfter,
      };
    } catch (error) {
      return ledgerFailure(error, reply);
    }
  });

  app.get('/api/operations/:id', async (request, reply) => {
    const g = guard(request, reply, 'read');
    if ('blocked' in g) return reply;
    try {
      const operation = ledger.reservations.getOperation(
        g.actor.orgId,
        (request.params as { id: string }).id,
      );
      return { operation };
    } catch (error) {
      return notFoundOrRethrow(error, reply, 'operation not found');
    }
  });
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value === '') {
    throw new BadRequestError(`${field} is required`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function requireNumber(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new BadRequestError(`${field} must be a safe integer`);
  }
  return value;
}

function optionalNumber(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function requireStringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new BadRequestError(`${field} must be an array of strings`);
  }
  return value as string[];
}

function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new BadRequestError(`${field} must be an array of strings`);
  }
  return value as string[];
}

class BadRequestError extends Error {}

function ledgerFailure(
  error: unknown,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
): unknown {
  if (error instanceof BadRequestError) {
    return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: error.message } });
  }
  if (isLedgerError(error)) {
    const conflictCodes = new Set([
      'IDEMPOTENCY_CONFLICT',
      'APPROVAL_CONSUMED',
      'APPROVAL_ALREADY_EXISTS',
      'MANDATE_ALREADY_REVOKED',
      'APPROVAL_INVALIDATED',
      'DUPLICATE_EVENT',
    ]);
    const status = conflictCodes.has(error.code) ? 409 : 403;
    return reply.code(status).send({
      error: { code: error.code, message: error.message, details: error.details ?? null },
    });
  }
  return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal server error.' } });
}

function notFoundOrRethrow(
  error: unknown,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  message: string,
): unknown {
  if (
    isLedgerError(error) &&
    [
      'OPERATION_NOT_FOUND',
      'MISSION_NOT_FOUND',
      'PLAN_NOT_FOUND',
      'APPROVAL_NOT_FOUND',
      'MANDATE_NOT_FOUND',
      'ACCOUNT_NOT_FOUND',
    ].includes(error.code)
  ) {
    // Cross-org resources are indistinguishable from missing ones.
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message } });
  }
  if (isLedgerError(error) && error.code === 'CROSS_ORG_ACCESS') {
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message } });
  }
  return ledgerFailure(error, reply);
}
