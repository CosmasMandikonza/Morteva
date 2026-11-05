/**
 * Scenario tests (issue #9): the two fixtures are deterministic, economically
 * meaningful and adversarially rich; both run through the SAME ingest code
 * path; and the module boundary is provably free of financial engine imports.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  offshoreScenario,
  runScenario,
  scriptDigest,
  warehouseScenario,
  MissionEventIngestService,
  SourceRegistry,
} from '../../src/mission-events/index.js';
import { TunableClock, openLedger } from '@moterva/ledger';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const MODULE_ROOT = join(import.meta.dirname, '..', '..', 'src', 'mission-events');

function world(): { orgId: string; missionId: string; ledger: ReturnType<typeof openLedger> } {
  const path = join(mkdtempSync(join(tmpdir(), 'moterva-scen-')), 'ledger.sqlite');
  const ledger = openLedger(path);
  ledger.migrate();
  const org = ledger.organizations.createOrganization('scen-org');
  const mission = ledger.organizations.createMission(org.id, 'scen-mission');
  return { orgId: org.id, missionId: mission.id, ledger };
}

function execute(definition: typeof offshoreScenario, seed?: string) {
  const w = world();
  const build = definition.build({ orgId: w.orgId, missionId: w.missionId }, seed);
  const registry = new SourceRegistry();
  registry.registerAll(build.sources);
  const clock = new TunableClock(build.script[0]!.at);
  const service = new MissionEventIngestService(w.ledger, clock, registry);
  const run = runScenario(service, build, clock);
  return { build, run, service, orgId: w.orgId, missionId: w.missionId, ledger: w.ledger };
}

describe('scenario determinism (same seed → same event sequence)', () => {
  it('flagship offshore: identical rebuild for the same seed, different for another seed', () => {
    const w = world();
    const first = offshoreScenario.build({ orgId: w.orgId, missionId: w.missionId });
    const second = offshoreScenario.build({ orgId: w.orgId, missionId: w.missionId });
    const other = offshoreScenario.build(
      { orgId: w.orgId, missionId: w.missionId },
      'different-seed',
    );
    expect(scriptDigest(second.script)).toBe(scriptDigest(first.script));
    expect(JSON.stringify(second.script)).toBe(JSON.stringify(first.script));
    expect(scriptDigest(other.script)).not.toBe(scriptDigest(first.script));
    w.ledger.close();
  });

  it('warehouse fixture: identical rebuild for the same seed', () => {
    const w = world();
    const first = warehouseScenario.build({ orgId: w.orgId, missionId: w.missionId });
    const second = warehouseScenario.build({ orgId: w.orgId, missionId: w.missionId });
    expect(JSON.stringify(second.script)).toBe(JSON.stringify(first.script));
    w.ledger.close();
  });

  it('both scenarios: every scripted expectation matches at runtime', () => {
    for (const definition of [offshoreScenario, warehouseScenario]) {
      const { run, ledger } = execute(definition);
      const mismatches = run.submissions.filter((s) => !s.matched);
      expect(
        mismatches,
        `${definition.id} expectation mismatches: ${JSON.stringify(mismatches.map((m) => ({ i: m.index, expected: m.expect, actual: m.actual })))}`,
      ).toEqual([]);
      expect(run.acceptedCount).toBeGreaterThan(0);
      expect(run.rejectedCount).toBeGreaterThanOrEqual(3);
      ledger.close();
    }
  });

  it('flagship offshore: at least two economically meaningful observation changes', () => {
    const { run, build } = execute(offshoreScenario);
    const economic = run.submissions.filter((s) => s.economicEffect !== undefined);
    expect(economic.length).toBeGreaterThanOrEqual(5);
    // The economic arc is carried by ACCEPTED evidence: calm launch window →
    // wind over the 22kt limit → major defect found.
    const windObservations = build.script
      .map((submission, index) => ({ submission, outcome: run.submissions[index]!.actual }))
      .filter(({ submission }) =>
        submission.envelope.observations.some((o) => o.kind === 'wind_speed'),
      )
      .map(({ submission, outcome }) => ({
        wind: submission.envelope.observations.find((o) => o.kind === 'wind_speed')!.value,
        outcome: outcome.status,
      }));
    const winds = windObservations.map((w) => w.wind);
    expect(winds).toContain('14.2');
    expect(winds).toContain('24.6');
    expect(windObservations.every((w) => w.outcome === 'accepted')).toBe(true);
    const defectAccepted = run.submissions.some(
      (s) =>
        s.actual.status === 'accepted' &&
        build.script[s.index]!.envelope.observations.some(
          (o) => o.kind === 'defect_severity' && o.value === 'major',
        ),
    );
    expect(defectAccepted).toBe(true);
  });

  it('flagship offshore: adversarial beats cover ghost/offline, replay, rogue source, gap, monotonic', () => {
    const { run } = execute(offshoreScenario);
    const codes = new Set(
      run.submissions.filter((s) => s.actual.status === 'rejected').map((s) => s.actual.code),
    );
    for (const required of [
      'ASSET_OFFLINE',
      'DUPLICATE_EVENT',
      'UNAUTHENTICATED_SOURCE',
      'SEQUENCE_GAP',
      'MONOTONIC_VIOLATION',
    ]) {
      expect(
        codes,
        `missing adversarial rejection ${required} (got ${[...codes].join(',')})`,
      ).toContain(required);
    }
  });

  it('warehouse fixture: adversarial beats cover ghost, authority terms, stale, monotonic', () => {
    const { run } = execute(warehouseScenario);
    const codes = new Set(
      run.submissions.filter((s) => s.actual.status === 'rejected').map((s) => s.actual.code),
    );
    for (const required of [
      'ASSET_OFFLINE',
      'AUTHORITY_TERMS_REJECTED',
      'STALE_EVENT',
      'MONOTONIC_VIOLATION',
    ]) {
      expect(
        codes,
        `missing adversarial rejection ${required} (got ${[...codes].join(',')})`,
      ).toContain(required);
    }
  });

  it('both domains ingest through the SAME service class with zero per-domain branches', () => {
    const offshore = execute(offshoreScenario);
    const warehouse = execute(warehouseScenario);
    expect(offshore.service).toBeInstanceOf(MissionEventIngestService);
    expect(warehouse.service).toBeInstanceOf(MissionEventIngestService);
    // Different vocabulary, same journal event type and topic.
    const rows = warehouse.ledger.db
      .prepare(`SELECT DISTINCT type, topic FROM evidence_events WHERE mission_id = ?`)
      .all(warehouse.missionId) as { type: string; topic: string }[];
    expect(rows).toEqual([{ type: 'mission.event.ingested', topic: 'operational' }]);
    offshore.ledger.close();
    warehouse.ledger.close();
  });

  it('offline asset stays offline until an AUTHORIZED recovery event (no magic recovery)', () => {
    const { service, orgId, missionId, ledger } = execute(offshoreScenario);
    const view = service.replay(orgId, missionId);
    // Final offshore state: the UAV was recovered BY the vessel gateway event
    // (accepted) and is docked — and exactly ONE event carries the recovery.
    const uav = view.assets['uav-seeker-1']!;
    expect(uav.comms).toBe('online');
    expect(uav.positionStatus).toBe('docked');
    const recoveries = view.events.filter(
      (e) =>
        e.assetId === 'uav-seeker-1' &&
        e.observations.some((o) => o.kind === 'asset_comms' && o.value === 'online') &&
        e.sourceType === 'vessel_gateway',
    );
    expect(recoveries.length).toBe(1);
    ledger.close();
  });
});

describe('module boundary conformance (architecture, not behavior)', () => {
  function listFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...listFiles(full));
      else if (name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('mission-events NEVER imports financial engine machinery', () => {
    const forbidden = [
      'reservations',
      'approvals',
      'mandates',
      'accounts',
      'outbox',
      'worker',
      'spendable',
      'authority',
      'plans',
      'recovery',
      'provider-receipts',
      'routes.js',
      'app.js',
    ];
    for (const file of listFiles(MODULE_ROOT)) {
      const source = readFileSync(file, 'utf8');
      for (const term of forbidden) {
        expect(
          source.includes(`/${term}`) || source.includes(`/${term}.js`),
          `${file} references forbidden financial module "${term}"`,
        ).toBe(false);
      }
      // Money vocabulary cannot appear as exported authority either.
      expect(source.includes('reserve(')).toBe(false);
    }
  });

  it('journal writes use topic operational only (the single permitted boundary)', () => {
    const ingestSource = readFileSync(join(MODULE_ROOT, 'src', 'ingest.ts'), 'utf8');
    expect(ingestSource.includes("topic: 'operational'")).toBe(true);
    expect(ingestSource.includes("topic: 'financial'")).toBe(false);
  });
});
