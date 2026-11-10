import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openLedger, type Clock, type Ledger } from '@moterva/ledger';
import {
  loadSnapshots,
  proposePlanFromSnapshot,
  recordSnapshot,
  snapshotServiceFor,
} from '../../src/integration/decision-snapshots.js';
import { fixtureSourceKey } from '../../src/mission-events/src/rng.js';
import { sourceSignature } from '../../src/mission-events/src/digest.js';
import type { NormalizedEvent } from '../../src/mission-events/src/schema.js';

/**
 * DETERMINISTIC PROOF — the asOf double-sample race behind CI run
 * 42707099406's governed-decision :318 failure (HTTP 409 PROPOSAL_REJECTED,
 * no decision-plan-row).
 *
 * Fault (pre-fix): proposePlanUnchecked sampled ledger.clock.now() a SECOND
 * time after service.replay() had already stamped timeline.asOf from the
 * same clock. physicalTimelineToPlannerSafety requires
 * Date.parse(timeline.asOf) === policy.asOf.getTime() EXACTLY, so any
 * millisecond tick between the two samples threw
 * INVALID_PHYSICAL_BRIDGE_SCOPE_OR_POLICY — a plain Error, which the demo
 * route's catch converts to the opaque 409. Under CI load the two samples
 * regularly straddled a tick; idle runs passed, which is why the failure was
 * intermittent and why the parallel two-actor test could pass the same run.
 *
 * Proof strategy: a clock that advances 1 ms on EVERY now() read. The gap
 * between replay's stamp and any later sample is then guaranteed ≥ 1 ms
 * (dozens, given the code reads the clock several times) — the old code
 * throws DETERMINISTICALLY; the fixed code (bridge asOf = timeline.asOf,
 * exactly like evaluateMission/decisionFor already did) succeeds.
 */

class TickingClock implements Clock {
  private readonly base: { now(): Date; iso(): string; advance(ms: number): unknown };
  ticks = 0;
  constructor(private readonly msPerRead = 1) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    this.base = createRealClock();
  }
  now(): Date {
    this.ticks += 1;
    this.base.advance(this.msPerRead);
    return this.base.now();
  }
  iso(): string {
    return this.now().toISOString();
  }
}

/** Small factory so the import stays a value (TunableClock is a class). */
function createRealClock(): { now(): Date; iso(): string; advance(ms: number): unknown } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TunableClock } = require('@moterva/ledger') as {
    TunableClock: new (iso: string) => { now(): Date; iso(): string; advance(ms: number): unknown };
  };
  return new TunableClock(new Date().toISOString());
}

