/**
 * Reliability-matrix runner (issue #15) — executes every scenario against
 * REAL services, twice, and emits the machine-readable matrix + summary.
 *
 * Run:  npm run build -w @moterva/api
 *       node apps/api/dist/mission-events/reliability/run.js [--json]
 * Regenerate committed artifacts:
 *       npx tsx apps/api/src/mission-events/reliability/run.ts --write
 *
 * Everything is SIMULATED_OPERATION / SYNTHETIC. The runner exits non-zero if
 * any case fails, the two runs disagree (non-determinism), or the invariant
 * "evidence-only cases create zero financial side effects" is violated.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCase } from './harness.js';
import { physicalScenarios } from './scenarios-physical.js';
import { financialScenarios } from './scenarios-financial.js';
import { baselineScenarios } from './scenarios-baselines.js';
import type { CaseResult, ScenarioCase } from './types.js';

export const ALL_SCENARIOS: readonly ScenarioCase[] = [
  ...physicalScenarios,
  ...financialScenarios,
  ...baselineScenarios,
];

export interface MatrixReport {
  readonly label: 'SIMULATED_OPERATION';
  readonly generatedBy: string;
  readonly totals: {
    readonly scenarios: number;
    readonly passed: number;
    readonly failed: number;
    readonly byFamily: Readonly<Record<string, { total: number; passed: number }>>;
  };
  readonly invariants: {
    readonly evidenceOnlyZeroFinancialSideEffects: boolean;
    readonly financialEvidenceOnlyFromExplicitFinancialActs: boolean;
    readonly noProviderReceiptsEver: boolean;
    readonly crossSourceRaceFixPreserved: boolean;
    readonly replayDeterministic: boolean;
  };
  readonly cases: readonly CaseResult[];
}

/** World-independent fingerprint used for the two-run determinism proof. */
function fingerprint(cases: readonly CaseResult[]): string {
  return JSON.stringify(
    cases.map((c) => ({
      id: c.id,
      checks: c.checks.map((k) => [k.name, k.expected, k.actual, k.pass]),
      planner: c.planner
        ? {
            outcome: c.planner.outcome,
            selectedId: c.planner.selectedId,
            rejectionCodes: c.planner.rejectionCodes,
            bridgeEvidence: c.planner.bridgeEvidence,
            bridgeWithheld: c.planner.bridgeWithheld,
            constraintStates: c.planner.constraintStates,
            note: c.planner.note,
          }
        : null,
      baseline: c.baseline ?? null,
      sideEffects: c.sideEffects,
      pass: c.pass,
    })),
  );
}

function executeAll(): CaseResult[] {
  const results: CaseResult[] = [];
  for (const scenario of ALL_SCENARIOS) {
    // A crashing scenario is a FAILED case, never a dead matrix.
    try {
      const { result, close } = runCase(scenario);
      results.push(result);
      close();
    } catch (error) {
      results.push({
        id: scenario.id,
        family: scenario.family,
        domain: scenario.domain,
        seed: scenario.seed,
        summary: scenario.summary,
        fault: scenario.fault,
        checks: [
          {
            name: 'scenario executed without unexpected error',
            expected: 'completed',
            actual: error instanceof Error ? error.message : String(error),
            pass: false,
          },
        ],
        planner: undefined,
        baseline: undefined,
        sideEffects: {
          operations: 0,
          commitments: 0,
          approvals: 0,
          providerReceipts: 0,
          financialEvidence: 0,
          operationalEvidence: 0,
        },
        replayDeterministic: null,
        replayNote: 'scenario crashed; not re-run',
        pass: false,
        explanation: 'unexpected error during execution',
      });
    }
  }
  return results;
}

export function runMatrix(): MatrixReport {
  const first = executeAll();
  const second = executeAll();
  const deterministic = fingerprint(first) === fingerprint(second);
  const cases = first.map((c, i) => ({
    ...c,
    replayDeterministic: deterministic,
    replayNote: deterministic
      ? 'two independent full runs produced identical world-independent results'
      : `runs diverged (compare with case ${second[i]?.id})`,
  }));

  const byFamily: Record<string, { total: number; passed: number }> = {};
  for (const c of cases) {
    const bucket = (byFamily[c.family] ??= { total: 0, passed: 0 });
    bucket.total += 1;
    if (c.pass) bucket.passed += 1;
  }
  const passed = cases.filter((c) => c.pass).length;

  const evidenceOnlyClean = cases
    .filter((c) => c.family === 'physical-evidence')
    .every(
      (c) =>
        c.sideEffects.operations === 0 &&
        c.sideEffects.commitments === 0 &&
        c.sideEffects.approvals === 0,
    );
  // Event ingestion NEVER writes financial-topic evidence: the physical
  // journal topic is 'operational' only. Financial-topic rows may exist in
  // financial-interaction cases — created exclusively by explicit public
  // financial calls (mandate issue, approval, reservation), never by events.
  const financialEvidenceClean = cases
    .filter((c) => c.family !== 'financial-interaction')
    .every((c) => c.sideEffects.financialEvidence === 0);
  const noReceipts = cases.every((c) => c.sideEffects.providerReceipts === 0);
  const racePreserved =
    cases.some((c) => c.id === 'PE-08' && c.pass) && cases.some((c) => c.id === 'PE-09' && c.pass);

  return {
    label: 'SIMULATED_OPERATION',
    generatedBy: 'mission-events reliability matrix (issue #15 evidence layer)',
    totals: { scenarios: cases.length, passed, failed: cases.length - passed, byFamily },
    invariants: {
      evidenceOnlyZeroFinancialSideEffects: evidenceOnlyClean,
      financialEvidenceOnlyFromExplicitFinancialActs: financialEvidenceClean,
      noProviderReceiptsEver: noReceipts,
      crossSourceRaceFixPreserved: racePreserved,
      replayDeterministic: deterministic,
    },
    cases,
  };
}

