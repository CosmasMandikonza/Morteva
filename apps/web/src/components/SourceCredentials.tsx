import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  ApiError,
  issueSourceCredential,
  revokeSourceKey,
  type MissionSpecSourceView,
  type SourceCredentialIssued,
  type SourceCredentialMeta,
} from '../lib/api';
import { HaloBadge } from './ui';
import { Sheet } from './OnboardingDialog';

/**
 * Source credential custody (browser side of the contract).
 *
 * A source credential is the signing key a customer's field system uses so
 * that MOTERVA can authenticate WHO claims an observation. Rules enforced here:
 *
 *  1. The secret exists ONLY in the one issuance response. It lives in this
 *     component's memory for the shortest practical time and is cleared on
 *     dismissal, on unmount (navigation, sign-out, session expiry), and by a
 *     hard timer. It is NEVER written to localStorage/sessionStorage/IndexedDB,
 *     the URL, console, analytics, error messages or any other component, and
 *     it is not rendered in the DOM unless the operator presses Reveal.
 *  2. The reveal dialog cannot be dismissed (Escape / Close) until the operator
 *     confirms the secret has been stored in their own secret manager.
 *  3. Only non-secret metadata (sourceId, keyId, time) is kept afterwards.
 *  4. A credential grants NO financial authority — it authenticates sources.
 */

/** Hard ceiling for how long the browser holds a revealed secret. */
export const SECRET_DISPLAY_TTL_MS = 5 * 60_000;

export interface IssuedKeyNote {
  readonly sourceId: string;
  readonly keyId: string;
  readonly at: string;
}

function CredentialRevealSheet({
  issued,
  onDismiss,
}: {
  issued: SourceCredentialIssued;
  onDismiss: () => void;
}): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [copied, setCopied] = useState(false);

  // Hard TTL: the browser stops holding the secret even if the operator walks
  // away. They can issue a NEW key; the old one is never re-displayed.
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, SECRET_DISPLAY_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [onDismiss]);

  const tryClose = (): void => {
    if (!acknowledged) {
      setBlocked(true);
      return;
    }
    onDismiss();
  };

  const copy = (): void => {
    void navigator.clipboard
      .writeText(issued.secret)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <Sheet
      title={`Source credential issued — ${issued.sourceId}`}
      onClose={tryClose}
      testId="credential-reveal"
    >
      <p className="mv-sheet__error" role="alert" data-testid="credential-warning">
        This secret is shown <strong>once</strong>. MOTERVA stores no readable copy you can fetch
        again. Store it in your integration&rsquo;s secret manager now. If you lose it, issue a new
        key — the old one cannot be re-displayed.
      </p>
      <dl className="mv-mandate__meta">
        <div>
          <dt>Source</dt>
          <dd className="mv-num">{issued.sourceId}</dd>
        </div>
        <div>
          <dt>Key id (not secret)</dt>
          <dd className="mv-num" data-testid="credential-keyid">
            {issued.keyId}
          </dd>
        </div>
        <div>
          <dt>Provenance</dt>
          <dd>
            <HaloBadge
              tone={issued.provenance === 'FIELD' ? 'info' : 'neutral'}
              glyph={issued.provenance === 'FIELD' ? '◈' : '◇'}
              label={`${issued.provenance} source`}
            />
          </dd>
        </div>
        <div>
          <dt>Signing secret</dt>
          <dd>
            {/* The real value is in the DOM ONLY while revealed. */}
            <code
              className="mv-num mv-spec__secret"
              data-testid="credential-secret"
              data-sensitive="true"
              aria-label={revealed ? 'Signing secret' : 'Signing secret (hidden)'}
            >
              {revealed ? issued.secret : '•'.repeat(32)}
            </code>
          </dd>
        </div>
      </dl>
      <div className="mv-sheet__actions">
        <button
          type="button"
          className="mv-btn"
          aria-pressed={revealed}
          data-testid="credential-reveal-toggle"
          onClick={() => setRevealed((r) => !r)}
        >
          {revealed ? 'Hide secret' : 'Reveal secret'}
        </button>
        <button type="button" className="mv-btn" data-testid="credential-copy" onClick={copy}>
          {copied ? 'Copied ✓ — paste into your secret store' : 'Copy secret'}
        </button>
      </div>
      <p className="mv-governed__note">
        Your clipboard may retain the secret; paste it straight into your secret manager and clear
        it. The credential authenticates your source only — it grants <strong>no</strong> spending
        authority and cannot approve, reserve or move money.
      </p>
      <label className="mv-check">
        <input
          type="checkbox"
          checked={acknowledged}
          data-testid="credential-ack"
          onChange={(e) => {
            setAcknowledged(e.target.checked);
            if (e.target.checked) setBlocked(false);
          }}
        />{' '}
        I have stored this secret in my own secret manager and understand it cannot be shown again.
      </label>
      {blocked && (
        <p className="mv-sheet__error" role="alert">
          Confirm that you stored the secret before closing — Escape and Close are disabled until
          then.
        </p>
      )}
      <div className="mv-sheet__actions">
        <button
          type="button"
          className="mv-btn mv-btn--primary"
          data-testid="credential-done"
          disabled={!acknowledged}
          onClick={onDismiss}
        >
          Done — clear it from this browser
        </button>
      </div>
    </Sheet>
  );
}

