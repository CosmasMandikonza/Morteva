import { useCallback, useMemo, useState } from 'react';
import type { LifecycleState } from './data';

/**
 * The honest-state laboratory: a small deterministic operation flow plus the
 * failure/edge overrides from issue #10 Phase 6. Every candidate renders the
 * SAME machine so the founder compares design, not behavior.
 *
 * Flow: PROPOSED → RESERVED → APPROVED → SUBMITTING → SUBMITTED → SETTLED → RECONCILED
 * Adversarial branches: STATUS_UNKNOWN (commitment held), REJECTED (digest mismatch),
 * EXPIRED (mandate lapse). No step ever skips provider verification.
 */

export type LabOverride =
  | 'none'
  | 'loading'
  | 'empty'
  | 'provider_offline'
  | 'stale_balance'
  | 'ai_unavailable'
  | 'webgl_lost'
  | 'evidence_unavailable';

export type FlowBranch = 'clean' | 'unknown' | 'rejected' | 'expired';

const ORDER: LifecycleState[] = [
  'PROPOSED',
  'RESERVED',
  'APPROVED',
  'SUBMITTING',
  'SUBMITTED',
  'SETTLED',
  'RECONCILED',
];

export interface OperationFlow {
  state: LifecycleState;
  branch: FlowBranch;
  settledAt: string | null;
  unknownSince: string | null;
  rejectReason: string | null;
}

export const FLOW_STEPS = ORDER.map((s) => s);

export function useOperationFlow() {
  const [flow, setFlow] = useState<OperationFlow>({
    state: 'PROPOSED',
    branch: 'clean',
    settledAt: null,
    unknownSince: null,
    rejectReason: null,
  });

  const reset = useCallback(() => {
    setFlow({
      state: 'PROPOSED',
      branch: 'clean',
      settledAt: null,
      unknownSince: null,
      rejectReason: null,
    });
  }, []);

  const advance = useCallback(() => {
    setFlow((f) => {
      const i = ORDER.indexOf(f.state);
      if (i < 0 || i >= ORDER.length - 1) return f;
      const next = ORDER[i + 1]!;
      return {
        ...f,
        state: next,
        settledAt: next === 'SETTLED' ? '14:36:02 UTC · verified by read-back' : f.settledAt,
      };
    });
  }, []);

  const loseResponse = useCallback(() => {
    setFlow((f) => ({
      ...f,
      state: 'STATUS_UNKNOWN',
      branch: 'unknown',
      unknownSince: '14:32:41 UTC',
    }));
  }, []);

  const resolveUnknown = useCallback(() => {
    setFlow((f) => ({
      ...f,
      state: 'SETTLED',
      branch: 'clean',
      settledAt: '14:37:12 UTC · resolved by original request id',
      unknownSince: null,
    }));
  }, []);

  const tamperTerms = useCallback(() => {
    setFlow((f) => ({
      ...f,
      state: 'REJECTED',
      branch: 'rejected',
      rejectReason: 'Beneficiary changed after approval — digest mismatch. Re-approval required.',
    }));
  }, []);

  const expireMandate = useCallback(() => {
    setFlow((f) => ({
      ...f,
      state: 'EXPIRED',
      branch: 'expired',
      rejectReason: 'Mandate expired before submission — spending authority lapsed.',
    }));
  }, []);

  const machine = useMemo(
    () => ({ flow, reset, advance, loseResponse, resolveUnknown, tamperTerms, expireMandate }),
    [flow, reset, advance, loseResponse, resolveUnknown, tamperTerms, expireMandate],
  );
  return machine;
}

export type FlowMachine = ReturnType<typeof useOperationFlow>;

/** Where the current state sits on the linear strip (unknown/rejected sit off-strip). */
export function stepIndex(state: LifecycleState): number {
  return ORDER.indexOf(state);
}
