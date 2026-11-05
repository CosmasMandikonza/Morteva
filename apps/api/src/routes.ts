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
import { isLedgerError, LedgerError } from '@moterva/ledger';
import { createMoney, isOperationState, toMajorString } from '@moterva/domain';
import type {
  AttentionLevel,
  CommitmentBreakdownView,
  FinancialCurrencyView,
  FinancialOverviewView,
  MissionEvidenceEventView,
  MissionEvidenceListView,
  MoneyView,
  OperationListView,
  OperationReadView,
} from '@moterva/domain';
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

  // Password login is a local/demo bridge, not production authentication.
  // Production auth requires a separately verified IdP integration.
  if (config.devAuth) {
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
        return void reply.code(400).send({
          error: { code: 'INVALID_INPUT', message: 'username and password are required' },
        });
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
  }

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
      return {
        operation: enrichOperationRow(ledger, orgOperationRow(ledger, g.actor.orgId, operation.id)),
      };
    } catch (error) {
      return notFoundOrRethrow(error, reply, 'operation not found');
    }
  });

  // ------------------------------------------------ financial reads (#34)
  //
  // Read-only operator visibility into what the ledger ALREADY computes —
  // balances with provenance, spendable capacity, commitment breakdown,
  // operation status and human-attention exceptions. No mutations, no
  // provider calls, no new authority: org scope always comes from the
  // actor's session; stale or missing balances are reported as such and
  // spendable is NEVER computed from them.

  app.get('/api/financial/overview', async (request, reply) => {
    const g = guard(request, reply, 'read');
    if ('blocked' in g) return reply;
    const orgId = g.actor.orgId;
    const accounts = ledger.db
      .prepare(
        `SELECT currency, protected_floor_minor FROM accounts
          WHERE org_id = ? AND kind = 'treasury' ORDER BY currency`,
      )
      .all(orgId) as { currency: string; protected_floor_minor: number }[];

    const currencies: FinancialCurrencyView[] = accounts.map((account) => {
      const currency = account.currency;
      const floorMinor = account.protected_floor_minor;
      const latest = ledger.accounts.latestSnapshot(orgId, currency, ledger.clock.now());

      if (latest === undefined) {
        return {
          currency,
          status: 'no_snapshot' as const,
          balance: null,
          provenance: null,
          protectedFloor: moneyView(currency, floorMinor),
          spendable: null,
          commitments: commitmentBreakdown(ledger, orgId, currency, null),
          statusDetail: `no balance observation exists for ${currency}; the ledger refuses to reason about unknown funds until a balance is recorded`,
        };
      }
      const provenance = {
        source: latest.snapshot.source,
        observedAt: latest.snapshot.observedAt,
        expiresAt: latest.snapshot.expiresAt,
        stale: !latest.fresh,
        // TRUTHFULNESS (final CTO review): `source` is descriptive provenance
        // only — recordBalanceSnapshot accepts a caller-provided source label
        // with no durable, independently validated provider observation
        // linked to the snapshot, so a label alone can NEVER imply verified
        // funds. providerVerified stays false for every snapshot until an
        // attestation-linked provider read path exists and its binding to
        // THIS snapshot is verified explicitly. A manual seed is recorded
        // operator input, and a balance is a different concept from mandate
        // authority (permission; served by /api/mandates). Authority is not money.
        providerVerified: false,
      };
      const breakdown = commitmentBreakdown(ledger, orgId, currency, latest.snapshot.observedAt);
      if (!latest.fresh) {
        return {
          currency,
          status: 'stale' as const,
          balance: moneyView(currency, latest.snapshot.minorUnits),
          provenance,
          protectedFloor: moneyView(currency, floorMinor),
          spendable: null,
          commitments: breakdown,
          statusDetail: `balance expired at ${latest.snapshot.expiresAt} (observed ${latest.snapshot.observedAt}); spendable capacity is not computed from stale money — a fresh observation is required`,
        };
      }
      // Fresh: the engine's own computation is the single source of truth.
      const view = ledger.spendable.compute(orgId, currency);
      return {
        currency,
        status: 'ok' as const,
        balance: moneyView(currency, view.balanceMinor),
        provenance,
        protectedFloor: moneyView(currency, view.protectedFloorMinor),
        spendable: {
          ...moneyView(currency, view.spendableMinor),
          overcommitted: view.overcommitted,
        },
        commitments: breakdown,
        statusDetail: null,
      };
    });

    const overview: FinancialOverviewView = {
      orgId,
      generatedAt: ledger.clock.iso(),
      currencies,
    };
    return overview;
  });

  app.get('/api/operations', async (request, reply) => {
    const g = guard(request, reply, 'read');
    if ('blocked' in g) return reply;
    const orgId = g.actor.orgId;
    const query = request.query as {
      missionId?: unknown;
      state?: unknown;
      attention?: unknown;
      limit?: unknown;
    };

    let missionId: string | undefined;
    if (typeof query.missionId === 'string' && query.missionId !== '') {
      missionId = query.missionId;
      try {
        ledger.organizations.getMission(orgId, missionId); // cross-tenant is 404, not a leak
      } catch (error) {
        return notFoundOrRethrow(error, reply, 'mission not found');
      }
    }
    let stateFilter: string | undefined;
    if (typeof query.state === 'string' && query.state !== '') {
      if (!isOperationState(query.state)) {
        return void reply.code(400).send({
          error: {
            code: 'INVALID_INPUT',
            message: `state must be one of the operation ladder states (got "${query.state}")`,
          },
        });
      }
      stateFilter = query.state;
    }
    let attentionOnly = false;
    if (typeof query.attention === 'string' && query.attention !== '') {
      if (query.attention !== 'needs-human') {
        return void reply.code(400).send({
          error: { code: 'INVALID_INPUT', message: 'attention must be "needs-human" when present' },
        });
      }
      attentionOnly = true;
    }
    const limitRaw = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isSafeInteger(limitRaw) || limitRaw < 1 || limitRaw > 200) {
      return void reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'limit must be an integer between 1 and 200' },
      });
    }

    const clauses = ['o.org_id = ?'];
    const params: unknown[] = [orgId];
    if (missionId !== undefined) {
      clauses.push('o.mission_id = ?');
      params.push(missionId);
    }
    if (stateFilter !== undefined) {
      clauses.push('o.state = ?');
      params.push(stateFilter);
    }
    if (attentionOnly) {
      clauses.push(`o.state IN ('REQUIRES_HUMAN', 'STATUS_UNKNOWN')`);
    }
    const rows = ledger.db
      .prepare(
        `SELECT ${OPERATION_COLUMNS}
           FROM operations o
           LEFT JOIN commitments c ON c.operation_id = o.id
           LEFT JOIN outbox_dispatches x ON x.operation_id = o.id
          WHERE ${clauses.join(' AND ')}
          ORDER BY o.created_at DESC, o.id
          LIMIT ?`,
      )
      .all(...params, limitRaw) as Record<string, unknown>[];

    // Org-wide exception counts (never scoped by the list filters) so the UI
    // can badge "needs human" without a second contract.
    const countsRow = ledger.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN state = 'REQUIRES_HUMAN' THEN 1 ELSE 0 END) AS needsHuman,
           SUM(CASE WHEN state = 'STATUS_UNKNOWN' THEN 1 ELSE 0 END) AS ambiguous
         FROM operations WHERE org_id = ?`,
      )
      .get(orgId) as { total: number; needsHuman: number | null; ambiguous: number | null };

    const list: OperationListView = {
      operations: rows.map((row) => enrichOperationRow(ledger, row)),
      counts: {
        returned: rows.length,
        needsHuman: countsRow.needsHuman ?? 0,
        ambiguous: countsRow.ambiguous ?? 0,
      },
    };
    return list;
  });

  // ---------------------------------------- mission financial history (#36)
  //
  // The append-only evidence journal is the mission's financial replay:
  // why the money looks the way it does (reservation, settlement, reversal,
  // denial, dispatch decisions), with each event's integrity digest. The
  // payload is the journal's own stored JSON — provider payloads were already
  // minimized at write time, so nothing raw can appear here.

  app.get('/api/missions/:missionId/evidence', async (request, reply) => {
    const g = guard(request, reply, 'read');
    if ('blocked' in g) return reply;
    const orgId = g.actor.orgId;
    const missionId = (request.params as { missionId: string }).missionId;
    try {
      ledger.organizations.getMission(orgId, missionId); // cross-tenant is 404
    } catch (error) {
      return notFoundOrRethrow(error, reply, 'mission not found');
    }
    const query = request.query as { topic?: unknown; limit?: unknown };
    let topic: 'financial' | 'operational' | undefined;
    if (typeof query.topic === 'string' && query.topic !== '') {
      if (query.topic !== 'financial' && query.topic !== 'operational') {
        return void reply.code(400).send({
          error: {
            code: 'INVALID_INPUT',
            message: 'topic must be "financial" or "operational" when present',
          },
        });
      }
      topic = query.topic;
    }
    const limitRaw = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isSafeInteger(limitRaw) || limitRaw < 1 || limitRaw > 200) {
      return void reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'limit must be an integer between 1 and 200' },
      });
    }

    const rows = ledger.db
      .prepare(
        `SELECT seq, id, topic, type, event_key, payload_digest, payload_json, recorded_at
           FROM evidence_events
          WHERE org_id = ? AND mission_id = ?
          ${topic === undefined ? '' : 'AND topic = ?'}
          ORDER BY seq DESC
          LIMIT ?`,
      )
      .all(
        ...(topic === undefined
          ? [orgId, missionId, limitRaw]
          : [orgId, missionId, topic, limitRaw]),
      ) as Record<string, unknown>[];

    const events: MissionEvidenceEventView[] = rows.map((row) => ({
      seq: row.seq as number,
      id: String(row.id),
      topic: String(row.topic) as 'financial' | 'operational',
      // Metadata is format-validated too: an unstructured event key or type
      // string from any writer is reported as null, never verbatim.
      type: safeEventType(String(row.type)),
      eventKey: safeEventKey(String(row.event_key)),
      payloadDigest: String(row.payload_digest),
      // DISCLOSURE BOUNDARY (#37 CTO review): the stored journal JSON is NOT
      // disclosed as-is. EvidenceService.append accepts caller-supplied
      // payloads, and provider-side minimization is not universal proof about
      // every writer — so the API projects an explicit per-event-type public
      // allowlist of scalar fields. Unrecognized event types → payload null.
      payload: projectEvidencePayload(String(row.type), safeJsonParse(row.payload_json)),
      recordedAt: String(row.recorded_at),
    }));
    const view: MissionEvidenceListView = { missionId, events };
    return view;
  });
}

/**
 * Public evidence-payload projection (#37 CTO review, final follow-up). For
 * every event type the engine journals today, ONLY these top-level fields are
 * disclosed to viewer sessions, and each value must pass the field's format
 * validator. Three disclosure rules, deliberately conservative:
 *
 *  1. NO FREE TEXT. Unstructured strings (reason, message, note) are never
 *     disclosed — a field-name allowlist cannot sanitize the CONTENTS of free
 *     text, so the text simply does not cross the wire. Operator narration
 *     remains in the journal and in server-side tooling.
 *  2. EXPLICIT TYPES ONLY. Both the tabulated types above and the exact set
 *     of known state-transition types below are enumerated; ANY unrecognized
 *     type — including unknown `operation.*` names — yields `payload: null`
 *     (the event stays listed with its integrity digest).
 *  3. VALIDATED FORMATS. Every disclosed value must match a strict engine
 *     shape (ids, state names, machine codes, ISO timestamps, structured
 *     `namespace:id[:suffix]` event keys). Anything else is dropped/null.
 *
 * The stored journal itself is untouched — projection is read-time only.
 * The tables were derived from an audit of every EvidenceService.append
 * writer (plans, mandates, authority, reservations, worker); adding a new
 * journaling call site REQUIRES extending this projection deliberately.
 */
// --- format validators: the only shapes that may cross the viewer boundary ---
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NON_NEGATIVE_INT = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const LOWER_WORD = /^[a-z][a-z0-9_-]{0,39}$/; // hyphens: engine enums use them (provider-readback, status-unknown)
const UPPER_WORDISH = /^[A-Za-z0-9_.-]{1,60}$/; // provider states (PAID, NO_TRANSFER_FOR_REQUEST_ID…)
const CURRENCY = /^[A-Z]{3}$/;
const HEXISH = /^[0-9a-f]{8,128}$/; // digests (sha256 hex)
const ISO_OR_EMPTY = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
const MACHINE_CODE = /^[A-Z][A-Z0-9_]{0,47}$/;
const LOWER_WORD_ARRAY = (v: unknown) =>
  Array.isArray(v) && v.every((item) => typeof item === 'string' && LOWER_WORD.test(item));
/** Engine event keys are structured `namespace:id[:suffix…]` — never free text. */
const SAFE_EVENT_KEY = /^[a-z][a-z0-9_]*(?::[A-Za-z0-9_.+-]{1,80}){1,8}$/;
const SAFE_EVENT_TYPE = /^[a-z][a-z0-9_.]{2,60}$/;

type FieldRule = readonly [string, RegExp | ((v: unknown) => boolean)];

const EVIDENCE_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly FieldRule[]>> = {
  'approval.granted': [
    ['approvalId', ID],
    ['planId', ID],
    ['planVersion', NON_NEGATIVE_INT],
    ['planDigest', HEXISH],
    ['decidedBy', ID],
    ['kind', LOWER_WORD],
    ['mandateId', ID],
    ['mandateVersion', NON_NEGATIVE_INT],
    ['expiresAt', ISO_OR_EMPTY],
  ],
  'approval.revoked': [
    ['approvalId', ID],
    ['by', ID], // reason (free text) deliberately NOT disclosed
  ],
  'mandate.issued': [
    ['mandateId', ID],
    ['version', NON_NEGATIVE_INT],
    ['currency', CURRENCY],
    ['maxAmountMinor', NON_NEGATIVE_INT],
    ['totalBudgetMinor', NON_NEGATIVE_INT],
    ['rails', LOWER_WORD_ARRAY],
    ['by', ID],
  ],
  'mandate.revoked': [
    ['mandateId', ID],
    ['by', ID], // reason (free text) deliberately NOT disclosed
  ],
  'actor.created': [
    ['actorId', ID],
    ['role', LOWER_WORD], // username deliberately NOT disclosed
    ['kind', LOWER_WORD],
  ],
  'actor.revoked': [
    ['actorId', ID],
    ['by', ID], // username deliberately NOT disclosed
  ],
  'session.created': [
    ['actorId', ID],
    ['expiresAt', ISO_OR_EMPTY],
  ],
  'grant.created': [
    ['grantId', ID],
    ['actorId', ID],
    ['by', ID],
  ],
  'grant.revoked': [
    ['missionId', ID],
    ['actorId', ID],
    ['by', ID],
  ],
  'reservation.denied': [
    ['requestId', ID],
    ['code', MACHINE_CODE], // message (free text) deliberately NOT disclosed
  ],
  'operation.reserved': [
    ['operationId', ID],
    ['requestId', ID],
    ['kind', LOWER_WORD],
    ['amountMinor', NON_NEGATIVE_INT],
    ['currency', CURRENCY],
    ['beneficiary', ID],
    ['planDigest', HEXISH],
    ['approvalId', ID],
  ],
  'dispatch.attempt': [
    ['dispatchId', ID],
    ['requestId', ID],
    ['attempt', NON_NEGATIVE_INT],
  ],
  'dispatch.result': [
    ['dispatchId', ID],
    ['requestId', ID],
    ['providerStatus', LOWER_WORD],
    ['providerState', UPPER_WORDISH],
  ],
  'dispatch.unknown': [
    ['dispatchId', ID],
    ['requestId', ID], // raw error text deliberately NOT disclosed
  ],
  'dispatch.blocked': [
    ['dispatchId', ID],
    ['requestId', ID],
    ['operationId', ID], // reason (free text) deliberately NOT disclosed
  ],
  'dispatch.reconcile': [
    ['dispatchId', ID],
    ['requestId', ID],
    ['providerStatus', LOWER_WORD],
    ['providerState', UPPER_WORDISH],
    ['verifiedAt', ISO_OR_EMPTY],
  ],
  'settlement.reversed': [
    ['dispatchId', ID],
    ['requestId', ID],
    ['providerState', UPPER_WORDISH], // note (free text) deliberately NOT disclosed
  ],
  'settlement.reversed.after_reconciled': [
    ['dispatchId', ID],
    ['requestId', ID],
    ['providerState', UPPER_WORDISH],
  ],
};

/**
 * The exact state-transition event types the engine journals via
 * reservations.transition (`operation.${to.toLowerCase()}`), enumerated so an
 * unrecognized `operation.*` name from any future writer gets payload null
 * instead of wildcard treatment. `operation.reserved` is tabulated above
 * (its payload is richer than a plain transition).
 */
const TRANSITION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'operation.submitting',
  'operation.in_flight',
  'operation.settled',
  'operation.reconciled',
  'operation.rejected',
  'operation.expired',
  'operation.status_unknown',
  'operation.cancelled',
  'operation.requires_human',
]);

function passesRule(value: unknown, rule: RegExp | ((v: unknown) => boolean)): boolean {
  if (typeof rule === 'function') return rule(value);
  return typeof value === 'string' && rule.test(value);
}

function projectEvidencePayload(type: string, raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const applyRules = (rules: readonly FieldRule[]): void => {
    for (const [key, rule] of rules) {
      if (key in record && passesRule(record[key], rule)) out[key] = record[key];
    }
  };

  if (type === 'mission.event.ingested') {
    // Only explicitly validated provenance scalars escape the operational journal.
    // Never expose nested observations, signatures, source keys or raw payload JSON.
    const event = record.event;
    if (event === null || typeof event !== 'object' || Array.isArray(event)) return null;
    const item = event as Record<string, unknown>;
    const src = item.source;
    const source = src !== null && typeof src === 'object' && !Array.isArray(src)
      ? (src as Record<string, unknown>) : null;
    if (passesRule(item.eventId, ID)) out.eventId = item.eventId;
    if (passesRule(item.assetId, ID)) out.assetId = item.assetId;
    if (passesRule(item.observedAt, ISO_OR_EMPTY)) out.observedAt = item.observedAt;
    if (passesRule(record.eventDigest, HEXISH)) out.eventDigest = record.eventDigest;
    if (source !== null && passesRule(source.sourceId, ID)) out.sourceId = source.sourceId;
    if (source !== null &&
        (source.provenance === 'SYNTHETIC' || source.provenance === 'FIELD'))
      out.provenance = source.provenance;
  } else if (EVIDENCE_PAYLOAD_ALLOWLIST[type] !== undefined) {
    applyRules(EVIDENCE_PAYLOAD_ALLOWLIST[type]!);
  } else if (TRANSITION_EVENT_TYPES.has(type)) {
    // Known state transitions: identifiers + state names only. The
    // attestation projects to its validated SOURCE — the note is free text
    // and is never disclosed.
    applyRules([
      ['operationId', ID],
      ['from', UPPER_WORDISH],
      ['to', UPPER_WORDISH],
    ]);
    const attestation = record.attestation;
    if (attestation !== null && typeof attestation === 'object' && !Array.isArray(attestation)) {
      const source = (attestation as Record<string, unknown>).source;
      if (typeof source === 'string' && LOWER_WORD.test(source)) {
        out.attestation = { source };
      }
    }
  } else {
    return null; // unrecognized type (incl. unknown operation.*): digest only
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Viewer-safe event metadata: structured event key and type, or null. */
function safeEventKey(eventKey: string): string | null {
  return SAFE_EVENT_KEY.test(eventKey) ? eventKey : null;
}
function safeEventType(type: string): string | null {
  return SAFE_EVENT_TYPE.test(type) ? type : null;
}

/** Parse stored journal JSON without ever throwing on malformed legacy rows. */
function safeJsonParse(raw: unknown): unknown {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Operation columns shared by the list and the single-get enrichment (#34). */
const OPERATION_COLUMNS = `o.id, o.mission_id, o.kind, o.request_id, o.state, o.plan_id, o.plan_version,
  o.amount_minor, o.currency, o.beneficiary, o.purpose, o.created_at, o.updated_at,
  c.state AS commitment_state, c.finalized_at AS commitment_finalized_at,
  x.id AS dispatch_id, x.rail AS dispatch_rail, x.attempts AS dispatch_attempts, x.status AS dispatch_status`;

/** Fetch one operation row (org-scoped) in the shared enrichment shape. */
function orgOperationRow(
  ledger: Ledger,
  orgId: string,
  operationId: string,
): Record<string, unknown> {
  const row = ledger.db
    .prepare(
      `SELECT ${OPERATION_COLUMNS}
         FROM operations o
         LEFT JOIN commitments c ON c.operation_id = o.id
         LEFT JOIN outbox_dispatches x ON x.operation_id = o.id
        WHERE o.org_id = ? AND o.id = ?`,
    )
    .get(orgId, operationId) as Record<string, unknown> | undefined;
  if (row === undefined) {
    // getOperation above already proved existence within this org; a miss
    // here means the join shape drifted — fail closed rather than guess.
    throw new LedgerError(
      'OPERATION_NOT_FOUND',
      `operation ${operationId} not found for organization`,
    );
  }
  return row;
}

/** Exact money formatting: minor-unit integer plus the domain major string (never floats). */
function moneyView(currency: string, minorUnits: number): MoneyView {
  return { minorUnits, major: toMajorString(createMoney(currency, minorUnits)) };
}

/**
 * Commitment-state sums for one org/currency (#34). `observedAt` splits the
 * settled bucket exactly like the engine's spendable math: a settlement keeps
 * consuming capacity until a balance snapshot NEWER than the settlement is
 * observed. When no snapshot exists the split is reported as null (unknown),
 * never guessed.
 */
function commitmentBreakdown(
  ledger: Ledger,
  orgId: string,
  currency: string,
  observedAt: string | null,
): CommitmentBreakdownView {
  const rows = ledger.db
    .prepare(
      `SELECT state, COALESCE(SUM(amount_minor), 0) AS total
         FROM commitments WHERE org_id = ? AND currency = ? GROUP BY state`,
    )
    .all(orgId, currency) as { state: string; total: number }[];
  const byState = new Map(rows.map((r) => [r.state, r.total]));
  const reservedMinor = byState.get('reserved') ?? 0;
  const unknownMinor = byState.get('unknown') ?? 0;
  const settledTotalMinor = byState.get('settled') ?? 0;
  const releasedMinor = byState.get('released') ?? 0;
  if (observedAt === null) {
    return {
      reservedMinor,
      unknownMinor,
      settledPendingObservationMinor: null,
      settledTotalMinor,
      releasedMinor,
      totalOutstandingMinor: null,
    };
  }
  const settledPendingRow = ledger.db
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS total
         FROM commitments
        WHERE org_id = ? AND currency = ? AND state = 'settled'
          AND finalized_at IS NOT NULL AND finalized_at >= ?`,
    )
    .get(orgId, currency, observedAt) as { total: number };
  const settledPending = settledPendingRow.total;
  return {
    reservedMinor,
    unknownMinor,
    settledPendingObservationMinor: settledPending,
    settledTotalMinor,
    releasedMinor,
    totalOutstandingMinor: reservedMinor + unknownMinor + settledPending,
  };
}

