/**
 * Issue #19 / A1+A2 — durable, replayable planner decision snapshots and the
 * guarded bridge from a recorded evaluation to an immutable ledger plan.
 *
 * LAWS:
 *  - GET never journals: snapshots are recorded ONLY by the explicit,
 *    CSRF-protected POST below (an authorized state-changing operation).
 *  - Idempotency is keyed on ECONOMIC INTENT (stage + admitted event digests
 *    + policy core), not on the wall clock — a repeated POST after time has
 *    passed returns the ORIGINAL journaled decision; recomputing with a later
 *    clock is never treated as replaying the original.
 *  - The snapshot lives in the append-only evidence journal (payload_digest
 *    integrity verified on every read; payload is float-free because the
 *    journal digests via canonicalJson — probabilities are stored as integer
 *    basis points).
 *  - The plan proposal loads the SAVED evaluation server-side; the browser
 *    supplies only the evaluation id — never amount, payee, probability,
 *    quote or approval state. Constraints that must still hold are
 *    revalidated at proposal time; failures are explicit machine codes.
 *  - No provider call, no reservation, no approval happens here. Approval and
 *    execution remain with the existing /api/approvals + /api/operations
 *    reserve services and the ledger's own authority gates.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ledger } from '@moterva/ledger';
import { isLedgerError } from '@moterva/ledger';
import {
  evaluate,
  financialFacts,
  generateCandidates,
  reviewEvidence,
  type FinancialPolicy,
  type MissionEvidenceInput,
} from '@moterva/planner';
import { canonicalJson, termsDigest } from '@moterva/domain';
import { csrfOk, guard } from '../auth.js';
import { MissionEventIngestService } from '../mission-events/src/ingest.js';
import { SourceRegistry } from '../mission-events/src/registry.js';
import { fixtureSourceKey } from '../mission-events/src/rng.js';
import type { MissionTimelineView } from '../mission-events/src/view.js';
import { physicalTimelineToPlannerSafety } from './physical-to-planner.js';

export const SNAPSHOT_TYPE = 'planner.decision.snapshot';
export const PLAN_PROPOSED_TYPE = 'planner.plan.proposed';
const SNAPSHOT_VERSION = 1;

// Catalog mirrors the demo-routes constants (single source of truth would be
// nicer, but demo-routes is C-reviewed frozen scope; values are asserted
// equal by test to prevent drift).
export const DECISION_CATALOG = {
  assetId: 'uav-seeker-1',
  windLimitKt: 22,
  incumbent: {
    id: 'uav-inspection',
    beneficiary: 'harbor-diagnostics',
    purpose: 'harbor inspection',
    currency: 'USD',
    baseCostMinor: 1_200_000,
  },
  alternative: {
    id: 'vessel-inspection',
    beneficiary: 'harbor-marine',
    purpose: 'harbor inspection',
    currency: 'USD',
    baseCostMinor: 1_800_000,
    feeMinor: 50_000,
  },
} as const;

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function snapshotServiceFor(ledger: Ledger, orgId: string, missionId: string) {
  const registry = new SourceRegistry();
  const suffix = sha(orgId + ':' + missionId).slice(0, 16);
  registry.register({
    orgId,
    missionId,
    sourceId: 'ops-console',
    sourceType: 'mission_control',
    keyId: 'key_demo_' + suffix,
    secretKey: fixtureSourceKey('synthetic-demo-only-' + suffix, 'ops-console'),
    provenance: 'SYNTHETIC',
    assetIds: [DECISION_CATALOG.assetId],
    trustedForRecovery: false,
  });
  return new MissionEventIngestService(ledger, ledger.clock, registry);
}

/** The full evaluation context behind a decision (planner + bridge + facts). */
export function evaluateMission(
  ledger: Ledger,
  orgId: string,
  missionId: string,
  timeline: MissionTimelineView,
) {
  const now = new Date(timeline.asOf);
  const tenant = { orgId, missionId };
  const safety = physicalTimelineToPlannerSafety(timeline, {
    ...tenant,
    asOf: now,
    uavWindLimitKt: DECISION_CATALOG.windLimitKt,
  });
  const reviewed = reviewEvidence([...safety.evidence], now, tenant);
  const policy: FinancialPolicy = {
    version: 1,
    currency: 'USD',
    missionDeadlineAt: new Date(now.getTime() + 12 * 3_600_000).toISOString(),
    missionValueMinor: 5_000_000,
    failureCostMinor: 1_500_000,
    protectedReserveMinor: 50_000,
    maxProbabilityAssumption: 0.95,
    unconfirmedAvailabilityFactor: 0.5,
    diagnosticValueThreshold: 1,
    forbidUnconfirmedAvailability: false,
    escalationScoreGap: 10_000,
  };
  const facts = financialFacts(ledger, orgId, missionId, 'USD');
  const candidates = generateCandidates(reviewed.accepted, {
    now,
    policyCurrency: 'USD',
    missionDeadlineAt: policy.missionDeadlineAt,
    incumbent: {
      ...DECISION_CATALOG.incumbent,
      kind: 'inspection-service',
      feeMinor: 0,
      leadTimeMinutes: 60,
      durationMinutes: 180,
      probabilityOfSuccess: 0.9,
      availability: 'confirmed',
    },
    incumbentAssetId: DECISION_CATALOG.assetId,
    alternatives: [
      {
        ...DECISION_CATALOG.alternative,
        kind: 'inspection-service',
        leadTimeMinutes: 45,
        durationMinutes: 180,
        probabilityOfSuccess: 0.85,
        availability: 'confirmed',
      },
    ],
  });
  const decision = evaluate({
    now,
    policy,
    facts,
    evidence: reviewed,
    candidates,
    modelAdapterId: null,
  });
  return { decision, reviewed, safety, policy, facts, timeline, now };
}

