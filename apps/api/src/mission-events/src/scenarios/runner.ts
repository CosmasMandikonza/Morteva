/**
 * Script runner: executes a scenario against a real ingest service and real
 * ledger, advancing the injected clock to each submission's anchor. Every
 * submission's ACTUAL outcome is compared to the scripted expectation; a
 * mismatch fails the run loudly (the script is the contract).
 */
import { isLedgerError } from '@moterva/ledger';
import type { TunableClock } from '@moterva/ledger';
import { MissionEventError } from '../errors.js';
import type { MissionEventIngestService } from '../ingest.js';
import type { ScenarioBuild, ScenarioRunReport, SubmissionResult } from './types.js';
import { scriptDigest } from './builder.js';

export function runScenario(
  service: MissionEventIngestService,
  build: ScenarioBuild,
  clock: TunableClock,
): ScenarioRunReport {
  const results: SubmissionResult[] = [];
  for (const [index, submission] of build.script.entries()) {
    const anchorMs = Date.parse(submission.at);
    const nowMs = clock.now().getTime();
    if (anchorMs > nowMs) clock.advance(anchorMs - nowMs);

    let actual: { status: 'accepted' | 'rejected'; code?: string };
    let message: string | undefined;
    let journalSeq: number | undefined;
    let eventDigest: string | undefined;
    try {
      const accepted = service.ingest(build.world.orgId, submission.envelope);
      actual = { status: 'accepted' };
      journalSeq = accepted.journalSeq;
      eventDigest = accepted.eventDigest;
    } catch (error) {
      if (error instanceof MissionEventError) {
        actual = { status: 'rejected', code: error.code };
        message = error.message;
      } else if (isLedgerError(error)) {
        // A raw ledger rejection must still surface deterministically.
        actual = { status: 'rejected', code: `LEDGER_${error.code}` };
        message = error.message;
      } else {
        throw error;
      }
    }
    const matched =
      actual.status === submission.expect.status &&
      (submission.expect.code === undefined || actual.code === submission.expect.code);
    results.push({
      index,
      eventId: submission.envelope.eventId,
      at: submission.at,
      expect: submission.expect,
      actual: { status: actual.status, code: actual.code as never },
      matched,
      message,
      journalSeq,
      eventDigest,
      beat: submission.beat,
      economicEffect: submission.economicEffect,
    });
  }
  const acceptedCount = results.filter((r) => r.actual.status === 'accepted').length;
  const rejectedCount = results.length - acceptedCount;
  return {
    scenarioId: build.id,
    seed: build.seed,
    title: build.title,
    provenanceStatement: build.provenanceStatement,
    submissions: results,
    acceptedCount,
    rejectedCount,
    allExpectationsMatched: results.every((r) => r.matched),
    scriptDigest: scriptDigest(build.script),
  };
}