function describeIssueError(error: ApiError): string {
  switch (error.code) {
    case 'SOURCE_NOT_IN_SPEC':
      return 'That source is not declared in the registered mission specification. Register or update the specification first.';
    case 'SOURCE_RECOVERY_FLAG_MISMATCH':
      return 'The recovery-trust flag must match the registered specification for this source.';
    case 'KEY_ID_ALREADY_REGISTERED':
      return 'That key id already exists for this mission. Rotation means a NEW key id — the old secret is never shown again.';
    case 'INVALID_INPUT':
      return error.message;
    default:
      return `${error.code}: ${error.message}`;
  }
}

function describeRevokeError(error: ApiError): string {
  switch (error.code) {
    case 'KEY_NOT_FOUND':
      return 'No key with that id was issued for this mission.';
    case 'KEY_ALREADY_REVOKED':
      return 'That key is already revoked — a revoked key id is never re-issuable.';
    case 'REVOCATION_REJECTED':
      return 'The server rejected the revocation. Nothing changed.';
    default:
      break;
  }
  if (error.status === 403) {
    return 'Revoking a credential is authority: the server requires an owner or admin.';
  }
  return `${error.code}: ${error.message}`;
}

export function SourceCredentials({
  missionId,
  sources,
  credentials,
  csrfToken,
  canIssue,
  canRevoke,
  onSessionExpired,
  onIssued,
}: {
  missionId: string;
  /** Declared sources, or null when this API build does not expose them. */
  sources: readonly MissionSpecSourceView[] | null;
  credentials: readonly SourceCredentialMeta[] | undefined;
  csrfToken: string | null;
  canIssue: boolean;
  /** Owner/admin only (server: manageAuthority) — revocation is authority. */
  canRevoke: boolean;
  onSessionExpired: () => void;
  /** Fired after a successful issuance (carries NO secret). */
  onIssued?: () => void;
}): JSX.Element {
  const [sourceId, setSourceId] = useState<string>('');
  const [keyId, setKeyId] = useState('');
  const [recoveryManual, setRecoveryManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<SourceCredentialIssued | null>(null);
  // NON-SECRET memory of what this session issued (key inventory fallback).
  const [notes, setNotes] = useState<readonly IssuedKeyNote[]>([]);
  // --- revocation (rotation = issue a NEW key id, then revoke the old one)
  const [rvSource, setRvSource] = useState('');
  const [rvKey, setRvKey] = useState('');
  const [rvReason, setRvReason] = useState('');
  const [rvConfirm, setRvConfirm] = useState(false);
  const [rvBusy, setRvBusy] = useState(false);
  const [rvError, setRvError] = useState<string | null>(null);
  const [revokedNow, setRevokedNow] = useState<readonly string[]>([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const declared = sources?.find((s) => s.sourceId === sourceId) ?? null;
  const effectiveSource = sources !== null ? sourceId : sourceId.trim();
  const recovery = declared !== null ? declared.trustedForRecovery : recoveryManual;
  const keyOk = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(keyId.trim());
  const ready = canIssue && csrfToken !== null && effectiveSource !== '' && keyOk && !busy;

  const dismiss = useCallback(() => setIssued(null), []);

  const rvSourceId = sources !== null ? rvSource : rvSource.trim();
  const rvKeyOk = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(rvKey.trim());
  const rvReady = canRevoke && csrfToken !== null && rvSourceId !== '' && rvKeyOk && !rvBusy;

  const revoke = (): void => {
    if (!rvReady || csrfToken === null) return;
    setRvBusy(true);
    setRvError(null);
    revokeSourceKey(missionId, rvSourceId, rvKey.trim(), rvReason.trim(), csrfToken)
      .then((r) => {
        if (!mounted.current) return;
        setRvBusy(false);
        setRvConfirm(false);
        setRevokedNow((list) => [...list, r.keyId]);
        setRvKey('');
        setRvReason('');
      })
      .catch((reason: unknown) => {
        if (!mounted.current) return;
        setRvBusy(false);
        setRvConfirm(false);
        if (reason instanceof ApiError && reason.status === 401) {
          onSessionExpired();
          return;
        }
        setRvError(
          reason instanceof ApiError
            ? describeRevokeError(reason)
            : 'Could not reach the server — nothing was revoked.',
        );
      });
  };

  const issue = (): void => {
    if (!ready || csrfToken === null) return;
    setBusy(true);
    setError(null);
    issueSourceCredential(missionId, effectiveSource, keyId.trim(), recovery, csrfToken)
      .then((response) => {
        if (!mounted.current) return;
        setIssued(response);
        setNotes((n) => [
          ...n,
          { sourceId: response.sourceId, keyId: response.keyId, at: new Date().toISOString() },
        ]);
        setKeyId('');
        setBusy(false);
        onIssued?.();
      })
      .catch((reason: unknown) => {
        if (!mounted.current) return;
        setBusy(false);
        if (reason instanceof ApiError && reason.status === 401) {
          onSessionExpired();
          return;
        }
        setError(
          reason instanceof ApiError
            ? describeIssueError(reason)
            : 'Could not reach the server — no credential was issued.',
        );
      });
  };

  const keysFor = (id: string): readonly string[] => {
    const known = (credentials ?? []).filter((c) => c.sourceId === id);
    const fromApi = known.map((c) => `${c.keyId} (${c.status})`);
    const fromSession = notes
      .filter((n) => n.sourceId === id && !known.some((c) => c.keyId === n.keyId))
      .map((n) => `${n.keyId} (issued this session)`);
    return [...fromApi, ...fromSession];
  };

  return (
    <section
      className="mv-governed"
      aria-label="Source credentials"
      data-testid="source-credentials"
    >
      <h3 className="mv-droom__secttitle">Source onboarding &amp; credentials</h3>
      <p className="mv-governed__lead">
        Each trusted source gets its own signing credential. MOTERVA generates it server-side and
        shows it <strong>once</strong>; your field system then signs every observation with it. The
        credential proves <em>which registered system</em> sent a reading — not that the reading is
        true — and carries no financial authority.
      </p>

      {sources === null ? (
        <p className="mv-governed__note" data-testid="sources-unknown">
          This API build does not list the declared sources. Enter the source id exactly as in your
          specification; the server refuses any source the specification does not declare.
        </p>
      ) : (
        <ul className="mv-governed__list" data-testid="source-list">
          {sources.map((s) => (
            <li key={s.sourceId} data-testid={`source-row-${s.sourceId}`}>
              <strong className="mv-num">{s.sourceId}</strong> · {s.sourceType} ·{' '}
              <HaloBadge
                tone={s.provenance === 'FIELD' ? 'info' : 'neutral'}
                glyph={s.provenance === 'FIELD' ? '◈' : '◇'}
                label={s.provenance}
              />{' '}
              · assets {s.assetIds.join(', ')}
              {s.trustedForRecovery ? ' · recovery-trusted' : ''}
              <br />
              <span className="mv-hud">
                keys:{' '}
                {keysFor(s.sourceId).length === 0
                  ? credentials === undefined
                    ? 'inventory not exposed by this API build (key ids you issue now are listed here)'
                    : 'none issued yet'
                  : keysFor(s.sourceId).join(', ')}
              </span>
            </li>
          ))}
        </ul>
      )}

      <form
        className="mv-spec__issue"
        onSubmit={(e) => {
          e.preventDefault();
          issue();
        }}
      >
        <div className="mv-sheet__grid">
          {sources !== null ? (
            <label className="mv-field">
              <span className="mv-field__label">Source</span>
              <select
                className="mv-input"
                value={sourceId}
                data-testid="issue-source"
                onChange={(e) => setSourceId(e.target.value)}
              >
                <option value="">— choose a declared source —</option>
                {sources.map((s) => (
                  <option key={s.sourceId} value={s.sourceId}>
                    {s.sourceId}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="mv-field">
              <span className="mv-field__label">Source id</span>
              <input
                className="mv-input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={sourceId}
                data-testid="issue-source"
                onChange={(e) => setSourceId(e.target.value)}
              />
            </label>
          )}
          <label className="mv-field">
            <span className="mv-field__label">New key id</span>
            <input
              className="mv-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={keyId}
              data-testid="issue-keyid"
              placeholder="e.g. key-2026-11-a"
              onChange={(e) => setKeyId(e.target.value)}
              aria-describedby="issue-keyid-hint"
            />
            <span className="mv-spec__hint" id="issue-keyid-hint">
              3-64 characters. Rotation = a NEW key id; an existing key id is never re-issued.
            </span>
          </label>
        </div>
        {sources === null && (
          <label className="mv-check">
            <input
              type="checkbox"
              checked={recoveryManual}
              onChange={(e) => setRecoveryManual(e.target.checked)}
            />{' '}
            Source is declared recovery-trusted in the specification
          </label>
        )}
        {declared !== null && (
          <p className="mv-governed__note">
            Declared {declared.provenance} source
            {declared.trustedForRecovery ? ', recovery-trusted' : ''} for{' '}
            {declared.assetIds.join(', ')}.
          </p>
        )}
        {!canIssue && (
          <p className="mv-governed__note" role="note">
            Your role cannot issue credentials (server requires operator or above).
          </p>
        )}
        {error !== null && (
          <p className="mv-sheet__error" role="alert" data-testid="issue-error">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="mv-btn mv-btn--primary"
          data-testid="issue-credential"
          disabled={!ready}
        >
          {busy ? 'Issuing…' : 'Issue credential (shown once)'}
        </button>
      </form>

      <fieldset className="mv-spec__section" data-testid="revoke-key" disabled={!canRevoke}>
        <legend className="mv-droom__secttitle">Revoke a key</legend>
        <p className="mv-governed__note">
          Rotation is two steps: issue a <strong>new</strong> key id, switch your sender to it, then
          revoke the old one. Revocation is immediate and irreversible — the key stops
          authenticating new events (also after a restart); events it already authenticated stay
          valid history; the key id can never be re-issued.
        </p>
        <div className="mv-sheet__grid">
          {sources !== null ? (
            <label className="mv-field">
              <span className="mv-field__label">Source</span>
              <select
                className="mv-input"
                value={rvSource}
                data-testid="revoke-source"
                onChange={(e) => setRvSource(e.target.value)}
              >
                <option value="">— choose a declared source —</option>
                {sources.map((x) => (
                  <option key={x.sourceId} value={x.sourceId}>
                    {x.sourceId}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="mv-field">
              <span className="mv-field__label">Source id</span>
              <input
                className="mv-input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={rvSource}
                data-testid="revoke-source"
                onChange={(e) => setRvSource(e.target.value)}
              />
            </label>
          )}
          <label className="mv-field">
            <span className="mv-field__label">Key id to revoke</span>
            <input
              className="mv-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={rvKey}
              data-testid="revoke-keyid"
              onChange={(e) => {
                setRvKey(e.target.value);
                setRvConfirm(false);
              }}
            />
          </label>
          <label className="mv-field">
            <span className="mv-field__label">Reason (optional, journaled)</span>
            <input
              className="mv-input"
              type="text"
              maxLength={300}
              value={rvReason}
              data-testid="revoke-reason"
              onChange={(e) => setRvReason(e.target.value)}
            />
          </label>
        </div>
        {notes.length > 0 && (
          <p className="mv-hud">
            keys issued this session:{' '}
            {notes.map((n) => (
              <button
                key={n.keyId}
                type="button"
                className="mv-btn mv-btn--ghost"
                onClick={() => {
                  setRvSource(n.sourceId);
                  setRvKey(n.keyId);
                  setRvConfirm(false);
                }}
              >
                {n.keyId}
                {revokedNow.includes(n.keyId) ? ' (revoked)' : ''}
              </button>
            ))}
          </p>
        )}
        {!canRevoke && (
          <p className="mv-governed__note" role="note">
            Revoking a credential is authority: only an owner or admin can do it (the server
            enforces this).
          </p>
        )}
        {rvError !== null && (
          <p className="mv-sheet__error" role="alert" data-testid="revoke-error">
            {rvError}
          </p>
        )}
        {revokedNow.length > 0 && (
          <p role="status" className="mv-droom__notice" data-testid="revoke-done">
            Key {revokedNow[revokedNow.length - 1]} revoked. It no longer authenticates new events;
            historical evidence it authenticated remains valid.
          </p>
        )}
        {!rvConfirm ? (
          <button
            type="button"
            className="mv-btn"
            data-testid="revoke-start"
            disabled={!rvReady}
            onClick={() => setRvConfirm(true)}
          >
            Revoke this key…
          </button>
        ) : (
          <div role="alert" className="mv-sheet__error" data-testid="revoke-confirm">
            <p>
              Revoke <strong className="mv-num">{rvKey.trim()}</strong> of{' '}
              <strong className="mv-num">{rvSourceId}</strong>? It stops authenticating new events
              immediately and can never be re-issued.
            </p>
            <div className="mv-sheet__actions">
              <button type="button" className="mv-btn" onClick={() => setRvConfirm(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="mv-btn mv-btn--primary"
                data-testid="revoke-confirm-btn"
                disabled={rvBusy}
                onClick={revoke}
              >
                {rvBusy ? 'Revoking…' : 'Confirm revoke'}
              </button>
            </div>
          </div>
        )}
      </fieldset>

      {issued !== null && <CredentialRevealSheet issued={issued} onDismiss={dismiss} />}
    </section>
  );
}
