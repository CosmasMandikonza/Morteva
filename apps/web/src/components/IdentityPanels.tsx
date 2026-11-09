import { useEffect, useState, type FormEvent } from 'react';
import type { JSX } from 'react';
import { Panel } from './Panel';

/**
 * Production identity UI (MTV-20) — implements the additive frontend
 * contract in docs/identity/FRONTEND_CONTRACT.md (identity/v1) without
 * touching the loopback DEMO_AUTH flow.
 *
 * Sign-in mode discovery: there is no invented backend field for the
 * signed-out mode probe — the shell probes the REAL `GET /api/auth/oidc/login`
 * capability endpoint (303 = OIDC configured and ready; 404 = identity routes
 * not mounted in this deployment). The demo form renders only in the
 * no-OIDC case, so production never implies a local credential system.
 */

export type AuthModeProbe = 'checking' | 'oidc' | 'local';

export function probeAuthMode(signal?: AbortSignal): Promise<AuthModeProbe> {
  return fetch('/api/auth/oidc/login', {
    method: 'GET',
    credentials: 'same-origin',
    redirect: 'manual',
    signal,
  }).then((r) => (r.status === 303 || r.type === 'opaqueredirect' ? 'oidc' : 'local'));
}

/** OIDC sign-in entry: full-page navigation to the backend login route
 *  (the server 303s to the IdP; PKCE/state live server-side). */
export function OidcSignIn({ orgId }: { orgId?: string }): JSX.Element {
  const href =
    orgId === undefined
      ? '/api/auth/oidc/login'
      : `/api/auth/oidc/login?orgId=${encodeURIComponent(orgId)}`;
  return (
    <a className="mv-btn mv-btn--primary" href={href} data-testid="oidc-signin">
      Continue to your identity provider →
    </a>
  );
}

/** Invitation acceptance (pre-authentication; the secret IS the credential).
 *  Validation goes through fetch first so machine-coded refusals render in
 *  useful language inline; success submits the real form so the browser
 *  follows the server's 303 to the IdP. */
export function InvitationAccept(): JSX.Element {
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Keep a native form in the DOM only when validation succeeded — the
    // submission itself follows the 303 like a normal browser navigation.
    setReady(false);
  }, [id, secret]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy || id.trim() === '' || secret.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/invitations/accept', {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'manual',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ invitationId: id.trim(), secret: secret.trim() }),
      });
      if (r.type === 'opaqueredirect' || r.status === 303) {
        // Server accepted the secret and is redirecting to the IdP —
        // repeat as a native form POST so the browser follows it.
        setReady(true);
        return;
      }
      const body = (await r.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      setError({
        code: body?.error?.code ?? `HTTP_${String(r.status)}`,
        message: friendlyInvitationError(
          body?.error?.code ?? '',
          body?.error?.message ?? 'the invitation could not be accepted',
        ),
      });
    } catch {
      setError({ code: 'NETWORK', message: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Accept your invitation"
      meta={<span className="mv-tag">membership · no public sign-up</span>}
      testId="invite-accept"
    >
      <p className="mv-signin__why">
        MOTERVA membership exists only by invitation. Enter the invitation id and the one-time
        secret exactly as delivered by your organization&rsquo;s owner or admin — after validation
        you will sign in through your identity provider and land with the invited role.
      </p>
      {ready ? (
        <form method="post" action="/api/auth/invitations/accept" ref={(f) => f?.submit()}>
          <input type="hidden" name="invitationId" value={id} />
          <input type="hidden" name="secret" value={secret} />
          <p role="status">Validated — continuing to your identity provider…</p>
        </form>
      ) : (
        <form
          className="mv-signin__form"
          onSubmit={(e) => {
            void submit(e);
          }}
        >
          <label className="mv-field">
            <span className="mv-field__label">Invitation id</span>
            <input
              className="mv-input"
              type="text"
              required
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
          </label>
          <label className="mv-field">
            <span className="mv-field__label">One-time secret</span>
            <input
              className="mv-input"
              type="password"
              required
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
          <button className="mv-btn mv-btn--primary" type="submit" disabled={busy}>
            {busy ? 'Validating…' : 'Accept invitation'}
          </button>
          {error !== null && (
            <p className="mv-signin__error" role="alert" data-testid="invite-error">
              {error.code}: {error.message}
            </p>
          )}
        </form>
      )}
    </Panel>
  );
}

function friendlyInvitationError(code: string, fallback: string): string {
  switch (code) {
    case 'INVITATION_SECRET_INVALID':
      return 'that invitation id and secret do not match — check the delivered link';
    case 'INVITATION_REDEEMED':
      return 'this invitation was already redeemed — ask your admin for a new one';
    case 'INVITATION_REVOKED':
      return 'this invitation was revoked by your organization';
    case 'INVITATION_EXPIRED':
      return 'this invitation expired — ask your admin for a new one';
    default:
      return fallback;
  }
}
