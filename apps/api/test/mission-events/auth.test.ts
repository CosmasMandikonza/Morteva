/**
 * Authentication / trust-boundary tests (issue #9): an event is only evidence
 * if its SOURCE is registered, HMAC-authenticated, tenant-correct, provenance-
 * consistent and asset-authorized. Runs against the real ledger so tenant
 * checks exercise real mission rows.
 */
import { describe, expect, it } from 'vitest';
import { fixtureSourceKey, sourceSignature } from '../../src/mission-events/index.js';
import { at, envelope, makeWorld } from './helpers.js';

function rejectionCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const match = /\[([A-Z_]+)\]/.exec(message);
    if (match === null) {
      throw new Error(`expected a coded rejection, got: ${message}`, { cause: error });
    }
    return match[1]!;
  }
  throw new Error('expected the call to reject, but it was accepted');
}

describe('mission-event source authentication', () => {
  it('accepts a properly signed event from a registered source', () => {
    const world = makeWorld();
    const accepted = world.service.ingest(world.orgId, envelope(world, {}));
    expect(accepted.status).toBe('accepted');
    world.ledger.close();
  });

  it('rejects an unregistered keyId (rogue source)', () => {
    const world = makeWorld();
    const rogue = envelope(world, {
      source: { ...world.telemetrySource, sourceId: 'rogue', keyId: 'key-rogue-v1' },
    });
    expect(rejectionCode(() => world.service.ingest(world.orgId, rogue))).toBe(
      'UNAUTHENTICATED_SOURCE',
    );
    world.ledger.close();
  });

  it('rejects a WRONG signature for the registered key', () => {
    const world = makeWorld();
    const forged = envelope(world, { signature: 'f'.repeat(64) });
    expect(rejectionCode(() => world.service.ingest(world.orgId, forged))).toBe(
      'SIGNATURE_INVALID',
    );
    world.ledger.close();
  });

  it('rejects a signature computed with a DIFFERENT source key (key confusion)', () => {
    const world = makeWorld();
    const wrongKey = sourceSignature(
      { ...envelope(world, {}) } as never,
      fixtureSourceKey('other-seed', 'src-telemetry'),
    );
    const confused = envelope(world, { signature: wrongKey });
    expect(rejectionCode(() => world.service.ingest(world.orgId, confused))).toBe(
      'SIGNATURE_INVALID',
    );
    world.ledger.close();
  });

  it('rejects a key registered in ANOTHER organization (cross-org key)', () => {
    const world = makeWorld();
    // Register a source with the same keyId in the foreign org via a fresh registry.
    const foreignSource = {
      ...world.telemetrySource,
      orgId: world.foreignOrgId,
      missionId: world.foreignMissionId,
    };
    const registry = world.registry;
    // keyId is unique per registry; simulate the attack by submitting the
    // foreign-source envelope to the caller's org context.
    const crossOrg = envelope(world, {
      source: foreignSource,
      orgId: world.foreignOrgId,
      missionId: world.foreignMissionId,
    });
    expect(rejectionCode(() => world.service.ingest(world.orgId, crossOrg))).toBe(
      'CROSS_ORG_EVENT',
    );
    expect(registry.all().length).toBe(2);
    world.ledger.close();
  });

  it('rejects an event for a mission that is not in the caller org (tenant isolation)', () => {
    const world = makeWorld();
    const foreign = envelope(world, {
      missionId: world.foreignMissionId,
      source: { ...world.telemetrySource, missionId: world.foreignMissionId },
    });
    expect(rejectionCode(() => world.service.ingest(world.orgId, foreign))).toBe(
      'MISSION_NOT_IN_ORG',
    );
    // And the mirror direction: caller = foreign org, event = our mission.
    const ours = envelope(world, {});
    expect(rejectionCode(() => world.service.ingest(world.foreignOrgId, ours))).toBe(
      'CROSS_ORG_EVENT',
    );
    world.ledger.close();
  });

  it('rejects an unregistered ASSET', () => {
    const world = makeWorld();
    const unknownAsset = envelope(world, { assetId: 'asset-ghost' });
    expect(rejectionCode(() => world.service.ingest(world.orgId, unknownAsset))).toBe(
      'UNKNOWN_ASSET',
    );
    world.ledger.close();
  });

  it('rejects a source speaking for an asset it is not bound to', () => {
    const world = makeWorld();
    // A second asset exists in the mission scope (registered via another
    // source with its own key); the telemetry source is bound only to
    // asset-uav-1 and must not speak for asset-uav-2.
    const secondAssetSource: typeof world.gatewaySource = {
      ...world.gatewaySource,
      sourceId: 'src-gateway-2',
      keyId: 'key-gw2-v1',
      assetIds: [...world.gatewaySource.assetIds, 'asset-uav-2'],
    };
    world.registry.register(secondAssetSource);
    const scopeViolation = envelope(world, {
      source: world.telemetrySource,
      assetId: 'asset-uav-2',
    });
    expect(rejectionCode(() => world.service.ingest(world.orgId, scopeViolation))).toBe(
      'SOURCE_NOT_AUTHORIZED_FOR_ASSET',
    );
    world.ledger.close();
  });

  it('rejects provenance mismatch: SYNTHETIC-registered source claiming FIELD', () => {
    const world = makeWorld();
    const claimField = envelope(world, { provenance: 'FIELD' });
    expect(rejectionCode(() => world.service.ingest(world.orgId, claimField))).toBe(
      'PROVENANCE_MISMATCH',
    );
    world.ledger.close();
  });

  it('AUTHORITY_TERMS_REJECTED: banking vocabulary cannot ride in via ids', () => {
    const world = makeWorld();
    for (const poisoned of [
      { assetId: 'settle-bot' },
      { assetId: 'approve-payment-drone' },
      { eventId: 'mevt_reserve_funds' },
      { assetId: 'transfer-unit' },
    ]) {
      const bad = envelope(world, poisoned);
      expect(rejectionCode(() => world.service.ingest(world.orgId, bad))).toBe(
        'AUTHORITY_TERMS_REJECTED',
      );
    }
    world.ledger.close();
  });

  it('a rejected event leaves NO journal row (rejections are not evidence)', () => {
    const world = makeWorld();
    const before = world.ledger.evidence.count(world.orgId);
    const forged = envelope(world, { signature: '0'.repeat(64) });
    expect(rejectionCode(() => world.service.ingest(world.orgId, forged))).toBe(
      'SIGNATURE_INVALID',
    );
    expect(world.ledger.evidence.count(world.orgId)).toBe(before);
    world.ledger.close();
  });

  it('signature covers post-signing tampering with the observation time', () => {
    const world = makeWorld();
    const original = envelope(world, { observedAt: at(1), ingestedAt: at(1) });
    expect(world.service.ingest(world.orgId, original).status).toBe('accepted');
    // Re-use the SAME signed envelope but flip observedAt AFTER signing: the
    // HMAC no longer covers the actual content → SIGNATURE_INVALID.
    const tampered = {
      ...original,
      sequence: 2,
      observedAt: at(2),
      ingestedAt: at(2),
    };
    expect(rejectionCode(() => world.service.ingest(world.orgId, tampered))).toBe(
      'SIGNATURE_INVALID',
    );
    world.ledger.close();
  });
});
