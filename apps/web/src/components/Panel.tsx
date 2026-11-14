import type { JSX, ReactNode } from 'react';

export function Panel({
  title,
  meta,
  children,
  actions,
  testId,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    <section className="mv-panel" data-testid={testId}>
      <header className="mv-panel__head">
        <h2 className="mv-panel__title">{title}</h2>
        {meta !== undefined && <span className="mv-panel__meta">{meta}</span>}
        {actions !== undefined && <div className="mv-panel__actions">{actions}</div>}
      </header>
      <div className="mv-panel__body">{children}</div>
    </section>
  );
}

/**
 * Honest capability gap: shown ONLY where no authorized API exists for the
 * capability. States exactly what is missing and why nothing is faked.
 */
export function UnavailableCard({
  title,
  what,
  why,
  tracking,
}: {
  title: string;
  what: string;
  why: string;
  tracking?: string;
}): JSX.Element {
  return (
    <section className="mv-panel mv-panel--unavailable" data-testid="unavailable-card">
      <header className="mv-panel__head">
        <h2 className="mv-panel__title">{title}</h2>
        <span className="mv-tag mv-tag--unavailable">not available</span>
      </header>
      <div className="mv-panel__body">
        <p className="mv-unavailable__what">{what}</p>
        <p className="mv-unavailable__why">{why}</p>
        <p className="mv-unavailable__note">
          No simulated or fixture data is shown here.{' '}
          {tracking !== undefined && <>Tracking: {tracking}.</>}
        </p>
      </div>
    </section>
  );
}

export function SkeletonRows({ rows = 3 }: { rows?: number }): JSX.Element {
  return (
    <div className="mv-skel" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div className="mv-skel__row" key={i} />
      ))}
    </div>
  );
}
