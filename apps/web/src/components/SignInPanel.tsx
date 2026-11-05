import { useState, type FormEvent } from 'react';
import type { JSX } from 'react';
import { Panel } from './Panel';

/**
 * Demo sign-in against the server's loopback-only DEMO_AUTH gate. Rendered
 * only when that gate exists; the panel never invents an auth path and never
 * handles financial mutations (read-only viewer role is sufficient).
 */
export function SignInPanel({
  onSubmit,
  busy,
  error,
}: {
  onSubmit: (username: string, password: string) => void;
  busy: boolean;
  error: string | null;
}): JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (username !== '' && password !== '' && !busy) onSubmit(username, password);
  };

  return (
    <Panel
      title="Operator sign-in"
      meta={<span className="mv-tag mv-tag--demo">DEMO_AUTH · local only</span>}
      testId="signin-panel"
    >
      <p className="mv-signin__why">
        Mission financial data is org-scoped and requires an authenticated session. This deployment
        runs the server&rsquo;s explicit loopback demo gate (username + password); production
        authentication is a separate, verified IdP integration.
      </p>
      <form className="mv-signin__form" onSubmit={submit}>
        <label className="mv-field">
          <span className="mv-field__label">Username</span>
          <input
            className="mv-input"
            type="text"
            name="username"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="mv-field">
          <span className="mv-field__label">Password</span>
          <input
            className="mv-input"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button className="mv-btn mv-btn--primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error !== null && (
          <p className="mv-signin__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Panel>
  );
}
