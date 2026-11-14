/** Shared network helpers for the identity modules. */

/** Loopback hosts the loopback-only test IdP transport may bind to. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '127.0.0.1' || h.endsWith('.localhost');
}

/** True when the request arrived over the trusted configured scheme. */
export function effectiveProtocol(
  requestProtocol: string,
  xForwardedProto: string | string[] | undefined,
  trustProxy: boolean,
): string {
  if (!trustProxy || xForwardedProto === undefined) return requestProtocol;
  const first = Array.isArray(xForwardedProto) ? xForwardedProto[0] : xForwardedProto;
  const value = (first ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  return value === 'https' || value === 'http' ? value : requestProtocol;
}
