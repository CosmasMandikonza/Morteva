import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveRoute, rewriteLegacyUrl } from '../src/router.js';

/**
 * Router contract for the landing integration (issue #21): the public page
 * lives at /, the authenticated app at /app, and every legacy deep link still
 * reaches the app section it named. No router dependency — pure functions.
 */
describe('route resolution', () => {
  it('/ is the landing', () => {
    expect(resolveRoute('/', '')).toEqual({ page: 'landing' });
  });

  it('/app and /app/* are the app', () => {
    expect(resolveRoute('/app', '#missions')).toEqual({ page: 'app' });
    expect(resolveRoute('/app/', '')).toEqual({ page: 'app' });
    expect(resolveRoute('/app/anything', '')).toEqual({ page: 'app' });
  });

  it('legacy path deep links (/missions, /authority) reach the app section', () => {
    for (const id of ['missions', 'setup', 'decisions', 'authority', 'evidence']) {
      expect(resolveRoute(`/${id}`, ''), id).toEqual({ page: 'app' });
    }
  });

  it('legacy hash deep links (/#decisions) reach the app section', () => {
    expect(resolveRoute('/', '#decisions')).toEqual({ page: 'app' });
    expect(resolveRoute('/', '#authority')).toEqual({ page: 'app' });
  });

  it('unknown paths land on the public page (no financial exposure)', () => {
    expect(resolveRoute('/privacy', '')).toEqual({ page: 'landing' });
    expect(resolveRoute('/random/deep/link', '')).toEqual({ page: 'landing' });
  });

  it('trailing and doubled slashes normalize', () => {
    expect(resolveRoute('//app//', '')).toEqual({ page: 'app' });
    expect(resolveRoute('//missions', '')).toEqual({ page: 'app' });
  });
});

describe('legacy URL rewrite (window surface)', () => {
  const originalWindow = globalThis.window;
  let currentPath = '/';
  let currentHash = '';

  afterEach(() => {
    globalThis.window = originalWindow;
    vi.unstubAllGlobals();
  });

  function stubWindow(path: string, hash: string): void {
    currentPath = path;
    currentHash = hash;
    vi.stubGlobal('window', {
      location: { pathname: path, hash, search: '' },
      history: {
        replaceState: (_n: unknown, _t: unknown, url: string) => {
          const i = url.indexOf('#');
          currentPath = i >= 0 ? url.slice(0, i) : url;
          currentHash = i >= 0 ? url.slice(i) : '';
        },
      },
    });
  }

  it('rewrites /#missions to /app#missions in place', () => {
    stubWindow('/', '#missions');
    expect(rewriteLegacyUrl()).toBe(true);
    expect(currentPath).toBe('/app');
    expect(currentHash).toBe('#missions');
  });

  it('rewrites /decisions to /app#decisions', () => {
    stubWindow('/decisions', '');
    expect(rewriteLegacyUrl()).toBe(true);
    expect(currentPath).toBe('/app');
    expect(currentHash).toBe('#decisions');
  });

  it('does not rewrite the landing or the app itself', () => {
    stubWindow('/', '');
    expect(rewriteLegacyUrl()).toBe(false);
    stubWindow('/app', '');
    expect(rewriteLegacyUrl()).toBe(false);
  });
});

describe('landing content contract', () => {
  const src = readFileSync(new URL('../src/landing/Landing.tsx', import.meta.url), 'utf8').replace(
    /\s+/g,
    ' ',
  );

  it('uses the mandated hero copy', () => {
    expect(src).toContain('When the mission changes,');
    expect(src).toContain('the money should know.');
    expect(src).toContain('tied to the same mission');
  });

  it('names the four chapters and links each into the real app', () => {
    for (const word of ['OBSERVE', 'DECIDE', 'AUTHORIZE', 'PROVE']) {
      expect(src).toContain(`word: '${word}'`);
    }
    expect(src).toContain("appHref: '/app#decisions'");
    expect(src).toContain("appHref: '/app#authority'");
    expect(src).toContain("appHref: '/app#evidence'");
  });

  it('labels the sample scenario honestly', () => {
    expect(src).toContain('Sample scenario from the documented demo mission');
    expect(src).toContain('not live telemetry or a real account');
  });

  it('never claims live money movement (negations allowed)', () => {
    expect(src).not.toMatch(/payment sent|funds transferred|provider status: settled/i);
    expect(src).toContain('awaiting approval');
    // the honest negation must be present — submitted is never settled
    expect(src.toLowerCase()).toContain('never');
  });
});
