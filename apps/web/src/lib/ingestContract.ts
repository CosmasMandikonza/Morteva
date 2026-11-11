/**
 * How a REAL field system sends signed observations (documentation + the one
 * place the UI learns the ingest route). This is the single module to update
 * when Agent C publishes the final machine-ingress contract (PR #64, CTO P0-1):
 * the guide in Mission Setup reads ONLY from here.
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
   * `operator-session`: the build only accepts the signed envelope through an
   * authenticated operator session (RBAC + CSRF) — a headless client holding
   * ONLY a source credential cannot post yet (CTO P0-1 on #64).
   * `source-credential`: credential-only machine ingress is available.
   */
  readonly authentication: 'operator-session' | 'source-credential';
  readonly maxEnvelopesPerRequest: number;
}

export const INGEST_CONTRACT: IngestContract = {
  method: 'POST',
  route: (missionId) => `/api/missions/${encodeURIComponent(missionId)}/events`,
  authentication: 'operator-session',
  maxEnvelopesPerRequest: 10,
};

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
  {
    code: 'UNAUTHENTICATED_SOURCE',
    meaning: 'No registered credential for this source/keyId (or it was revoked).',
  },
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

export function headlessSnippet(): string {
  return `import { createHmac } from 'node:crypto';

${HEADLESS_SIGNING_CORE}

// The secret comes from YOUR secret store (shown once by MOTERVA at issuance).
// Never commit it, never log it, never put it in a URL or a browser.
const secret = process.env.MOTERVA_SOURCE_SECRET;

// event = the envelope shown above, with source.signature omitted or ignored.
event.source.signature = signEvent(event, secret);
// then POST { "events": [event] } to the ingest route.`;
}
