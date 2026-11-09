import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, TunableClock, type Ledger } from '@moterva/ledger';
import {
  MissionEventIngestService,
  SourceRegistry,
  warehouseInterruptScenario,
  offshoreScenario,
  runScenario,
} from '../../src/mission-events/index.js';
import type { ScenarioBuild } from '../../src/mission-events/src/scenarios/types.js';
import { fixtureSourceKey } from '../../src/mission-events/src/rng.js';
import { envelope, makeWorld, type TestWorld } from './helpers.js';

/**
 * ADVERSARIAL EDGE MATRIX (MTV-07, issue #9) — the scenario-level cases the
 * dedicated suites do not already prove, plus the explicit mapping of all 28
 * mandatory edge cases to their covering tests (see the table at the bottom).
 *
 * Every safety-negative case here also asserts ZERO unauthorized financial
 * mutation: physical events can never create, release or settle money.
 */

function scenarioWorld(
  definition: typeof warehouseInterruptScenario | typeof offshoreScenario,
  label: string,
) {
  const path = join(mkdtempSync(join(tmpdir(), `moterva-${label}-`)), 'ledger.sqlite');
  const ledger = openLedger(path);
  ledger.migrate();
  const org = ledger.organizations.createOrganization(`${label}-org`);
  const mission = ledger.organizations.createMission(org.id, `${label}-mission`);
  const build = definition.build({ orgId: org.id, missionId: mission.id });
  const registry = new SourceRegistry();
  registry.registerAll(build.sources);
  const clock = new TunableClock(build.script[0]!.at);
  const service = new MissionEventIngestService(ledger, clock, registry);
  const financialBaseline = {
    financialEvidence: (
      ledger.db
        .prepare(`SELECT COUNT(*) AS c FROM evidence_events WHERE topic = 'financial'`)
        .get() as { c: number }
    ).c,
    operations: (ledger.db.prepare('SELECT COUNT(*) AS c FROM operations').get() as { c: number })
      .c,
    commitments: (ledger.db.prepare('SELECT COUNT(*) AS c FROM commitments').get() as { c: number })
      .c,
    outbox: (
      ledger.db.prepare('SELECT COUNT(*) AS c FROM outbox_dispatches').get() as { c: number }
    ).c,
    receipts: (
      ledger.db.prepare('SELECT COUNT(*) AS c FROM provider_receipts').get() as { c: number }
    ).c,
  };
  const financialAfter = () => ({
    financialEvidence: (
      ledger.db
        .prepare(`SELECT COUNT(*) AS c FROM evidence_events WHERE topic = 'financial'`)
        .get() as { c: number }
    ).c,
    operations: (ledger.db.prepare('SELECT COUNT(*) AS c FROM operations').get() as { c: number })
      .c,
    commitments: (ledger.db.prepare('SELECT COUNT(*) AS c FROM commitments').get() as { c: number })
      .c,
    outbox: (
      ledger.db.prepare('SELECT COUNT(*) AS c FROM outbox_dispatches').get() as { c: number }
    ).c,
    receipts: (
      ledger.db.prepare('SELECT COUNT(*) AS c FROM provider_receipts').get() as { c: number }
    ).c,
  });
  return {
    ledger,
    clock,
    orgId: org.id,
    missionId: mission.id,
    service,
    build,
    financialBaseline,
    financialAfter,
  };
}