/** Economic-intent identity: stage + admitted event digests + policy core. */
function intentKey(
  stage: string,
  accepted: readonly { eventId: string; digest: string }[],
  policy: FinancialPolicy,
  orgId: string,
  missionId: string,
  authority: string,
): string {
  const events = [...accepted]
    .map((e) => `${e.eventId}:${e.digest}`)
    .sort()
    .join('|');
  const policyCore = canonicalJson({
    currency: policy.currency,
    missionValueMinor: policy.missionValueMinor,
    failureCostMinor: policy.failureCostMinor,
    protectedReserveMinor: policy.protectedReserveMinor,
    maxProbabilityAssumptionBps: Math.round(policy.maxProbabilityAssumption * 10_000),
  });
  // Authority identity (mandate id@version, or 'none') is part of the
  // intent: a mandate change after an evaluation REQUIRES a new snapshot —
  // and re-recording must be possible, never deadlocked by the old row.
  // Balance movements deliberately do NOT fork the intent; the proposal
  // revalidation catches them (FINANCIAL_STATE_CHANGED).
  return sha(`${orgId}|${missionId}|${stage}|${events}|${policyCore}|${authority}`).slice(0, 32);
}

interface StoredSnapshot {
  readonly seq: number;
  readonly eventKey: string;
  readonly payload: Record<string, unknown>;
}

/** Read + digest-verify every snapshot of a mission (integrity-enforcing). */
export function loadSnapshots(ledger: Ledger, orgId: string, missionId: string): StoredSnapshot[] {
  const rows = ledger.db
    .prepare(
      `SELECT seq, event_key, payload_digest, payload_json FROM evidence_events
        WHERE org_id = ? AND mission_id = ? AND type = ?
        ORDER BY seq DESC`,
    )
    .all(orgId, missionId, SNAPSHOT_TYPE) as {
    seq: number;
    event_key: string;
    payload_digest: string;
    payload_json: string;
  }[];
  const out: StoredSnapshot[] = [];
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const digest = sha(canonicalJson(payload));
    if (digest !== row.payload_digest) {
      // Journal integrity violation: fail the whole read rather than serve a
      // tampered decision history.
      throw new Error(`SNAPSHOT_INTEGRITY_VIOLATION:${row.event_key}`);
    }
    out.push({ seq: row.seq, eventKey: row.event_key, payload });
  }
  return out;
}

