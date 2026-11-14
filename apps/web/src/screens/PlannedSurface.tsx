import type { JSX } from 'react';
import type { NavItem } from '../nav';
import { Panel } from '../components/Panel';

/**
 * Honest planned surfaces: Decision Room, Authority & Execution and Evidence
 * Replay are real roadmap capabilities with their own tracking issues. No
 * mock screens, no dead controls — the operator sees exactly what exists.
 */
export function PlannedSurface({ item }: { item: NavItem }): JSX.Element {
  return (
    <Panel
      title={item.label}
      meta={<span className="mv-tag">planned</span>}
      testId="planned-surface"
    >
      <p className="mv-planned__summary">{item.summary}</p>
      <p className="mv-planned__status" data-testid="planned-status">
        Not implemented yet — planned capability, tracking issue{' '}
        <a
          href={`https://github.com/CosmasMandikonza/Morteva/issues/${item.issue.replace('#', '')}`}
        >
          {item.issue}
        </a>
        . No mock data and no dead controls render here; Mission Treasury is the first implemented
        surface.
      </p>
    </Panel>
  );
}