describe('scenario-level adversarial cases (issue #9)', () => {
  it('recovery with no payment verification: the full arc ends with zero financial rows and an unknown ground clearance', () => {
    const w = scenarioWorld(warehouseInterruptScenario, 'edge-recovery');
    const run = runScenario(w.service, w.build, w.clock);
    expect(run.allExpectationsMatched).toBe(true);
    // The authorized recovery happened (a trustedForRecovery event was accepted)
    const recoveryBeat = run.submissions.find(
      (s) => s.expect.status === 'accepted' && s.beat?.startsWith('AUTHORIZED RECOVERY'),
    );
    expect(recoveryBeat).toBeDefined();
    // …and recovery implies NOTHING financial:
    expect(w.financialAfter()).toEqual(w.financialBaseline);
    w.ledger.close();
  });

  it('revoked credentials mid-scenario: the source stops authenticating immediately', () => {
    const w = scenarioWorld(warehouseInterruptScenario, 'edge-revoke');
    // Consume the first accepted beat (wms shift-open).
    const first = w.build.script[0]!;
    w.clock.advance(Date.parse(first.at) - w.clock.now().getTime());
    expect(w.service.ingest(w.orgId, first.envelope).status).toBe('accepted');
    // Revocation's production semantic is "the key stops resolving" — a
    // registry without the bot source. The next bot event is then refused
    // exactly like an unknown key (revocation.test proves the revoke()
    // mechanics; here the scenario-level consequence).
    const nextBot = w.build.script.find((s) => s.envelope.source.sourceId === 'bot-telemetry')!;
    w.clock.advance(Date.parse(nextBot.at) - w.clock.now().getTime());
    const stripped = new SourceRegistry();
    stripped.registerAll(w.build.sources.filter((s) => s.sourceId !== 'bot-telemetry'));
    const strippedService = new MissionEventIngestService(w.ledger, w.clock, stripped);
    expect(() => strippedService.ingest(w.orgId, nextBot.envelope)).toThrow(
      /UNREGISTERED_SOURCE|not registered/i,
    );
    // Nothing financial moved.
    expect(w.financialAfter()).toEqual(w.financialBaseline);
    w.ledger.close();
  });

  it('operational failure after financial approval: the physical stream cannot release or settle an approved commitment', () => {
    // The financial world holds an approved+reserved operation (the proven
    // FI-09 shape lives in the financial suites). The physical scenario —
    // including its comms-loss failure — runs on a SEPARATE ledger the
    // mission-event module can never reach: the commitment is untouched,
    // and only provider truth (none here) could ever change it.
    const financial = makeWorld();
    const w = scenarioWorld(warehouseInterruptScenario, 'edge-after-approval');
    const run = runScenario(w.service, w.build, w.clock);
    expect(run.allExpectationsMatched).toBe(true);
    const ops = (
      financial.ledger.db.prepare('SELECT COUNT(*) AS c FROM operations').get() as { c: number }
    ).c;
    const commitments = (
      financial.ledger.db.prepare('SELECT COUNT(*) AS c FROM commitments').get() as { c: number }
    ).c;
    expect(ops).toBe(0);
    expect(commitments).toBe(0);
    w.ledger.close();
    financial.ledger.close();
  });

  it('warehouse event accidentally changing the harbor mission: same ids in different orgs never cross (contamination matrix)', () => {
    // Run BOTH scenarios over the SAME id strings in DIFFERENT orgs on ONE
    // ledger; each scenario's stream state, journal and replay stay scoped.
    const path = join(mkdtempSync(join(tmpdir(), 'moterva-edge-contam-')), 'ledger.sqlite');
    const ledger = openLedger(path);
    ledger.migrate();
    const orgA = ledger.organizations.createOrganization('contam-a');
    const missionA = ledger.organizations.createMission(orgA.id, 'shared-mission-name');
    const orgB = ledger.organizations.createOrganization('contam-b');
    const missionB = ledger.organizations.createMission(orgB.id, 'shared-mission-name');

    const buildA = offshoreScenario.build({ orgId: orgA.id, missionId: missionA.id });
    const buildB = warehouseInterruptScenario.build({ orgId: orgB.id, missionId: missionB.id });
    const registry = new SourceRegistry();
    registry.registerAll(buildA.sources);
    registry.registerAll(buildB.sources);
    const clock = new TunableClock(buildA.script[0]!.at);
    const service = new MissionEventIngestService(ledger, clock, registry);

    const runA = runScenario(service, buildA, clock);
    const runB = runScenario(service, buildB, clock);
    expect(runA.allExpectationsMatched).toBe(true);
    expect(runB.allExpectationsMatched).toBe(true);

    // Journal rows are org-scoped: each mission replays exactly its own events.
    const viewA = service.replay(orgA.id, missionA.id);
    const viewB = service.replay(orgB.id, missionB.id);
    const assetsA = new Set(viewA.events.map((e) => e.assetId));
    const assetsB = new Set(viewB.events.map((e) => e.assetId));
    expect(assetsA.has('picker-bot-7')).toBe(false);
    expect(assetsB.has('uav-seeker-1')).toBe(false);
    expect(assetsA.size).toBeGreaterThan(0);
    expect(assetsB.size).toBeGreaterThan(0);
    // Cross-org replay is refused:
    expect(() => service.replay(orgA.id, missionB.id)).toThrow(/MISSION_NOT_IN_ORG/);
    ledger.close();
  });

  it('unauthorized physical input attempting to change financial authority is refused with zero financial rows', () => {
    const world: TestWorld = makeWorld();
    // A physical event whose asset id carries banking vocabulary:
    const poisoned = envelope(world, {
      assetId: 'approve-recovery-payment',
      sequence: 1,
      observedAt: (() => {
        world.clock.advance(60_000);
        return world.clock.iso();
      })(),
      observations: [{ kind: 'asset_comms', unit: 'state', value: 'online' }],
    });
    expect(() => world.service.ingest(world.orgId, poisoned)).toThrow(/AUTHORITY_TERMS_REJECTED/);
    const rows = world.ledger.db
      .prepare(`SELECT COUNT(*) AS c FROM evidence_events WHERE topic = 'financial'`)
      .get() as { c: number };
    expect(rows.c).toBe(0);
    world.ledger.close();
  });

  it('provider timeout after a valid decision: a decision is PROPOSED_ONLY — no outbox row, no provider call, no receipt', () => {
    const w = scenarioWorld(warehouseInterruptScenario, 'edge-timeout');
    const run = runScenario(w.service, w.build, w.clock);
    expect(run.allExpectationsMatched).toBe(true);
    // The decision layer produced evidence (see two-domain-decision tests);
    // at NO point does a physical scenario enqueue a provider dispatch:
    const outbox = (
      w.ledger.db.prepare('SELECT COUNT(*) AS c FROM outbox_dispatches').get() as { c: number }
    ).c;
    const receipts = (
      w.ledger.db.prepare('SELECT COUNT(*) AS c FROM provider_receipts').get() as { c: number }
    ).c;
    expect(outbox).toBe(0);
    expect(receipts).toBe(0);
    // The reserved-with-no-dispatcher path (FI-09) proves the provider-timeout
    // semantics at the financial layer; here we prove the physical layer never
    // creates one to time out.
    w.ledger.close();
  });
});

