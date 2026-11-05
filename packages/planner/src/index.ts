/**
 * @moterva/planner — adaptive mission-finance decision engine (issue #8).
 *
 * Purity law: evidence/candidates/evaluate are deterministic and side-effect
 * free. The ledger binding is read-only + proposal-only. Model adapters are
 * optional, validated and never grant financial authority. Truth label on
 * every trace: SIMULATED_OPERATION / POLICY-ONLY.
 */
export type {
  AcceptedEvidence,
  CandidateKind,
  CandidateRejectionCode,
  DecisionReason,
  DecisionResult,
  DecisionTrace,
  EvidenceRejectionCode,
  EvidenceReview,
  FinancialFacts,
  FinancialPolicy,
  MissionConstraint,
  MissionEvidenceInput,
  MissionModelAdapter,
  PlannerCandidate,
  RejectedEvidence,
  ScoredCandidate,
} from './contracts.js';
export { reviewEvidence, detectContradictions } from './evidence.js';
export { generateCandidates, weatherWindowOf, contractorDelayMinutes } from './candidates.js';
export type { GenerationContext, SupplierOffer } from './candidates.js';
export { evaluate, scoreCandidate, replayDecision } from './evaluate.js';
export type { EvaluationInput } from './evaluate.js';
export { FixtureModelAdapter, sanitizeModelProse } from './model.js';
export { financialFacts, recordDecisionPlan, journalDecision } from './ledger-binding.js';
