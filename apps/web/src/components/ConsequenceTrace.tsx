import type { JSX } from 'react';
import { money } from '../lib/format';

/**
 * Mission Consequence Trace — PROPOSAL (mtv-08.3, awaiting founder visual
 * approval; rendered on the proposal branch only).
 *
 * The smallest informative rendering of the product's competitive spine:
 * mission event → financial consequence → decision → authority → evidence.
 * Every node is honest about its data source TODAY:
 *   - `ledger`   : real data from authorized read APIs (internal records)
 *   - `pending`  : capability not exposed over HTTP yet (named issue)
 *   - `absent`   : provider observation does not exist (never fabricated)
 *
 * Pattern provenance (docs/03 ledger): horizontal step-rail anatomy
 * re-implemented originally from the React Bits Stepper BEHAVIOR (MIT +
 * Commons Clause — zero source copied); figures-visible-collapsed detail from
 * Cult UI Expandable Card (MIT); staggered entrance from React Bits Animated
 * List BEHAVIOR (re-implemented, reduced-motion gated). Skiper UI: not used
 * (rejected in the component ledger). Awwwards: art-direction benchmark for
 * restraint (composition reference only, no imitation).
 */

type NodeKind = 'ledger' | 'pending' | 'absent';

interface TraceNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly glyph: string;
  readonly label: string;
  readonly datum: string;
  readonly provenance: string;
  readonly action?: { label: string; onClick: () => void };
}

const KIND_CLASS: Readonly<Record<NodeKind, string>> = {
  ledger: 'mv-trace__node--ledger',
  pending: 'mv-trace__node--pending',
  absent: 'mv-trace__node--absent',
};

const KIND_TAG: Readonly<Record<NodeKind, string>> = {
  ledger: 'ledger record',
  pending: 'awaiting API',
  absent: 'provider absent',
};

export function ConsequenceTrace({
  missionTitle,
  _createdAt,
  committed,
  activeMandates,
  onGotoAuthority,
  onGotoDecisions,
}: {
  missionTitle: string;
  _createdAt: string;
  committed: ReadonlyArray<{ currency: string; minor: number }>;
  activeMandates: number;
  onGotoAuthority: () => void;
  onGotoDecisions: () => void;
}): JSX.Element {
  const nodes: readonly TraceNode[] = [
    {
      id: 'event',
      kind: 'ledger',
      glyph: '◈',
      label: 'Event',
      datum: `Mission opened — ${missionTitle}`,
      provenance: 'internal ledger record',
    },
    {
      id: 'consequence',
      kind: 'ledger',
      glyph: '$',
      label: 'Consequence',
      datum:
        committed.length === 0
          ? 'No active spending authority'
          : committed.map((c) => money(c.currency, c.minor)).join(' + ') + ' committed',
      provenance: 'mission envelopes (internal)',
    },
    {
      id: 'decision',
      kind: 'pending',
      glyph: '◇',
      label: 'Decision',
      datum: 'Decision Room endpoints not exposed',
      provenance: 'planned — #8/#13',
      action: { label: 'Open Decision Room', onClick: onGotoDecisions },
    },
    {
      id: 'authority',
      kind: 'ledger',
      glyph: '◆',
      label: 'Authority',
      datum:
        activeMandates === 0
          ? 'No active mandate'
          : `${activeMandates} active mandate${activeMandates === 1 ? '' : 's'} under review`,
      provenance: 'mandates (internal)',
      action: { label: 'Review spending authority', onClick: onGotoAuthority },
    },
    {
      id: 'evidence',
      kind: 'absent',
      glyph: '⌗',
      label: 'Evidence',
      datum: 'Append-only journal not exposed over HTTP yet',
      provenance: 'internal records only — #37 pending; provider observation absent',
    },
  ];

  return (
    <section
      className="mv-trace"
      aria-label="Mission consequence trace — proposal"
      data-testid="consequence-trace"
    >
      <ol className="mv-trace__rail">
        {nodes.map((node, index) => (
          <li
            key={node.id}
            className={`mv-trace__node ${KIND_CLASS[node.kind]}`}
            style={{ '--mv-trace-i': index } as React.CSSProperties}
          >
            <span className="mv-trace__glyph" aria-hidden="true">
              {node.glyph}
            </span>
            <span className="mv-trace__label">{node.label}</span>
            <span className="mv-trace__datum">{node.datum}</span>
            <span className="mv-trace__tag mv-hud">{KIND_TAG[node.kind]}</span>
            <span className="mv-trace__provenance">{node.provenance}</span>
            {node.action !== undefined && (
              <button type="button" className="mv-btn mv-btn--ghost" onClick={node.action.onClick}>
                {node.action.label}
              </button>
            )}
            {index < nodes.length - 1 && (
              <span className="mv-trace__link" aria-hidden="true">
                →
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
