/**
 * Deterministic candidate generation (the POLICY-ONLY engine).
 *
 * Decisions EMERGE from constraint math over the supplier catalogue and the
 * accepted evidence — never from a scripted preference. The same generator
 * backs the benchmark and the demo; the model adapter can only ADD typed
 * candidates that pass the same validation.
 */
import type { AcceptedEvidence, PlannerCandidate } from './contracts.js';

/** A supplier/service the mission may buy from (typed operational catalogue). */
export interface SupplierOffer {
  readonly id: string;
  readonly kind: 'inspection-service' | 'diagnostic-service';
  readonly beneficiary: string;
  readonly purpose: string;
  readonly currency: string;
  readonly baseCostMinor: number;
  readonly feeMinor: number;
  /** Minutes from "now" until this supplier can start. */
  readonly leadTimeMinutes: number;
  readonly durationMinutes: number;
  /** 0..1 historical on-time success rate (an assumption, surfaced as such). */
  readonly probabilityOfSuccess: number;
  readonly availability: 'confirmed' | 'unconfirmed';
  readonly quoteExpiresAt?: string;
}

export interface GenerationContext {
  readonly now: Date;
  readonly policyCurrency: string;
  readonly missionDeadlineAt: string;
  /** The incumbent supplier executing the current plan (kind continue-supplier). */
  readonly incumbent: SupplierOffer;
  /** The real physical asset the incumbent UAV service depends on, when known. */
  readonly incumbentAssetId?: string;
  /** Alternative suppliers (kind hire-alternative). */
  readonly alternatives: readonly SupplierOffer[];
  /** A diagnostic information service, if one exists (kind purchase-diagnostics). */
  readonly diagnosticService?: SupplierOffer;
  /**
   * Probability the diagnostic changes the outcome (0..1) — an explicit
   * assumption, usually tied to diagnostic-finding severity.
   */
  readonly diagnosticInformationGain?: number;
}

/** Latest accepted weather window per asset, if any. */
export function weatherWindowOf(
  accepted: readonly AcceptedEvidence[],
  assetId: string,
): { opensAt: string; closesAt: string; confidence: number } | null {
  let latest: { opensAt: string; closesAt: string; confidence: number; sequence: number } | null =
    null;
  for (const item of accepted) {
    if (item.input.asset.id !== assetId || item.input.constraint.kind !== 'weather-window')
      continue;
    if (latest === null || item.input.event.sequence > latest.sequence) {
      const c = item.input.constraint;
      latest = {
        opensAt: c.windowOpensAt,
        closesAt: c.windowClosesAt,
        confidence: c.confidence,
        sequence: item.input.event.sequence,
      };
    }
  }
  return latest === null
    ? null
    : { opensAt: latest.opensAt, closesAt: latest.closesAt, confidence: latest.confidence };
}

/** Latest accepted contractor delay for a beneficiary, in minutes. */
export function contractorDelayMinutes(
  accepted: readonly AcceptedEvidence[],
  contractorId: string,
): number {
  let delay = 0;
  let sequence = -1;
  for (const item of accepted) {
    if (item.input.constraint.kind !== 'contractor-delay') continue;
    if (item.input.constraint.contractorId !== contractorId) continue;
    if (item.input.event.sequence > sequence) {
      delay = item.input.constraint.delayMinutes;
      sequence = item.input.event.sequence;
    }
  }
  return delay;
}

function addMinutes(from: Date, minutes: number): string {
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}

function addDelayMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

/**
 * Generate the full candidate set from accepted evidence and the catalogue.
 * Pure: same evidence + catalogue + now → same candidates.
 */
