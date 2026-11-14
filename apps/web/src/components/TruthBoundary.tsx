import type { JSX } from 'react';
import { HaloBadge } from './ui';

/**
 * The truth boundary of every decision on screen, in one strip: what the
 * evidence is, what the decision engine is, whether a model contributed, and
 * what is (not) known about external money. Each line states a limitation
 * rather than a capability — this product's credibility is in what it refuses
 * to imply.
 */
export function TruthBoundary({
  modelLabel,
  modelDetail,
}: {
  /** From the latest evaluation's causality; `null` before any evaluation. */
  modelLabel: string | null;
  modelDetail: string | null;
}): JSX.Element {
  return (
    <section className="mv-truth" aria-label="Truth boundary" data-testid="truth-boundary">
      <ul className="mv-truth__list">
        <li>
          <HaloBadge tone="info" glyph="◈" label="FIELD EVIDENCE = AUTHENTICATED CLAIMS" />
        </li>
        <li>
          <HaloBadge tone="hold" glyph="⚑" label="DECISIONS PROPOSE ONLY" />
        </li>
        <li data-testid="truth-model">
          <HaloBadge tone="neutral" glyph="◇" label={modelLabel ?? 'MODEL: POLICY-ONLY'} />
        </li>
        <li data-testid="truth-airwallex">
          <HaloBadge tone="hold" glyph="✕" label="AIRWALLEX: OFFLINE · UNVERIFIED" />
        </li>
        <li data-testid="truth-metal">
          <HaloBadge tone="neutral" glyph="○" label="METAL: NO RECEIPT" />
        </li>
      </ul>
      <details className="mv-governed__manual">
        <summary>What these labels mean</summary>
        <ul className="mv-xcard__list">
          <li>
            <strong>Field evidence</strong> — a registered source proved its identity with its
            credential and claimed an observation. MOTERVA does not independently measure the
            physical world.
          </li>
          <li>
            <strong>Decisions</strong> — computed by deterministic policy from your configured
            economics. They are proposals: approval, reservation and provider execution are separate
            controls, and a different person must approve.
          </li>
          <li>
            <strong>Model</strong> —{' '}
            {modelDetail ??
              'no model contributed. Without a configured model provider the engine is POLICY-ONLY; a model can only add typed evidence, never authority.'}
          </li>
          <li>
            <strong>Airwallex</strong> — no provider has observed any plan on this screen; treat
            every external money state as unknown until provider evidence says otherwise.
          </li>
          <li>
            <strong>Metal</strong> — no purchase receipt exists for any plan here.
          </li>
        </ul>
      </details>
    </section>
  );
}
