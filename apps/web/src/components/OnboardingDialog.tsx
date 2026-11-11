import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { JSX } from 'react';
import { ApiError, createMission, createMandate, type MandateRow } from '../lib/api';
import { formatDate, money, parseMajorToMinor } from '../lib/format';

/**
 * Accessible onboarding sheet (role="dialog", focus trapped to the sheet,
 * focus restored to the opener on close, Escape closes, reduced-motion safe).
 * Both flows are REVIEW-THEN-WRITE: the exact payload the server will receive
 * is shown verbatim before submission, and authorization is enforced by the
 * server — the UI only describes what it knows about the actor's role.
 */

export function Sheet({
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
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    ref.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab' && ref.current !== null) {
        const focusables = ref.current.querySelectorAll<HTMLElement>(
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
    <div
      className="mv-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
      tabIndex={-1}
      ref={ref}
    >
      <header className="mv-sheet__head">
        <h2 className="mv-sheet__title">{title}</h2>
        <button type="button" className="mv-btn mv-btn--ghost" onClick={onClose}>
          Close ✕
        </button>
      </header>
      <div className="mv-sheet__body">{children}</div>
    </div>
  );
}

export function MissionCreateSheet({
  onClose,
  onCreated,
  csrfToken,
}: {
  onClose: () => void;
  onCreated: (missionId: string) => void;
  csrfToken: string | null;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy || csrfToken === null || title.trim() === '') return;
    setBusy(true);
    setError(null);
    createMission(title.trim(), csrfToken)
      .then((mission) => {
        setBusy(false);
        onCreated(mission.id);
      })
      .catch((reason: unknown) => {
        setBusy(false);
        setError(
          reason instanceof ApiError
            ? { code: reason.code, message: reason.message }
            : { code: 'NETWORK', message: 'Could not reach the server.' },
        );
      });
  };

  return (
    <Sheet title="Create mission" onClose={onClose} testId="mission-create-sheet">
      <form className="mv-sheet__form" onSubmit={submit}>
        <label className="mv-field">
          <span className="mv-field__label">Mission name</span>
          <input
            className="mv-input"
            type="text"
            name="title"
            required
            maxLength={120}
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <p className="mv-sheet__review">
          The server creates a mission record scoped to your organization. No mandate and no
          spending authority are created automatically — authority is a separate, reviewed step.
        </p>
        {error !== null && (
          <p className="mv-sheet__error" role="alert" data-testid="onboarding-error">
            {error.code}: {error.message}
          </p>
        )}
        <div className="mv-sheet__actions">
          <button
            type="submit"
            className="mv-btn mv-btn--primary"
            disabled={busy || title.trim() === '' || csrfToken === null}
            data-testid="create-mission-submit"
          >
            {busy ? 'Creating…' : 'Create mission'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

// Mirror of the domain supported-currency table (R3 P0-1): every code here
// has a registered minor-unit precision — JPY 0, KWD/BHD 3, USDZ 2 (token).
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'KWD', 'BHD', 'USDZ', 'NOK', 'SGD'] as const;
const OPERATION_KINDS = ['airwallex_transfer', 'internal_hold'] as const;

export function MandateCreateSheet({
  missionId,
  missionTitle,
  canManageAuthority,
  onClose,
  onCreated,
  csrfToken,
  prefill,
}: {
  missionId: string;
  missionTitle: string;
  canManageAuthority: boolean;
  onClose: () => void;
  onCreated: (mandate: MandateRow) => void;
  csrfToken: string | null;
  /** SUGGESTED constraints (e.g. from the registered mission specification's
   *  derived mandate shape). A human still reviews every value and submits;
   *  nothing is granted by prefilling. */
  prefill?: {
    currency?: string;
    beneficiaries?: readonly string[];
    purposes?: readonly string[];
  };
}): JSX.Element {
  const [step, setStep] = useState<'form' | 'review'>('form');
  const [currency, setCurrency] = useState<string>(prefill?.currency ?? 'USD');
  const [kinds, setKinds] = useState<readonly string[]>(['airwallex_transfer']);
  const [maxMajor, setMaxMajor] = useState('');
  const [budgetMajor, setBudgetMajor] = useState('');
  const [beneficiaries, setBeneficiaries] = useState((prefill?.beneficiaries ?? []).join(', '));
  const [purposes, setPurposes] = useState((prefill?.purposes ?? []).join(', '));
  const [expiryDays, setExpiryDays] = useState('7');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  // Exponent-aware exact parse (R3 P0-1): rejects extra decimals instead of
  // rounding, and works for any currency the mandate allows (JPY/KWD/USDZ…).
  const parseMajor = (value: string): number | null => {
    const minor = parseMajorToMinor(currency, value);
    return minor !== null && minor > 0 ? minor : null;
  };
  const maxMinor = parseMajor(maxMajor);
  const budgetMinor = budgetMajor.trim() === '' ? null : parseMajor(budgetMajor);
  const splitList = (value: string): readonly string[] =>
    value
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
  const expiryIso = (): string => {
    const days = Number(expiryDays);
    const safe = Number.isFinite(days) && days > 0 ? days : 7;
    return new Date(Date.now() + safe * 86_400_000).toISOString();
  };
  const formValid =
    maxMinor !== null &&
    (budgetMinor === null || budgetMinor >= maxMinor) &&
    kinds.length > 0 &&
    Number(expiryDays) > 0;

  const payload = {
    missionId,
    currency,
    maxAmountMinor: maxMinor ?? 0,
    ...(budgetMinor !== null ? { totalBudgetMinor: budgetMinor } : {}),
    permittedOperationKinds: kinds,
    allowedBeneficiaries: splitList(beneficiaries),
    allowedPurposes: splitList(purposes),
    expiresAt: expiryIso(),
  };

  const submit = (): void => {
    if (busy || csrfToken === null || !formValid) return;
    setBusy(true);
    setError(null);
    createMandate(payload, csrfToken)
      .then((mandate) => {
        setBusy(false);
        onCreated(mandate);
      })
      .catch((reason: unknown) => {
        setBusy(false);
        setStep('form');
        setError(
          reason instanceof ApiError
            ? { code: reason.code, message: reason.message }
            : { code: 'NETWORK', message: 'Could not reach the server.' },
        );
      });
  };

  return (
    <Sheet
      title={`Grant spending authority — ${missionTitle}`}
      onClose={onClose}
      testId="mandate-create-sheet"
    >
      {!canManageAuthority && (
        <p className="mv-sheet__error" role="alert" data-testid="mandate-role-note">
          Your role cannot manage authority (server requires owner or admin). The server will refuse
          this request — the button below exists so the refusal is observable, not to bypass it.
        </p>
      )}
      {/* Cult UI Onboarding pattern: explicit step indicator with gating. */}
      <ol className="mv-wizard__steps" aria-label="Mandate wizard steps">
        <li className={step === 'form' ? 'is-active' : 'is-done'}>
          <span className="mv-wizard__num">1</span> Constraints
        </li>
        <li
          className={step === 'review' ? 'is-active' : step === 'form' ? 'is-pending' : 'is-done'}
        >
          <span className="mv-wizard__num">2</span> Exact review
        </li>
        <li className="is-pending">
          <span className="mv-wizard__num">3</span> Server grant
        </li>
      </ol>
      {step === 'form' ? (
        <form
          className="mv-sheet__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (formValid) setStep('review');
          }}
        >
          <div className="mv-sheet__grid">
            <label className="mv-field">
              <span className="mv-field__label">Currency</span>
              <select
                className="mv-input"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {(CURRENCIES.includes(currency as (typeof CURRENCIES)[number])
                  ? [...CURRENCIES]
                  : [currency, ...CURRENCIES]
                ).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="mv-field">
              <span className="mv-field__label">Per-operation cap ({currency})</span>
              <input
                className="mv-input"
                type="number"
                min="0.01"
                step="0.01"
                required
                value={maxMajor}
                onChange={(e) => setMaxMajor(e.target.value)}
                placeholder="e.g. 800"
              />
            </label>
            <label className="mv-field">
              <span className="mv-field__label">
                Mission budget envelope ({currency}, optional — defaults to the cap)
              </span>
              <input
                className="mv-input"
                type="number"
                min="0.01"
                step="0.01"
                value={budgetMajor}
                onChange={(e) => setBudgetMajor(e.target.value)}
                placeholder="e.g. 1500"
              />
            </label>
            <label className="mv-field">
              <span className="mv-field__label">Expires in (days)</span>
              <input
                className="mv-input"
                type="number"
                min="1"
                step="1"
                required
                value={expiryDays}
                onChange={(e) => setExpiryDays(e.target.value)}
              />
            </label>
          </div>
          <fieldset className="mv-field">
            <legend className="mv-field__label">Permitted operation kinds</legend>
            {OPERATION_KINDS.map((kind) => (
              <label key={kind} className="mv-check">
                <input
                  type="checkbox"
                  checked={kinds.includes(kind)}
                  onChange={(e) =>
                    setKinds(e.target.checked ? [...kinds, kind] : kinds.filter((k) => k !== kind))
                  }
                />
                {kind}
              </label>
            ))}
          </fieldset>
          <label className="mv-field">
            <span className="mv-field__label">
              Approved beneficiaries (comma-separated, optional)
            </span>
            <input
              className="mv-input"
              type="text"
              value={beneficiaries}
              onChange={(e) => setBeneficiaries(e.target.value)}
              placeholder="harbor-diagnostics, harbor-marine"
            />
          </label>
          <label className="mv-field">
            <span className="mv-field__label">Approved purposes (comma-separated, optional)</span>
            <input
              className="mv-input"
              type="text"
              value={purposes}
              onChange={(e) => setPurposes(e.target.value)}
              placeholder="diagnostic sweep, mooring inspection"
            />
          </label>
          {error !== null && (
            <p className="mv-sheet__error" role="alert" data-testid="onboarding-error">
              {error.code}: {error.message}
            </p>
          )}
          <div className="mv-sheet__actions">
            <button
              type="submit"
              className="mv-btn mv-btn--primary"
              disabled={!formValid}
              data-testid="mandate-review-btn"
            >
              Review exact authority →
            </button>
          </div>
        </form>
      ) : (
        <div className="mv-sheet__reviewpane" data-testid="mandate-review">
          <h3 className="mv-subhead">Exact authority to be submitted</h3>
          <dl className="mv-mandate__meta">
            <div>
              <dt>Mission</dt>
              <dd>
                {missionTitle} <span className="mv-num">({missionId.slice(0, 11)}…)</span>
              </dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd className="mv-num">{currency}</dd>
            </div>
            <div>
              <dt>Per-operation cap</dt>
              <dd className="mv-num">{money(currency, maxMinor ?? 0)}</dd>
            </div>
            <div>
              <dt>Mission budget envelope</dt>
              <dd className="mv-num">
                {budgetMinor === null
                  ? `${money(currency, maxMinor ?? 0)} (defaults to the cap)`
                  : money(currency, budgetMinor)}
              </dd>
            </div>
            <div>
              <dt>Permitted kinds</dt>
              <dd>{kinds.join(' · ')}</dd>
            </div>
            <div>
              <dt>Approved beneficiaries</dt>
              <dd>{splitList(beneficiaries).join(' · ') || 'any (not restricted)'}</dd>
            </div>
            <div>
              <dt>Approved purposes</dt>
              <dd>{splitList(purposes).join(' · ') || 'any (not restricted)'}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{formatDate(expiryIso())}</dd>
            </div>
          </dl>
          <p className="mv-sheet__review">
            This grants real spending authority under the server&rsquo;s role and mandate rules.
            Once submitted, only the authority workflow can revoke or supersede it.
          </p>
          {error !== null && (
            <p className="mv-sheet__error" role="alert" data-testid="onboarding-error">
              {error.code}: {error.message}
            </p>
          )}
          <div className="mv-sheet__actions">
            <button
              type="button"
              className="mv-btn"
              onClick={() => setStep('form')}
              disabled={busy}
            >
              ← Edit
            </button>
            <button
              type="button"
              className="mv-btn mv-btn--primary"
              onClick={submit}
              disabled={busy || csrfToken === null}
              data-testid="mandate-submit-btn"
            >
              {busy ? 'Submitting…' : 'Grant this authority'}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
