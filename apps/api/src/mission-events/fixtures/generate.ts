/**
 * Regenerate the committed reference traces and contract examples from the
 * scenario definitions (issue #9 fixture provenance tool).
 *
 * Run from the repository root:
 *   npx tsx apps/api/src/mission-events/fixtures/generate.ts
 *
 * The output is deterministic: running this on an unchanged scenario
 * definition reproduces the committed files byte-for-byte. If a diff appears
 * after editing a scenario, the reference trace changed on purpose — review
 * it in the PR. All generated content is SYNTHETIC.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OBSERVATION_KINDS,
  offshoreScenario,
  scriptDigest,
  warehouseScenario,
  type ScenarioDefinition,
} from '../index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = join(HERE, '..', 'contract');

/** The FIXED reference world used by the committed golden fixtures. */
export const REFERENCE_WORLD = {
  orgId: 'org_fixture_reference',
  missionId: 'msn_fixture_reference',
};

export function generateAll(): void {
  mkdirSync(join(CONTRACT, 'examples'), { recursive: true });
  for (const definition of [offshoreScenario, warehouseScenario] as ScenarioDefinition[]) {
    const build = definition.build(REFERENCE_WORLD);
    const fixture = {
      scenarioId: definition.id,
      seed: definition.defaultSeed,
      provenance:
        'SIMULATED_OPERATION: fully SYNTHETIC reference trace; regenerates deterministically ' +
        'from this seed with the scenario builders (see module README).',
      world: REFERENCE_WORLD,
      scriptDigest: scriptDigest(build.script),
      envelopes: build.script.map((s) => s.envelope),
    };
    writeFileSync(
      join(HERE, `${definition.id}.reference-trace.json`),
      JSON.stringify(fixture, null, 2) + '\n',
    );

    // Contract example: the first scripted envelope, shown in normalized form
    // (the signature is ingress-only and never persisted or disclosed).
    const first = build.script[0]!.envelope;
    const { sourceId, sourceType, keyId, provenance } = first.source;
    const normalized = {
      ...first,
      source: { sourceId, sourceType, keyId, provenance },
    };
    writeFileSync(
      join(CONTRACT, 'examples', `${definition.id}.event.json`),
      JSON.stringify(normalized, null, 2) + '\n',
    );
  }
  writeFileSync(
    join(CONTRACT, 'observation-kinds.v1.json'),
    JSON.stringify(
      {
        contractVersion: 1,
        description:
          'Closed observation vocabulary (contract v1): kind -> unit + value rules + ' +
          'monotonicity. Ingest rejects any kind, unit or value outside this table; the ' +
          'planner (issue #8) consumes exactly these typed readings.',
        kinds: OBSERVATION_KINDS,
      },
      null,
      2,
    ) + '\n',
  );
}

const isDirectRun = process.argv[1]
  ?.replace(/\\/g, '/')
  .endsWith('mission-events/fixtures/generate.ts');
if (isDirectRun) {
  generateAll();
  console.info('regenerated reference traces + contract examples (SYNTHETIC fixtures)');
}
