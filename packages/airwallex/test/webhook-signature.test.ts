/**
 * OFFLINE TESTS — Airwallex webhook signature verification (issue #5; D4).
 * Covers the adversarial cases the financial-security docs require: valid
 * signature, tampered body, wrong secret, stale timestamp (replay window),
 * future-dated timestamp, malformed inputs — and the raw-bytes law: a
 * re-serialized body with different key order MUST fail.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from '../src/webhook-signature.js';
import { AirwallexDispatcher, AirwallexWebhookSignatureError } from '../src/dispatcher.js';
import { FixtureTransport, ok } from '../src/fixture-transport.js';
import { loadAirwallexConfig } from '../src/config.js';
import type { ProviderReceiptStore } from '@moterva/providers';

const WEBHOOK_HMAC_FIXTURE = 'webhook-signing-secret-fixture';
const NOW = 1_800_000_000; // fixed "now" (unix seconds)
const BODY = '{"id":"evt-1","name":"transfer.updated","data":{"object":{"status":"PAID"}}}';

function sign(body: string, secret = WEBHOOK_HMAC_FIXTURE, encoding: 'hex' | 'base64' = 'hex'): string {
  const digest = createHmac('sha256', secret).update(body);
  return encoding === 'hex' ? digest.digest('hex') : digest.digest('base64');
}

describe('airwallex webhook signature verification (raw-bytes HMAC-SHA256)', () => {
  it('accepts a valid current signature over the exact raw bytes (hex and base64 encodings)', () => {
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signature: sign(BODY),
        timestamp: NOW,
        secret: WEBHOOK_HMAC_FIXTURE,
        nowSeconds: NOW,
      }),
    ).toBe('valid');
    expect(
      verifyWebhookSignature({
        rawBody: Buffer.from(BODY, 'utf8'),
        signature: sign(BODY),
        timestamp: String(NOW),
        secret: WEBHOOK_HMAC_FIXTURE,
        nowSeconds: NOW,
      }),
    ).toBe('valid');
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signature: sign(BODY, WEBHOOK_HMAC_FIXTURE, 'base64'),
        timestamp: NOW,
        secret: WEBHOOK_HMAC_FIXTURE,
        nowSeconds: NOW,
      }),
    ).toBe('valid');
  });

  it('rejects a signature computed over a re-serialized body with different key order', () => {
    const reordered =
      '{"name":"transfer.updated","id":"evt-1","data":{"object":{"status":"PAID"}}}';
    expect(
      verifyWebhookSignature({
        rawBody: reordered,
        signature: sign(BODY), // signed the original order
        timestamp: NOW,
        secret: WEBHOOK_HMAC_FIXTURE,
        nowSeconds: NOW,
      }),
    ).toBe('signature-mismatch');
  });

  it('rejects a tampered body and a wrong secret (timing-safe compare, no exception channel)', () => {
    expect(
      verifyWebhookSignature({
        rawBody: BODY + ' ',
        signature: sign(BODY),
        timestamp: NOW,
        secret: WEBHOOK_HMAC_FIXTURE,
        nowSeconds: NOW,
      }),
    ).toBe('signature-mismatch');
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signature: sign(BODY, 'attacker-secret'),
        timestamp: NOW,
        secret: WEBHOOK_HMAC_FIXTURE,
        nowSeconds: NOW,
      }),
    ).toBe('signature-mismatch');
  });

  it('rejects stale timestamps beyond the replay window and future-dated timestamps', () => {
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signature: sign(BODY),
        timestamp: NOW - 301,
        secret: WEBHOOK_HMAC_FIXTURE,
        nowSeconds: NOW,
      }),
    ).toBe('stale-timestamp');
    // At the boundary itself it is still valid:
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signature: sign(BODY),
        timestamp: NOW - 300,
        secret: WEBHOOK_HMAC_FIXTURE,
        nowSeconds: NOW,
      }),
    ).toBe('valid');
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signature: sign(BODY),
        timestamp: NOW + 3600,
        secret: WEBHOOK_HMAC_FIXTURE,
        nowSeconds: NOW,
      }),
    ).toBe('future-timestamp');
  });

  it('fails closed on malformed inputs (missing signature/secret/timestamp/body)', () => {
    for (const input of [
      { rawBody: BODY, signature: undefined, timestamp: NOW, secret: WEBHOOK_HMAC_FIXTURE, nowSeconds: NOW },
      { rawBody: BODY, signature: '', timestamp: NOW, secret: WEBHOOK_HMAC_FIXTURE, nowSeconds: NOW },
      { rawBody: BODY, signature: sign(BODY), timestamp: 'abc', secret: WEBHOOK_HMAC_FIXTURE, nowSeconds: NOW },
      { rawBody: BODY, signature: sign(BODY), timestamp: NOW, secret: '', nowSeconds: NOW },
    ]) {
      expect(verifyWebhookSignature(input)).toBe('malformed-input');
    }
  });

  it('enforces verification at the ingestion seam: a bad signature never reaches the sink or a reconciliation', async () => {
    const receipts: Array<{ kind: string; providerStatus: string | null }> = [];
    const store: ProviderReceiptStore = {
      append(receipt) {
        receipts.push({ kind: receipt.kind, providerStatus: receipt.providerStatus });
      },
      listByRequestId: () => [],
    };
    const transport = new FixtureTransport({
      login: [
        ok({ token: 'fixture-token', expires_at: new Date(Date.now() + 900_000).toISOString() }),
      ],
      listTransfers: [ok({ items: [], has_more: false })],
    });
    const clock = {
      now: () => new Date(NOW * 1000),
      iso: () => new Date(NOW * 1000).toISOString(),
    };
    // Secured dispatcher: the deps-level webhook secret turns verification on.
    const secured = new AirwallexDispatcher({
      config: loadAirwallexConfig(),
      transport,
      store,
      clock,
      beneficiaryIdForOrg: () => 'beneficiary-fixture',
      environment: 'offline-fixture',
      webhookSecret: WEBHOOK_HMAC_FIXTURE,
    });
    await expect(
      secured.ingestTransferWebhook({
        orgId: 'org_1',
        eventId: 'evt-bad',
        name: 'transfer.updated',
        requestId: 'req-1',
        payload: { id: 'evt-bad' },
        rawBody: BODY,
        signature: sign('{"tampered":true}'),
        timestamp: NOW,
      }),
    ).rejects.toBeInstanceOf(AirwallexWebhookSignatureError);
    expect(receipts.some((r) => (r.providerStatus ?? '').startsWith('WEBHOOK_SIGNATURE_'))).toBe(
      true,
    );
    // A valid signature flows through to the normal reconcile path.
    await expect(
      secured.ingestTransferWebhook({
        orgId: 'org_1',
        eventId: 'evt-good',
        name: 'transfer.updated',
        requestId: 'req-1',
        payload: { id: 'evt-good' },
        rawBody: BODY,
        signature: sign(BODY),
        timestamp: NOW,
      }),
    ).resolves.toMatchObject({ deduped: false, reconciled: true });
  });
});
