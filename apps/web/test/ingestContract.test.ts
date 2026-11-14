import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HEADLESS_SIGNING_CORE, headlessSnippet, INGEST_CONTRACT } from '../src/lib/ingestContract';
import { sourceSignature } from '../../api/src/mission-events/src/digest';
import type { NormalizedEvent } from '../../api/src/mission-events/src/schema';

/**
 * The headless-sender guide shown to customers is EXECUTABLE documentation:
 * the reference signer printed in the UI must produce exactly the signature
 * the API verifier (`sourceSignature`) expects. If the verifier's canonical
 * form changes, this test fails before a customer copies a broken snippet.
 */
const TEST_KEY = ['test', 'only', 'hmac', 'key', 'material'].join('-');

function build(): NormalizedEvent {
  return {
    contractVersion: 1,
    eventId: 'evt_unseen_0001',
    sequence: 1,
    orgId: 'org_unseen',
    missionId: 'msn_unseen',
    assetId: 'survey-quad-q3',
    observedAt: '2026-11-11T21:00:00.000Z',
    ingestedAt: '2026-11-11T21:00:01.000Z',
    source: {
      sourceId: 'bench7-flight-link',
      sourceType: 'asset_telemetry',
      keyId: 'key_bench7_001',
      provenance: 'FIELD',
    },
    observations: [
      { kind: 'wind_speed', unit: 'kt', value: '29.3' },
      { kind: 'weather_hold', unit: 'state', value: 'active' },
    ],
  };
}

describe('headless sender guide (executable documentation)', () => {
  const signEvent = new Function('createHmac', `${HEADLESS_SIGNING_CORE}\nreturn signEvent;`)(
    createHmac,
  ) as (event: unknown, secret: string) => string;

  it('the printed reference signer equals the API verifier signature', () => {
    const event = build();
    const wire = { ...event, source: { ...event.source, signature: 'ignored-placeholder' } };
    expect(signEvent(wire, TEST_KEY)).toBe(sourceSignature(event, TEST_KEY));
  });

  it('an altered byte changes the signature (tamper evidence)', () => {
    const event = build();
    const tampered = { ...event, observations: [{ kind: 'wind_speed', unit: 'kt', value: '5.0' }] };
    expect(signEvent(tampered, TEST_KEY)).not.toBe(signEvent(event, TEST_KEY));
  });

  it('the printed snippet never embeds a secret', () => {
    const text = headlessSnippet(INGEST_CONTRACT.route('msn_x'));
    expect(text).toContain('process.env.MOTERVA_SOURCE_SECRET');
    expect(text).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });

  it('declares the current ingest authentication honestly', () => {
    expect(INGEST_CONTRACT.route('msn_x')).toBe('/api/machine/missions/msn_x/events');
    // machine ingress: NO cookie, NO csrf — the printed snippet must say so
    expect(headlessSnippet(INGEST_CONTRACT.route('msn_x'))).toContain('NO cookie, NO CSRF');
    expect(['operator-session', 'source-credential']).toContain(INGEST_CONTRACT.authentication);
  });
});
