/**
 * Production identity configuration — fail-closed validation tests.
 * A partially configured OIDC deployment must never boot; every rule here is
 * a startup guarantee, not a runtime check.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, StartupConfigError } from '../../src/config.js';
import { DEFAULT_FLOW_TTL_MS, parseIdentityConfig } from '../../src/identity/config.js';

function captureIssues(
  env: Record<string, string | undefined>,
  nodeEnv: 'development' | 'test' | 'production' = 'development',
): string[] {
  let issues: string[] = [];
  parseIdentityConfig(env, nodeEnv, (collected) => {
    issues = [...collected];
  });
  return issues;
}

const COMPLETE = {
  MOTERVA_OIDC_ISSUER: 'https://idp.example.com',
  MOTERVA_OIDC_CLIENT_ID: 'moterva-prod',
  MOTERVA_OIDC_CLIENT_SECRET: 'a-real-server-side-secret-value',
  MOTERVA_OIDC_REDIRECT_URI: 'https://app.example.com/api/auth/oidc/callback',
};

describe('identity configuration is all-or-nothing', () => {
  it('no identity variables → identity disabled (null), other config still loads', () => {
    expect(parseIdentityConfig({}, 'production', () => {})).toBeNull();
    const config = loadConfig({ NODE_ENV: 'production' });
    expect(config.identity).toBeNull();
  });

  it('missing redirect URI is a named startup error listing all missing vars', () => {
    const issues = captureIssues({
      MOTERVA_OIDC_ISSUER: 'https://idp.example.com',
      MOTERVA_OIDC_CLIENT_ID: 'moterva',
    });
    expect(issues.join('\n')).toMatch(/MOTERVA_OIDC_CLIENT_SECRET, MOTERVA_OIDC_REDIRECT_URI/);
    expect(() => loadConfig({ ...COMPLETE, MOTERVA_OIDC_CLIENT_SECRET: undefined })).toThrow(
      StartupConfigError,
    );
  });

  it('a lone stray variable (e.g. only a secret) still requires the full set', () => {
    const issues = captureIssues({ MOTERVA_OIDC_CLIENT_SECRET: 'orphaned-secret' });
    expect(issues.join('\n')).toMatch(/missing MOTERVA_OIDC_ISSUER/);
  });
});

describe('transport rules', () => {
  it('production accepts https issuer + redirect', () => {
    expect(captureIssues(COMPLETE, 'production')).toEqual([]);
  });

  it('production refuses plain-HTTP issuer even with the insecure escape hatch', () => {
    const issues = captureIssues(
      {
        ...COMPLETE,
        MOTERVA_OIDC_ISSUER: 'http://idp.example.com',
        MOTERVA_OIDC_ALLOW_INSECURE_TRANSPORT: '1',
      },
      'production',
    );
    expect(issues.join('\n')).toMatch(/https:\/\/ issuer/);
  });

  it('plain-HTTP loopback issuer requires the explicit insecure-transport flag', () => {
    const without = captureIssues(
      { ...COMPLETE, MOTERVA_OIDC_ISSUER: 'http://127.0.0.1:8080' },
      'test',
    );
    expect(without.join('\n')).toMatch(/MOTERVA_OIDC_ALLOW_INSECURE_TRANSPORT=1/);
    const withFlag = captureIssues(
      {
        ...COMPLETE,
        MOTERVA_OIDC_ISSUER: 'http://127.0.0.1:8080',
        MOTERVA_OIDC_ALLOW_INSECURE_TRANSPORT: '1',
      },
      'test',
    );
    expect(withFlag).toEqual([]);
  });

  it('plain-HTTP NON-loopback issuer is refused even with the flag (non-production)', () => {
    const issues = captureIssues(
      {
        ...COMPLETE,
        MOTERVA_OIDC_ISSUER: 'http://idp.lan.example:8080',
        MOTERVA_OIDC_ALLOW_INSECURE_TRANSPORT: '1',
      },
      'development',
    );
    expect(issues.join('\n')).toMatch(/plain-HTTP issuers are only allowed on loopback/);
  });

  it('issuer with a query string or fragment is refused', () => {
    const issues = captureIssues({
      ...COMPLETE,
      MOTERVA_OIDC_ISSUER: 'https://idp.example.com/?x=1',
    });
    expect(issues.join('\n')).toMatch(/query strings and fragments/);
    const frag = captureIssues({ ...COMPLETE, MOTERVA_OIDC_ISSUER: 'https://idp.example.com/#/x' });
    expect(frag.join('\n')).toMatch(/query strings and fragments/);
  });

  it('origin + path issuers are accepted (Amazon Cognito carries a mandatory pool-id path)', () => {
    const cognitoIssuer = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ExamplePool';
    const issues = captureIssues({ ...COMPLETE, MOTERVA_OIDC_ISSUER: cognitoIssuer }, 'production');
    expect(issues).toEqual([]);
    const config = loadConfig({
      ...COMPLETE,
      MOTERVA_OIDC_ISSUER: cognitoIssuer,
      NODE_ENV: 'production',
    });
    expect(config.identity!.issuer).toBe(cognitoIssuer);
  });

  it('redirect URI fragment is refused; production redirect must be https', () => {
    const frag = captureIssues({
      ...COMPLETE,
      MOTERVA_OIDC_REDIRECT_URI: 'https://app.example.com/cb#z',
    });
    expect(frag.join('\n')).toMatch(/fragments are not allowed/);
    const httpProd = captureIssues(
      { ...COMPLETE, MOTERVA_OIDC_REDIRECT_URI: 'http://app.example.com/api/auth/oidc/callback' },
      'production',
    );
    expect(httpProd.join('\n')).toMatch(/production redirect URI must be https/);
  });
});

describe('credential hygiene', () => {
  it('placeholder client secrets are refused', () => {
    for (const secret of ['changeme', 'PLACEHOLDER', 'replace-me']) {
      const issues = captureIssues({ ...COMPLETE, MOTERVA_OIDC_CLIENT_SECRET: secret });
      expect(issues.join('\n'), secret).toMatch(/placeholder value refused/);
    }
  });

  it('placeholder client ids are refused', () => {
    const issues = captureIssues({ ...COMPLETE, MOTERVA_OIDC_CLIENT_ID: 'change-me' });
    expect(issues.join('\n')).toMatch(/placeholder value refused/);
  });
});

describe('flow and scope validation', () => {
  it('flow TTL must be 1–15 minutes; default applies when unset', () => {
    expect(captureIssues({ ...COMPLETE, MOTERVA_OIDC_FLOW_TTL_MS: '59000' }).join('\n')).toMatch(
      /between 60000 and 900000/,
    );
    expect(captureIssues({ ...COMPLETE, MOTERVA_OIDC_FLOW_TTL_MS: '900001' }).join('\n')).toMatch(
      /between 60000 and 900000/,
    );
    const ok = captureIssues({ ...COMPLETE, MOTERVA_OIDC_FLOW_TTL_MS: '120000' });
    expect(ok).toEqual([]);
  });

  it('scopes must include openid; defaults apply when unset', () => {
    const missing = captureIssues({ ...COMPLETE, MOTERVA_OIDC_SCOPES: 'profile email' });
    expect(missing.join('\n')).toMatch(/must include the "openid" scope/);
  });
});

describe('loadConfig integration', () => {
  it('complete config produces a working identity block + flow default', () => {
    const config = loadConfig({ ...COMPLETE, NODE_ENV: 'production', MOTERVA_TRUST_PROXY: '1' });
    expect(config.identity).not.toBeNull();
    expect(config.identity!.issuer).toBe('https://idp.example.com');
    expect(config.identity!.flowTtlMs).toBe(DEFAULT_FLOW_TTL_MS);
    expect(config.identity!.insecureTransport).toBe(false);
    expect(config.trustProxy).toBe(true);
  });

  it('partial identity config fails the whole startup (fail closed)', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', MOTERVA_OIDC_CLIENT_ID: 'only-the-id' }),
    ).toThrow(StartupConfigError);
  });

  it('trust proxy defaults to false', () => {
    expect(loadConfig({}).trustProxy).toBe(false);
  });
});
