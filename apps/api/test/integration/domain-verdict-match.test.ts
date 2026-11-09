/**
 * P0-2 MATCHED-VERDICT PROOF (CTO R3 follow-up): Agent A's physical-view
 * constraint engine (`constraintFor`, PR #52) and Agent D's planner bridge
 * (`physicalTimelineToPlannerSafety`, PR #54) must emit IDENTICAL verdicts
 * (state + reason) for the same journal state — walked PER EVENT at EVERY
 * accepted beat of both REAL ingested traces:
 *   - the offshore aerial trace (wind/hold/comms arc, uav-seeker-1),
 *   - the warehouse ground trace from #54 (comms-interrupt/recovery arc,
 *     picker-bot-7).
 * Domain declarations are passed IDENTICALLY to both engines — the
 * comparison is engine equivalence, not catalog policy (the live route's
 * fixed demo catalog and its ASSET_DOMAIN_UNAVAILABLE fail-closed path are
 * separately covered by the physical-view tests).
 *
 * A ground verdict must never be `clear`, and the post-recovery steady state
 * must remain honest `unknown/insufficient-evidence` in BOTH engines.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, TunableClock, type Ledger } from '@moterva/ledger';
import type { MissionEvidenceInput } from '@moterva/planner';
import {
  MissionEventIngestService,
  offshoreScenario,
  SourceRegistry,
  warehouseInterruptScenario,
  type ScenarioDefinition,
} from '../../src/mission-events/index.js';
import type {
  AcceptedEventView,
  MissionTimelineView,
  ObservationReading,
} from '../../src/mission-events/src/view.js';
import { physicalTimelineToPlannerSafety } from '../../src/integration/physical-to-planner.js';
import { constraintFor } from '../../src/integration/physical-view.js';

const WIND_LIMIT_KT = 22;
const SAFETY_KINDS = new Set(['wind_speed', 'weather_hold', 'asset_comms']);

interface Verdict {
  state: string;
  reason: string;
  assetId: string;
}

interface TraceRun {
  ledger: Ledger;
  dbDir: string;
  orgId: string;
  missionId: string;
  verdicts: Verdict[];
  lastTimeline: MissionTimelineView;
}

/**
 * Ingests the FULL scripted trace in one clock-ordered pass. After EVERY
 * accepted submission the matched-verdict walk runs at that beat's own
 * moment (the clock is never rewound), so every journaled event is compared
 * while it is inside the freshness window — the same discipline the live
 * route and the bridge use.
 */
function runTraceWithMatchedWalks(
  definition: ScenarioDefinition,
  label: string,
  domains: Readonly<Record<string, 'aerial' | 'ground'>>,
): TraceRun {
  const dbDir = mkdtempSync(join(tmpdir(), `verdict-match-${label}-`));
  const ledger = openLedger(join(dbDir, 'ledger.sqlite'));
  ledger.migrate();
  const org = ledger.organizations.createOrganization(`${label}-org`);
  const mission = ledger.organizations.createMission(org.id, `${label}-mission`);
  const build = definition.build({ orgId: org.id, missionId: mission.id });
  const registry = new SourceRegistry();
  registry.registerAll(build.sources);
  const clock = new TunableClock(build.script[0]!.at);
  const service = new MissionEventIngestService(ledger, clock, registry);

  const verdicts: Verdict[] = [];
  let lastTimeline: MissionTimelineView | undefined;
  for (const submission of build.script) {
    const anchorMs = Date.parse(submission.at);
    if (anchorMs > clock.now().getTime()) {
      clock.advance(anchorMs - clock.now().getTime());
    }
    try {
      const outcome = service.ingest(org.id, submission.envelope);
      expect(outcome.status).toBe(submission.expect.status);
    } catch (error) {
      // Rejections THROW; the scripted expectation records the code.
      const message = error instanceof Error ? error.message : String(error);
      expect(submission.expect.status).toBe('rejected');
      expect(message).toContain(`[${submission.expect.code ?? ''}]`);
    }
    if (submission.expect.status !== 'accepted') continue;
    const timeline = service.replay(org.id, mission.id);
    lastTimeline = timeline;
    verdicts.push(
      ...assertVerdictsMatch({
        timeline,
        asOf: new Date(clock.now()),
        domains,
        traceName: label,
      }),
    );
  }
  return { ledger, dbDir, orgId: org.id, missionId: mission.id, verdicts, lastTimeline: lastTimeline! };
}

/**
 * Walks ONE timeline per-event with Agent D's exact withholding predicate,
 * accumulating the same latest-readings map the bridge accumulates, and
 * asserts the physical-view engine emits the SAME (state, reason) for every
 * bridge verdict. Returns the matched verdict pairs for coverage assertions.
 */
