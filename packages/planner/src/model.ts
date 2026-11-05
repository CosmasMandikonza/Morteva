/**
 * Bounded optional model adapter (issue #8: "model interpretation is optional
 * and never grants financial authority").
 *
 * `FixtureModelAdapter` is a DETERMINISTIC stand-in explicitly labeled
 * POLICY-ONLY: no live inference happens and nothing claims it does. A real
 * adapter wraps an actual model provider, returns the same typed shapes, and
 * its id is recorded in the decision trace. Adapter output is validated by
 * the evaluator exactly like any other candidate source; adapter THROWING is
 * an outage that degrades to the deterministic generator.
 */
import type { MissionEvidenceInput, MissionModelAdapter, PlannerCandidate } from './contracts.js';

/**
 * POLICY-ONLY fixture adapter. `interpret` demonstrates text → typed evidence
 * (a real model would do this with an LLM); `propose` intentionally returns
 * nothing — the deterministic generator already covers the option space, so
 * the fixture never injects preference. `explain` produces fixed prose.
 */
export class FixtureModelAdapter implements MissionModelAdapter {
  readonly id = 'fixture-policy-only';

  interpret(text: string, context: { assetKind: string }): readonly MissionEvidenceInput[] {
    // Deterministic keyword mapping — NOT inference. Any prompt-injection
    // content in `text` can at worst produce constraints that then pass
    // through the SAME validation as Agent C's events (version, timestamps,
    // freshness, sequence); it can never touch money or authority.
    const out: MissionEvidenceInput[] = [];
    const now = new Date().toISOString();
    const base = {
      version: 1 as const,
      tenant: { orgId: 'fixture-org', missionId: 'fixture-mission' },
      asset: { id: `fixture-${context.assetKind}`, kind: context.assetKind },
      source: { kind: 'operator-report' as const, digest: 'fixture-interpretation' },
      validity: { notAfter: new Date(Date.parse(now) + 3_600_000).toISOString() },
    };
    if (/delay/i.test(text)) {
      out.push({
        ...base,
        event: { id: `fixture-delay-${out.length}`, sequence: 1, observedAt: now, ingestedAt: now },
        constraint: {
          kind: 'contractor-delay',
          contractorId: 'fixture-contractor',
          delayMinutes: 30,
        },
      });
    }
    return out;
  }

  propose(): readonly PlannerCandidate[] {
    return [];
  }

  explain(): string {
    return 'POLICY-ONLY fixture adapter: no live model inference contributed to this decision.';
  }
}

/** Sanitize any adapter prose before storage (prompt-injection defense in depth). */
export function sanitizeModelProse(text: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters IS the sanitize behavior
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 500);
}
