import { useCallback, useMemo, useState } from 'react';
import type { Framing } from '../viewport/Scene';
import { useOperationFlow, type LabOverride } from './state-machine';

export type { LabOverride };

export type ScreenId = 'treasury' | 'decision' | 'authority' | 'replay';

export const SCREENS: Array<{ id: ScreenId; label: string; hint: string }> = [
  { id: 'treasury', label: 'Mission Treasury', hint: 'Liquidity, commitments, exceptions' },
  { id: 'decision', label: 'Decision Room', hint: 'Evidence, alternatives, economics' },
  { id: 'authority', label: 'Authority & Execution', hint: 'Exact terms, honest provider states' },
  { id: 'replay', label: 'Evidence Replay', hint: 'Immutable journal, linked receipts' },
];

/** One shared interaction model so both candidates behave identically. */
export function useLabState() {
  // Deep-link support for captures/tests: #decision|#authority|… picks the
  // initial screen; ?screen= is normalized to the hash by the entry point.
  const hashScreen = window.location.hash.replace('#', '') as ScreenId;
  const valid = SCREENS.some((s) => s.id === hashScreen);
  const [screen, setScreen] = useState<ScreenId>(valid ? hashScreen : 'treasury');
  const [selectedMission, setSelectedMission] = useState('M-104');
  const [selectedPlan, setSelectedPlan] = useState('P2');
  const [selectedPin, setSelectedPin] = useState<string | null>('EV-2214');
  const [framing, setFraming] = useState<Framing>('overview');
  const [selectedEvent, setSelectedEvent] = useState('RE-08');
  const [override, setOverride] = useState<LabOverride>('none');
  const [reducedMotion, setReducedMotion] = useState(false);
  const flow = useOperationFlow();

  const toggleReducedMotion = useCallback(() => setReducedMotion((v) => !v), []);

  const selectPlan = useCallback((id: string) => {
    setSelectedPlan(id);
    if (id === 'P2') setScreen('authority');
  }, []);

  const selectEvent = useCallback((id: string) => {
    setSelectedEvent(id);
    if (id === 'RE-02' || id === 'RE-08') {
      setSelectedPin('EV-2214');
    }
  }, []);

  return useMemo(
    () => ({
      screen,
      setScreen,
      selectedMission,
      setSelectedMission,
      selectedPlan,
      selectPlan,
      selectedPin,
      setSelectedPin,
      framing,
      setFraming,
      selectedEvent,
      selectEvent,
      override,
      setOverride,
      reducedMotion,
      toggleReducedMotion,
      flow,
    }),
    [
      screen,
      selectedMission,
      selectedPlan,
      selectPlan,
      selectedPin,
      framing,
      selectedEvent,
      selectEvent,
      override,
      reducedMotion,
      toggleReducedMotion,
      flow,
    ],
  );
}

export type LabState = ReturnType<typeof useLabState>;

export const OVERRIDES: Array<{ id: LabOverride; label: string; effect: string }> = [
  { id: 'none', label: 'Nominal', effect: 'normal honest-state operation' },
  { id: 'loading', label: 'Loading', effect: 'labeled skeletons everywhere' },
  { id: 'empty', label: 'Empty', effect: 'first-run empty states + honest CTA' },
  {
    id: 'provider_offline',
    label: 'Provider offline',
    effect: 'OFFLINE chips, retry, no fake data',
  },
  { id: 'stale_balance', label: 'Stale balance', effect: 'age badge + autonomy suspended' },
  { id: 'ai_unavailable', label: 'AI unavailable', effect: 'case readable, manual path only' },
  { id: 'webgl_lost', label: '3D unavailable', effect: 'viewport shows 2D fallback card' },
  {
    id: 'evidence_unavailable',
    label: 'Evidence unavailable',
    effect: 'narrative degrades honestly',
  },
];
