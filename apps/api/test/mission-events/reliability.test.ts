/**
 * Reliability-matrix tests (issue #15 evidence layer): the committed matrix
 * must pass end-to-end, be deterministic, enforce the safety invariants, and
 * the committed artifacts must regenerate byte-for-byte.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_SCENARIOS,
  matrixPassed,
  renderSummary,
  runMatrix,
} from '../../src/mission-events/reliability/run.js';

const RESULTS = join(
  import.meta.dirname,
  '..',
  '..',
  'src',
  'mission-events',
  'reliability',
  'results',
);

describe('mission-event reliability matrix (issue #15)', () => {
  it('all scenarios pass with every safety invariant enforced', () => {
    const report = runMatrix();
    expect(report.totals.scenarios).toBeGreaterThanOrEqual(30);
    expect(report.totals.failed).toBe(0);
    expect(matrixPassed(report)).toBe(true);
    for (const [invariant, ok] of Object.entries(report.invariants)) {
      expect(ok, `invariant ${invariant} must hold`).toBe(true);
    }
    // Every scenario records at least one named check (no vacuous cases).
    for (const c of report.cases) {
      expect(c.checks.length, `${c.id} must assert something`).toBeGreaterThan(0);
    }
  }, 180_000);

  it('evidence-only families produce zero financial side effects; financial rows only from explicit acts', () => {
    const report = runMatrix();
    for (const c of report.cases.filter((x) => x.family === 'physical-evidence')) {
      expect(c.sideEffects.operations, `${c.id} operations`).toBe(0);
      expect(c.sideEffects.commitments, `${c.id} commitments`).toBe(0);
      expect(c.sideEffects.approvals, `${c.id} approvals`).toBe(0);
      expect(c.sideEffects.financialEvidence, `${c.id} financial evidence`).toBe(0);
      expect(c.sideEffects.providerReceipts, `${c.id} receipts`).toBe(0);
    }
    // No case anywhere fabricates a provider receipt.
    for (const c of report.cases) {
      expect(c.sideEffects.providerReceipts, `${c.id} receipts`).toBe(0);
    }
  }, 180_000);

  it('the accepted cross-source race fix stays proven (PE-08 offline race, PE-09 monotonic race)', () => {
    const report = runMatrix();
    const offline = report.cases.find((c) => c.id === 'PE-08');
    const monotonic = report.cases.find((c) => c.id === 'PE-09');
    expect(offline?.checks.find((k) => k.name.includes('offline commit'))?.actual).toBe(
      'rejected/ASSET_OFFLINE',
    );
    expect(monotonic?.checks.find((k) => k.name.includes('journaled 66'))?.actual).toBe(
      'rejected/MONOTONIC_VIOLATION',
    );
    expect(report.invariants.crossSourceRaceFixPreserved).toBe(true);
  }, 180_000);

  it('honest baselines: wins, ties AND losses are all represented', () => {
    const report = runMatrix();
    const verdicts = new Set(
      report.cases.filter((c) => c.baseline).map((c) => c.baseline!.verdict),
    );
    expect(verdicts.has('planner-wins')).toBe(true);
    expect(verdicts.has('tie')).toBe(true);
    expect(verdicts.has('baseline-wins')).toBe(true);
  }, 180_000);

  it('committed artifacts regenerate byte-for-byte from a fresh run', () => {
    const report = runMatrix();
    const committedMatrix = readFileSync(join(RESULTS, 'matrix.json'), 'utf8');
    const committedSummary = readFileSync(join(RESULTS, 'summary.md'), 'utf8');
    expect(JSON.stringify(report)).toBe(JSON.stringify(JSON.parse(committedMatrix)));
    expect(renderSummary(report)).toBe(committedSummary);
  }, 180_000);

  it('the scenario catalogue is stable (45 cases across three families)', () => {
    expect(ALL_SCENARIOS).toHaveLength(45);
    const families = new Set(ALL_SCENARIOS.map((s) => s.family));
    expect(families.has('physical-evidence')).toBe(true);
    expect(families.has('financial-interaction')).toBe(true);
    expect(families.has('baseline-comparison')).toBe(true);
  });
});
