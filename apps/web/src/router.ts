/**
 * Minimal path router (issue #21 landing integration).
 *
 * The authenticated Mission Treasury app lives at /app and keeps its existing
 * hash-based sections (#missions … #evidence) untouched — deep links, saved
 * mission context and browser history keep working. The public landing page
 * lives at /.
 *
 * Legacy compatibility: the app used to be served at the bare origin, so old
 * links look like /#missions or /missions. Both are redirected (replaceState
 * + hashchange) to /app#missions — the browser preserves the fragment during
 * the path rewrite.
 */
export type Route = { readonly page: 'landing' | 'app' };

const NAV_IDS = ['missions', 'setup', 'decisions', 'authority', 'evidence'] as const;

export function resolveRoute(pathname: string, hash: string): Route {
  const path = (pathname.replace(/\/+$/, '') || '/').replace(/\/{2,}/g, '/');
  if (path === '/app' || path.startsWith('/app/')) return { page: 'app' };
  // Legacy hash deep links (/#missions) are checked BEFORE the root
  // early-return: a bare-origin visit carrying an app-section hash is a
  // legacy app link, not a landing visit.
  if ((NAV_IDS as readonly string[]).includes(hash.replace('#', ''))) return { page: 'app' };
  if (path === '/') return { page: 'landing' };
  // Legacy path deep links (/missions, /authority/…) → the app section.
  const leaf = path.split('/').pop() ?? '';
  if ((NAV_IDS as readonly string[]).includes(leaf)) return { page: 'app' };
  return { page: 'landing' };
}

/**
 * Rewrite a legacy app URL (bare-origin path or hash deep link) to the /app
 * route in place, preserving the fragment. Returns true when a rewrite
 * happened (the caller should re-resolve).
 */
export function rewriteLegacyUrl(): boolean {
  const { pathname, hash, search } = window.location;
  const bareHash = hash.replace('#', '');
  const leaf = pathname.replace(/\/+$/, '').split('/').pop() ?? '';
  const pathIsLegacy = pathname !== '/' && (NAV_IDS as readonly string[]).includes(leaf);
  const hashIsLegacy = (NAV_IDS as readonly string[]).includes(bareHash);
  if (!pathIsLegacy && !hashIsLegacy) return false;
  const target = '/app' + (pathIsLegacy ? `#${leaf}` : hash) + (pathIsLegacy ? search : '');
  window.history.replaceState(null, '', target);
  return true;
}