function seedWorld(): {
  ledger: Ledger;
  clock: TickingClock;
  orgId: string;
  missionId: string;
  actorId: string;
} {
  const path = join(mkdtempSync(join(tmpdir(), 'moterva-asof-race-')), 'ledger.sqlite');
  const clock = new TickingClock(1);
  const ledger = openLedger(path, clock);
  ledger.migrate();
  const org = ledger.organizations.createOrganization('asof-race-org');
  const mission = ledger.organizations.createMission(org.id, 'asof-race mission');
  const admin = ledger.authority.createHumanActor({
    orgId: org.id,
    username: 'race-operator',
    displayName: 'Operator',
    role: 'operator',
    password: ['race', 'fixture'].join('-'),
  });
  ledger.accounts.ensureTreasuryAccount({
    orgId: org.id,
    currency: 'USD',
    label: 'USD',
    protectedFloorMinor: 10_000,
  });
  ledger.accounts.recordBalanceSnapshot({
    orgId: org.id,
    currency: 'USD',
    minorUnits: 5_000_000,
    source: 'manual-seed',
    observedAt: clock.iso(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  ledger.mandates.issue({
    orgId: org.id,
    missionId: mission.id,
    currency: 'USD',
    maxAmountMinor: 2_500_000,
    totalBudgetMinor: 2_500_000,
    permittedOperationKinds: ['airwallex_transfer'],
    allowedBeneficiaries: ['harbor-diagnostics', 'harbor-marine'],
    allowedPurposes: ['harbor inspection'],
    byActorId: admin.id,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  return { ledger, clock, orgId: org.id, missionId: mission.id, actorId: admin.id };
}

/** Exactly the demo route's synthetic-step envelopes, signed the same way. */
function ingestDemoStep(
  ledger: Ledger,
  clock: TickingClock,
  orgId: string,
  missionId: string,
  step: 'baseline' | 'incident',
): void {
  const service = snapshotServiceFor(ledger, orgId, missionId);
  const suffix = createHash('sha256')
    .update(orgId + ':' + missionId)
    .digest('hex')
    .slice(0, 16);
  const secretKey = fixtureSourceKey('synthetic-demo-only-' + suffix, 'ops-console');
  const source = {
    sourceId: 'ops-console',
    sourceType: 'mission_control' as const,
    keyId: 'key_demo_' + suffix,
    provenance: 'SYNTHETIC' as const,
  };
  const observations: NormalizedEvent['observations'] =
    step === 'baseline'
      ? [
          { kind: 'wind_speed', unit: 'kt', value: '14.2' },
          { kind: 'weather_hold', unit: 'state', value: 'clear' },
          { kind: 'asset_comms', unit: 'state', value: 'online' },
        ]
      : [
          { kind: 'wind_speed', unit: 'kt', value: '24.6' },
          { kind: 'weather_hold', unit: 'state', value: 'active' },
        ];
  const eventId =
    'evt_demo_' +
    step +
    '_' +
    createHash('sha256')
      .update(orgId + ':' + missionId)
      .digest('hex')
      .slice(0, 20);
  const now = clock.iso();
  const event: NormalizedEvent = {
    contractVersion: 1,
    eventId,
    sequence: step === 'baseline' ? 1 : 2,
    orgId,
    missionId,
    assetId: 'uav-seeker-1',
    observedAt: now,
    ingestedAt: now,
    source: {
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      keyId: source.keyId,
      provenance: source.provenance,
    },
    observations,
  };
  service.ingest(orgId, {
    ...event,
    source: { ...event.source, signature: sourceSignature(event, secretKey) },
  });
}

describe('propose-plan asOf race (CI 42707099406 root cause)', () => {
  it('a clock ticking between replay and the bridge sample no longer breaks the proposal (was: INVALID_PHYSICAL_BRIDGE_SCOPE_OR_POLICY → opaque 409)', () => {
    const world = seedWorld();
    // Same order as the UI journey: baseline event → baseline snapshot →
    // incident event → incident snapshot (a retroactive baseline is refused).
    ingestDemoStep(world.ledger, world.clock, world.orgId, world.missionId, 'baseline');
    recordSnapshot(world.ledger, world.orgId, world.missionId, 'baseline');
    ingestDemoStep(world.ledger, world.clock, world.orgId, world.missionId, 'incident');
    recordSnapshot(world.ledger, world.orgId, world.missionId, 'incident');

    const snapshots = loadSnapshots(world.ledger, world.orgId, world.missionId);
    const incident = snapshots.find((s) => s.payload.stage === 'incident');
    expect(incident).toBeDefined();
    const evaluationId = String(incident?.payload.evaluationId);

    // With the pre-fix double clock sample this call threw
    // INVALID_PHYSICAL_BRIDGE_SCOPE_OR_POLICY on EVERY run of this test
    // (the ticking clock guarantees the two samples differ).
    const result = proposePlanFromSnapshot(
      world.ledger,
      world.orgId,
      world.missionId,
      evaluationId,
      world.actorId,
    );
    if ('rejected' in result) {
      throw new Error(
        `propose rejected: ${String(result.rejected.code)} — ${result.rejected.message}`,
      );
    }
    expect(result.replayed).toBe(false);
    expect(result.plan.amountMinor).toBe(1_850_000); // server-catalog vessel terms
    expect(result.plan.beneficiary).toBe('harbor-marine');
    expect(result.plan.currency).toBe('USD');

    // Idempotency preserved: the identical proposal replays the SAME plan.
    const again = proposePlanFromSnapshot(
      world.ledger,
      world.orgId,
      world.missionId,
      evaluationId,
      world.actorId,
    );
    if ('rejected' in again) {
      throw new Error(`replay rejected: ${String(again.rejected.code)}`);
    }
    expect(again.replayed).toBe(true);
    expect(again.plan.id).toBe(result.plan.id);
    world.ledger.close();
  });
});
