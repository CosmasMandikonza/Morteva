import { useState, type FormEvent } from 'react';
import type { JSX } from 'react';
import {
  ApiError,
  createApproval,
  createPlan,
  mayApprove,
  mayPropose,
  type MandateRow,
  type PhysicalDecisionSummary,
} from '../lib/api';
import { formatDate, money } from '../lib/format';
import { Sheet } from './OnboardingDialog';

/**
 * Governed follow-through for a Decision Room evaluation, using ONLY the
 * real plan/approval contracts. Two steps, deliberately separated:
 *   1) PROPOSE (operator+): record a plan version whose terms the proposer
 *      types and reviews exactly — the decision summary informs the terms,
 *      it never fills them invisibly.
 *   2) APPROVE (approver+): a DIFFERENT actor role records the approval
 *      against the plan id+version with kind, mandate and expiry — shown
 *      with the plan digest so changed economic terms are visible.
 * The server enforces every role boundary; the UI renders refusals as
 * first-class outcomes rather than hiding the affordances.
 */

export function ProposePlanSheet({
  missionId,
  missionTitle,
  decision,
  role,
  onClose,
  onProposed,
  csrfToken,
}: {
  missionId: string;
  missionTitle: string;
  decision: PhysicalDecisionSummary;
  role: string | null;
  onClose: () => void;
  onProposed: (plan: { id: string; version: number; digest: string }) => void;
  csrfToken: string | null;
}): JSX.Element {
  const canPropose = mayPropose(role);
  const candidate = decision.selected;
  const [step, setStep] = useState<'form' | 'review'>('form');
  const [amountMajor, setAmountMajor] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [beneficiary, setBeneficiary] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const amountMinor =
    amountMajor.trim() === ''
      ? null
      : Number.isFinite(Number(amountMajor)) && Number(amountMajor) > 0
        ? Math.round(Number(amountMajor) * 100)
        : null;
  const formValid = amountMinor !== null && beneficiary.trim() !== '' && purpose.trim() !== '';
  const overSpendable =
    decision.currentSpendableMinor !== null &&
    amountMinor !== null &&
    amountMinor > decision.currentSpendableMinor;

  const submit = (): void => {
    if (busy || csrfToken === null || !formValid || amountMinor === null) return;
    setBusy(true);
    setError(null);
    createPlan(
      {
        missionId,
        terms: {
          amountMinor,
          currency,
          beneficiary: beneficiary.trim(),
          purpose: purpose.trim(),
        },
      },
      csrfToken,
    )
      .then((result) => {
        setBusy(false);
        onProposed(result.plan);
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
    <Sheet title={`Propose plan — ${missionTitle}`} onClose={onClose} testId="propose-plan-sheet">
      {!canPropose && (
        <p className="mv-sheet__error" role="alert" data-testid="propose-role-note">
          Your role ({role ?? 'unknown'}) cannot propose plans — the server requires an operate
          grant (operator or above) and will refuse this submission.
        </p>
      )}
      <p className="mv-sheet__review">
        Proposal source: evaluation {decision.evaluationId} ({decision.mode}). The evaluation never
        becomes a payment by itself — a plan must be recorded, approved and dispatched under mandate
        authority.
      </p>
      {step === 'form' ? (
        <form
          className="mv-sheet__form"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            if (formValid) setStep('review');
          }}
        >
          {candidate !== null && (
            <p className="mv-sheet__review">
              Evaluation selected “{candidate.label}” (gross {money(currency, candidate.grossMinor)}
              , expected net {money(currency, candidate.expectedNetMinor)} — model assumptions).
              Enter the exact terms you intend to commit; they are your typed inputs, not copies.
            </p>
          )}
          <div className="mv-sheet__grid">
            <label className="mv-field">
              <span className="mv-field__label">Amount ({currency})</span>
              <input
                className="mv-input"
                type="number"
                min="0.01"
                step="0.01"
                required
                value={amountMajor}
                onChange={(e) => setAmountMajor(e.target.value)}
              />
            </label>
            <label className="mv-field">
              <span className="mv-field__label">Currency</span>
              <select
                className="mv-input"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {['USD', 'EUR', 'GBP'].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="mv-field">
            <span className="mv-field__label">Beneficiary (exact allowlist identity)</span>
            <input
              className="mv-input"
              type="text"
              required
              value={beneficiary}
              onChange={(e) => setBeneficiary(e.target.value)}
              placeholder="harbor-diagnostics"
            />
          </label>
          <label className="mv-field">
            <span className="mv-field__label">Purpose (exact mandate-approved purpose)</span>
            <input
              className="mv-input"
              type="text"
              required
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="diagnostic sweep"
            />
          </label>
          {overSpendable && (
            <p className="mv-sheet__error" role="status">
              Amount exceeds the mission&rsquo;s current engine-computed spendable (
              {money(currency, decision.currentSpendableMinor ?? 0)}). The server will reject or
              block this at approval/reservation time.
            </p>
          )}
          {error !== null && (
            <p className="mv-sheet__error" role="alert" data-testid="governed-error">
              {error.code}: {error.message}
            </p>
          )}
          <div className="mv-sheet__actions">
            <button
              type="submit"
              className="mv-btn mv-btn--primary"
              disabled={!formValid}
              data-testid="propose-review-btn"
            >
              Review exact plan →
            </button>
          </div>
        </form>
      ) : (
        <div className="mv-sheet__reviewpane" data-testid="plan-review">
          <h3 className="mv-subhead">Exact plan terms to be submitted</h3>
          <dl className="mv-mandate__meta">
            <div>
              <dt>Mission</dt>
              <dd>
                {missionTitle} <span className="mv-num">({missionId.slice(0, 11)}…)</span>
              </dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd className="mv-num">{money(currency, amountMinor ?? 0)}</dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd className="mv-num">{currency}</dd>
            </div>
            <div>
              <dt>Beneficiary</dt>
              <dd>{beneficiary.trim()}</dd>
            </div>
            <div>
              <dt>Purpose</dt>
              <dd>{purpose.trim()}</dd>
            </div>
          </dl>
          <p className="mv-sheet__review">
            Recording a plan is a proposal only — nothing is reserved or sent. Approval is a
            separate actor&rsquo;s decision.
          </p>
          {error !== null && (
            <p className="mv-sheet__error" role="alert" data-testid="governed-error">
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
              data-testid="propose-submit-btn"
            >
              {busy ? 'Submitting…' : 'Record this plan'}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

export function ApprovePlanSheet({
  missionId,
  missionTitle,
  plan,
  role,
  mandates,
  onClose,
  onApproved,
  csrfToken,
}: {
  missionId: string;
  missionTitle: string;
  plan: { id: string; version: number; digest: string };
  role: string | null;
  mandates: readonly MandateRow[];
  onClose: () => void;
  onApproved: (approval: { id: string; status: string; expiresAt: string }) => void;
  csrfToken: string | null;
}): JSX.Element {
  const canApprove = mayApprove(role);
  const effective = mandates.filter(
    (m) => m.status === 'active' && Date.parse(m.expires_at) > Date.now(),
  );
  const [step, setStep] = useState<'form' | 'review'>('form');
  const [kind, setKind] = useState<'airwallex_transfer' | 'metal_order' | 'internal_hold'>(
    'airwallex_transfer',
  );
  const [mandateKey, setMandateKey] = useState<string>(
    effective.length > 0 ? `${effective[0]?.id}:${String(effective[0]?.version)}` : '',
  );
  const [expiryDays, setExpiryDays] = useState('3');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const chosen = effective.find((m) => `${m.id}:${String(m.version)}` === mandateKey) ?? null;
  const formValid = chosen !== null && Number(expiryDays) > 0;
  const expiryIso = (): string => {
    const days = Number(expiryDays);
    const safe = Number.isFinite(days) && days > 0 ? days : 3;
    return new Date(Date.now() + safe * 86_400_000).toISOString();
  };

  const submit = (): void => {
    if (busy || csrfToken === null || !formValid || chosen === null) return;
    setBusy(true);
    setError(null);
    createApproval(
      {
        missionId,
        planId: plan.id,
        planVersion: plan.version,
        kind,
        mandateId: chosen.id,
        mandateVersion: chosen.version,
        expiresAt: expiryIso(),
      },
      csrfToken,
    )
      .then((result) => {
        setBusy(false);
        onApproved(result.approval);
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
    <Sheet title={`Approve plan — ${missionTitle}`} onClose={onClose} testId="approve-plan-sheet">
      {!canApprove && (
        <p className="mv-sheet__error" role="alert" data-testid="approve-role-note">
          Your role ({role ?? 'unknown'}) cannot approve financial actions — the server requires
          approver or above and will refuse this submission.
        </p>
      )}
      <p className="mv-sheet__review" data-testid="self-approval-note">
        This session recorded the plan. The server enforces separation of duties — it will refuse
        self-approval (AUTH_SELF_APPROVAL); a different approver records the approval. Handing the
        plan to another actor needs a plans read API (Agent A dependency).
      </p>
      {effective.length === 0 && (
        <p className="mv-sheet__error" role="alert">
          This mission has no effective (active and unexpired) mandate to approve against. Grant
          spending authority in Mission Treasury first.
        </p>
      )}
      {step === 'form' ? (
        <form
          className="mv-sheet__form"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            if (formValid) setStep('review');
          }}
        >
          <div className="mv-sheet__grid">
            <label className="mv-field">
              <span className="mv-field__label">Operation kind</span>
              <select
                className="mv-input"
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                <option value="airwallex_transfer">airwallex_transfer</option>
                <option value="internal_hold">internal_hold</option>
                <option value="metal_order">metal_order</option>
              </select>
            </label>
            <label className="mv-field">
              <span className="mv-field__label">Approval expires in (days)</span>
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
          <label className="mv-field">
            <span className="mv-field__label">Mandate under which this approval is issued</span>
            <select
              className="mv-input"
              value={mandateKey}
              onChange={(e) => setMandateKey(e.target.value)}
            >
              {effective.map((m) => (
                <option key={m.id} value={`${m.id}:${String(m.version)}`}>
                  {m.currency} v{String(m.version)} · cap {money(m.currency, m.max_amount_minor)}
                </option>
              ))}
            </select>
          </label>
          {error !== null && (
            <p className="mv-sheet__error" role="alert" data-testid="governed-error">
              {error.code}: {error.message}
            </p>
          )}
          <div className="mv-sheet__actions">
            <button
              type="submit"
              className="mv-btn mv-btn--primary"
              disabled={!formValid}
              data-testid="approve-review-btn"
            >
              Review exact approval →
            </button>
          </div>
        </form>
      ) : (
        <div className="mv-sheet__reviewpane" data-testid="approval-review">
          <h3 className="mv-subhead">Exact approval to be recorded</h3>
          <dl className="mv-mandate__meta">
            <div>
              <dt>Plan</dt>
              <dd>
                <span className="mv-num" title={plan.id}>
                  {plan.id}
                </span>{' '}
                v{String(plan.version)}
              </dd>
            </div>
            <div>
              <dt>Plan digest (economic terms fingerprint)</dt>
              <dd className="mv-num mv-break">{plan.digest}</dd>
            </div>
            <div>
              <dt>Operation kind</dt>
              <dd>{kind}</dd>
            </div>
            {chosen !== null && (
              <div>
                <dt>Mandate</dt>
                <dd>
                  {chosen.currency} v{String(chosen.version)} · cap{' '}
                  <span className="mv-num">{money(chosen.currency, chosen.max_amount_minor)}</span>{' '}
                  · expires {formatDate(chosen.expires_at)}
                </dd>
              </div>
            )}
            <div>
              <dt>Approval expires</dt>
              <dd>{formatDate(expiryIso())}</dd>
            </div>
          </dl>
          <p className="mv-sheet__review">
            Compare the digest against the proposer&rsquo;s shown digest before approving — approval
            binds to this exact plan version. An approval authorizes reservation; it is still not a
            provider submission.
          </p>
          {error !== null && (
            <p className="mv-sheet__error" role="alert" data-testid="governed-error">
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
              disabled={busy || csrfToken === null || !formValid}
              data-testid="approve-submit-btn"
            >
              {busy ? 'Submitting…' : 'Record this approval'}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