export function generateCandidates(
  accepted: readonly AcceptedEvidence[],
  ctx: GenerationContext,
): PlannerCandidate[] {
  const evidenceAll = accepted.map((a) => a.input.event.id);
  const candidates: PlannerCandidate[] = [];
  const primaryAsset =
    ctx.incumbentAssetId ??
    (accepted.length > 0 ? accepted[0]!.input.asset.id : `${ctx.incumbent.id}-default-asset`);
  const window = weatherWindowOf(accepted, primaryAsset);
  const safetyReadings = accepted
    .filter((a) => a.input.asset.id === primaryAsset && a.input.constraint.kind === 'asset-safety')
    .sort((a, b) => a.input.event.sequence - b.input.event.sequence);
  const safety = safetyReadings.at(-1)?.input.constraint;
  const operationallyBlocked = safety?.kind === 'asset-safety' && safety.state !== 'clear';

  // ---- no-action: safe abstention if physical clearance is missing or blocked.
  // ---- no-action: always present; its probability collapses when accepted
  // evidence makes the current plan infeasible.
  let noActionProbability = ctx.incumbent.probabilityOfSuccess;
  const noActionAssumptions: string[] = [];
  const incumbentDelay = contractorDelayMinutes(accepted, ctx.incumbent.id);
  let noActionStart = addMinutes(ctx.now, ctx.incumbent.leadTimeMinutes);
  if (incumbentDelay > 0) {
    noActionStart = addDelayMinutes(noActionStart, incumbentDelay);
    noActionProbability = noActionProbability * 0.5; // delay materially hurts delivery
    noActionAssumptions.push(`incumbent delayed by ${String(incumbentDelay)} minutes`);
  }
  if (window !== null) {
    // Doing nothing means the incumbent flies its NOMINAL schedule — and a
    // flight outside the weather window is not a flight: the plan collapses.
    const openMs = Date.parse(window.opensAt);
    const closeMs = Date.parse(window.closesAt);
    const startMs = Date.parse(noActionStart);
    const finishMs = startMs + ctx.incumbent.durationMinutes * 60_000;
    const outsideWindow = startMs < openMs || finishMs > closeMs;
    if (outsideWindow) {
      noActionProbability = noActionProbability * 0.1;
      noActionAssumptions.push(
        'nominal flight falls outside the latest weather window — holding course forfeits the mission',
      );
    } else {
      noActionProbability = noActionProbability * window.confidence;
      noActionAssumptions.push(`weather confidence ${String(window.confidence)} applied`);
    }
  }
  if (operationallyBlocked) {
    noActionProbability = 0;
    noActionAssumptions.push(
      'physical clearance missing/blocked; no spend is a safe pause, never permission to fly',
    );
  }
  candidates.push({
    id: 'no-action',
    kind: 'no-action',
    label: operationallyBlocked
      ? 'Pause the physical operation (no new spend)'
      : 'Hold the current plan (no new spend)',
    costMinor: 0,
    currency: ctx.policyCurrency,
    feeMinor: 0,
    beneficiary: ctx.incumbent.beneficiary,
    purpose: ctx.incumbent.purpose,
    earliestStartAt: noActionStart,
    durationMinutes: ctx.incumbent.durationMinutes,
    deadlineAt: ctx.missionDeadlineAt,
    probabilityOfSuccess: noActionProbability,
    availability: 'confirmed',
    evidenceIds: evidenceAll.length > 0 ? evidenceAll : [],
    rationale: noActionAssumptions.join('; ') || 'no adverse evidence accepted',
  });

  // ---- continue with the incumbent (explicit, possibly delayed).
  // Offshore operations execute INSIDE the weather window: the earliest
  // start is the later of the supplier lead time and the window opening.
  let incumbentStart = addMinutes(ctx.now, ctx.incumbent.leadTimeMinutes);
  if (incumbentDelay > 0) {
    incumbentStart = addDelayMinutes(incumbentStart, incumbentDelay);
  }
  if (window !== null && Date.parse(window.opensAt) > Date.parse(incumbentStart)) {
    incumbentStart = window.opensAt;
  }
  const continueCost = ctx.incumbent.baseCostMinor;
  let continueProbability = ctx.incumbent.probabilityOfSuccess;
  const continueAssumptions: string[] = [];
  if (incumbentDelay > 0) {
    continueProbability *= 0.75;
    continueAssumptions.push(`delayed start +${String(incumbentDelay)}m`);
  }
  if (window !== null) {
    const finishMs = Date.parse(incumbentStart) + ctx.incumbent.durationMinutes * 60_000;
    if (finishMs > Date.parse(window.closesAt)) {
      continueProbability *= 0.4;
      continueAssumptions.push('completion likely outside weather window');
    } else {
      continueProbability *= window.confidence;
      continueAssumptions.push('completion inside weather window');
    }
  }
  candidates.push({
    id: `continue-${ctx.incumbent.id}`,
    kind: 'continue-supplier',
    label: `Continue with ${ctx.incumbent.id}`,
    requiresAssetId: ctx.incumbentAssetId,
    costMinor: continueCost,
    currency: ctx.incumbent.currency,
    feeMinor: ctx.incumbent.feeMinor,
    beneficiary: ctx.incumbent.beneficiary,
    purpose: ctx.incumbent.purpose,
    earliestStartAt: incumbentStart,
    durationMinutes: ctx.incumbent.durationMinutes,
    deadlineAt: ctx.missionDeadlineAt,
    probabilityOfSuccess: continueProbability,
    availability: ctx.incumbent.availability,
    quoteExpiresAt: ctx.incumbent.quoteExpiresAt,
    evidenceIds: evidenceAll.length > 0 ? evidenceAll : [],
    rationale: continueAssumptions.join('; ') || 'nominal plan',
  });

  // ---- reschedule the incumbent into the weather window — only a REAL
  // deferral (the window opens after the incumbent could otherwise start).
  if (window !== null) {
    const leadStart = addMinutes(ctx.now, ctx.incumbent.leadTimeMinutes);
    const isRealDeferral = Date.parse(window.opensAt) > Date.parse(leadStart);
    if (isRealDeferral) {
      const reschedStart = window.opensAt;
      const finishMs = Date.parse(reschedStart) + ctx.incumbent.durationMinutes * 60_000;
      const insideWindow = finishMs <= Date.parse(window.closesAt);
      candidates.push({
        id: 'reschedule-into-window',
        kind: 'reschedule',
        label: `Reschedule ${ctx.incumbent.id} into the observed weather window`,
        requiresAssetId: ctx.incumbentAssetId,
        costMinor: 0,
        currency: ctx.policyCurrency,
        feeMinor: Math.round(ctx.incumbent.baseCostMinor * 0.05), // 5% rescheduling fee (assumption)
        beneficiary: ctx.incumbent.beneficiary,
        purpose: ctx.incumbent.purpose,
        earliestStartAt: reschedStart,
        durationMinutes: ctx.incumbent.durationMinutes,
        deadlineAt: ctx.missionDeadlineAt,
        probabilityOfSuccess:
          ctx.incumbent.probabilityOfSuccess * window.confidence * (insideWindow ? 1 : 0.5),
        availability: 'confirmed',
        evidenceIds: accepted
          .filter(
            (a) =>
              a.input.constraint.kind === 'weather-window' && a.input.asset.id === primaryAsset,
          )
          .map((a) => a.input.event.id),
        rationale: `execute inside the window [${window.opensAt}, ${window.closesAt}] confidence ${String(window.confidence)}${insideWindow ? '' : ' (window shorter than duration — penalized)'}`,
      });
    }
  }

  // ---- hire alternatives.
  for (const alt of ctx.alternatives) {
    const altDelay = contractorDelayMinutes(accepted, alt.id);
    let start = addMinutes(ctx.now, alt.leadTimeMinutes);
    if (window !== null && Date.parse(window.opensAt) > Date.parse(start)) start = window.opensAt;
    let probability = alt.probabilityOfSuccess;
    const assumptions: string[] = [];
    if (altDelay > 0) {
      start = addDelayMinutes(start, altDelay);
      probability *= 0.75;
      assumptions.push(`alternative delayed +${String(altDelay)}m`);
    }
    if (window !== null) {
      const finishMs = Date.parse(start) + alt.durationMinutes * 60_000;
      if (finishMs > Date.parse(window.closesAt)) {
        probability *= 0.4;
        assumptions.push('completion likely outside window');
      } else {
        probability *= window.confidence;
        assumptions.push('completion inside window');
      }
    }
    candidates.push({
      id: `hire-${alt.id}`,
      kind: 'hire-alternative',
      label: `Hire ${alt.id} instead`,
      costMinor: alt.baseCostMinor,
      currency: alt.currency,
      feeMinor: alt.feeMinor,
      beneficiary: alt.beneficiary,
      purpose: alt.purpose,
      earliestStartAt: start,
      durationMinutes: alt.durationMinutes,
      deadlineAt: ctx.missionDeadlineAt,
      probabilityOfSuccess: probability,
      availability: alt.availability,
      quoteExpiresAt: alt.quoteExpiresAt,
      evidenceIds: evidenceAll.length > 0 ? evidenceAll : [],
      rationale: assumptions.join('; ') || 'alternative supplier terms',
    });
  }

  // ---- purchase diagnostics (information has a price and must justify itself).
  if (ctx.diagnosticService !== undefined) {
    const svc = ctx.diagnosticService;
    const severity = accepted.find((a) => a.input.constraint.kind === 'diagnostic-finding');
    // Information gain assumption: driven by the LATEST diagnostic finding's
    // severity when present, otherwise the context-supplied estimate.
    let informationGain = ctx.diagnosticInformationGain ?? 0.2;
    if (severity !== undefined && severity.input.constraint.kind === 'diagnostic-finding') {
      informationGain =
        severity.input.constraint.severity === 'high'
          ? 0.45
          : severity.input.constraint.severity === 'medium'
            ? 0.3
            : 0.15;
    }
    candidates.push({
      id: `diagnostics-${svc.id}`,
      kind: 'purchase-diagnostics',
      label: `Buy ${svc.id} diagnostic report before deciding`,
      costMinor: svc.baseCostMinor,
      currency: svc.currency,
      feeMinor: svc.feeMinor,
      beneficiary: svc.beneficiary,
      purpose: svc.purpose,
      earliestStartAt: addMinutes(ctx.now, svc.leadTimeMinutes),
      durationMinutes: svc.durationMinutes,
      deadlineAt: ctx.missionDeadlineAt,
      probabilityOfSuccess: svc.probabilityOfSuccess,
      informationGain,
      availability: svc.availability,
      quoteExpiresAt: svc.quoteExpiresAt,
      evidenceIds:
        severity !== undefined
          ? [severity.input.event.id, ...evidenceAll.filter((id) => id !== severity.input.event.id)]
          : evidenceAll,
      rationale: `information gain assumption ${String(informationGain)} (severity-driven); cost must clear the diagnostic value threshold`,
    });
  }

  return candidates;
}
