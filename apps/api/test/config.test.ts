import { describe, expect, it } from 'vitest';
import { StartupConfigError, loadConfig } from '../src/config.js';

describe('loadConfig — safe startup validation', () => {
  it('applies safe defaults for a bare environment', () => {
    const config = loadConfig({});
    expect(config.port).toBe(8787);
    expect(config.host).toBe('127.0.0.1');
    expect(config.webOrigin).toBe('http://localhost:5173');
    expect(config.providerMode).toBe('offline');
    expect(config.warnings).toEqual([]);
  });

  it('accepts explicit valid values', () => {
    const config = loadConfig({
      PORT: '9000',
      WEB_ORIGIN: 'https://ops.example.org',
      MOTERVA_PROVIDER_MODE: 'simulated',
      LOG_LEVEL: 'debug',
      GIT_SHA: 'abc123',
    });
    expect(config.port).toBe(9000);
    expect(config.webOrigin).toBe('https://ops.example.org');
    expect(config.providerMode).toBe('simulated');
    expect(config.gitSha).toBe('abc123');
  });

  it('refuses to start in sandbox mode (reserved, not implemented — issue #5)', () => {
    expect(() => loadConfig({ MOTERVA_PROVIDER_MODE: 'sandbox' })).toThrowError(StartupConfigError);
    expect(() => loadConfig({ MOTERVA_PROVIDER_MODE: 'sandbox' })).toThrowError(/#5/);
  });

  it('refuses to start in testnet mode (reserved, not implemented — issue #6)', () => {
    expect(() => loadConfig({ MOTERVA_PROVIDER_MODE: 'testnet' })).toThrowError(/#6/);
  });

  it('rejects unknown provider modes with the allowed list', () => {
    expect(() => loadConfig({ MOTERVA_PROVIDER_MODE: 'production' })).toThrowError(
      /offline.*simulated.*sandbox.*testnet/i,
    );
    // An explicitly empty value is treated as unset (safe default 'offline'),
    // mirroring how `.env` template lines behave when left blank.
    expect(loadConfig({ MOTERVA_PROVIDER_MODE: '' }).providerMode).toBe('offline');
  });

  it('rejects a non-numeric or out-of-range port', () => {
    expect(() => loadConfig({ PORT: 'not-a-port' })).toThrowError(/PORT/);
    expect(() => loadConfig({ PORT: '0' })).toThrowError(StartupConfigError);
    expect(() => loadConfig({ PORT: '70000' })).toThrowError(StartupConfigError);
  });

  it('rejects a malformed web origin', () => {
    expect(() => loadConfig({ WEB_ORIGIN: 'not a url' })).toThrowError(/WEB_ORIGIN/);
  });

  it('warns — but does not use — provider credentials while offline', () => {
    const config = loadConfig({ AIRWALLEX_API_KEY: 'placeholder-not-a-real-key' });
    expect(config.warnings.join(' ')).toMatch(/AIRWALLEX_API_KEY.*IGNORED/);
  });

  it('reports every invalid variable at once, not just the first', () => {
    try {
      loadConfig({ PORT: 'x', WEB_ORIGIN: 'bad', MOTERVA_PROVIDER_MODE: 'nope' });
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(StartupConfigError);
      const message = (error as StartupConfigError).message;
      expect(message).toContain('PORT');
      expect(message).toContain('WEB_ORIGIN');
      expect(message).toContain('MOTERVA_PROVIDER_MODE');
    }
  });
});
