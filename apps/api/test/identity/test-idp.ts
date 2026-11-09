/**
 * Strictly-local TEST identity provider (oidc-provider) for automated
 * verification of the MOTERVA production-identity feature.
 *
 * This is NOT a production component and never ships in a deployment: it is a
 * test fixture, clearly labeled, bound to 127.0.0.1, existing only so the
 * real OIDC code path (discovery, authorization endpoint, PKCE, nonce, JWKS,
 * token exchange) runs against a genuine OpenID Provider instead of a mock.
 * IdP accounts live only inside the fixture; MOTERVA roles NEVER come from
 * here — they come from MOTERVA invitations/provisioning.
 */
import Provider from 'oidc-provider';

export interface TestIdpUser {
  readonly subject: string;
  readonly email: string;
  readonly name: string;
}

export interface TestIdpHandle {
  readonly issuer: string;
  readonly port: number;
  readonly users: Map<string, TestIdpUser>;
  close(): Promise<void>;
}

export interface TestIdpOptions {
  readonly redirectUri: string;
  readonly port?: number;
  readonly users?: readonly TestIdpUser[];
}

const CLIENT_ID = 'moterva-test-client';
export const TEST_IDP_CLIENT_ID = CLIENT_ID;
export const TEST_IDP_CLIENT_SECRET = 'test-idp-client-secret-not-a-production-credential';

export async function startTestIdp(options: TestIdpOptions): Promise<TestIdpHandle> {
  const users = new Map<string, TestIdpUser>();
  for (const user of options.users ?? []) users.set(user.subject, user);
  const port = options.port ?? 0;
  const provider = new Provider(`http://127.0.0.1:${port}`, {
    clients: [
      {
        client_id: CLIENT_ID,
        client_secret: TEST_IDP_CLIENT_SECRET,
        redirect_uris: [options.redirectUri],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
      },
    ],
    claims: {
      profile: ['name'],
      email: ['email', 'email_verified'],
    },
    findAccount: async (_ctx, subject) => ({
      accountId: subject,
      claims: () => {
        const user = users.get(subject);
        return {
          sub: subject,
          email: user?.email ?? `${subject}@idp.test`,
          email_verified: true,
          name: user?.name ?? subject,
        };
      },
    }),
    features: {
      devInteractions: { enabled: true }, // renders the local sign-in form
    },
    // Deterministic-ish TTLs; short code lifetime exercises expiry windows.
    ttl: {
      AccessToken: 600,
      AuthorizationCode: 60,
      IdToken: 600,
      Interaction: 600,
      Session: 600,
    },
  });

  const server = provider.listen(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    if (server.listening) resolve();
    else server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  const actualPort = address !== null && typeof address === 'object' ? address.port : port;
  return {
    issuer: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    users,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/**
 * Completes a REAL sign-in at the local IdP over HTTP (no browser needed in
 * unit/integration tests): follows the authorization redirect into the IdP's
 * interaction, submits the login form, confirms consent, and returns the
 * final callback URL (with code + state) the IdP wants the client to hit.
 * The credentials belong to the IDP user — MOTERVA never sees them.
 */
export async function idpSignIn(
  idp: TestIdpHandle,
  authorizationUrl: string,
  subject: string,
): Promise<{ callbackUrl: string }> {
  // Minimal cookie jar: the IdP interaction state lives in cookies that must
  // ride every hop (fetch does not keep them across manual redirects).
  const jar = new Map<string, string>();
  const absorb = (response: Response): void => {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const eq = pair!.indexOf('=');
      if (eq > 0) jar.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
    }
  };
  const cookieHeader = (): string => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const follow = async (url: string, init?: RequestInit): Promise<Response> => {
    const response = await fetch(url, {
      redirect: 'manual',
      ...init,
      headers: { ...(init?.headers ?? {}), cookie: cookieHeader() },
    });
    absorb(response);
    return response;
  };

  let response = await follow(authorizationUrl);
  let hops = 0;
  // Walk the IdP's dev-interaction pages: each renders a form (login, then
  // consent) whose action is the interaction URL; fill and submit each one
  // until the provider resumes to the client callback.
  for (;;) {
    if (hops++ > 12) throw new Error('IdP interaction loop');
    const location = response.headers.get('location');
    if (location !== null && location.includes(REDIRECT_HINT)) {
      return { callbackUrl: new URL(location, idp.issuer).href };
    }
    if (location !== null && response.status >= 300 && response.status < 400) {
      response = await follow(new URL(location, idp.issuer).href);
      continue;
    }
    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(`unexpected IdP status ${response.status}: ${body.slice(0, 200)}`);
    }
    const html = await response.text();
    const action = html.match(/action="([^"]*)"/)?.[1];
    if (action === undefined) throw new Error('IdP interaction page has no form');
    const fields = new URLSearchParams();
    for (const match of html.matchAll(/<input[^>]*>/g)) {
      const tag = match[0];
      const name = tag.match(/name="([^"]*)"/)?.[1];
      if (name === undefined || name === 'login' || name === 'password') continue;
      const value = tag.match(/value="([^"]*)"/)?.[1] ?? '';
      fields.set(name, value);
    }
    if (fields.get('prompt') === 'login') {
      fields.set('login', subject);
      fields.set('password', `idp-${subject}`);
    }
    response = await follow(new URL(action, idp.issuer).href, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: fields,
    });
  }
}

const REDIRECT_HINT = '/api/auth/oidc/callback';
