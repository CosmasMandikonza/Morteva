import { useId, useRef, type ReactNode } from 'react';
import type { JSX } from 'react';

/**
 * Halo Tabs — R3 P1-4 fix: the tablist and its panels now share ONE
 * component-generated baseId, so `aria-controls`/`aria-labelledby` always
 * resolve (the previous split-component API let callers pass a different
 * baseId — DecisionRoom passed '', producing dangling references). Inactive
 * panels render `hidden`, which removes them from tab order and the
 * accessibility tree. Roving tabindex + Arrow/Home/End keyboard behavior is
 * implemented here (per tablist ARIA), with focus moved by the key handler.
 */
export function HaloTabs<T extends string>({
  tabs,
  panels,
  value,
  onChange,
  ariaLabel,
}: {
  tabs: readonly { readonly id: T; readonly label: string; readonly count?: number }[];
  /** One panel per tab id, in any order; inactive panels render hidden. */
  panels: readonly { readonly id: T; readonly content: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
}): JSX.Element {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const idx = tabs.findIndex((t) => t.id === value);
    const next =
      event.key === 'ArrowRight'
        ? (idx + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (idx - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : idx;
    if (next === idx) return;
    event.preventDefault();
    onChange(tabs[next]!.id);
    listRef.current
      ?.querySelector<HTMLElement>(`#${CSS.escape(`${baseId}-tab-${tabs[next]!.id}`)}`)
      ?.focus();
  };

  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => t.id === value),
  );

  return (
    <div className="mv-halotabs__root">
      <div
        className="mv-halotabs"
        role="tablist"
        aria-label={ariaLabel}
        ref={listRef}
        onKeyDown={onKeyDown}
        style={
          {
            '--mv-halotabs-count': String(tabs.length),
            '--mv-halotabs-active': String(activeIndex),
          } as React.CSSProperties
        }
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`${baseId}-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={t.id === value}
            aria-controls={`${baseId}-panel-${t.id}`}
            tabIndex={t.id === value ? 0 : -1}
            className={`mv-halotabs__tab${t.id === value ? ' is-active' : ''}`}
            data-testid={`halotab-${t.id}`}
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {t.count !== undefined && <span className="mv-halotabs__count">{t.count}</span>}
          </button>
        ))}
        <span className="mv-halotabs__indicator" aria-hidden="true" />
      </div>
      {tabs.map((t) => {
        const panel = panels.find((p) => p.id === t.id);
        const active = t.id === value;
        return (
          <div
            key={t.id}
            id={`${baseId}-panel-${t.id}`}
            role="tabpanel"
            aria-labelledby={`${baseId}-tab-${t.id}`}
            hidden={!active}
            className="mv-halotabs__panel"
            data-testid={`halopanel-${t.id}`}
          >
            {active ? panel?.content : null}
          </div>
        );
      })}
    </div>
  );
}
