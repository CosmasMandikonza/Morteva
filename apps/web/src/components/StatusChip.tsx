import type { JSX } from 'react';
import type { PresentationEntry, Tone } from '../status/statusMap';

/** Tone → semantic CSS vars (never color-only: glyph + label always render). */
const TONE_CLASS: Readonly<Record<Tone, string>> = {
  neutral: 'mv-chip--neutral',
  info: 'mv-chip--info',
  transit: 'mv-chip--transit',
  hold: 'mv-chip--hold',
  attention: 'mv-chip--attention',
  verified: 'mv-chip--verified',
  danger: 'mv-chip--danger',
};

export function StatusChip({
  entry,
  size = 'md',
}: {
  entry: PresentationEntry;
  size?: 'md' | 'sm';
}): JSX.Element {
  return (
    <span
      className={`mv-chip ${TONE_CLASS[entry.tone]} ${size === 'sm' ? 'mv-chip--sm' : ''}`}
      title={entry.meaning}
    >
      <span className="mv-chip__glyph" aria-hidden="true">
        {entry.glyph}
      </span>
      {entry.label}
    </span>
  );
}
