/**
 * REVIEWER_DEMO — hosted, explicitly-enabled reviewer capability (issues
 * #17/#19/E3). Registered ONLY when MOTERVA_REVIEWER_DEMO=1 AND a production
 * identity is configured; otherwise these routes do not exist at all
 * (fail-closed 404 via the app not-found handler).
 *
 * What it adds for an authenticated OIDC org member with the operator role
 * or above: provisioning of their OWN sandbox mission, admission of the
 * FIXED signed synthetic baseline/incident scenario through the SAME
 * validated mission-event ingest pipeline the local demo uses, and a safe
 * reset (a fresh successor mission — the append-only journal is never
 * rewritten). The rest of the journey (durable evaluations, immutable plan
 * proposals, separate human approval) flows through the EXISTING governed
 * production routes; nothing here touches provider dispatch or authority.
 *
 * Hardening beyond the loopback demo route:
 *  - session-bound CSRF on every mutation (same csrfOk contract);
 *  - per-actor fixed-window rate limits on every route (in-memory — the
 *    deployment is a single writer by design);
 *  - strict per-reviewer ownership: steps are accepted only for the
 *    caller's own reviewer mission (title prefix bound to the username);
 *  - fixed scenario catalog: no request field can influence observations,
 *    signatures, amounts or beneficiaries — the client sends only a step.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ledger } from '@moterva/ledger';
import { guard, csrfOk } from '../auth.js';
import { stepEventId } from '../integration/demo-routes.js';
import { MissionEventIngestService } from '../mission-events/src/ingest.js';
import { SourceRegistry, type RegisteredSource } from '../mission-events/src/registry.js';
import { sourceSignature } from '../mission-events/src/digest.js';
import { fixtureSourceKey } from '../mission-events/src/rng.js';
import type { NormalizedEvent } from '../mission-events/src/schema.js';

const ASSET_ID = 'uav-seeker-1';
const MISSION_TITLE_PREFIX = 'reviewer-demo:';
const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

/** Fixed-window limiter, keyed per actor and action (single instance). */
class PerActorRateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string, now: number): boolean {
    const entry = this.hits.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (entry.count >= this.max) return false;
    entry.count += 1;
    return true;
  }
}

/**
 * Synthetic source registration — the EXACT demo-catalog derivation (same
 * sourceId/keyId/fixture secret and event-id scheme as the loopback demo and
 * the decision-snapshot evaluation path import from demo-routes). This is
 * deliberate: the signed synthetic scenario is ONE approved catalog, and the
 * governed evaluation routes must be able to verify and evaluate exactly
 * these events — a divergent derivation would silently dead-end the journey.
 */
function sourceFor(orgId: string, missionId: string): RegisteredSource {
  const suffix = createHash('sha256')
    .update(orgId + ':' + missionId)
    .digest('hex')
    .slice(0, 16);
  return {
    orgId,
    missionId,
    sourceId: 'ops-console',
    sourceType: 'mission_control',
    keyId: 'key_demo_' + suffix,
    secretKey: fixtureSourceKey('synthetic-demo-only-' + suffix, 'ops-console'),
    provenance: 'SYNTHETIC',
    assetIds: [ASSET_ID],
    trustedForRecovery: false,
  };
}

const OBSERVATIONS = {
  baseline: [
    { kind: 'wind_speed', unit: 'kt', value: '14.2' },
    { kind: 'weather_hold', unit: 'state', value: 'clear' },
    { kind: 'asset_comms', unit: 'state', value: 'online' },
  ],
  incident: [
    { kind: 'wind_speed', unit: 'kt', value: '24.6' },
    { kind: 'weather_hold', unit: 'state', value: 'active' },
  ],
} as const;

/**
 * Admitted-scenario stage from the real ingest replay. Decisions are NEVER
 * computed here — they come from the governed decision-snapshot routes
 * (recorded evaluations, immutable proposals), so this module cannot drift
 * from the planner or manufacture an economic claim.
 */
function stageFor(
  ledger: Ledger,
  orgId: string,
  missionId: string,
): 'empty' | 'baseline' | 'incident' {
  const { service } = reviewerServiceFor(ledger, orgId, missionId);
  const events = service.replay(orgId, missionId).events;
  const has = (step: 'baseline' | 'incident') =>
    events.some((e) => e.eventId === stepEventId(orgId, missionId, step));
  return has('incident') ? 'incident' : has('baseline') ? 'baseline' : 'empty';
}

