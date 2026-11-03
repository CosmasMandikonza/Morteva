import type { ReactNode } from 'react';
import type { EnvLabel, LifecycleState } from './data';
import { status } from './format';
import { stepIndex } from './state-machine';

/**
 * Candidate-neutral primitives. Visual identity comes from each candidate's
 * CSS scope (`.lab-a` / `.lab-b`), so the two directions stay genuinely
 * different compositions while rendering the identical semantics.
 */

export function StatusChip({ state, compact }: { state: LifecycleState; compact?: boolean }) {
  const s = status(state);
  return (
    <span className={`chip chip--${s.tone}`} data-state={state}>
      <span aria-hidden="true" className="chip__glyph">
        {s.glyph}
      </span>
      <span className="chip__label">{state.replace(/_/g, ' ')}</span>
      {!compact && <span className="chip__blurb">{s.blurb}</span>}
    </span>
  );
}

export function EnvChip({ env }: { env: EnvLabel }) {
  return (
    <span className="env" data-env={env}>
      {env}
    </span>
  );
}

/** Linear lifecycle strip with off-ramp states rendered as side notes. */
export function LifecycleStrip({
  state,
  steps,
}: {
  state: LifecycleState;
  steps: LifecycleState[];
}) {
  const idx = stepIndex(state);
  const onStrip = idx >= 0;
  return (
    <ol className="strip" aria-label={`Operation lifecycle — current state ${state}`}>
      {steps.map((step, i) => {
        const s = status(step);
        const isCurrent = onStrip && i === idx;
        const isDone = onStrip && i < idx;
        return (
          <li
            key={step}
            className={`strip__step${isCurrent ? ' is-current' : ''}${isDone ? ' is-done' : ''}`}
            data-tone={s.tone}
            aria-current={isCurrent ? 'step' : undefined}
          >
            <span className="strip__glyph" aria-hidden="true">
              {isDone ? '✓' : s.glyph}
            </span>
            <span className="strip__label">{step.replace(/_/g, ' ')}</span>
          </li>
        );
      })}
      {!onStrip && (
        <li className="strip__step is-current strip__step--off" data-tone={status(state).tone}>
          <span className="strip__glyph" aria-hidden="true">
            {status(state).glyph}
          </span>
          <span className="strip__label">{state.replace(/_/g, ' ')}</span>
          <span className="strip__note">
            {state === 'STATUS_UNKNOWN'
              ? 'off-ramp — commitment retained'
              : state === 'REJECTED'
                ? 'off-ramp — blocked before spend'
                : 'off-ramp — authority lapsed'}
          </span>
        </li>
      )}
    </ol>
  );
}

/** Dependency-free sparkline with threshold + end annotation and safe padding. */
export function Sparkline({
  points,
  label,
  threshold,
  endLabel,
  stroke = 'currentColor',
  fill = 'transparent',
  width = 220,
  height = 44,
  className,
}: {
  points: number[];
  label: string;
  /** optional threshold line (e.g. envelope cap) */
  threshold?: number;
  /** optional end annotation (e.g. "81k") */
  endLabel?: string;
  stroke?: string;
  fill?: string;
  width?: number;
  height?: number;
  className?: string;
}) {
  const min = Math.min(...points, ...(threshold !== undefined ? [threshold] : []));
  const max = Math.max(...points, ...(threshold !== undefined ? [threshold] : []));
  const pad = (max - min) * 0.25 || 1; // headroom so the line never hugs edges
  const lo = min - pad;
  const hi = max + pad;
  const span = hi - lo;
  const x = (i: number) => (i / (points.length - 1)) * (width - 34) + 3;
  const y = (p: number) => height - 6 - ((p - lo) / span) * (height - 14);
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p).toFixed(1)}`)
    .join(' ');
  const area = `${d} L${x(points.length - 1)} ${height} L3 ${height} Z`;
  const last = points[points.length - 1]!;
  // Bottom band reserved for the period label so it can never clip.
  const totalH = height + 11;
  return (
    <figure
      className={`spark${className ? ` ${className}` : ''}`}
      role="img"
      aria-label={`${label}: ${Math.min(...points)} to ${Math.max(...points)} thousand USD over ${points.length} days, rising overall${threshold !== undefined ? `, threshold ${threshold}` : ''}`}
    >
      <svg viewBox={`0 0 ${width} ${totalH}`} aria-hidden="true">
        {threshold !== undefined && (
          <g>
            <line
              x1="3"
              x2={width - 8}
              y1={y(threshold)}
              y2={y(threshold)}
              stroke={stroke}
              strokeWidth="1"
              strokeDasharray="4 4"
              opacity="0.55"
            />
            <text
              x={width - 6}
              y={y(threshold) + 3}
              textAnchor="end"
              className="spark-cap"
              fill={stroke}
            >
              cap {threshold}k
            </text>
          </g>
        )}
        <path d={area} fill={fill} stroke="none" opacity="0.35" />
        <path d={d} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
        <circle cx={x(points.length - 1)} cy={y(last)} r="3" fill={stroke} />
        {endLabel && (
          <text x={x(points.length - 1) + 6} y={y(last) + 3.5} className="spark-end" fill={stroke}>
            {endLabel}
          </text>
        )}
        <text x="3" y={height + 8} className="spark-cap" fill={stroke} opacity="0.85">
          ← 14 d trend
        </text>
      </svg>
    </figure>
  );
}

export function KV({ k, v, locked }: { k: string; v: ReactNode; locked?: boolean }) {
  return (
    <div className="kv">
      <dt className="kv__k">
        {k}
        {locked && (
          <span className="kv__lock" title="Bound to approval digest — any change invalidates">
            🔒 locked
          </span>
        )}
      </dt>
      <dd className="kv__v">{v}</dd>
    </div>
  );
}
