import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { JSX } from 'react';
export { HaloTabs } from './HaloTabs';
import { moneyAmount } from '../../lib/format';

/**
 * MTV-20 UI primitives — original implementations of the Cult UI component
 * patterns selected in docs/design/mtv-20-design-implementation-map.md,
 * adapted to MOTERVA's semantic-token CSS (this app is not Tailwind/shadcn).
 * Every primitive here owns its accessibility obligations explicitly:
 * roving tabindex, focus trapping/restoration, live announcements and the
 * repo-wide reduced-motion gate (durations collapse under
 * `prefers-reduced-motion: reduce` via the global motion tokens).
 *
 * Provenance: pattern source is Cult UI (MIT, © Nolly Studio) as documented
 * in the reference ledger + implementation map; no Cult UI source is copied.
 * React Bits patterns (Animated List entrances, Stepper strip) are likewise
 * re-implemented from documented behavior — no React Bits source enters this
 * public repository (Commons Clause redistribution gate).
 */

export function HaloSegmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly { readonly id: T; readonly label: string }[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
}): JSX.Element {
  return (
    <div className="mv-segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          className={`mv-segmented__opt${o.id === value ? ' is-active' : ''}`}
          data-testid={`segmented-${o.id}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Halo Badge — tone+glyph+label status chip (never color-only), tabular
 *  counts. Tones map to the existing semantic chip tokens. */
export function HaloBadge({
  tone,
  glyph,
  label,
  live,
  count,
  title,
}: {
  tone: 'transit' | 'verified' | 'danger' | 'hold' | 'info' | 'neutral';
  glyph: string;
  label: string;
  live?: boolean;
  count?: number;
  title?: string;
}): JSX.Element {
  return (
    <span className={`mv-badge mv-badge--${tone}`} title={title}>
      <span className="mv-badge__glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="mv-badge__label">{label}</span>
      {count !== undefined && <span className="mv-badge__count">{count}</span>}
      {live === true && <span className="mv-badge__live" aria-hidden="true" />}
    </span>
  );
}

/** Halo Progress — envelope/reserve bar with a mandatory text equivalent. */
export function HaloProgress({
  label,
  usedMinor,
  totalMinor,
  currency,
  warn,
}: {
  label: string;
  usedMinor: number;
  totalMinor: number;
  currency: string;
  warn?: boolean;
}): JSX.Element {
  const pct = totalMinor > 0 ? Math.min(100, Math.round((usedMinor / totalMinor) * 100)) : 0;
  // Shared exact minor-unit formatter (R3 P0-1) — exponent-aware, BigInt-exact.
  const fmt = (m: number): string => moneyAmount(currency, m);
  return (
    <div className={`mv-progress${warn === true ? ' mv-progress--warn' : ''}`}>
      <div className="mv-progress__head">
        <span className="mv-progress__label">{label}</span>
        <span className="mv-progress__value mv-num">
          {fmt(usedMinor)} of {fmt(totalMinor)}
        </span>
      </div>
      <div
        className="mv-progress__track"
        role="img"
        aria-label={`${label}: ${pct}% committed, ${fmt(usedMinor)} of ${fmt(totalMinor)}`}
      >
        <div className="mv-progress__fill" style={{ width: `${String(pct)}%` }} />
      </div>
      <span className="mv-progress__pct mv-num">{String(pct)}% committed</span>
    </div>
  );
}

/** Expandable Card — collapsed state always carries the money figures and
 *  verdict; expansion reveals reasoning/uncertainty/evidence IDs. */
export function ExpandableCard({
  summary,
  details,
  defaultOpen = false,
  tone,
  testId,
}: {
  summary: ReactNode;
  details: ReactNode;
  defaultOpen?: boolean;
  tone?: 'selected' | 'eligible' | 'blocked' | 'noaction';
  testId?: string;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <article
      className={`mv-xcard${tone ? ` mv-xcard--${tone}` : ''}${open ? ' is-open' : ''}`}
      data-testid={testId}
    >
      <button
        type="button"
        className="mv-xcard__summary"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="mv-xcard__chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="mv-xcard__body">{summary}</span>
      </button>
      {open && <div className="mv-xcard__details">{details}</div>}
    </article>
  );
}

/** Side Panel — right-side inspector with the focus trap/restore the Cult
 *  reference lacks (ledger audit item). Escape closes; page content is
 *  inert to pointer events while open. */
export function SidePanel({
  title,
  onClose,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId: string;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab' && panelRef.current !== null) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0] as HTMLElement;
        const last = focusables[focusables.length - 1] as HTMLElement;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="mv-sidepanel" role="dialog" aria-modal="true" aria-label={title}>
      <div className="mv-sidepanel__card" ref={panelRef} tabIndex={-1} data-testid={testId}>
        <header className="mv-sidepanel__head">
          <h3 className="mv-sidepanel__title">{title}</h3>
          <button type="button" className="mv-btn mv-btn--ghost" onClick={onClose}>
            Close ✕
          </button>
        </header>
        <div className="mv-sidepanel__body">{children}</div>
      </div>
    </div>
  );
}

/** Copy Button — clipboard echo with a live announcement. */
export function CopyButton({ value, label }: { value: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => undefined);
  }, [value]);
  return (
    <>
      <button
        type="button"
        className="mv-btn mv-btn--ghost mv-copybtn"
        onClick={copy}
        data-testid="copy-button"
      >
        {copied ? 'Copied ✓' : `Copy ${label}`}
      </button>
      <span role="status" className="mv-visually-hidden">
        {copied ? `${label} copied to clipboard` : ''}
      </span>
    </>
  );
}

/** Stepper — factual workflow strip (proposal → reservation → submission →
 *  verification). Text labels mandatory; side-states are distinct glyphs. */
export function Stepper({
  steps,
  ariaLabel,
}: {
  steps: readonly {
    readonly key: string;
    readonly label: string;
    readonly state: 'done' | 'active' | 'pending' | 'halted' | 'unknown';
    readonly note?: string;
  }[];
  ariaLabel: string;
}): JSX.Element {
  return (
    <ol className="mv-stepper" aria-label={ariaLabel} data-testid="workflow-stepper">
      {steps.map((s) => (
        <li key={s.key} className={`mv-stepper__step is-${s.state}`}>
          <span className="mv-stepper__marker" aria-hidden="true">
            {s.state === 'done'
              ? '●'
              : s.state === 'active'
                ? '◐'
                : s.state === 'halted'
                  ? '✕'
                  : s.state === 'unknown'
                    ? '?'
                    : '○'}
          </span>
          <span className="mv-stepper__text">
            <span className="mv-stepper__label">{s.label}</span>
            {s.note && <span className="mv-stepper__note">{s.note}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Toast — status echo with role=status; callers keep the persistent record
 *  in the owning panel (a toast is never the only record of a financial
 *  state, per the design gate). */
const ToastContext = createContext<{ push: (msg: string) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [messages, setMessages] = useState<readonly { id: number; msg: string }[]>([]);
  const push = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setMessages((m) => [...m, { id, msg }]);
    window.setTimeout(() => setMessages((m) => m.filter((x) => x.id !== id)), 6000);
  }, []);
  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="mv-toasts" aria-label="Status notifications">
        {messages.map((m) => (
          <p key={m.id} role="status" className="mv-toast">
            {m.msg}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): { push: (msg: string) => void } {
  const ctx = useContext(ToastContext);
  return ctx ?? { push: () => undefined };
}

/** Skeleton rows — loading feedback with text (never spinner-only). */
export function SkeletonRows({
  rows = 3,
  label = 'reading…',
}: {
  rows?: number;
  label?: string;
}): JSX.Element {
  return (
    <div role="status" aria-label={label} className="mv-skeletonrows" data-testid="skeleton-rows">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="mv-skeletonrows__row" aria-hidden="true" />
      ))}
      <span className="mv-visually-hidden">{label}</span>
    </div>
  );
}