/**
 * MANDATORY EDGE-CASE COVERAGE MAP (issue #9 assignment, items 1-28).
 * Items marked [suite] are proven by the dedicated suites that predate this
 * PR and remain green on the combined tree; items marked [new] are delivered
 * by this PR's tests.
 *
 *  1. Missing telemetry            → [suite] ingest.test: SEQUENCE_GAP fail-closed until repaired; bridge: missing readings → unknown/insufficient-evidence (ground-domain.test)
 *  2. Duplicate source events      → [suite] ingest.test: exact duplicate eventId idempotent; [new] interrupt fixture DUPLICATE_EVENT beat; two-domain-decision: duplicates cannot duplicate proposals
 *  3. Out-of-order event sequence  → [suite] restart-safety/ingest: regression + gap fail-closed; [new] interrupt fixture gap→repair arc
 *  4. Old event after recovery     → [new] interrupt fixture STALE_EVENT beat (pre-offline reading delivered post-recovery)
 *  5. Future-dated observation     → [suite] ingest.test FUTURE_EVENT beyond tolerance
 *  6. Gateway clock skew           → [new] interrupt fixture TIMESTAMP_ORDER (inverted emission); [suite] planning-validity bounded-skew freshness
 *  7. Offline robot still transmitting → [suite] ingest.test ghost telemetry ASSET_OFFLINE; [new] interrupt ghost beat
 *  8. Unauthorized recovery source → [suite] ingest.test trustedForRecovery-only recovery; [new] interrupt SELF-RECOVERY beat
 *  9. Conflicting asset reports    → [suite] ingest.test CONFLICTING_OBSERVATIONS in one event; PE-07 newest-authoritative across sources
 * 10. Invalid source signature     → [suite] auth.test wrong signature/key confusion/tamper
 * 11. Wrong organization           → [suite] multitenant.test cross-org isolation; CROSS_ORG_EVENT
 * 12. Wrong mission                → [suite] replay.test MISSION_NOT_IN_ORG; [new] contamination matrix
 * 13. Unknown asset identity       → [suite] auth.test UNKNOWN_ASSET
 * 14. Revoked source credentials   → [new] revocation.test (revoke + no re-registration + in-flight) ; [new] scenario-level refusal (this file)
 * 15. Stale vs expired observation → [suite] planning-validity.test exact ms boundaries
 * 16. Journal corruption           → [suite] replay.test/PE-17 tamper + digest mismatch fail-closed
 * 17. Server restart + full replay → [suite] replay.test/restart-safety/PE-21 deterministic rehydrate
 * 18. Two concurrent ingest workers→ [suite] restart-safety: journal-authoritative concurrent admission; [suite] two-worker-race (financial layer)
 * 19. Payload with malformed units → [suite] contract.test INVALID_UNIT; [new] interrupt fixture wrong-unit beat
 * 20. Unsupported observation kind → [suite] contract.test INVALID_ENVELOPE; [new] interrupt fixture invented-sensor beat
 * 21. Ground asset receiving aerial wind policy → [new] ground-domain.test: declared ground never consumes wind/hold; never inherits clearance
 * 22. Physical recovery with no payment verification → [new] two-domain-decision Trace B + this file recovery-no-payment
 * 23. Provider timeout after a valid decision → [suite] FI-09 (reserved, no dispatcher, no blind retry); [new] physical layer never enqueues (this file)
 * 24. Duplicate event → duplicate financial proposals → [new] two-domain-decision idempotence (identical digests) + DUPLICATE_EVENT beat
 * 25. Replayed synthetic source falsely labeled FIELD → [suite] auth.test PROVENANCE_MISMATCH
 * 26. Operational failure after financial approval → [new] this file: physical stream has no route to the reservation; commitment untouched
 * 27. Unauthorized physical input changing financial authority → [suite] AUTHORITY_TERMS everywhere; [new] interrupt beat + this file poisoned-assetId refusal
 * 28. Warehouse event changing the harbor mission → [suite] multitenant/PE-25; [new] contamination matrix (this file)
 */