function reviewerServiceFor(ledger: Ledger, orgId: string, missionId: string) {
  const registry = new SourceRegistry();
  const source = sourceFor(orgId, missionId);
  registry.register(source);
  return { source, service: new MissionEventIngestService(ledger, ledger.clock, registry) };
}

interface ReviewerMission {
  readonly missionId: string;
  readonly title: string;
}

/** The actor's CURRENT reviewer mission = highest numeric suffix on the title. */
function currentReviewerMission(
  ledger: Ledger,
  orgId: string,
  username: string,
): ReviewerMission | null {
  const prefix = MISSION_TITLE_PREFIX + username + ':';
  const rows = ledger.db
    .prepare('SELECT id, title FROM missions WHERE org_id = ? AND title LIKE ?')
    .all(orgId, prefix + '%') as Array<{ id: string; title: string }>;
  let best: { missionId: string; title: string; n: number } | null = null;
  for (const row of rows) {
    const n = Number.parseInt(row.title.slice(prefix.length), 10);
    if (!Number.isSafeInteger(n)) continue;
    if (best === null || n > best.n) best = { missionId: row.id, title: row.title, n };
  }
  return best === null ? null : { missionId: best.missionId, title: best.title };
}

function provisionReviewerMission(
  ledger: Ledger,
  orgId: string,
  username: string,
  byActorId: string,
): ReviewerMission {
  const prefix = MISSION_TITLE_PREFIX + username + ':';
  const existing = ledger.db
    .prepare('SELECT COUNT(*) AS c FROM missions WHERE org_id = ? AND title LIKE ?')
    .get(orgId, prefix + '%') as { c: number };
  const mission = ledger.organizations.createMission(
    orgId,
    `${prefix}${existing.c + 1} (SYNTHETIC sandbox)`,
  );
  ledger.accounts.ensureTreasuryAccount({
    orgId,
    currency: 'USD',
    label: 'Reviewer demo USD treasury',
    protectedFloorMinor: 0,
  });
  ledger.accounts.recordBalanceSnapshot({
    orgId,
    currency: 'USD',
    minorUnits: 8_000_000,
    source: 'manual-seed',
    observedAt: ledger.clock.iso(),
    expiresAt: new Date(ledger.clock.now().getTime() + 24 * 3_600_000).toISOString(),
  });
  ledger.mandates.issue({
    orgId,
    missionId: mission.id,
    currency: 'USD',
    maxAmountMinor: 4_000_000,
    totalBudgetMinor: 4_000_000,
    permittedOperationKinds: ['airwallex_transfer'],
    allowedBeneficiaries: ['harbor-diagnostics', 'harbor-marine'],
    allowedPurposes: ['harbor inspection'],
    byActorId,
    expiresAt: new Date(ledger.clock.now().getTime() + 26 * 3_600_000).toISOString(),
  });
  return { missionId: mission.id, title: mission.title };
}

/**
 * Registers the reviewer-demo routes. Call ONLY from the authenticated
 * scope when config.reviewerDemo && config.identity !== null (enforced by
 * the caller; the config layer refuses REVIEWER_DEMO without identity).
 */