function buildSnapshotPayload(
  ctx: ReturnType<typeof evaluateMission>,
  stage: 'baseline' | 'incident',
  linkage: { baselineEvaluationId: string | null },
): Record<string, unknown> {
  const { decision, safety, facts, policy, timeline, now } = ctx;
  const selected =
    decision.selected === null
      ? null
      : {
          candidateId: decision.selected.candidate.id,
          kind: decision.selected.candidate.kind,
          label: decision.selected.candidate.label,
          grossMinor: decision.selected.grossCostMinor,
          currency: decision.selected.candidate.currency,
          beneficiary: decision.selected.candidate.beneficiary,
          purpose: decision.selected.candidate.purpose,
          expectedNetMinor: decision.selected.expectedNetMinor,
          probabilityBps: Math.round(decision.selected.effectiveProbability * 10_000),
          evidenceIds: [...decision.selected.candidate.evidenceIds],
        };
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    stage,
    evaluationId: decision.trace.evaluationId,
    recordedAt: now.toISOString(),
    orgId: timeline.orgId,
    missionId: timeline.missionId,
    acceptedEvents: safety.evidence.map((e: MissionEvidenceInput) => ({
      eventId: e.event.id,
      sourceId: e.source.physicalSourceId ?? 'unknown-source',
      digest: e.source.digest,
      observedAt: e.event.observedAt,
      sequence: e.event.sequence,
    })),
    withheldEventIds: [...safety.withheldEventIds],
    physical: {
      asOf: now.toISOString(),
      acceptedCount: safety.evidence.length,
      withheldCount: safety.withheldEventIds.length,
    },
    facts: {
      currency: facts.currency,
      balanceStatus: facts.balanceStatus,
      spendableMinor: facts.spendableMinor,
      outstandingCommittedMinor: facts.outstandingCommittedMinor,
      mandateId: facts.mandate?.id ?? 'none',
      mandateVersion: facts.mandate?.version ?? 0,
      mandateExpiresAt: facts.mandate?.expiresAt ?? 'none',
    },
    policy: {
      version: policy.version,
      missionDeadlineAt: policy.missionDeadlineAt,
      missionValueMinor: policy.missionValueMinor,
      failureCostMinor: policy.failureCostMinor,
      protectedReserveMinor: policy.protectedReserveMinor,
      truthLabel: decision.trace.truthLabel,
    },
    candidates: decision.trace.scores.map((s) => ({
      id: s.candidate.id,
      kind: s.candidate.kind,
      grossMinor: s.grossCostMinor,
      feasible: s.feasible,
      rejection: s.rejection?.code ?? 'none',
    })),
    decision: { outcome: decision.outcome, selected },
    linkage,
  };
}

/** Record (idempotently) the durable snapshot for one stage. */
export function recordSnapshot(
  ledger: Ledger,
  orgId: string,
  missionId: string,
  stage: 'baseline' | 'incident',
): { snapshot: StoredSnapshot; replayed: boolean } {
  const service = snapshotServiceFor(ledger, orgId, missionId);
  const timeline = service.replay(orgId, missionId);
  const ctx = evaluateMission(ledger, orgId, missionId, timeline);
  const { facts } = ctx;
  const baseline =
    stage === 'incident' ? latestSnapshot(ledger, orgId, missionId, 'baseline') : null;
  const payload = buildSnapshotPayload(ctx, stage, {
    baselineEvaluationId: baseline === null ? null : String(baseline.payload.evaluationId),
  });
  const key = intentKey(
    stage,
    payload.acceptedEvents as { eventId: string; digest: string }[],
    ctx.policy,
    orgId,
    missionId,
    facts.mandate === null ? 'none' : `${facts.mandate.id}@${String(facts.mandate.version)}`,
  );
  const eventKey = `planner-snapshot:v${String(SNAPSHOT_VERSION)}:${stage}:${key.slice(0, 24)}`;
  try {
    ledger.evidence.append({
      orgId,
      missionId,
      topic: 'operational',
      type: SNAPSHOT_TYPE,
      eventKey,
      payload,
    });
  } catch (error) {
    // Idempotent replay across requests AND restarts: the same economic
    // intent returns the ORIGINAL journaled snapshot untouched.
    if (isLedgerError(error) && error.code === 'DUPLICATE_EVENT') {
      const existing = loadSnapshots(ledger, orgId, missionId).find((s) => s.eventKey === eventKey);
      if (existing !== undefined) return { snapshot: existing, replayed: true };
    }
    throw error;
  }
  const stored = loadSnapshots(ledger, orgId, missionId).find((s) => s.eventKey === eventKey);
  if (stored === undefined) throw new Error('SNAPSHOT_WRITE_LOST');
  return { snapshot: stored, replayed: false };
}

export function latestSnapshot(
  ledger: Ledger,
  orgId: string,
  missionId: string,
  stage: 'baseline' | 'incident',
): StoredSnapshot | null {
  return loadSnapshots(ledger, orgId, missionId).find((s) => s.payload.stage === stage) ?? null;
}