/** Human-attention classification shared by list and detail (#34). */
function attentionFor(state: string): AttentionLevel {
  if (state === 'REQUIRES_HUMAN') return 'human';
  if (state === 'STATUS_UNKNOWN') return 'ambiguous';
  return 'none';
}

/** Shape one operation row for the API (list + detail agree). */
function enrichOperationRow(ledger: Ledger, row: Record<string, unknown>): OperationReadView {
  void ledger;
  const currency = String(row.currency);
  const amountMinor = row.amount_minor as number;
  const hasDispatch = row.dispatch_id !== null && row.dispatch_id !== undefined;
  return {
    id: String(row.id),
    missionId: String(row.mission_id),
    kind: String(row.kind),
    requestId: String(row.request_id),
    state: String(row.state),
    attention: attentionFor(String(row.state)),
    amount: { currency, ...moneyView(currency, amountMinor) },
    beneficiary: String(row.beneficiary),
    purpose: String(row.purpose),
    planId: String(row.plan_id),
    planVersion: row.plan_version as number,
    commitment: {
      state: String(row.commitment_state),
      finalizedAt:
        row.commitment_finalized_at === null || row.commitment_finalized_at === undefined
          ? null
          : String(row.commitment_finalized_at),
    },
    // Null until an outbox dispatch exists; a queued dispatch with no rail
    // claim yet reports rail: null rather than pretending a rail was chosen.
    dispatch: hasDispatch
      ? {
          rail:
            row.dispatch_rail === null || row.dispatch_rail === undefined
              ? null
              : String(row.dispatch_rail),
          attempts: (row.dispatch_attempts as number) ?? 0,
          status: String(row.dispatch_status),
        }
      : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
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
