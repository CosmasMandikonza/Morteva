import { useState, type FormEvent } from 'react';
import type { JSX } from 'react';
import { Panel } from './Panel';

/**
 * Production identity UI (MTV-20/R3) — implements the additive frontend
 * contract in docs/identity/FRONTEND_CONTRACT.md (identity/v1) without
 * touching the loopback DEMO_AUTH flow.
 *
 * R3 P0-2: mode discovery uses the REAL anonymous read-only endpoint
 * `GET /api/auth/capabilities` → `{ authMode: 'oidc'|'demo'|'none',
 * demoLogin: boolean }`. The previous probe (GET /api/auth/oidc/login with
 * redirect:'manual') was side-effectful — it STARTED an OIDC flow server-side
 * on every render probe — and failed open to the demo form. There is now NO
 * fallback to the local demo form on any probe failure: an unavailable
 * capability read renders an explicit unavailable state.
 */

export type AuthModeProbe = 'checking' | 'oidc' | 'demo' | 'none' | 'unavailable';

/** Read-only, side-effect-free mode discovery. Every failure mode — network
 *  error, non-JSON body, unexpected enum, 429/5xx, abort — resolves to
 *  'unavailable', never to 'demo'. */
export function probeAuthMode(signal?: AbortSignal): Promise<AuthModeProbe> {
  return fetch('/api/auth/capabilities', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    signal,
  })
    .then((r) => {
      if (!r.ok) return 'unavailable' as const;
      return r
        .json()
        .then(
          (body: unknown): AuthModeProbe => {
            if (
              body !== null &&
              typeof body === 'object' &&
              'authMode' in body &&
              ((body as { authMode: unknown }).authMode === 'oidc' ||
                (body as { authMode: unknown }).authMode === 'demo' ||
                (body as { authMode: unknown }).authMode === 'none')
            ) {
              const mode = (body as { authMode: 'oidc' | 'demo' | 'none' }).authMode;
              if (mode === 'demo') {
                // The demo form is offered ONLY when the demo login affordance
                // is actually enabled server-side (R3: never on demoLogin=false).
                const demoLogin = (body as { demoLogin?: unknown }).demoLogin;
                return demoLogin === true ? 'demo' : 'none';
              }
              return mode;
            }
            return 'unavailable'; // unexpected enum/shape — fail closed
          },
          () => 'unavailable' as const, // invalid JSON
        );
    })
    .catch(() => 'unavailable' as const); // network error / 429 / 5xx / abort
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
 *
 *  R3 P0-3: exactly ONE network submission. The fetch POST carries the JSON
 *  body + `Accept: application/json`; on success it resolves
 *  `{ redirectUrl }` (the coordinated JSON continuation — see the route
 *  comment in apps/api/src/identity/routes.ts) and the browser navigates to
 *  the exact server-issued IdP URL. No native second form, no secret in any
 *  URL, no success state before backend confirmation, double-click guarded.
 *  If the server responds 303 anyway (addition not deployed), the fetch sees
 *  an opaque redirect: an explicit honest state tells the user the deployment
 *  lacks the JSON continuation — never a silent fake. */
export function InvitationAccept(): JSX.Element {
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const [needsContinuationSupport, setNeedsContinuationSupport] = useState(false);
  const [submittedOnce, setSubmittedOnce] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy || submittedOnce || id.trim() === '' || secret.trim() === '') return;
    setBusy(true);
    setError(null);
    setSubmittedOnce(true); // one redemption per user action — no double POST
    try {
      const r = await fetch('/api/auth/invitations/accept', {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'manual',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ invitationId: id.trim(), secret: secret.trim() }),
      });
      if (r.type === 'opaqueredirect' || r.status === 303) {
        // The deployment does not provide the JSON continuation. The POST
        // already happened once — never repeat it; state the situation.
        setNeedsContinuationSupport(true);
        return;
      }
      if (!r.ok) {
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
        setSubmittedOnce(false); // validation failure: the user may correct input
        return;
      }
      const body = (await r.json().catch(() => null)) as {
        redirectUrl?: unknown;
      } | null;
      if (
        body !== null &&
        typeof body === 'object' &&
        typeof body.redirectUrl === 'string' &&
        body.redirectUrl !== ''
      ) {
        setRedirecting(true);
        window.location.assign(body.redirectUrl); // exact server-issued IdP URL
        return;
      }
      setError({ code: 'UNEXPECTED_RESPONSE', message: 'unexpected response shape' });
      setSubmittedOnce(false);
    } catch {
      // Network interruption: the server may or may not have validated the
      // secret. Recovery never replays redemption automatically.
      setError({
        code: 'NETWORK',
        message:
          'connection interrupted after submission — do not resubmit: if this invitation was already accepted, sign in through your identity provider and check your membership; otherwise try again once.',
      });
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
        secret exactly as delivered by your organization&rsquo;s owner or admin — after
        validation you will sign in through your identity provider and land with the invited
        role.
      </p>
      {redirecting ? (
        <p role="status" data-testid="invite-redirecting">
          Invitation validated — continuing to your identity provider…
        </p>
      ) : needsContinuationSupport ? (
        <p className="mv-sheet__error" role="alert" data-testid="invite-continuation-unsupported">
          This deployment&rsquo;s invitation endpoint does not provide the JSON continuation this
          page needs (it redirects instead). Your invitation was submitted exactly once — contact
          your organization&rsquo;s administrator; do not resubmit the secret.
        </p>
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
              autoComplete="off"
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
              autoComplete="off"
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
          <button
            className="mv-btn mv-btn--primary"
            type="submit"
            disabled={busy || submittedOnce}
          >
            {busy ? 'Validating…' : 'Accept invitation'}
          </button>
          {submittedOnce && busy && (
            <p role="status" className="mv-governed__note">
              Submitting exactly once — no resubmission will occur.
            </p>
          )}
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
      return 'this invitation was already redeemed — sign in through your identity provider; ask your admin for a new invitation if you still need access';
    case 'INVITATION_REVOKED':
      return 'this invitation was revoked by your organization';
    case 'INVITATION_EXPIRED':
      return 'this invitation expired — ask your admin for a new one';
    case 'RATE_LIMITED':
      return 'too many attempts — wait a minute before trying again';
    case 'INVALID_INPUT':
      return 'both the invitation id and the one-time secret are required';
    default:
      return fallback;
  }
}