export function registerReviewerDemoRoutes(app: FastifyInstance, ledger: Ledger): void {
  const missionLimiter = new PerActorRateLimiter(5, 60 * 60_000); // 5 provisions/hour
  const resetLimiter = new PerActorRateLimiter(3, 60 * 60_000); // 3 resets/hour
  const stepLimiter = new PerActorRateLimiter(30, 5 * 60_000); // 30 admissions/5 min

  function usernameOf(ledgerActor: { username: string }): string | null {
    return USERNAME_PATTERN.test(ledgerActor.username) ? ledgerActor.username : null;
  }

  app.get('/api/reviewer-demo/state', async (request, reply) => {
    const g = guard(request, reply, 'read');
    if ('blocked' in g) return reply;
    const username = usernameOf(g.actor);
    if (username === null) {
      return reply.code(403).send({ error: { code: 'REVIEWER_DEMO_USERNAME_UNSUPPORTED' } });
    }
    const mission = currentReviewerMission(ledger, g.actor.orgId, username);
    if (mission === null) {
      return { reviewerDemo: true, mission: null, stage: 'empty' };
    }
    const stage = stageFor(ledger, g.actor.orgId, mission.missionId);
    return {
      reviewerDemo: true,
      mission: { id: mission.missionId, title: mission.title },
      stage,
      // Evaluations/proposals are read via the governed routes:
      // GET /api/missions/:id/decision-snapshots · /decision-plans
      nextSteps: stage === 'empty' ? ['baseline'] : stage === 'baseline' ? ['incident'] : [],
    };
  });

  app.post('/api/reviewer-demo/mission', async (request, reply) => {
    const g = guard(request, reply, 'operate');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const username = usernameOf(g.actor);
    if (username === null) {
      return reply.code(403).send({ error: { code: 'REVIEWER_DEMO_USERNAME_UNSUPPORTED' } });
    }
    if (!missionLimiter.allow(g.actor.id, Date.now())) {
      return reply.code(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: 'reviewer mission provisioning limit reached; retry later',
        },
      });
    }
    const existing = currentReviewerMission(ledger, g.actor.orgId, username);
    if (existing !== null) {
      // Idempotent: one reviewer sandbox per actor until reset.
      return { mission: { id: existing.missionId, title: existing.title }, replayed: true };
    }
    const mission = provisionReviewerMission(ledger, g.actor.orgId, username, g.actor.id);
    return { mission: { id: mission.missionId, title: mission.title }, replayed: false };
  });

  app.post('/api/reviewer-demo/mission/reset', async (request, reply) => {
    const g = guard(request, reply, 'operate');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const username = usernameOf(g.actor);
    if (username === null) {
      return reply.code(403).send({ error: { code: 'REVIEWER_DEMO_USERNAME_UNSUPPORTED' } });
    }
    if (!resetLimiter.allow(g.actor.id, Date.now())) {
      return reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: 'reviewer reset limit reached; retry later' },
      });
    }
    // Safe reset = a FRESH successor mission; the append-only journal of the
    // previous sandbox is preserved (nothing is deleted or rewritten).
    const mission = provisionReviewerMission(ledger, g.actor.orgId, username, g.actor.id);
    return { mission: { id: mission.missionId, title: mission.title } };
  });

  app.post('/api/missions/:missionId/reviewer-synthetic-step', async (request, reply) => {
    const g = guard(request, reply, 'operate');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const username = usernameOf(g.actor);
    if (username === null) {
      return reply.code(403).send({ error: { code: 'REVIEWER_DEMO_USERNAME_UNSUPPORTED' } });
    }
    if (!stepLimiter.allow(g.actor.id, Date.now())) {
      return reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: 'synthetic admission limit reached; retry later' },
      });
    }
    const missionId = (request.params as { missionId: string }).missionId;
    const step = (request.body as { step?: unknown } | null)?.step;
    if (step !== 'baseline' && step !== 'incident') {
      return reply.code(400).send({ error: { code: 'INVALID_STEP' } });
    }
    let mission: { id: string; title: string };
    try {
      const view = ledger.organizations.getMission(g.actor.orgId, missionId);
      mission = { id: view.id, title: view.title };
    } catch {
      return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    }
    // Strict per-reviewer ownership: only the caller's own sandbox.
    if (!mission.title.startsWith(MISSION_TITLE_PREFIX + username + ':')) {
      return reply.code(403).send({ error: { code: 'NOT_YOUR_REVIEWER_MISSION' } });
    }
    try {
      const { source, service } = reviewerServiceFor(ledger, g.actor.orgId, missionId);
      const existing = service.replay(g.actor.orgId, missionId);
      const id = stepEventId(g.actor.orgId, missionId, step);
      if (existing.events.some((event) => event.eventId === id)) {
        return { replayed: true, stage: step };
      }
      if (
        step === 'incident' &&
        !existing.events.some(
          (event) => event.eventId === stepEventId(g.actor.orgId, missionId, 'baseline'),
        )
      ) {
        return reply.code(409).send({ error: { code: 'BASELINE_REQUIRED' } });
      }
      const now = ledger.clock.iso();
      const event: NormalizedEvent = {
        contractVersion: 1,
        eventId: id,
        sequence: step === 'baseline' ? 1 : 2,
        orgId: g.actor.orgId,
        missionId,
        assetId: ASSET_ID,
        observedAt: now,
        ingestedAt: now,
        source: {
          sourceId: source.sourceId,
          sourceType: source.sourceType,
          keyId: source.keyId,
          provenance: source.provenance,
        },
        observations: OBSERVATIONS[step],
      };
      service.ingest(g.actor.orgId, {
        ...event,
        source: { ...event.source, signature: sourceSignature(event, source.secretKey) },
      });
      return {
        replayed: false,
        stage: step,
        disclaimer:
          'SYNTHETIC physical observations signed server-side; labeled provenance; never verified provider funds. No money is moved by this route.',
      };
    } catch (error) {
      request.log.error({ err: error }, 'reviewer synthetic step rejected');
      return reply.code(409).send({ error: { code: 'SYNTHETIC_ADMISSION_REJECTED' } });
    }
  });
}
