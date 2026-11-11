/**
 * Typed client for the REAL MOTERVA API (apps/api/src/routes.ts + app.ts).
 * Reads plus the governed onboarding writes (mission + mandate creation) —
 * every write is role-checked by the SERVER and carries the session's CSRF
 * token via the X-CSRF-Token header; the UI never relies on hiding buttons
 * for authorization. Financial routes exist only under the server's explicit
 * loopback-only DEMO_AUTH gate; when that gate is off they are simply absent
 * (404) and the UI renders honest unavailable states — never fixture data.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    credentials: 'same-origin',
  });
  if (!response.ok) {
    let code = 'HTTP_' + String(response.status);
    let message = `API responded with HTTP ${String(response.status)}`;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      /* non-JSON error body — keep HTTP-level message */
    }
    throw new ApiError(response.status, code, message);
  }
  return (await response.json()) as T;
}

// ---------------------------------------------------------------- system

export interface ProviderStatus {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

export interface SystemStatus {
  readonly service: string;
  readonly version: string;
  readonly time: string;
  readonly providerMode: string;
  readonly providers: readonly ProviderStatus[];
  readonly simulationNotice: string;
  readonly ledger?: {
    readonly status?: string;
    readonly migrations?: readonly string[];
  };
}

export function fetchSystemStatus(signal?: AbortSignal): Promise<SystemStatus> {
  return request<SystemStatus>('/api/system/status', { signal });
}

// ---------------------------------------------------------------- session

export interface Actor {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: string;
  readonly kind: string;
  readonly orgId?: string;
}

export interface SessionInfo {
  readonly actor: Actor;
  readonly expiresAt: string;
  readonly demoAuth: boolean;
}

export type SessionState =
  | { kind: 'checking' }
  | { kind: 'signed-in'; session: SessionInfo }
  | { kind: 'signed-out' } // auth exists; no valid session
  | { kind: 'unavailable' }; // financial/auth routes not registered in this deployment

export async function fetchSession(signal?: AbortSignal): Promise<SessionInfo | null> {
  try {
    return await request<SessionInfo>('/api/auth/session', { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    if (error instanceof ApiError && error.status === 404) throw error;
    throw error;
  }
}

export async function login(
  username: string,
  password: string,
  signal?: AbortSignal,
): Promise<{ actor: Actor; csrfToken: string }> {
  return request<{ actor: Actor; csrfToken: string }>('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal,
  });
}

export async function logout(csrfToken: string, signal?: AbortSignal): Promise<void> {
  await request<{ ok: boolean }>('/api/auth/logout', {
    method: 'POST',
    headers: { 'x-csrf-token': csrfToken },
    signal,
  });
}

// ---------------------------------------------------------------- missions

export interface MissionRow {
  readonly id: string;
  readonly org_id: string;
  readonly title: string;
  readonly status: string;
  readonly created_at: string;
}

export function fetchMissions(signal?: AbortSignal): Promise<MissionRow[]> {
  return request<{ missions: MissionRow[] }>('/api/missions', { signal }).then(
    (body) => body.missions,
  );
}

/** Role of the signed-in actor as the SERVER reports it (never client-guessed). */
export function actorRole(session: SessionState): string | null {
  return session.kind === 'signed-in' ? session.session.actor.role : null;
}

/** Mirrors the server's role matrix (domain/roles) ONLY for UI affordances;
 *  enforcement is always server-side — a hidden button is not authorization. */
export function mayManageAuthority(role: string | null): boolean {
  return role === 'owner' || role === 'admin';
}

export function mayOperate(role: string | null): boolean {
  return role === 'owner' || role === 'admin' || role === 'approver' || role === 'operator';
}

function csrfHeaders(csrfToken: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-csrf-token': csrfToken };
}

/** POST /api/missions — requires the server's `operate` grant. */
export function createMission(title: string, csrfToken: string): Promise<MissionRow> {
  return request<{ id: string; org_id: string; title: string; status: string; created_at: string }>(
    '/api/missions',
    { method: 'POST', headers: csrfHeaders(csrfToken), body: JSON.stringify({ title }) },
  );
}

export interface CreateMandateInput {
  readonly missionId: string;
  readonly currency: string;
  readonly maxAmountMinor: number;
  readonly totalBudgetMinor?: number | undefined;
  readonly permittedOperationKinds: readonly string[];
  readonly rails?: readonly string[] | undefined;
  readonly allowedBeneficiaries?: readonly string[] | undefined;
  readonly allowedPurposes?: readonly string[] | undefined;
  readonly expiresAt: string;
}

/** POST /api/mandates — requires the server's `manageAuthority` grant. */
export function createMandate(input: CreateMandateInput, csrfToken: string): Promise<MandateRow> {
  return request<{ mandate: MandateRow }>('/api/mandates', {
    method: 'POST',
    headers: csrfHeaders(csrfToken),
    body: JSON.stringify(input),
  }).then((body) => body.mandate);
}

// ---------------------------------------------------------------- mandates

export interface MandateRow {
  readonly id: string;
  readonly mission_id: string;
  readonly version: number;
  readonly status: MandateStatusString;
  readonly currency: string;
  readonly max_amount_minor: number;
  readonly total_budget_minor: number;
  readonly permitted_kinds_json: string;
  readonly rails_json: string | null;
  readonly allowed_beneficiaries_json: string | null;
  readonly allowed_purposes_json: string | null;
  readonly require_separate_approver: number;
  readonly expires_at: string;
  readonly revoked_at: string | null;
  readonly created_at: string;
  readonly consumed_minor: number;
  readonly remaining_minor: number;
}

type MandateStatusString = 'active' | 'superseded' | 'expired' | 'revoked';

export function fetchMandates(missionId: string, signal?: AbortSignal): Promise<MandateRow[]> {
  return request<{ mandates: MandateRow[] }>(
    `/api/mandates?missionId=${encodeURIComponent(missionId)}`,
    { signal },
  ).then((body) => body.mandates);
}

// ---------------------------------------------------------------- operations

export interface OperationRow {
  readonly id: string;
  readonly state: string;
  readonly kind: string;
  readonly request_id: string;
  readonly mission_id: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly beneficiary: string;
  readonly purpose: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export function fetchOperation(id: string, signal?: AbortSignal): Promise<OperationRow> {
  return request<{ operation: OperationRow }>(`/api/operations/${encodeURIComponent(id)}`, {
    signal,
  }).then((body) => body.operation);
}

// ------------------------------------------------- financial overview (#35)

import type {
  FinancialOverviewView,
  MissionEvidenceListView,
  OperationListView,
} from '@moterva/domain';

export type {
  BalanceProvenanceView,
  CommitmentBreakdownView,
  FinancialCurrencyView,
  FinancialOverviewView,
  MissionEvidenceEventView,
  MissionEvidenceListView,
  OperationListView,
  OperationReadView,
} from '@moterva/domain';

export function fetchFinancialOverview(signal?: AbortSignal): Promise<FinancialOverviewView> {
  return request<FinancialOverviewView>('/api/financial/overview', { signal });
}

// ---------------------------------------------------- operations list (#35)

export function fetchOperations(
  query: { missionId?: string; state?: string; attention?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<OperationListView> {
  const params = new URLSearchParams();
  if (query.missionId !== undefined) params.set('missionId', query.missionId);
  if (query.state !== undefined) params.set('state', query.state);
  if (query.attention !== undefined) params.set('attention', query.attention);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return request<OperationListView>(`/api/operations${qs === '' ? '' : `?${qs}`}`, { signal });
}

// -------------------------------------------------- mission evidence (#37)

export function fetchMissionEvidence(
  missionId: string,
  query: { topic?: 'financial' | 'operational'; limit?: number } = {},
  signal?: AbortSignal,
): Promise<MissionEvidenceListView> {
  const params = new URLSearchParams();
  if (query.topic !== undefined) params.set('topic', query.topic);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return request<MissionEvidenceListView>(
    `/api/missions/${encodeURIComponent(missionId)}/evidence${qs === '' ? '' : `?${qs}`}`,
    { signal },
  );
}

// -------------------------------- connected simulated mission planner (#19)

export interface PhysicalCandidateSummary {
  readonly candidateId: string;
  readonly label: string;
  readonly kind: string;
  readonly grossMinor: number;
  readonly expectedNetMinor: number;
}

export interface PhysicalDecisionSummary {
  readonly evaluationId: string;
  readonly outcome: 'select' | 'decline' | 'escalate';
  readonly selected: PhysicalCandidateSummary | null;
  readonly alternatives: readonly {
    readonly id: string;
    readonly label: string;
    readonly kind: string;
    readonly feasible: boolean;
    readonly grossMinor: number;
    readonly expectedNetMinor: number;
    readonly rejection: string | null;
  }[];
  readonly evidenceIds: readonly string[];
  readonly reasons: readonly {
    readonly code: string;
    readonly message: string;
    readonly evidenceIds: readonly string[];
  }[];
  readonly withheldEventIds: readonly string[];
  readonly currentBalanceStatus: string;
  readonly currentSpendableMinor: number | null;
  readonly authorization: string;
  readonly providerVerified: false;
  readonly mode: string;
}

export interface PhysicalDecisionJourney {
  readonly missionId: string;
  readonly stage: 'empty' | 'baseline' | 'incident';
  readonly before: PhysicalDecisionSummary | null;
  readonly after: PhysicalDecisionSummary | null;
  readonly admittedEventIds: readonly string[];
  readonly incident: {
    readonly eventId: string;
    readonly sourceId: string;
    readonly eventDigest: string;
    readonly observedAt: string;
    readonly reading: string;
    readonly provenance: string;
  } | null;
  readonly disclaimer: string;
}

export function fetchPhysicalDecision(
  missionId: string,
  signal?: AbortSignal,
  mode: 'local-demo' | 'reviewer-demo' = 'local-demo',
): Promise<PhysicalDecisionJourney> {
  const endpoint = mode === 'reviewer-demo' ? 'reviewer-physical-decision' : 'physical-decision';
  return request<PhysicalDecisionJourney>(
    `/api/missions/${encodeURIComponent(missionId)}/${endpoint}`,
    { signal },
  );
}

// ---------------------- C1 mission specification read (typed, read-only)

export interface MissionSpecAsset {
  readonly assetId: string;
  readonly domainKind: 'aerial' | 'ground' | 'surface';
  readonly label: string;
}

export interface SpecOfferView {
  readonly id: string;
  readonly kind: string;
  readonly currency: string;
  readonly baseCostMinor: number;
  readonly feeMinor: number;
  readonly leadTimeMinutes: number;
  readonly durationMinutes: number;
  readonly probabilityOfSuccess: number;
  readonly availability: string;
  readonly beneficiary: string;
  readonly purpose: string;
  readonly requiresAssetId?: string;
}

/** Closed industry discriminator (C1): a LABEL for the product surface —
 *  decisions derive from the spec's own assets/policy/offers, never from it. */
export type SpecIndustry = 'maritime-uav' | 'warehouse-amr' | 'general-operations';

export interface MissionSpecSourceView {
  readonly sourceId: string;
  readonly sourceType: string;
  readonly assetIds: readonly string[];
  readonly trustedForRecovery: boolean;
  readonly provenance: 'SYNTHETIC' | 'FIELD';
}

/** NON-SECRET credential metadata. Key bytes are never part of any read. */
export interface SourceCredentialMeta {
  readonly sourceId: string;
  readonly keyId: string;
  readonly status: string;
  readonly issuedAt?: string;
  readonly issuedBy?: string;
  readonly revokedAt?: string | null;
}

export interface MissionSpecView {
  readonly missionId: string;
  readonly registered: boolean;
  readonly specId: string;
  readonly specDigest: string;
  readonly industry: SpecIndustry;
  readonly objective: string;
  readonly truthLabel: string;
  readonly assets: readonly MissionSpecAsset[];
  /** Declared trusted sources — present once C's contract exposes them
   *  (requested on #64); absent on older builds, never guessed client-side. */
  readonly sources?: readonly MissionSpecSourceView[];
  /** NON-SECRET credential metadata (never key bytes) — requested on #64. */
  readonly credentials?: readonly SourceCredentialMeta[];
  readonly safetyPolicy: {
    readonly version: number;
    readonly clearanceAuthority: string;
    readonly uavWindLimitKt?: number;
    readonly groundInterrupts?: readonly string[];
  };
  readonly economics: {
    readonly currency: string;
    readonly missionValueMinor: number;
    readonly failureCostMinor: number;
    readonly protectedReserveMinor: number;
    readonly deadlineOffsetMinutes: number;
  };
  readonly offers: {
    readonly incumbent: SpecOfferView;
    readonly alternatives: readonly SpecOfferView[];
    readonly diagnostics?: SpecOfferView;
  };
  readonly financialMandateShape: {
    readonly currency: string;
    readonly allowedBeneficiaries: readonly string[];
    readonly allowedPurposes: readonly string[];
  };
  readonly caseLineage: { readonly caseId: string; readonly evaluationId: string } | null;
  readonly authorization: string;
}

/** GET /api/missions/:id/mission-spec — READ-ONLY typed mission configuration
 *  (C1 contract): industry, objective, assets, safety policy, economics,
 *  supplier offers and decision-case lineage. Never authority. */
export function fetchMissionSpec(
  missionId: string,
  signal?: AbortSignal,
): Promise<MissionSpecView> {
  return request<MissionSpecView>(
    '/api/missions/' + encodeURIComponent(missionId) + '/mission-spec',
    { signal },
  );
}

// ---------------------- warehouse domain journey (C2, spec-driven)

export interface WarehouseJourneyLastEvent {
  readonly eventId: string;
  readonly assetId: string;
  readonly sourceId: string;
  readonly eventDigest: string;
  readonly observedAt: string;
  readonly reading: string;
  readonly provenance: string;
}

export interface WarehouseDecisionJourney {
  readonly missionId: string;
  readonly specId: string;
  readonly industry: 'warehouse-amr';
  readonly stage: string;
  readonly before: PhysicalDecisionSummary | null;
  readonly after: PhysicalDecisionSummary | null;
  readonly admittedEventIds: readonly string[];
  readonly lastEvent: WarehouseJourneyLastEvent | null;
  readonly disclaimer: string;
}

export const WAREHOUSE_STEPS = [
  'baseline',
  'aisle-obstruction',
  'charger-fault',
  'comms-loss',
  'comms-restored',
] as const;
export type WarehouseStep = (typeof WAREHOUSE_STEPS)[number];

/** GET /api/missions/:id/warehouse-decision — the warehouse journey read
 *  (same decision-view shape as harbor; spec-driven stage ladder). */
export function fetchWarehouseDecision(
  missionId: string,
  signal?: AbortSignal,
): Promise<WarehouseDecisionJourney> {
  return request<WarehouseDecisionJourney>(
    '/api/missions/' + encodeURIComponent(missionId) + '/warehouse-decision',
    { signal },
  );
}

/** POST /api/missions/:id/warehouse-step — DEMO event source: admits the
 *  signed synthetic events for one warehouse step (idempotent; registers
 *  the mission spec once) and returns the refreshed journey. */
export function admitWarehouseStep(
  missionId: string,
  step: WarehouseStep,
  csrfToken: string,
): Promise<WarehouseDecisionJourney> {
  return request<WarehouseDecisionJourney>(
    '/api/missions/' + encodeURIComponent(missionId) + '/warehouse-step',
    {
      method: 'POST',
      headers: csrfHeaders(csrfToken),
      body: JSON.stringify({ step }),
    },
  );
}

/** POST /api/demo/refresh-authority — demo-time authority refresh
 *  (manageAuthority + CSRF): issues a FRESH mandate version from the
 *  registered mission spec shape; nothing is silently extended. */
export function refreshMissionAuthority(missionId: string, csrfToken: string): Promise<unknown> {
  return request('/api/demo/refresh-authority', {
    method: 'POST',
    headers: csrfHeaders(csrfToken),
    body: JSON.stringify({ missionId }),
  });
}
// ------------------------------------------------------------------------
// PRODUCTION mission operations (Agent C, PR #64) — the customer-operated
// pathway. NONE of these routes is a demo fixture: they accept validated
// customer input and read the real event journal. Authority is unchanged:
// every result is PROPOSED_ONLY; money moves only through ledger mandates,
// separate human approval and provider evidence.
// ------------------------------------------------------------------------

/** Customer-authored mission specification (wire form). `identity.orgId` and
 *  `identity.missionId` are NEVER sent — the server re-stamps them. */
export interface MissionSpecDraftWire {
  readonly specVersion: 1;
  readonly specId: string;
  readonly industry: SpecIndustry;
  readonly identity: { readonly title: string; readonly objective: string };
  readonly assets: readonly MissionSpecAsset[];
  readonly sources: readonly MissionSpecSourceView[];
  readonly safetyPolicy: {
    readonly version: number;
    readonly clearanceAuthority: 'deterministic-domain-policy';
    readonly uavWindLimitKt?: number;
    readonly groundInterrupts?: readonly string[];
  };
  readonly economics: MissionSpecView['economics'];
  readonly offers: MissionSpecView['offers'];
  readonly financialMandateShape: MissionSpecView['financialMandateShape'];
  readonly truthLabel: string;
}

export interface MissionSpecRegistration {
  readonly missionId: string;
  readonly specId: string;
  readonly digest: string;
  readonly replayed: boolean;
  readonly industry: SpecIndustry;
  readonly registeredBy: string;
}

/** POST /api/missions/:id/mission-spec — operate + CSRF; typed 400 `SPEC_*`
 *  codes surface verbatim; the server re-stamps tenant identity. */
export function registerMissionSpec(
  missionId: string,
  spec: MissionSpecDraftWire,
  csrfToken: string,
): Promise<MissionSpecRegistration> {
  return request<MissionSpecRegistration>(
    '/api/missions/' + encodeURIComponent(missionId) + '/mission-spec',
    { method: 'POST', headers: csrfHeaders(csrfToken), body: JSON.stringify({ spec }) },
  );
}

/** ONE-TIME credential issuance response. `secret` exists ONLY in this
 *  response: callers must hold it in component memory, never in storage,
 *  URLs, logs, analytics, caches or evidence views. */
export interface SourceCredentialIssued {
  readonly missionId: string;
  readonly sourceId: string;
  readonly keyId: string;
  readonly assetIds: readonly string[];
  readonly trustedForRecovery: boolean;
  readonly provenance: 'SYNTHETIC' | 'FIELD';
  readonly secret: string;
  readonly signing: string;
  readonly warning: string;
}

/** POST /api/missions/:id/sources/:sourceId/secret — spec-bound issuance. The
 *  request opts out of every cache (`no-store`) because the response carries
 *  the only copy of the secret the browser will ever see. */
export function issueSourceCredential(
  missionId: string,
  sourceId: string,
  keyId: string,
  trustedForRecovery: boolean,
  csrfToken: string,
): Promise<SourceCredentialIssued> {
  return request<SourceCredentialIssued>(
    '/api/missions/' +
      encodeURIComponent(missionId) +
      '/sources/' +
      encodeURIComponent(sourceId) +
      '/secret',
    {
      method: 'POST',
      headers: csrfHeaders(csrfToken),
      cache: 'no-store',
      body: JSON.stringify({ keyId, trustedForRecovery }),
    },
  );
}

export interface OperationsCandidateScore {
  readonly id: string;
  readonly kind: string;
  readonly grossMinor: number;
  readonly feasible: boolean;
  readonly rejection: string;
}

export interface OperationsAcceptedEvent {
  readonly eventId: string;
  readonly sourceId: string;
  readonly digest: string;
  readonly observedAt: string;
  readonly sequence: number;
}

export interface OperationsEvaluation {
  readonly missionId: string;
  readonly replayed: boolean;
  readonly snapshot: {
    readonly evaluationId: string;
    readonly caseId: string;
    readonly stage: 'baseline' | 'incident';
    readonly recordedAt: string;
    readonly spec: { readonly specId: string; readonly digest: string };
    readonly causality: Readonly<Record<string, string>>;
    readonly decision: RecordedSnapshotDecision;
    readonly linkage: { readonly baselineEvaluationId: string | null } | null;
    readonly candidates: readonly OperationsCandidateScore[];
    readonly acceptedEvents: readonly OperationsAcceptedEvent[];
    readonly withheldEventIds: readonly string[];
  };
  readonly authorization: string;
  readonly providerVerified: false;
}

/** POST /api/missions/:id/operations/evaluate — stages derive from THE
 *  JOURNAL (no demo event ids). Idempotent per economic intent. */
export function evaluateFromJournal(
  missionId: string,
  stage: 'baseline' | 'incident',
  csrfToken: string,
): Promise<OperationsEvaluation> {
  return request<OperationsEvaluation>(
    '/api/missions/' + encodeURIComponent(missionId) + '/operations/evaluate',
    { method: 'POST', headers: csrfHeaders(csrfToken), body: JSON.stringify({ stage }) },
  );
}

/** A sanitized admitted event (same typed allowlist as physical-view). */
export interface FieldObservationEvent {
  readonly eventId: string;
  readonly journalSeq?: number;
  readonly sequence: number;
  readonly assetId: string;
  readonly sourceId: string;
  readonly sourceType?: string;
  readonly provenance: 'SYNTHETIC' | 'FIELD' | string;
  readonly observedAt: string;
  readonly eventDigest: string;
  readonly observations: readonly {
    readonly kind: string;
    readonly unit: string;
    readonly value: string | number;
  }[];
  readonly freshnessAtSnapshot?: string;
  readonly planningValidAtSnapshot?: boolean;
}

export interface OperationsDecision {
  readonly missionId: string;
  readonly eventCount: number;
  readonly stage: 'empty' | 'baseline' | 'incident';
  readonly decision: PhysicalDecisionSummary;
  readonly mode: string;
  readonly authorization: string;
  readonly providerVerified: false;
  /** Sanitized admitted events — requested on #64 (item 8); optional until
   *  the contract lands. The UI falls back to physical-view honestly. */
  readonly events?: readonly FieldObservationEvent[];
}

/** GET /api/missions/:id/operations/decision — read-only live evaluation of
 *  the real journal at "now". Never records, never mutates. */
export function fetchOperationsDecision(
  missionId: string,
  signal?: AbortSignal,
): Promise<OperationsDecision> {
  return request<OperationsDecision>(
    '/api/missions/' + encodeURIComponent(missionId) + '/operations/decision',
    { signal },
  );
}

export interface ModelInterpretationResult {
  readonly missionId: string;
  readonly interpretation: {
    readonly status: string;
    readonly adapterId: string;
    readonly modelId: string | null;
    readonly providerInvoked: boolean;
    readonly confidenceBps: number | null;
    readonly errorCode: string | null;
    readonly evidenceCount: number;
    readonly causality: string;
  };
  readonly admittedEvidence: number;
  readonly authorization: string;
}

/** POST /api/missions/:id/model-interpretation — bounded, optional. A 503
 *  `MODEL_NOT_CONFIGURED` is the labeled POLICY-ONLY fallback. */
export function interpretIncidentReport(
  missionId: string,
  report: string,
  csrfToken: string,
): Promise<ModelInterpretationResult> {
  return request<ModelInterpretationResult>(
    '/api/missions/' + encodeURIComponent(missionId) + '/model-interpretation',
    { method: 'POST', headers: csrfHeaders(csrfToken), body: JSON.stringify({ report }) },
  );
}

export function submitSyntheticStep(
  missionId: string,
  step: 'baseline' | 'incident',
  csrfToken: string,
): Promise<PhysicalDecisionJourney> {
  return request<PhysicalDecisionJourney>(
    `/api/missions/${encodeURIComponent(missionId)}/synthetic-step`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ step }),
    },
  );
}

// ------------------------- production OIDC reviewer demonstration (E3/E4)

/** Pure configuration read: never guesses that a signed synthetic route exists. */
export function fetchReviewerDemoCapability(signal?: AbortSignal): Promise<boolean> {
  return request<{ reviewerDemo?: unknown }>('/api/auth/capabilities', { signal }).then(
    (body) => body.reviewerDemo === true,
  );
}

/** Server provisions the signed-in reviewer's own fixed SYNTHETIC mission. */
export function provisionReviewerMission(
  csrfToken: string,
): Promise<{ mission: { id: string; title: string }; replayed: boolean }> {
  return request('/api/reviewer-demo/mission', {
    method: 'POST',
    headers: csrfHeaders(csrfToken),
    body: '{}',
  });
}

/** Only step identity crosses the wire; the server owns measurements and authority. */
export function submitReviewerSyntheticStep(
  missionId: string,
  step: 'baseline' | 'incident',
  csrfToken: string,
): Promise<{ replayed: boolean; stage: 'baseline' | 'incident' }> {
  return request(`/api/missions/${encodeURIComponent(missionId)}/reviewer-synthetic-step`, {
    method: 'POST',
    headers: csrfHeaders(csrfToken),
    body: JSON.stringify({ step }),
  });
}

// --------------------------------------------- governed decision actions

export interface CreatePlanInput {
  readonly missionId: string;
  readonly terms: {
    readonly amountMinor: number;
    readonly currency: string;
    readonly beneficiary: string;
    readonly purpose: string;
    readonly quote?: string | undefined;
  };
}

/** POST /api/plans — requires the server's `propose` grant (operator+). */
export function createPlan(
  input: CreatePlanInput,
  csrfToken: string,
): Promise<{
  plan: { id: string; version: number; digest: string };
}> {
  return request<{ plan: { id: string; version: number; digest: string } }>('/api/plans', {
    method: 'POST',
    headers: csrfHeaders(csrfToken),
    body: JSON.stringify(input),
  });
}

export interface CreateApprovalInput {
  readonly missionId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly kind: 'airwallex_transfer' | 'metal_order' | 'internal_hold';
  readonly mandateId?: string | undefined;
  readonly mandateVersion?: number | undefined;
  readonly evidenceDigest?: string | undefined;
  readonly expiresAt: string;
}

/** POST /api/approvals — requires the server's `approve` grant (approver+). */
export function createApproval(
  input: CreateApprovalInput,
  csrfToken: string,
): Promise<{ approval: { id: string; status: string; expiresAt: string } }> {
  return request<{ approval: { id: string; status: string; expiresAt: string } }>(
    '/api/approvals',
    {
      method: 'POST',
      headers: csrfHeaders(csrfToken),
      body: JSON.stringify(input),
    },
  );
}

export function mayPropose(role: string | null): boolean {
  return mayOperate(role);
}

export function mayApprove(role: string | null): boolean {
  return role === 'owner' || role === 'admin' || role === 'approver';
}

// -------------------------- durable decision snapshots (#44 contract)

export interface RecordedSnapshotDecision {
  readonly outcome: 'select' | 'decline' | 'escalate';
  readonly selected: {
    readonly candidateId: string;
    readonly grossMinor: number;
    readonly currency: string;
    readonly beneficiary: string;
    readonly purpose: string;
    readonly probabilityBps: number;
    readonly expectedNetMinor: number;
    readonly evidenceIds: readonly string[];
  } | null;
}

export interface RecordedSnapshot {
  readonly evaluationId: string;
  readonly stage: 'baseline' | 'incident';
  readonly recordedAt: string;
  readonly decision: RecordedSnapshotDecision;
  readonly linkage: {
    readonly baselineEvaluationId?: string | null;
    readonly incidentEventId?: string | null;
  } | null;
  readonly seq: number;
}

/** GET /api/missions/:id/decision-snapshots — READ ONLY; never creates. */
export function fetchDecisionSnapshots(
  missionId: string,
  signal?: AbortSignal,
): Promise<{ missionId: string; integrity: string; snapshots: RecordedSnapshot[] }> {
  return request<{ missionId: string; integrity: string; snapshots: RecordedSnapshot[] }>(
    `/api/missions/${encodeURIComponent(missionId)}/decision-snapshots`,
    { signal },
  );
}

export interface SnapshotRecordResult {
  readonly missionId: string;
  readonly replayed: boolean;
  readonly snapshot: {
    readonly evaluationId: string;
    readonly stage: 'baseline' | 'incident';
    readonly recordedAt: string;
    readonly decision: RecordedSnapshotDecision;
  };
}

/** POST /api/missions/:id/decision-snapshots — explicit, operate + CSRF, idempotent. */
export function recordDecisionSnapshot(
  missionId: string,
  stage: 'baseline' | 'incident',
  csrfToken: string,
): Promise<SnapshotRecordResult> {
  return request<SnapshotRecordResult>(
    `/api/missions/${encodeURIComponent(missionId)}/decision-snapshots`,
    {
      method: 'POST',
      headers: csrfHeaders(csrfToken),
      body: JSON.stringify({ stage }),
    },
  );
}

/** POST /api/missions/:id/decision-snapshots/:evaluationId/propose-plan —
 *  BODYLESS apart from request metadata: the selected economic terms come
 *  ONLY from the saved evaluation / server journal. Never send terms here. */
export function proposePlanFromEvaluation(
  missionId: string,
  evaluationId: string,
  csrfToken: string,
): Promise<{
  plan: {
    id: string;
    version: number;
    digest: string;
    amountMinor: number;
    currency: string;
    beneficiary: string;
  };
  replayed: boolean;
  authorization: string;
  providerVerified: false;
}> {
  return request<{
    plan: {
      id: string;
      version: number;
      digest: string;
      amountMinor: number;
      currency: string;
      beneficiary: string;
    };
    replayed: boolean;
    authorization: string;
    providerVerified: false;
  }>(
    `/api/missions/${encodeURIComponent(missionId)}/decision-snapshots/${encodeURIComponent(
      evaluationId,
    )}/propose-plan`,
    { method: 'POST', headers: csrfHeaders(csrfToken), body: '{}' },
  );
}

export interface DecisionPlanProposal {
  readonly evaluationId: string;
  readonly proposedBy: string;
  readonly plan: {
    readonly id: string;
    readonly version: number;
    readonly digest: string;
    readonly createdAt: string;
    readonly terms: {
      readonly amountMinor: number;
      readonly currency: string;
      readonly beneficiary: string;
      readonly purpose: string;
    };
  };
  readonly providerVerified: false;
}

/** GET /api/missions/:id/decision-plans — read-only reviewer handoff. */
export function fetchDecisionPlans(
  missionId: string,
  signal?: AbortSignal,
): Promise<{ missionId: string; plans: DecisionPlanProposal[]; authorization: string }> {
  return request<{ missionId: string; plans: DecisionPlanProposal[]; authorization: string }>(
    `/api/missions/${encodeURIComponent(missionId)}/decision-plans`,
    { signal },
  );
}

/** Journal-verified approvals for rebuild-after-reload: filter the real
 *  financial journal for approval.granted events (server truth, no invention). */
export interface RecordedApproval {
  readonly approvalId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly planDigest: string;
  readonly decidedBy: string;
  readonly kind: string;
  readonly expiresAt: string;
}

export function approvalsFromEvidence(
  events: readonly { type: string; payload: Record<string, unknown> }[],
): RecordedApproval[] {
  return events
    .filter((e) => e.type === 'approval.granted')
    .map((e) => {
      const p = e.payload as Record<string, unknown>;
      return {
        approvalId: String(p.approvalId ?? ''),
        planId: String(p.planId ?? ''),
        planVersion: Number(p.planVersion ?? 0),
        planDigest: String(p.planDigest ?? ''),
        decidedBy: String(p.decidedBy ?? ''),
        kind: String(p.kind ?? ''),
        expiresAt: String(p.expiresAt ?? ''),
      };
    })
    .filter((a) => a.approvalId !== '' && a.planId !== '');
}

// ---------------------------------------------------------------------------
// MTV-09/12 physical mission viewer (Agent C module) — the ONE authenticated
// read the Decision Room performs for it. The response is validated by the
// viewer module's strict adapter (snapshotFromServerPayload) BEFORE any scene
// renders; a shape deviation is an honest unavailable state, never a
// partially-trusted scene.
// ---------------------------------------------------------------------------

/** Raw physical-view payload (physical-view.v1 wire, Agent A implementation). */
export type PhysicalViewPayload = Record<string, unknown>;

export async function fetchPhysicalView(
  missionId: string,
  signal?: AbortSignal,
): Promise<PhysicalViewPayload> {
  return request<PhysicalViewPayload>(
    `/api/missions/${encodeURIComponent(missionId)}/physical-view`,
    { signal },
  );
}
