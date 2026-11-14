import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  evaluateFromJournal,
  fetchOperationsDecision,
  type OperationsDecision,
  type OperationsEvaluation,
} from './api';
import { loadFieldEvents, type FieldState } from './fieldEvents';
import { describeEvaluateError } from './operationsFlow';

/**
 * Customer-workflow state for one mission: the real journal read
 * (`GET /operations/decision`), the authenticated event list, and the explicit
 * "record this evaluation" action. Nothing here is a demo route and nothing
 * writes on read: a refresh only GETs; recording is a deliberate POST that the
 * server makes idempotent per economic intent.
 */

export type OpsState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: OperationsDecision }
  | { readonly kind: 'error'; readonly status: number; readonly code: string };

export interface OperationsController {
  readonly ops: OpsState;
  readonly field: FieldState;
  /** Full detail of the last evaluation recorded in THIS browser session. */
  readonly evaluation: OperationsEvaluation | null;
  readonly evalBusy: boolean;
  readonly evalError: string | null;
  readonly refreshing: boolean;
  readonly refresh: () => void;
  readonly evaluate: (stage: 'baseline' | 'incident') => void;
}

export function useOperations(args: {
  missionId: string | null;
  enabled: boolean;
  csrfToken: string | null;
  onSessionExpired: () => void;
  /** Called after an evaluation is recorded so durable lists can reload. */
  onRecorded: () => void;
}): OperationsController {
  const { missionId, enabled, csrfToken, onSessionExpired, onRecorded } = args;
  const [ops, setOps] = useState<OpsState>({ kind: 'idle' });
  const [field, setField] = useState<FieldState>({ kind: 'loading' });
  const [evaluation, setEvaluation] = useState<OperationsEvaluation | null>(null);
  const [evalBusy, setEvalBusy] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // A different mission means a different journal: never carry detail across.
  useEffect(() => {
    setEvaluation(null);
    setEvalError(null);
    setOps({ kind: 'idle' });
    setField({ kind: 'loading' });
  }, [missionId]);

  useEffect(() => {
    if (!enabled || missionId === null) return;
    const controller = new AbortController();
    setRefreshing(true);
    setOps((current) => (current.kind === 'ready' ? current : { kind: 'loading' }));
    fetchOperationsDecision(missionId, controller.signal)
      .then(async (data) => {
        if (controller.signal.aborted) return;
        setOps({ kind: 'ready', data });
        if (data.events !== undefined) {
          setField({ kind: 'ready', events: data.events, constraints: [] });
        } else {
          setField(await loadFieldEvents(missionId, controller.signal));
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiError && reason.status === 401) {
          onSessionExpired();
          return;
        }
        setOps({
          kind: 'error',
          status: reason instanceof ApiError ? reason.status : 0,
          code: reason instanceof ApiError ? reason.code : 'NETWORK',
        });
        setField({
          kind: 'unavailable',
          code: reason instanceof ApiError ? reason.code : 'NETWORK',
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setRefreshing(false);
      });
    return () => controller.abort();
  }, [missionId, enabled, tick, onSessionExpired]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const evaluate = useCallback(
    (stage: 'baseline' | 'incident'): void => {
      if (!enabled || missionId === null || csrfToken === null || evalBusy) return;
      setEvalBusy(true);
      setEvalError(null);
      evaluateFromJournal(missionId, stage, csrfToken)
        .then((result) => {
          setEvaluation(result);
          setEvalBusy(false);
          setTick((n) => n + 1);
          onRecorded();
        })
        .catch((reason: unknown) => {
          setEvalBusy(false);
          if (reason instanceof ApiError && reason.status === 401) {
            onSessionExpired();
            return;
          }
          setEvalError(
            reason instanceof ApiError
              ? describeEvaluateError(reason.code, reason.status)
              : 'Could not reach the server — nothing was recorded.',
          );
          // The journal may have moved under us (another operator, a new
          // event): re-read it so the next action is based on current facts.
          setTick((n) => n + 1);
        });
    },
    [enabled, missionId, csrfToken, evalBusy, onRecorded, onSessionExpired],
  );

  return { ops, field, evaluation, evalBusy, evalError, refreshing, refresh, evaluate };
}