export interface ProposalRejection {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/**
 * A2 — turn a RECORDED, still-valid evaluation into an immutable candidate
 * plan through ledger.plans.recordVersion. Every economic term comes from the
 * stored snapshot (revalidated), never from the request. Stable plan identity
 * per evaluation; identical re-proposals return the existing version.
 */
/**
 * Serialized admission boundary: every revalidation AND the plan/journal
 * writes commit together inside one BEGIN IMMEDIATE transaction, so two
 * concurrent proposals of the same evaluation cannot both pass against
 * pre-commit state — the loser either replays the identical committed plan
 * or fails closed. (Same discipline as the mission-event admission path.)
 */
export function proposePlanFromSnapshot(
  ledger: Ledger,
  orgId: string,
  missionId: string,
  evaluationId: string,
  proposedByActorId: string,
):
  | {
      plan: {
        id: string;
        version: number;
        digest: string;
        amountMinor: number;
        currency: string;
        beneficiary: string;
      };
      replayed: boolean;
    }
  | { rejected: ProposalRejection } {
  return ledger.db.transaction(
    () => proposePlanUnchecked(ledger, orgId, missionId, evaluationId, proposedByActorId),
    'immediate',
  );
}

function proposePlanUnchecked(
  ledger: Ledger,
  orgId: string,
  missionId: string,
  evaluationId: string,
  proposedByActorId: string,
):
  | {
      plan: {
        id: string;
        version: number;
        digest: string;
        amountMinor: number;
        currency: string;
        beneficiary: string;
      };
      replayed: boolean;
    }
  | { rejected: ProposalRejection } {
  const snapshots = loadSnapshots(ledger, orgId, missionId);
  const snapshot = snapshots.find((s) => s.payload.evaluationId === evaluationId);
  if (snapshot === undefined) {
    return {
      rejected: {
        status: 404,
        code: 'EVALUATION_NOT_FOUND',
        message: 'no durable snapshot for that evaluation id in this mission',
      },
    };
  }
  const decision = snapshot.payload.decision as {
    outcome: string;
    selected: null | {
      candidateId: string;
      grossMinor: number;
      currency: string;
      beneficiary: string;
      purpose: string;
      probabilityBps: number;
      expectedNetMinor: number;
      evidenceIds: string[];
    };
  };
  if (
    decision.outcome !== 'select' ||
    decision.selected === null ||
    decision.selected.grossMinor <= 0
  ) {
    return {
      rejected: {
        status: 409,
        code: 'DECISION_NOT_EXECUTABLE',
        message: `recorded outcome is ${decision.outcome}${decision.selected === null ? '' : ' with a zero-gross (no-action) selection'}; decline, escalation and no-action never produce an executable payment proposal`,
      },
    };
  }
  const selected = decision.selected;

  // ---- physical world must still support the cited evidence NOW.
  const service = snapshotServiceFor(ledger, orgId, missionId);
  const timeline = service.replay(orgId, missionId);
  const bridge = physicalTimelineToPlannerSafety(timeline, {
    orgId,
    missionId,
    asOf: ledger.clock.now(),
    uavWindLimitKt: DECISION_CATALOG.windLimitKt,
  });
  const admittedNow = new Set(bridge.evidence.map((e) => e.event.id));
  const stillAdmitted = selected.evidenceIds.every(
    (id) => admittedNow.has(id) && !bridge.withheldEventIds.includes(id),
  );
  if (!stillAdmitted) {
    return {
      rejected: {
        status: 409,
        code: 'EVIDENCE_STALE_OR_WITHHELD',
        message:
          'cited physical evidence is no longer admitted/planning-valid at proposal time; re-evaluate',
      },
    };
  }

  // ---- authority and funds must still hold NOW (ledger re-checks again at
  // approval and reservation; these pre-checks keep failures explicit).
  const facts = financialFacts(ledger, orgId, missionId, 'USD');
  const recordedFacts = snapshot.payload.facts as { mandateId: string; mandateVersion: number };
  if (facts.mandate === null) {
    return {
      rejected: {
        status: 409,
        code: 'AUTHORITY_CHANGED',
        message: 'no active mandate at proposal time',
      },
    };
  }
  if (
    facts.mandate.id !== recordedFacts.mandateId ||
    facts.mandate.version !== recordedFacts.mandateVersion
  ) {
    return {
      rejected: {
        status: 409,
        code: 'AUTHORITY_CHANGED',
        message: `mandate moved from v${String(recordedFacts.mandateVersion)} to v${String(facts.mandate.version)} after the evaluation; re-evaluate under the new authority`,
      },
    };
  }
  if (
    facts.mandate.allowedBeneficiaries.length > 0 &&
    !facts.mandate.allowedBeneficiaries.includes(selected.beneficiary)
  ) {
    return {
      rejected: {
        status: 409,
        code: 'BENEFICIARY_NOT_ALLOWED',
        message: `beneficiary ${selected.beneficiary} is no longer permitted`,
      },
    };
  }
  if (
    facts.mandate.allowedPurposes.length > 0 &&
    !facts.mandate.allowedPurposes.includes(selected.purpose)
  ) {
    return {
      rejected: {
        status: 409,
        code: 'PURPOSE_NOT_ALLOWED',
        message: `purpose ${selected.purpose} is no longer permitted`,
      },
    };
  }
  if (
    selected.grossMinor > facts.mandate.maxPerPaymentMinor ||
    selected.grossMinor > facts.mandate.remainingBudgetMinor
  ) {
    return {
      rejected: {
        status: 409,
        code: 'AUTHORITY_LIMIT_EXCEEDED',
        message: 'gross exceeds the per-payment cap or remaining mission budget',
      },
    };
  }
  if (facts.balanceStatus !== 'ok' || facts.spendableMinor === null) {
    return {
      rejected: {
        status: 409,
        code: 'FINANCIAL_STATE_CHANGED',
        message: `balance status ${facts.balanceStatus}: cannot commit against unverified funds`,
      },
    };
  }
  if (
    facts.spendableMinor - selected.grossMinor <
    Number((snapshot.payload.policy as { protectedReserveMinor: number }).protectedReserveMinor)
  ) {
    return {
      rejected: {
        status: 409,
        code: 'FINANCIAL_STATE_CHANGED',
        message: 'spendable no longer covers the gross plus the protected reserve',
      },
    };
  }

  // ---- immutable plan with a stable identity derived from the evaluation.
  const planId = 'plan_' + sha(`evaluation:${evaluationId}`).slice(0, 24);
  const terms = {
    amountMinor: selected.grossMinor,
    currency: selected.currency,
    beneficiary: selected.beneficiary,
    purpose: selected.purpose,
    quote: {
      evaluationId,
      snapshotEventKey: snapshot.eventKey,
      candidateId: selected.candidateId,
      probabilityBps: selected.probabilityBps,
      expectedNetMinor: selected.expectedNetMinor,
      evidenceIds: [...selected.evidenceIds],
      truthLabel: 'SIMULATED_OPERATION — POLICY-ONLY',
    },
  };
  const existing = ledger.db
    .prepare(
      'SELECT id, version, digest, terms_json FROM candidate_plans WHERE id = ? AND org_id = ? ORDER BY version DESC LIMIT 1',
    )
    .get(planId, orgId) as
    { id: string; version: number; digest: string; terms_json: string } | undefined;
  if (existing !== undefined) {
    // Idempotent: same evaluation → same terms digest → return the existing
    // version. A DIFFERENT digest for the same evaluation is a contradiction.
    // Same digest rules as the plan service (termsDigest over canonical JSON).
    const newDigest = termsDigest(terms as Record<string, unknown>);
    if (existing.digest === newDigest) {
      const storedTerms = JSON.parse(existing.terms_json) as {
        amountMinor: number;
        currency: string;
        beneficiary: string;
      };
      return {
        plan: {
          id: existing.id,
          version: existing.version,
          digest: existing.digest,
          amountMinor: storedTerms.amountMinor,
          currency: storedTerms.currency,
          beneficiary: storedTerms.beneficiary,
        },
        replayed: true,
      };
    }
    return {
      rejected: {
        status: 409,
        code: 'EVALUATION_TERMS_CONFLICT',
        message:
          'a different plan already exists for this evaluation id; refusing to overwrite immutable terms',
      },
    };
  }

  const plan = ledger.plans.recordVersion({
    orgId,
    missionId,
    planId,
    proposedBy: proposedByActorId,
    terms: terms as Parameters<typeof ledger.plans.recordVersion>[0]['terms'],
  });
  // Journal the proposal (idempotent).
  try {
    ledger.evidence.append({
      orgId,
      missionId,
      topic: 'operational',
      type: PLAN_PROPOSED_TYPE,
      eventKey: `planner-plan-proposed:v1:${evaluationId}`,
      payload: {
        evaluationId,
        planId: plan.id,
        planVersion: plan.version,
        planDigest: plan.digest,
        proposedBy: proposedByActorId,
        grossMinor: selected.grossMinor,
        currency: selected.currency,
      },
    });
  } catch (error) {
    if (!(isLedgerError(error) && error.code === 'DUPLICATE_EVENT')) throw error;
  }
  return {
    plan: {
      id: plan.id,
      version: plan.version,
      digest: plan.digest,
      amountMinor: selected.grossMinor,
      currency: selected.currency,
      beneficiary: selected.beneficiary,
    },
    replayed: false,
  };
}

/** Register the decision→authority routes (DEMO_AUTH scope only). */
export function registerDecisionAuthorityRoutes(app: FastifyInstance, ledger: Ledger): void {
  app.get('/api/missions/:missionId/decision-snapshots', async (request, reply) => {
    const g = guard(request, reply, 'read');
    if ('blocked' in g) return reply;
    const missionId = (request.params as { missionId: string }).missionId;
    try {
      ledger.organizations.getMission(g.actor.orgId, missionId);
      const snapshots = loadSnapshots(ledger, g.actor.orgId, missionId);
      return {
        missionId,
        integrity: 'verified',
        snapshots: snapshots.map((s) => ({
          evaluationId: s.payload.evaluationId,
          stage: s.payload.stage,
          recordedAt: s.payload.recordedAt,
          decision: s.payload.decision,
          linkage: s.payload.linkage,
          seq: s.seq,
        })),
      };
    } catch (error) {
      request.log.error({ err: error }, 'decision snapshot read failed');
      if (error instanceof Error && error.message.startsWith('SNAPSHOT_INTEGRITY_VIOLATION')) {
        return reply.code(500).send({ error: { code: 'JOURNAL_INTEGRITY_VIOLATION' } });
      }
      return reply.code(404).send({ error: { code: 'NOT_FOUND_OR_UNAVAILABLE' } });
    }
  });

  app.post('/api/missions/:missionId/decision-snapshots', async (request, reply) => {
    const g = guard(request, reply, 'operate');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const missionId = (request.params as { missionId: string }).missionId;
    const stage = (request.body as { stage?: unknown } | null)?.stage;
    if (stage !== 'baseline' && stage !== 'incident') {
      return reply.code(400).send({
        error: { code: 'INVALID_STAGE', message: "stage must be 'baseline' or 'incident'" },
      });
    }
    try {
      ledger.organizations.getMission(g.actor.orgId, missionId);
      if (stage === 'incident') {
        // An incident snapshot requires a recorded baseline first (linkage).
        if (latestSnapshot(ledger, g.actor.orgId, missionId, 'baseline') === null) {
          return reply.code(409).send({
            error: {
              code: 'BASELINE_SNAPSHOT_REQUIRED',
              message: 'record the baseline evaluation before the incident evaluation',
            },
          });
        }
      }
      const { snapshot, replayed } = recordSnapshot(ledger, g.actor.orgId, missionId, stage);
      return {
        missionId,
        replayed,
        snapshot: {
          evaluationId: snapshot.payload.evaluationId,
          stage: snapshot.payload.stage,
          recordedAt: snapshot.payload.recordedAt,
          decision: snapshot.payload.decision,
          linkage: snapshot.payload.linkage,
        },
      };
    } catch (error) {
      if (
        isLedgerError(error) &&
        (error.code === 'CROSS_ORG_ACCESS' || error.code === 'MISSION_NOT_FOUND')
      ) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND_OR_UNAVAILABLE' } });
      }
      request.log.error({ err: error }, 'decision snapshot record failed');
      if (error instanceof Error && error.message.startsWith('SNAPSHOT_INTEGRITY_VIOLATION')) {
        return reply.code(500).send({ error: { code: 'JOURNAL_INTEGRITY_VIOLATION' } });
      }
      return reply.code(409).send({ error: { code: 'SNAPSHOT_RECORD_REJECTED' } });
    }
  });

