import type { JSX, ReactNode } from 'react';
import { SUPPORTED_CURRENCIES } from '../lib/format';
import {
  blankAsset,
  blankOffer,
  blankSource,
  GROUND_INTERRUPTS,
  INDUSTRIES,
  SOURCE_TYPES,
  type AssetDraft,
  type DomainKind,
  type FieldIssue,
  type OfferDraft,
  type SourceDraft,
  type SpecDraft,
} from '../lib/missionSpecForm';

/**
 * The customer-authored mission specification form. Every field is a plain
 * controlled input; validation lives in lib/missionSpecForm.ts (pure, tested,
 * server-parity). The form seeds NO example values: what is typed here is the
 * mission's trust configuration, so it must be the customer's own.
 */

function errId(path: string): string {
  return `spec-err-${path.replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

function Field({
  label,
  path,
  issues,
  hint,
  children,
}: {
  label: string;
  path: string;
  issues: readonly FieldIssue[];
  hint?: string;
  children: (a: { id: string; 'aria-invalid': boolean; 'aria-describedby': string }) => ReactNode;
}): JSX.Element {
  const issue = issues.find((i) => i.path === path);
  const id = `spec-f-${path.replace(/[^a-zA-Z0-9]+/g, '-')}`;
  const describedBy = [issue ? errId(path) : '', hint ? `${id}-hint` : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className="mv-field">
      <label className="mv-field__label" htmlFor={id}>
        {label}
      </label>
      {children({ id, 'aria-invalid': issue !== undefined, 'aria-describedby': describedBy })}
      {hint !== undefined && (
        <span className="mv-spec__hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {issue !== undefined && (
        <span className="mv-spec__error" id={errId(path)}>
          <span aria-hidden="true">⚠ </span>
          {issue.message} <span className="mv-spec__code">{issue.code}</span>
        </span>
      )}
    </div>
  );
}

function Text({
  label,
  path,
  value,
  onChange,
  issues,
  hint,
  placeholder,
  disabled,
  inputMode,
}: {
  label: string;
  path: string;
  value: string;
  onChange: (v: string) => void;
  issues: readonly FieldIssue[];
  hint?: string;
  placeholder?: string;
  disabled: boolean;
  inputMode?: 'numeric' | 'decimal' | 'text';
}): JSX.Element {
  return (
    <Field label={label} path={path} issues={issues} hint={hint}>
      {(a) => (
        <input
          {...a}
          className="mv-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          inputMode={inputMode}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

function OfferFields({
  title,
  path,
  offer,
  onChange,
  assets,
  currency,
  issues,
  kindLocked,
  disabled,
  onRemove,
}: {
  title: string;
  path: string;
  offer: OfferDraft;
  onChange: (o: OfferDraft) => void;
  assets: readonly AssetDraft[];
  currency: string;
  issues: readonly FieldIssue[];
  kindLocked: boolean;
  disabled: boolean;
  onRemove?: () => void;
}): JSX.Element {
  const set = <K extends keyof OfferDraft>(k: K, v: OfferDraft[K]): void =>
    onChange({ ...offer, [k]: v });
  const declared = assets.map((a) => a.assetId.trim()).filter((a) => a !== '');
  return (
    <fieldset className="mv-spec__card" disabled={disabled} data-testid={`spec-${path}`}>
      <legend className="mv-spec__legend">{title}</legend>
      <div className="mv-sheet__grid">
        <Text
          label="Offer id"
          path={`${path}.id`}
          issues={issues}
          value={offer.id}
          onChange={(v) => set('id', v)}
          disabled={disabled}
          hint="Letters, digits, _ and -. Candidate ids derive from it."
        />
        <Field label="Kind" path={`${path}.kind`} issues={issues}>
          {(a) => (
            <select
              {...a}
              className="mv-input"
              value={offer.kind}
              disabled={disabled || kindLocked}
              onChange={(e) => set('kind', e.target.value as OfferDraft['kind'])}
            >
              <option value="inspection-service">inspection-service</option>
              <option value="diagnostic-service">diagnostic-service</option>
            </select>
          )}
        </Field>
        <Text
          label="Beneficiary (who is paid)"
          path={`${path}.beneficiary`}
          issues={issues}
          value={offer.beneficiary}
          onChange={(v) => set('beneficiary', v)}
          disabled={disabled}
        />
        <Text
          label="Purpose"
          path={`${path}.purpose`}
          issues={issues}
          value={offer.purpose}
          onChange={(v) => set('purpose', v)}
          disabled={disabled}
        />
        <Text
          label={`Base cost (${currency})`}
          path={`${path}.baseCost`}
          issues={issues}
          value={offer.baseCost}
          onChange={(v) => set('baseCost', v)}
          disabled={disabled}
          inputMode="decimal"
        />
        <Text
          label={`Fee (${currency})`}
          path={`${path}.fee`}
          issues={issues}
          value={offer.fee}
          onChange={(v) => set('fee', v)}
          disabled={disabled}
          inputMode="decimal"
        />
        <Text
          label="Lead time (minutes)"
          path={`${path}.leadTimeMinutes`}
          issues={issues}
          value={offer.leadTimeMinutes}
          onChange={(v) => set('leadTimeMinutes', v)}
          disabled={disabled}
          inputMode="numeric"
        />
        <Text
          label="Duration (minutes)"
          path={`${path}.durationMinutes`}
          issues={issues}
          value={offer.durationMinutes}
          onChange={(v) => set('durationMinutes', v)}
          disabled={disabled}
          inputMode="numeric"
        />
        <Text
          label="Success probability (%)"
          path={`${path}.probabilityPercent`}
          issues={issues}
          value={offer.probabilityPercent}
          onChange={(v) => set('probabilityPercent', v)}
          disabled={disabled}
          inputMode="decimal"
          hint="An assumption you own, e.g. 91.5 — shown as an assumption in every decision."
        />
        <Field label="Availability" path={`${path}.availability`} issues={issues}>
          {(a) => (
            <select
              {...a}
              className="mv-input"
              value={offer.availability}
              disabled={disabled}
              onChange={(e) => set('availability', e.target.value as OfferDraft['availability'])}
            >
              <option value="confirmed">confirmed</option>
              <option value="unconfirmed">unconfirmed</option>
            </select>
          )}
        </Field>
        <Field
          label="Requires this asset cleared (optional)"
          path={`${path}.requiresAssetId`}
          issues={issues}
          hint="If that asset is blocked or unknown, this offer is refused."
        >
          {(a) => (
            <select
              {...a}
              className="mv-input"
              value={offer.requiresAssetId}
              disabled={disabled}
              onChange={(e) => set('requiresAssetId', e.target.value)}
            >
              <option value="">— none —</option>
              {declared.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {onRemove !== undefined && (
        <button type="button" className="mv-btn mv-btn--ghost" onClick={onRemove}>
          Remove this supplier
        </button>
      )}
    </fieldset>
  );
}

export function SpecForm({
  draft,
  onChange,
  issues,
  disabled,
}: {
  draft: SpecDraft;
  onChange: (next: SpecDraft) => void;
  issues: readonly FieldIssue[];
  disabled: boolean;
}): JSX.Element {
  const set = <K extends keyof SpecDraft>(k: K, v: SpecDraft[K]): void =>
    onChange({ ...draft, [k]: v });
  const hasAerial = draft.assets.some((a) => a.domainKind === 'aerial');
  const hasGround = draft.assets.some((a) => a.domainKind === 'ground');
  const declaredAssets = draft.assets.map((a) => a.assetId.trim()).filter((a) => a !== '');

  const setAsset = (i: number, next: AssetDraft): void =>
    set(
      'assets',
      draft.assets.map((a, idx) => (idx === i ? next : a)),
    );
  const setSource = (i: number, next: SourceDraft): void =>
    set(
      'sources',
      draft.sources.map((s, idx) => (idx === i ? next : s)),
    );

  return (
    <div className="mv-spec" data-testid="spec-form">
      {/* ------------------------------------------------------- identity */}
      <fieldset className="mv-spec__section" disabled={disabled}>
        <legend className="mv-droom__secttitle">1 · Mission</legend>
        <div className="mv-sheet__grid">
          <Text
            label="Spec id"
            path="specId"
            issues={issues}
            value={draft.specId}
            onChange={(v) => set('specId', v)}
            disabled={disabled}
            hint="Lowercase kebab-case, 3-64 chars. Specs are immutable: a change is a NEW spec id."
          />
          <Field
            label="Industry label"
            path="industry"
            issues={issues}
            hint="A label for the product surface. Decisions derive from YOUR assets, thresholds and offers — never from this label."
          >
            {(a) => (
              <select
                {...a}
                className="mv-input"
                value={draft.industry}
                disabled={disabled}
                onChange={(e) => set('industry', e.target.value as SpecDraft['industry'])}
              >
                {INDUSTRIES.map((i) => (
                  <option key={i} value={i}>
                    {i}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Text
            label="Mission title"
            path="title"
            issues={issues}
            value={draft.title}
            onChange={(v) => set('title', v)}
            disabled={disabled}
          />
        </div>
        <Field label="Objective" path="objective" issues={issues}>
          {(a) => (
            <textarea
              {...a}
              className="mv-input"
              rows={3}
              value={draft.objective}
              disabled={disabled}
              onChange={(e) => set('objective', e.target.value)}
            />
          )}
        </Field>
      </fieldset>

      {/* --------------------------------------------------------- assets */}
      <fieldset className="mv-spec__section" disabled={disabled}>
        <legend className="mv-droom__secttitle">2 · Assets</legend>
        <p className="mv-governed__note">
          The physical or logical things your mission depends on. The domain kind decides which
          safety rules may apply (an aerial asset carries a wind limit; a ground asset carries
          interrupt conditions; rules never cross domains).
        </p>
        {draft.assets.map((asset, i) => (
          <div className="mv-spec__row" key={`asset-${String(i)}`}>
            <Text
              label={`Asset ${String(i + 1)} id`}
              path={`assets.${String(i)}.assetId`}
              issues={issues}
              value={asset.assetId}
              onChange={(v) => setAsset(i, { ...asset, assetId: v })}
              disabled={disabled}
            />
            <Text
              label={`Asset ${String(i + 1)} label`}
              path={`assets.${String(i)}.label`}
              issues={issues}
              value={asset.label}
              onChange={(v) => setAsset(i, { ...asset, label: v })}
              disabled={disabled}
            />
            <Field
              label={`Asset ${String(i + 1)} domain`}
              path={`assets.${String(i)}.domainKind`}
              issues={issues}
            >
              {(a) => (
                <select
                  {...a}
                  className="mv-input"
                  value={asset.domainKind}
                  disabled={disabled}
                  onChange={(e) =>
                    setAsset(i, { ...asset, domainKind: e.target.value as DomainKind })
                  }
                >
                  <option value="aerial">aerial</option>
                  <option value="ground">ground</option>
                  <option value="surface">surface</option>
                </select>
              )}
            </Field>
            <button
              type="button"
              className="mv-btn mv-btn--ghost"
              disabled={disabled || draft.assets.length <= 1}
              onClick={() =>
                set(
                  'assets',
                  draft.assets.filter((_, idx) => idx !== i),
                )
              }
              aria-label={`Remove asset ${String(i + 1)}`}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="mv-btn"
          disabled={disabled || draft.assets.length >= 20}
          onClick={() => set('assets', [...draft.assets, blankAsset()])}
        >
          Add asset
        </button>
        {issues.find((i) => i.path === 'assets') !== undefined && (
          <p className="mv-spec__error">{issues.find((i) => i.path === 'assets')?.message}</p>
        )}
      </fieldset>

      {/* -------------------------------------------------------- sources */}
      <fieldset className="mv-spec__section" disabled={disabled}>
        <legend className="mv-droom__secttitle">3 · Trusted sources</legend>
        <p className="mv-governed__note">
          Which systems may report observations, and for which assets. Each source later receives a
          signing credential (shown once). FIELD means the credential-authenticated source{' '}
          <em>claims</em> a field observation — not independently verified measurement.
        </p>
        {draft.sources.map((source, i) => (
          <div
            className="mv-spec__card"
            key={`source-${String(i)}`}
            data-testid={`spec-source-${String(i)}`}
          >
            <div className="mv-sheet__grid">
              <Text
                label={`Source ${String(i + 1)} id`}
                path={`sources.${String(i)}.sourceId`}
                issues={issues}
                value={source.sourceId}
                onChange={(v) => setSource(i, { ...source, sourceId: v })}
                disabled={disabled}
                hint="Lowercase letters, digits, . _ - (3-64)."
              />
              <Field
                label={`Source ${String(i + 1)} type`}
                path={`sources.${String(i)}.sourceType`}
                issues={issues}
              >
                {(a) => (
                  <select
                    {...a}
                    className="mv-input"
                    value={source.sourceType}
                    disabled={disabled}
                    onChange={(e) =>
                      setSource(i, {
                        ...source,
                        sourceType: e.target.value as SourceDraft['sourceType'],
                      })
                    }
                  >
                    {SOURCE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field
                label={`Source ${String(i + 1)} provenance`}
                path={`sources.${String(i)}.provenance`}
                issues={issues}
              >
                {(a) => (
                  <select
                    {...a}
                    className="mv-input"
                    value={source.provenance}
                    disabled={disabled}
                    onChange={(e) =>
                      setSource(i, {
                        ...source,
                        provenance: e.target.value as SourceDraft['provenance'],
                      })
                    }
                  >
                    <option value="FIELD">FIELD — registered field system</option>
                    <option value="SYNTHETIC">SYNTHETIC — simulator / test</option>
                  </select>
                )}
              </Field>
            </div>
            <fieldset
              className="mv-spec__assets"
              aria-describedby={errId(`sources.${String(i)}.assetIds`)}
            >
              <legend className="mv-field__label">May report for these assets</legend>
              {declaredAssets.length === 0 && (
                <span className="mv-governed__note">Declare an asset id above first.</span>
              )}
              {declaredAssets.map((id) => (
                <label key={id} className="mv-check">
                  <input
                    type="checkbox"
                    checked={source.assetIds.includes(id)}
                    disabled={disabled}
                    onChange={(e) =>
                      setSource(i, {
                        ...source,
                        assetIds: e.target.checked
                          ? [...source.assetIds, id]
                          : source.assetIds.filter((x) => x !== id),
                      })
                    }
                  />{' '}
                  {id}
                </label>
              ))}
              {issues.find((x) => x.path === `sources.${String(i)}.assetIds`) !== undefined && (
                <span className="mv-spec__error" id={errId(`sources.${String(i)}.assetIds`)}>
                  <span aria-hidden="true">⚠ </span>
                  {issues.find((x) => x.path === `sources.${String(i)}.assetIds`)?.message}
                </span>
              )}
            </fieldset>
            <label className="mv-check">
              <input
                type="checkbox"
                checked={source.trustedForRecovery}
                disabled={disabled}
                onChange={(e) => setSource(i, { ...source, trustedForRecovery: e.target.checked })}
              />{' '}
              Trusted to confirm recovery after an offline period
            </label>
            <button
              type="button"
              className="mv-btn mv-btn--ghost"
              disabled={disabled || draft.sources.length <= 1}
              onClick={() =>
                set(
                  'sources',
                  draft.sources.filter((_, idx) => idx !== i),
                )
              }
              aria-label={`Remove source ${String(i + 1)}`}
            >
              Remove source
            </button>
          </div>
        ))}
        <button
          type="button"
          className="mv-btn"
          disabled={disabled || draft.sources.length >= 20}
          onClick={() => set('sources', [...draft.sources, blankSource()])}
        >
          Add source
        </button>
      </fieldset>

      {/* ---------------------------------------------------- safety policy */}
      <fieldset className="mv-spec__section" disabled={disabled}>
        <legend className="mv-droom__secttitle">4 · Safety thresholds</legend>
        {hasAerial ? (
          <Text
            label="Modeled wind limit (kt) — aerial assets"
            path="uavWindLimitKt"
            issues={issues}
            value={draft.uavWindLimitKt}
            onChange={(v) => set('uavWindLimitKt', v)}
            disabled={disabled}
            inputMode="decimal"
            hint="Your operating rule, not a measurement. 0 < limit ≤ 200."
          />
        ) : (
          <p className="mv-governed__note">
            No aerial asset: no wind rule is created (domain isolation — a wind limit never applies
            to ground or surface assets).
          </p>
        )}
        {hasGround && (
          <fieldset className="mv-spec__assets">
            <legend className="mv-field__label">Ground interrupting conditions</legend>
            {GROUND_INTERRUPTS.map((g) => (
              <label key={g} className="mv-check">
                <input
                  type="checkbox"
                  checked={g === 'comms-offline' || draft.groundInterrupts.includes(g)}
                  disabled={disabled || g === 'comms-offline'}
                  onChange={(e) =>
                    set(
                      'groundInterrupts',
                      e.target.checked
                        ? [...draft.groundInterrupts, g]
                        : draft.groundInterrupts.filter((x) => x !== g),
                    )
                  }
                />{' '}
                {g}
                {g === 'comms-offline' ? ' (always declared)' : ''}
              </label>
            ))}
          </fieldset>
        )}
      </fieldset>

      {/* -------------------------------------------------------- economics */}
      <fieldset className="mv-spec__section" disabled={disabled}>
        <legend className="mv-droom__secttitle">5 · Economics</legend>
        <div className="mv-sheet__grid">
          <Field label="Currency" path="currency" issues={issues}>
            {(a) => (
              <select
                {...a}
                className="mv-input"
                value={draft.currency}
                disabled={disabled}
                onChange={(e) => set('currency', e.target.value)}
              >
                {SUPPORTED_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Text
            label={`Mission value (${draft.currency})`}
            path="missionValue"
            issues={issues}
            value={draft.missionValue}
            onChange={(v) => set('missionValue', v)}
            disabled={disabled}
            inputMode="decimal"
            hint="Exact amount; extra decimals are refused, never rounded."
          />
          <Text
            label={`Cost of failure (${draft.currency})`}
            path="failureCost"
            issues={issues}
            value={draft.failureCost}
            onChange={(v) => set('failureCost', v)}
            disabled={disabled}
            inputMode="decimal"
          />
          <Text
            label={`Protected reserve (${draft.currency})`}
            path="protectedReserve"
            issues={issues}
            value={draft.protectedReserve}
            onChange={(v) => set('protectedReserve', v)}
            disabled={disabled}
            inputMode="decimal"
            hint="Never spendable by any decision."
          />
          <Text
            label="Deadline (minutes after evaluation)"
            path="deadlineOffsetMinutes"
            issues={issues}
            value={draft.deadlineOffsetMinutes}
            onChange={(v) => set('deadlineOffsetMinutes', v)}
            disabled={disabled}
            inputMode="numeric"
          />
        </div>
      </fieldset>

      {/* --------------------------------------------------------- suppliers */}
      <fieldset className="mv-spec__section" disabled={disabled}>
        <legend className="mv-droom__secttitle">6 · Suppliers &amp; financial constraints</legend>
        <p className="mv-governed__note">
          The catalogue the planner chooses from. The mandate shape (who may be paid, for what) is{' '}
          <strong>derived</strong> from these offers and shown at review — the spending authority
          itself is granted separately, by a human, in a ledger mandate.
        </p>
        <OfferFields
          title="Incumbent supplier (the current plan)"
          path="offers.incumbent"
          offer={draft.incumbent}
          onChange={(o) => set('incumbent', o)}
          assets={draft.assets}
          currency={draft.currency}
          issues={issues}
          kindLocked={false}
          disabled={disabled}
        />
        {draft.alternatives.map((alt, i) => (
          <OfferFields
            key={`alt-${String(i)}`}
            title={`Alternative supplier ${String(i + 1)}`}
            path={`offers.alternatives.${String(i)}`}
            offer={alt}
            onChange={(o) =>
              set(
                'alternatives',
                draft.alternatives.map((x, idx) => (idx === i ? o : x)),
              )
            }
            assets={draft.assets}
            currency={draft.currency}
            issues={issues}
            kindLocked={false}
            disabled={disabled}
            onRemove={() =>
              set(
                'alternatives',
                draft.alternatives.filter((_, idx) => idx !== i),
              )
            }
          />
        ))}
        <div className="mv-droom__actions">
          <button
            type="button"
            className="mv-btn"
            disabled={disabled || draft.alternatives.length >= 10}
            onClick={() => set('alternatives', [...draft.alternatives, blankOffer()])}
          >
            Add alternative supplier
          </button>
          {draft.diagnostics === null ? (
            <button
              type="button"
              className="mv-btn"
              disabled={disabled}
              onClick={() => set('diagnostics', blankOffer('diagnostic-service'))}
            >
              Add diagnostic service
            </button>
          ) : null}
        </div>
        {draft.diagnostics !== null && (
          <OfferFields
            title="Diagnostic service (information purchase)"
            path="offers.diagnostics"
            offer={draft.diagnostics}
            onChange={(o) => set('diagnostics', o)}
            assets={draft.assets}
            currency={draft.currency}
            issues={issues}
            kindLocked
            disabled={disabled}
            onRemove={() => set('diagnostics', null)}
          />
        )}
      </fieldset>
    </div>
  );
}