function assertVerdictsMatch(input: {
  timeline: MissionTimelineView;
  asOf: Date;
  domains: Readonly<Record<string, 'aerial' | 'ground'>>;
  traceName: string;
}): Verdict[] {
  const { timeline, asOf, domains, traceName } = input;
  const nowMs = asOf.getTime();
  const maxAgeMs = timeline.policy.maxAgeMs;
  const bridge = physicalTimelineToPlannerSafety(timeline, {
    orgId: timeline.orgId,
    missionId: timeline.missionId,
    asOf,
    uavWindLimitKt: WIND_LIMIT_KT,
    assetKinds: domains,
  });

  // Agent D's exact admission predicate (physical-to-planner.ts) — the ONLY
  // gate deciding which journaled events influence verdicts.
  const admitted = (e: AcceptedEventView): boolean => {
    const observedMs = Date.parse(e.observedAt);
    return (
      e.planningValid &&
      e.provenance === 'SYNTHETIC' &&
      Number.isFinite(observedMs) &&
      observedMs <= nowMs &&
      nowMs - observedMs < maxAgeMs
    );
  };

  const latest = new Map<string, Record<string, ObservationReading>>();
  const matched: Verdict[] = [];
  for (const event of [...timeline.events].sort((a, b) => a.journalSeq - b.journalSeq)) {
    if (!admitted(event)) continue;
    const acc: Record<string, ObservationReading> = latest.get(event.assetId) ?? {};
    let touchedSafety = false;
    for (const o of event.observations) {
      if (!SAFETY_KINDS.has(o.kind)) continue;
      acc[o.kind] = {
        kind: o.kind,
        unit: o.unit,
        value: o.value,
        eventId: event.eventId,
        observedAt: event.observedAt,
        freshness: 'fresh',
      };
      touchedSafety = true;
    }
    latest.set(event.assetId, acc);
    if (!touchedSafety) continue;

    const bridgeEntry = bridge.evidence.find(
      (x: MissionEvidenceInput) => x.event.id === event.eventId,
    );
    expect(
      bridgeEntry,
      `${traceName}: bridge emitted no verdict for admitted event ${event.eventId}`,
    ).toBeDefined();
    const constraint = bridgeEntry!.constraint as { state: string; reason: string };
    const mine = constraintFor({
      assetId: event.assetId,
      domain: domains[event.assetId] ?? 'aerial',
      latest: acc,
      windLimitKt: WIND_LIMIT_KT,
    });
    expect(
      `${mine.state}/${mine.reason}`,
      `${traceName}: verdict mismatch at event ${event.eventId} (${event.assetId})`,
    ).toBe(`${constraint.state}/${constraint.reason}`);
    matched.push({ state: mine.state, reason: mine.reason, assetId: event.assetId });
  }
  // 1:1 — the bridge emitted exactly the verdicts the walk compared.
  expect(
    bridge.evidence,
    `${traceName}: bridge emitted ${bridge.evidence.length} verdicts but ${matched.length} were matched`,
  ).toHaveLength(matched.length);
  return matched;
}

describe('P0-2 matched verdicts: physical-view engine ≡ planner bridge on REAL traces', () => {
  it('offshore aerial trace: identical verdicts at every accepted beat', () => {
    // BOTH engines get the SAME declarations. The vessel is declared aerial
    // here so the aerial chain equivalence is exercised on its wind/hold
    // beats too (catalog policy for the vessel is a separate route concern).
    const world = runTraceWithMatchedWalks(offshoreScenario, 'offshore-match', {
      'uav-seeker-1': 'aerial',
      'vessel-prospect': 'aerial',
    });
    try {
      // The matched walks covered the meaningful aerial verdicts: nominal
      // baseline, the wind-limit incident, offline block, and the
      // degraded → unknown honesty.
      const reasons = new Set(world.verdicts.map((v) => v.reason));
      expect(reasons).toContain('nominal');
      expect(reasons).toContain('wind-limit');
      expect(reasons).toContain('comms-offline');
      expect(reasons).toContain('insufficient-evidence');
      for (const v of world.verdicts) {
        expect(['clear', 'blocked', 'unknown']).toContain(v.state);
      }
    } finally {
      world.ledger.close();
      rmSync(world.dbDir, { recursive: true, force: true });
    }
  });

  it('warehouse ground trace (#54): identical verdicts, never clear, honest post-recovery unknown', () => {
    const world = runTraceWithMatchedWalks(warehouseInterruptScenario, 'warehouse-match', {
      'picker-bot-7': 'ground',
    });
    try {
      // Ground verdicts covered BOTH meaningful states: the comms-offline
      // interrupt (blocked) and the honest unknown everywhere else —
      // including degraded comms and the post-recovery steady state.
      const reasons = new Set(world.verdicts.map((v) => v.reason));
      expect(reasons).toContain('comms-offline');
      expect(reasons).toContain('insufficient-evidence');
      // A ground asset is NEVER clear and NEVER inherits aerial reasons.
      for (const v of world.verdicts) {
        expect(v.assetId).toBe('picker-bot-7');
        expect(v.state).not.toBe('clear');
        expect(['wind-limit', 'weather-hold']).not.toContain(v.reason);
      }
      // FINAL steady state (CTO #54 acceptance): comms fresh online, healthy
      // ground facts journaled — the LAST matched verdict (final beat's walk,
      // agreed by both engines) and the view's authoritative latest-readings
      // map both stay honest `unknown/insufficient-evidence`.
      expect(`${world.verdicts[world.verdicts.length - 1]!.state}/${world.verdicts[world.verdicts.length - 1]!.reason}`).toBe(
        'unknown/insufficient-evidence',
      );
      const lastTimeline = world.lastTimeline;
      const viewLatest = lastTimeline.assets['picker-bot-7']!.latest;
      const fromView = constraintFor({
        assetId: 'picker-bot-7',
        domain: 'ground',
        latest: viewLatest,
        windLimitKt: WIND_LIMIT_KT,
      });
      expect(`${fromView.state}/${fromView.reason}`).toBe('unknown/insufficient-evidence');
      // The view's authoritative comms reading is the fresh online recovery
      // report — the honest unknown is grounded in the newest journal state.
      expect(viewLatest['asset_comms']!.value).toBe('online');
      expect(viewLatest['asset_comms']!.freshness).toBe('fresh');
    } finally {
      world.ledger.close();
      rmSync(world.dbDir, { recursive: true, force: true });
    }
  });
});
