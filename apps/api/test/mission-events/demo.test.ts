/**
 * Demo + golden fixture tests (issue #9): the runnable demonstration passes
 * end-to-end against a real ledger, and the committed reference traces
 * regenerate byte-for-byte from the fixed world + seed (fixture provenance).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  offshoreScenario,
  warehouseScenario,
  scriptDigest,
  runDemo,
} from '../../src/mission-events/index.js';

const FIXTURES = join(import.meta.dirname, '..', '..', 'src', 'mission-events', 'fixtures');

/** The FIXED reference world used by the committed golden fixtures. */
const REFERENCE_WORLD = {
  orgId: 'org_fixture_reference',
  missionId: 'msn_fixture_reference',
};

describe('runnable fixture demonstration', () => {
  it('runDemo passes end-to-end: expectations, determinism, financial isolation', async () => {
    const report = await runDemo();
    expect(report.label).toBe('SIMULATED_OPERATION');
    expect(report.passed).toBe(true);
    expect(report.allExpectationsMatched).toBe(true);
    expect(report.determinism.sameSeedRebuildIdentical).toBe(true);
    expect(report.determinism.differentSeedDiffers).toBe(true);
    expect(report.financialIsolation.financialTopicEvidenceEvents).toBe(0);
    expect(report.financialIsolation.operationsRows).toBe(0);
    expect(report.financialIsolation.commitmentRows).toBe(0);
    expect(report.scenarios).toHaveLength(2);
    const [offshore, warehouse] = report.scenarios;
    expect(offshore!.run.acceptedCount).toBeGreaterThan(0);
    expect(warehouse!.run.acceptedCount).toBeGreaterThan(0);
  }, 120_000);

  it('two consecutive full runs reproduce the same meaningful event sequence', async () => {
    const first = await runDemo();
    const second = await runDemo();
    // Journal digests differ across runs because each run binds a FRESH
    // org/mission world (ids are part of the signed envelope). The reproducible
    // artifact is the world-independent event sequence: same order, same
    // sequences, same observations, same timestamps, same outcomes.
    const project = (report: Awaited<ReturnType<typeof runDemo>>) =>
      report.scenarios.map((scenario) => ({
        scenarioId: scenario.scenarioId,
        seed: scenario.seed,
        scriptDigestStablePerWorld: scenario.run.scriptDigest.length === 64,
        submissions: scenario.run.submissions.map((s) => ({
          index: s.index,
          at: s.at,
          expect: s.expect,
          actual: s.actual,
        })),
      }));
    expect(project(second)).toEqual(project(first));
    expect(second.determinism.sameSeedRebuildIdentical).toBe(true);
  });
});

describe('committed reference fixtures regenerate exactly', () => {
  for (const definition of [offshoreScenario, warehouseScenario]) {
    it(`${definition.id}: committed trace matches a fresh seeded rebuild`, () => {
      const build = definition.build(REFERENCE_WORLD);
      const fixturePath = join(FIXTURES, `${definition.id}.reference-trace.json`);
      const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
        scenarioId: string;
        seed: string;
        scriptDigest: string;
        envelopes: unknown[];
      };
      expect(fixture.scenarioId).toBe(definition.id);
      expect(fixture.seed).toBe(definition.defaultSeed);
      expect(fixture.scriptDigest).toBe(scriptDigest(build.script));
      expect(fixture.envelopes).toEqual(build.script.map((s) => s.envelope));
    });
  }
});
