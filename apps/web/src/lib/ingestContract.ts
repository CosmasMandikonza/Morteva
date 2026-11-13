/**
 * How a REAL field system sends signed observations (documentation + the one
 * place the UI learns the ingest route). Mirrors Agent C's machine-ingress
 * contract (PR #64): `POST /api/machine/missions/:missionId/events`.
 *
 * Truth boundary printed to the operator:
 *  - a source credential authenticates THE SOURCE (it proves a registered
 *    system holding the key signed these bytes). It does not prove the
 *    measurement is true — FIELD means "credential-authenticated registered
 *    source CLAIMED this observation", never "independently measured";
 *  - a source credential carries NO financial authority;
 *  - the browser never signs events and never holds a credential after the
 *    one-time display.
 */

export interface IngestContract {
  readonly method: 'POST';
  readonly route: (missionId: string) => string;
  /**
   * `source-credential`: machine ingress authenticated by the event HMAC
   * alone — NO cookie, NO CSRF; the key id pins tenant + mission + source and
   * a request carrying a browser cookie is refused.
   * `operator-session`: an older build that only accepted signed events
   * through an authenticated operator session (kept so the guide stays honest
   * against such a build).
   */
  readonly authentication: 'operator-session' | 'source-credential';
  readonly maxEnvelopesPerRequest: number;
}

export const INGEST_CONTRACT: IngestContract = {
  method: 'POST',
  route: (missionId) => `/api/machine/missions/${encodeURIComponent(missionId)}/events`,
  authentication: 'source-credential',
  maxEnvelopesPerRequest: 10,
};

/** HTTP-level answers to the whole request (before per-envelope outcomes). */
export const INGEST_HTTP_GUIDE: readonly { status: string; meaning: string }[] = [
  { status: '200', meaning: 'At least one envelope was admitted; read each outcome.' },
  { status: '422', meaning: 'Every envelope was refused; read each outcome code.' },
  {
    status: '401',
    meaning:
      'Unknown key (MACHINE_AUTH_UNKNOWN_KEY), key/mission mismatch (MACHINE_TENANT_MISMATCH), or a browser cookie was sent (MACHINE_SURFACE_BROWSER_FORBIDDEN).',
  },
  {
    status: '403',
    meaning: 'The credential was revoked (CREDENTIAL_REVOKED) or expired (CREDENTIAL_EXPIRED).',
  },
  {
    status: '410',
    meaning: 'EVENTS_ROUTE_MOVED — the old operator-session route no longer accepts events.',
  },
];

/** Typed outcomes a sender will see per envelope (`outcomes[].code`). */
export const INGEST_OUTCOME_GUIDE: readonly { code: string; meaning: string }[] = [
  {
    code: 'accepted',
    meaning: 'Admitted to the append-only journal; shown in Field observations.',
  },
  {
    code: 'SIGNATURE_INVALID',
    meaning: 'The HMAC did not match — wrong key, altered bytes or wrong canonical form.',
  },
  { code: 'UNAUTHENTICATED_SOURCE', meaning: 'No registered credential for this source/keyId.' },
  {
    code: 'DUPLICATE_EVENT',
    meaning: 'This eventId was already admitted — safe to treat as delivered.',
  },
  { code: 'SEQUENCE_GAP', meaning: 'Per (asset, source) sequence must be 1,2,3… without gaps.' },
  { code: 'TIMESTAMP_ORDER', meaning: 'observedAt moved backwards within the stream.' },
  {
    code: 'STALE_EVENT',
    meaning: 'Too old to be planning-valid; stale history never re-enters as fresh.',
  },
  {
    code: 'CROSS_ORG_EVENT',
    meaning: 'The envelope names a different organisation than the credential.',
  },
  {
    code: 'INVALID_ENVELOPE',
    meaning: 'Schema, vocabulary or banking-term violation in an id or value.',
  },
];

/**
 * Reference signer. The body is EXECUTED by apps/web/test/ingestContract.test.ts
 * against the API's own `sourceSignature` — the documentation cannot drift
 * from the verifier without failing CI.
 */
export const HEADLESS_SIGNING_CORE = `function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function signEvent(event, secret) {
  const { signature, ...sourceWithoutSignature } = event.source;
  void signature;
  return createHmac('sha256', secret)
    .update(canonical({ ...event, source: sourceWithoutSignature }))
    .digest('hex');
}`;

export function headlessSnippet(route: string): string {
  return `import { createHmac } from 'node:crypto';

${HEADLESS_SIGNING_CORE}

// The secret comes from YOUR secret store (shown once by MOTERVA at issuance).
// Never commit it, never log it, never put it in a URL or a browser.
const secret = process.env.MOTERVA_SOURCE_SECRET;

// event = the envelope shown above (source.signature is recomputed here).
event.source.signature = signEvent(event, secret);

// NO cookie, NO CSRF token: the signature is the authentication.
const response = await fetch(MOTERVA_ORIGIN + '${route}', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ events: [event] }),
});
const { outcomes } = await response.json(); // one typed outcome per envelope`;
}