/** All invariants hold AND every case passed. */
export function matrixPassed(report: MatrixReport): boolean {
  return report.totals.failed === 0 && Object.values(report.invariants).every((v) => v === true);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

export function writeArtifacts(report: MatrixReport): void {
  const resultsDir = join(HERE, 'results');
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, 'matrix.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(resultsDir, 'summary.md'), renderSummary(report));
}

export function renderSummary(report: MatrixReport): string {
  const lines: string[] = [];
  lines.push('# Mission-event reliability matrix — SYNTHETIC / SIMULATED_OPERATION');
  lines.push('');
  lines.push(
    `Generated by \`apps/api/src/mission-events/reliability/run.ts\` (regenerate with \`npx tsx …/run.ts --write\`). ` +
      `Every scenario runs against a REAL temp SQLite ledger through the public ingest → bridge → planner → ledger seams. ` +
      `No provider, bank or physical vehicle is contacted; all sources are SYNTHETIC and the planner is POLICY-ONLY.`,
  );
  lines.push('');
  lines.push(
    `**${report.totals.passed}/${report.totals.scenarios} scenarios PASS** across ` +
      Object.entries(report.totals.byFamily)
        .map(([family, t]) => `${family} ${t.passed}/${t.total}`)
        .join(' · ') +
      `.`,
  );
  lines.push('');
  lines.push('## Invariants');
  for (const [name, ok] of Object.entries(report.invariants)) {
    lines.push(`- ${ok ? '✅' : '❌'} ${name}`);
  }
  lines.push('');
  lines.push('## Honest baseline outcomes (wins, ties AND losses recorded)');
  const baselines = report.cases.filter((c) => c.baseline !== undefined);
  const wins = baselines.filter((c) => c.baseline!.verdict === 'planner-wins').length;
  const ties = baselines.filter((c) => c.baseline!.verdict === 'tie').length;
  const losses = baselines.filter((c) => c.baseline!.verdict === 'baseline-wins').length;
  lines.push(
    `Constrained planner vs strongest of {cheapest-first, earliest-deadline-first, static-safe}: ` +
      `${wins} planner-wins · ${ties} ties · ${losses} baseline-wins across ${baselines.length} benchmark scenarios. ` +
      `The dataset intentionally preserves cases where a simpler baseline matches or beats the planner.`,
  );
  lines.push('');
  lines.push(
    '| Scenario | Verdict | Planner pick (net minor) | Cheapest-first | EDF | Static-safe |',
  );
  lines.push('|---|---|---|---|---|---|');
  for (const c of baselines) {
    const b = c.baseline!;
    lines.push(
      `| ${c.id} | ${b.verdict} | ${b.plannerPick} (${b.plannerNetMinor}) | ${b.cheapestFirst.pick} (${b.cheapestFirst.netMinor}) | ${b.earliestDeadlineFirst.pick} (${b.earliestDeadlineFirst.netMinor}) | ${b.staticSafe.pick} (${b.staticSafe.netMinor}) |`,
    );
  }
  lines.push('');
  lines.push('## Scenario matrix');
  lines.push('');
  lines.push(
    '| Scenario | Family | Domain | Injected fault / change | Result | Side effects (ops/commit/approv/receipt/finEv/opEv) | Explanation |',
  );
  lines.push('|---|---|---|---|---|---|---|');
  for (const c of report.cases) {
    const s = c.sideEffects;
    lines.push(
      `| ${c.id} | ${c.family} | ${c.domain} | ${c.fault} | ${c.pass ? 'PASS' : 'FAIL'} | ${s.operations}/${s.commitments}/${s.approvals}/${s.providerReceipts}/${s.financialEvidence}/${s.operationalEvidence} | ${c.explanation} |`,
    );
  }
  lines.push('');
  lines.push('## Known limitations (honest)');
  lines.push(
    '- Raw writers bypassing ingestion can still insert journal rows; duplicate sequences are DETECTED fail-closed at replay (PE-23), not prevented.',
  );
  lines.push(
    '- The integration bridge maps wind/hold/comms only. Warehouse-only readings (aisle, charger, discrepancy) currently yield conservative unknown clearance rather than domain semantics — a typed adapter request to Agent A is filed (contract/planner-adapter-request.v1.md).',
  );
  lines.push(
    '- Baseline picks are heuristics over the same scored candidate set; they do not model a real procurement team.',
  );
  lines.push(
    '- A simulated weather hold is treated as a present-tense blocking state only; NO forecast reopening time is ever derived (the bridge refuses to invent windows).',
  );
  return lines.join('\n') + '\n';
}

async function main(): Promise<void> {
  const report = runMatrix();
  if (process.argv.includes('--write')) {
    writeArtifacts(report);
    console.info('reliability artifacts written (SIMULATED_OPERATION)');
  }
  if (process.argv.includes('--json')) {
    console.info(JSON.stringify(report, null, 2));
  } else {
    console.info(renderSummary(report));
  }
  process.exitCode = matrixPassed(report) ? 0 : 1;
}

const script = process.argv[1]?.replace(/\\/g, '/') ?? '';
const invoked =
  script.endsWith('mission-events/reliability/run.ts') ||
  script.endsWith('mission-events/reliability/run.js');
if (invoked) {
  void main();
}
