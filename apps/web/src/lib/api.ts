/**
 * Typed client for the REAL MOTERVA API (apps/api/src/routes.ts + app.ts).
 * Read-only: the production UI performs no financial mutations. Financial
 * routes exist only under the server's explicit loopback-only DEMO_AUTH gate;
 * when that gate is off they are simply absent (404) and the UI renders
 * honest unavailable states — never fixture data.
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
): Promise<PhysicalDecisionJourney> {
  return request<PhysicalDecisionJourney>(
    `/api/missions/${encodeURIComponent(missionId)}/physical-decision`,
    { signal },
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