  app.post(
    '/api/missions/:missionId/decision-snapshots/:evaluationId/propose-plan',
    async (request, reply) => {
      const g = guard(request, reply, 'propose');
      if ('blocked' in g) return reply;
      if (!csrfOk(ledger, request, reply)) return reply;
      const { missionId, evaluationId } = request.params as {
        missionId: string;
        evaluationId: string;
      };
      try {
        ledger.organizations.getMission(g.actor.orgId, missionId);
        const result = proposePlanFromSnapshot(
          ledger,
          g.actor.orgId,
          missionId,
          evaluationId,
          g.actor.id,
        );
        if ('rejected' in result) {
          return reply
            .code(result.rejected.status)
            .send({ error: { code: result.rejected.code, message: result.rejected.message } });
        }
        return {
          plan: result.plan,
          replayed: result.replayed,
          authorization:
            'PROPOSED_ONLY — approval requires a separate authorized actor via POST /api/approvals; execution requires POST /api/operations/reserve with the ledger rechecking all authority',
          providerVerified: false,
        };
      } catch (error) {
        if (
          isLedgerError(error) &&
          (error.code === 'CROSS_ORG_ACCESS' || error.code === 'MISSION_NOT_FOUND')
        ) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
        }
        request.log.error({ err: error }, 'plan proposal failed');
        return reply.code(409).send({ error: { code: 'PROPOSAL_REJECTED' } });
      }
    },
  );
}

