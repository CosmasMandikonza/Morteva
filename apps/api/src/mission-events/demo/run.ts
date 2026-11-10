/**
 * Runnable fixture demonstration (issue #9 acceptance).
 *
 * Executes both seeded scenarios against a REAL temporary SQLite ledger
 * through the real ingest service and the append-only evidence journal,
 * replays each mission timeline from the journal, and proves three properties
 * live:
 *   1. every scripted expectation (accepts AND adversarial rejections) matches,
 *   2. the same seed regenerates a byte-identical script (determinism),
 *   3. ZERO financial-topic evidence and ZERO operations rows exist after a
 *      full scenario — physical events never became banking authority.
 *
 * Run: npm run build -w @moterva/api
 *      node apps/api/dist/mission-events/demo/run.js [--json]
 * Everything printed is SIMULATED_OPERATION / SYNTHETIC.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, TunableClock, type Ledger } from '@moterva/ledger';
import { MissionEventIngestService } from '../src/ingest.js';
import { SourceRegistry } from '../src/registry.js';
import { offshoreScenario } from '../src/scenarios/offshore.js';
import { warehouseScenario } from '../src/scenarios/warehouse.js';
import { warehouseInterruptScenario } from '../src/scenarios/warehouse-interrupt.js';
import { runScenario } from '../src/scenarios/runner.js';
import { scriptDigest } from '../src/scenarios/builder.js';
import type { ScenarioBuild, ScenarioRunReport } from '../src/scenarios/types.js';

export interface DemoReplaySummary {
  readonly asOf: string;
  readonly eventCount: number;
  readonly freshCount: number;
  readonly staleCount: number;
  readonly expiredCount: number;
  readonly planningValidCount: number;
  readonly assets: readonly {
    readonly assetId: string;
    readonly comms: string | null;
    readonly positionStatus: string | null;
    readonly latestKinds: readonly string[];
  }[];
}

export interface DemoScenarioReport {
  readonly scenarioId: string;
  readonly title: string;
  readonly seed: string;
  readonly provenanceStatement: string;
  readonly run: ScenarioRunReport;
  readonly replay: DemoReplaySummary;
}

export interface DemoReport {
  readonly label: 'SIMULATED_OPERATION';
  readonly scenarios: readonly DemoScenarioReport[];
  readonly determinism: {
    readonly sameSeedRebuildIdentical: boolean;
    readonly differentSeedDiffers: boolean;
  };
  readonly financialIsolation: {
    readonly financialTopicEvidenceEvents: number;
    readonly operationsRows: number;
    readonly commitmentRows: number;
  };
  readonly allExpectationsMatched: boolean;
  readonly passed: boolean;
}

export async function runDemo(options: { keepDb?: boolean } = {}): Promise<DemoReport> {
  const dbDir = mkdtempSync(join(tmpdir(), 'moterva-mission-events-demo-'));
  const ledger: Ledger = openLedger(join(dbDir, 'demo.sqlite'));
  try {
    ledger.migrate();
    const scenarioReports: DemoScenarioReport[] = [];
    const determinismChecks: { same: boolean; differs: boolean }[] = [];

    for (const definition of [offshoreScenario, warehouseScenario, warehouseInterruptScenario]) {
      const org = ledger.organizations.createOrganization(`demo-${definition.id}`);
      const mission = ledger.organizations.createMission(org.id, `${definition.id} mission`);
      const world = { orgId: org.id, missionId: mission.id };
      const build: ScenarioBuild = definition.build(world);

      const registry = new SourceRegistry();
      registry.registerAll(build.sources);
      const clock = new TunableClock(build.script[0]!.at);
      const service = new MissionEventIngestService(ledger, clock, registry);
      const run = runScenario(service, build, clock);

      // Determinism proof: same seed + same world must rebuild byte-identical
      // envelopes; a different seed must NOT.
      const rebuilt = definition.build(world);
      const otherSeed = definition.build(world, `${definition.defaultSeed}-different`);
      const same = scriptDigest(rebuilt.script) === scriptDigest(build.script);
      const differs = scriptDigest(otherSeed.script) !== scriptDigest(build.script);
      determinismChecks.push({ same, differs });

      const view = service.replay(world.orgId, world.missionId);
      const replay: DemoReplaySummary = {
        asOf: view.asOf,
        eventCount: view.events.length,
        freshCount: view.events.filter((e) => e.freshness === 'fresh').length,
        staleCount: view.events.filter((e) => e.freshness === 'stale').length,
        expiredCount: view.events.filter((e) => e.freshness === 'expired').length,
        planningValidCount: view.events.filter((e) => e.planningValid).length,
        assets: Object.values(view.assets).map((asset) => ({
          assetId: asset.assetId,
          comms: asset.comms,
          positionStatus: asset.positionStatus,
          latestKinds: Object.keys(asset.latest).sort(),
        })),
      };

      scenarioReports.push({
        scenarioId: definition.id,
        title: definition.title,
        seed: build.seed,
        provenanceStatement: build.provenanceStatement,
        run,
        replay,
      });
    }

    // Financial isolation proof across the whole demo ledger: a full physical
    // scenario must produce ZERO financial-topic evidence, ZERO operations and
    // ZERO commitments.
    const financialIsolation = {
      financialTopicEvidenceEvents: countRows(
        ledger,
        `SELECT COUNT(*) AS c FROM evidence_events WHERE topic = 'financial'`,
      ),
      operationsRows: countRows(ledger, 'SELECT COUNT(*) AS c FROM operations'),
      commitmentRows: countRows(ledger, 'SELECT COUNT(*) AS c FROM commitments'),
    };

    const allExpectationsMatched = scenarioReports.every((s) => s.run.allExpectationsMatched);
    const determinism = {
      sameSeedRebuildIdentical: determinismChecks.every((d) => d.same),
      differentSeedDiffers: determinismChecks.every((d) => d.differs),
    };
    const passed =
      allExpectationsMatched &&
      determinism.sameSeedRebuildIdentical &&
      determinism.differentSeedDiffers &&
      financialIsolation.financialTopicEvidenceEvents === 0 &&
      financialIsolation.operationsRows === 0 &&
      financialIsolation.commitmentRows === 0;

    return {
      label: 'SIMULATED_OPERATION',
      scenarios: scenarioReports,
      determinism,
      financialIsolation,
      allExpectationsMatched,
      passed,
    };
  } finally {
    ledger.close();
    if (options.keepDb !== true) rmSync(dbDir, { recursive: true, force: true });
  }
}

function countRows(ledger: Ledger, sql: string): number {
  const row = ledger.db.prepare(sql).get() as { c: number };
  return row.c;
}

// ---------------------------------------------------------------------------
// CLI printing
// ---------------------------------------------------------------------------

function printHuman(report: DemoReport): void {
  console.info('='.repeat(100));
  console.info('MOTERVA mission-event fixture demonstration — ISSUE #9 (Agent C lane)');
  console.info('TRUTH LABEL: SIMULATED_OPERATION — every event, source and asset is SYNTHETIC.');
  console.info('No provider, bank or physical vehicle was contacted. Nothing here moves money.');
  console.info('='.repeat(100));
  for (const scenario of report.scenarios) {
    console.info('');
    console.info(`SCENARIO ${scenario.scenarioId} — ${scenario.title}`);
    console.info(`seed: ${scenario.seed}`);
    console.info(`PROVENANCE: ${scenario.provenanceStatement}`);
    console.info('-'.repeat(100));
    for (const s of scenario.run.submissions) {
      const at = s.at.slice(11, 19);
      const outcome =
        s.actual.status === 'accepted'
          ? `ACCEPTED (journal seq ${s.journalSeq}, digest ${s.eventDigest?.slice(0, 12)}…)`
          : `REJECTED [${s.actual.code}]`;
      const head = `#${String(s.index + 1).padStart(2, '0')} ${at}Z ${outcome}`;
      console.info(`${head}  ${s.beat ?? ''}`);
      if (s.economicEffect !== undefined) console.info(`      ECONOMIC ▸ ${s.economicEffect}`);
      if (s.message !== undefined && s.actual.status === 'rejected' && !s.matched) {
        console.info(`      UNEXPECTED OUTCOME: ${s.message}`);
      }
    }
    console.info('-'.repeat(100));
    console.info(
      `script digest ${scenario.run.scriptDigest} | accepted ${scenario.run.acceptedCount} | rejected ${scenario.run.rejectedCount} | expectations ${
        scenario.run.allExpectationsMatched ? 'ALL MATCHED' : 'MISMATCH'
      }`,
    );
    console.info(
      `journal replay @ ${scenario.replay.asOf}: ${scenario.replay.eventCount} events — fresh ${scenario.replay.freshCount}, stale ${scenario.replay.staleCount}, expired ${scenario.replay.expiredCount} (planning-valid ${scenario.replay.planningValidCount})`,
    );
    for (const asset of scenario.replay.assets) {
      console.info(
        `  asset ${asset.assetId}: comms=${asset.comms ?? 'unknown'}, position=${asset.positionStatus ?? 'unknown'}, latest=[${asset.latestKinds.join(', ')}]`,
      );
    }
  }
  console.info('');
  console.info('='.repeat(100));
  console.info(
    `determinism: same-seed rebuild identical=${report.determinism.sameSeedRebuildIdentical}, different seed differs=${report.determinism.differentSeedDiffers}`,
  );
  console.info(
    `financial isolation: financial-topic evidence events=${report.financialIsolation.financialTopicEvidenceEvents}, operations rows=${report.financialIsolation.operationsRows}, commitment rows=${report.financialIsolation.commitmentRows} (all must be 0)`,
  );
  console.info(`VERDICT: ${report.passed ? 'PASS — both scenario traces reproduced' : 'FAIL'}`);
  console.info('='.repeat(100));
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const report = await runDemo();
  if (json) {
    console.info(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
  process.exitCode = report.passed ? 0 : 1;
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('mission-events/demo/run.js');
if (isDirectRun) {
  void main();
}
