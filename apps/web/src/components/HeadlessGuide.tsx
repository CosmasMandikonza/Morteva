import type { JSX } from 'react';
import type { MissionSpecSourceView } from '../lib/api';
import { headlessSnippet, INGEST_CONTRACT, INGEST_OUTCOME_GUIDE } from '../lib/ingestContract';
import { sampleEnvelope, type DomainKind } from '../lib/missionSpecForm';
import { CopyButton, HaloBadge } from './ui';

/**
 * "How does a real field system send evidence?" — the customer-facing
 * contract for a headless sender. Contains NO secret (a literal placeholder
 * signature and an environment-variable reference only). The reference signer
 * is executed against the API verifier in CI (apps/web/test/ingestContract).
 *
 * Honest about what is true TODAY: when the build only accepts signed events
 * through an operator session, the guide says so instead of implying that a
 * bare credential is enough.
 */
export function HeadlessGuide({
  missionId,
  orgId,
  source,
  assetDomain,
}: {
  missionId: string;
  orgId: string | null;
  source: MissionSpecSourceView | null;
  assetDomain: DomainKind;
}): JSX.Element {
  const route = INGEST_CONTRACT.route(missionId);
  const example = sampleEnvelope({
    orgId,
    missionId,
    source: source ?? {
      sourceId: '<your declared sourceId>',
      sourceType: '<its declared sourceType>',
      provenance: 'FIELD',
      assetIds: ['<assetId>'],
    },
    assetDomain,
    keyId: '<the keyId you were issued>',
  });
  const exampleText = JSON.stringify({ events: [example] }, null, 2);
  const snippet = headlessSnippet();
  const machine = INGEST_CONTRACT.authentication === 'source-credential';

  return (
    <section
      className="mv-governed"
      aria-label="How a field system sends signed evidence"
      data-testid="headless-guide"
    >
      <h3 className="mv-droom__secttitle">How a field system sends signed evidence</h3>
      <p className="mv-governed__lead">
        Observations do not come from this screen. Your own system (telemetry gateway, WMS, control
        room) signs each observation with its source credential and sends it to MOTERVA. The
        Decision Room then evaluates from the real journal.
      </p>

      <p className="mv-governed__note" data-testid="ingest-auth-status">
        <HaloBadge
          tone={machine ? 'info' : 'hold'}
          glyph={machine ? '◈' : '⚑'}
          label={machine ? 'CREDENTIAL-ONLY INGRESS' : 'OPERATOR-SESSION INGRESS (INTERIM)'}
        />{' '}
        {machine
          ? 'A system holding only the issued credential can submit signed events.'
          : 'This build accepts signed events only through an authenticated operator session. A credential-only machine route is pending (tracked on PR #64); until it ships, a headless client holding only a source credential cannot post here, and this guide will not pretend otherwise.'}
      </p>

      <dl className="mv-mandate__meta">
        <div>
          <dt>Endpoint</dt>
          <dd className="mv-num mv-wrap" data-testid="ingest-route">
            {INGEST_CONTRACT.method} {route}
          </dd>
        </div>
        <div>
          <dt>Body</dt>
          <dd>
            <code>
              {'{ "events": [ …1–' +
                String(INGEST_CONTRACT.maxEnvelopesPerRequest) +
                ' signed envelopes ] }'}
            </code>
          </dd>
        </div>
        <div>
          <dt>Signature</dt>
          <dd>
            HMAC-SHA256 (hex) of the canonical JSON of the envelope <em>without</em>{' '}
            <code>source.signature</code>, keyed with the secret. Canonical JSON: keys sorted at
            every depth, no whitespace, integers only (decimals travel as strings).
          </dd>
        </div>
        <div>
          <dt>Ordering</dt>
          <dd>
            <code>sequence</code> is per (asset, source) stream: 1, 2, 3… with no gaps; unique{' '}
            <code>eventId</code>; <code>observedAt</code> must not move backwards.
          </dd>
        </div>
      </dl>

      <details className="mv-governed__manual">
        <summary>Example envelope (shape only — contains no secret)</summary>
        <pre className="mv-spec__pre" tabIndex={0} data-testid="ingest-example">
          {exampleText}
        </pre>
        <CopyButton value={exampleText} label="example" />
      </details>

      <details className="mv-governed__manual">
        <summary>Reference signer (Node.js)</summary>
        <pre className="mv-spec__pre" tabIndex={0} data-testid="ingest-snippet">
          {snippet}
        </pre>
        <CopyButton value={snippet} label="signer" />
      </details>

      <details className="mv-governed__manual">
        <summary>What the server answers per envelope</summary>
        <table className="mv-spec__table">
          <thead>
            <tr>
              <th scope="col">outcome</th>
              <th scope="col">meaning</th>
            </tr>
          </thead>
          <tbody>
            {INGEST_OUTCOME_GUIDE.map((row) => (
              <tr key={row.code}>
                <th scope="row" className="mv-num">
                  {row.code}
                </th>
                <td>{row.meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <p className="mv-governed__note">
        <strong>What FIELD means.</strong> The evidence is a <em>credential-authenticated claim</em>{' '}
        by a registered source about the physical world — MOTERVA verifies who signed it, not that
        the sensor is right. It can inform a proposal; it can never approve, reserve or move money.
      </p>
    </section>
  );
}