/**
 * A5 — demo-time authority refresh. Long-lived demo ledgers seeded days
 * before Nov 15 would show lapsed mandates. This explicit, CSRF-protected
 * manageAuthority operation issues a FRESH mandate VERSION through the normal
 * ledger flow (the old version is superseded and journaled — nothing is
 * silently extended) and records a FRESH balance observation with labeled
 * provenance. The response states the actual clock mode so the UI can label
 * provenance honestly.
 */
export function registerDemoAuthorityRefreshRoute(app: FastifyInstance, ledger: Ledger): void {
  app.post('/api/demo/refresh-authority', async (request, reply) => {
    const g = guard(request, reply, 'manageAuthority');
    if ('blocked' in g) return reply;
    if (!csrfOk(ledger, request, reply)) return reply;
    const missionId = (request.body as { missionId?: unknown } | null)?.missionId;
    if (typeof missionId !== 'string' || missionId === '') {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_INPUT', message: 'missionId is required' } });
    }
    try {
      const mission = ledger.organizations.getMission(g.actor.orgId, missionId);
      const now = ledger.clock.now();
      const mandate = ledger.mandates.issue({
        orgId: g.actor.orgId,
        missionId,
        currency: 'USD',
        maxAmountMinor: 4_000_000,
        totalBudgetMinor: 4_000_000,
        permittedOperationKinds: ['airwallex_transfer'],
        allowedBeneficiaries: ['harbor-diagnostics', 'harbor-marine'],
        allowedPurposes: ['harbor inspection'],
        byActorId: g.actor.id,
        expiresAt: new Date(now.getTime() + 26 * 3_600_000).toISOString(),
      });
      ledger.accounts.recordBalanceSnapshot({
        orgId: g.actor.orgId,
        currency: 'USD',
        minorUnits: 8_000_000,
        source: 'manual-seed',
        observedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
      });
      const facts = financialFacts(ledger, g.actor.orgId, missionId, 'USD');
      return {
        missionId,
        missionTitle: mission.title,
        clockMode: 'SYSTEM_CLOCK',
        provenance: [
          {
            action: 'mandate.issued',
            mandateId: mandate.id,
            version: mandate.version,
            expiresAt: mandate.expiresAt,
            by: g.actor.id,
            at: now.toISOString(),
          },
          {
            action: 'balance.snapshot',
            source: 'manual-seed',
            minorUnits: 8_000_000,
            at: now.toISOString(),
          },
        ],
        effectiveAuthority: {
          mandateId: facts.mandate?.id ?? null,
          mandateVersion: facts.mandate?.version ?? null,
          mandateExpiresAt: facts.mandate?.expiresAt ?? null,
          balanceStatus: facts.balanceStatus,
          spendableMinor: facts.spendableMinor,
        },
        note: 'demo-refresh issues a NEW mandate version and a fresh balance observation through the normal journaled flows; persisted mandates are never silently extended.',
      };
    } catch (error) {
      request.log.error({ err: error }, 'authority refresh failed');
      return reply.code(409).send({ error: { code: 'AUTHORITY_REFRESH_REJECTED' } });
    }
  });
}
