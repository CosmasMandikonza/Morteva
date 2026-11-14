import { describe, expect, it } from 'vitest';
import { at, envelope, makeWorld, type TestWorld } from './helpers.js';

/**
 * Credential revocation (MTV-07, issue #9; audit gap G3, edge case 14).
 * A revoked keyId stops resolving immediately: every further event signed
 * with it is refused exactly like an unknown key, the key can never be
 * silently re-registered, and rotation means a NEW keyId. An event in
 * flight during rotation is not grandfathered.
 */
function signedEvent(world: TestWorld, sequence: number, minute: number) {
  return envelope(world, {
    sequence,
    observedAt: at(minute),
    ingestedAt: at(minute, 2),
    observations: [
      { kind: 'battery_soc', unit: 'percent', value: 80 },
      { kind: 'asset_comms', unit: 'state', value: 'online' },
    ],
  });
}

describe('source credential revocation', () => {
  it('a revoked keyId is refused exactly like an unknown key; nothing is journaled', () => {
    const world = makeWorld();
    const first = signedEvent(world, 1, 1);
    expect(world.service.ingest(world.orgId, first).status).toBe('accepted');

    expect(world.registry.revoke(world.telemetrySource.keyId)).toBe(true);
    expect(world.registry.isRevoked(world.telemetrySource.keyId)).toBe(true);

    const after = signedEvent(world, 2, 3);
    expect(() => world.service.ingest(world.orgId, after)).toThrow(
      /UNREGISTERED_SOURCE|not registered/i,
    );
    // No journal row for the refused event:
    const rows = world.ledger.db
      .prepare('SELECT COUNT(*) AS c FROM evidence_events WHERE type = ?')
      .get('mission.event.ingested') as { c: number };
    expect(rows.c).toBe(1); // only the pre-revocation event
  });

  it('a revoked keyId can never be silently re-registered (rotation means a NEW keyId)', () => {
    const world = makeWorld();
    world.registry.revoke(world.telemetrySource.keyId);
    expect(() => world.registry.register(world.telemetrySource)).toThrow(
      /revoked and cannot be re-registered/,
    );
    // Rotation with a NEW keyId works and authenticates:
    const rotated = { ...world.telemetrySource, keyId: 'key-tel-v2' };
    world.registry.register(rotated);
    const viaRotated = envelope(world, {
      source: rotated,
      sequence: 1,
      observedAt: at(1),
      ingestedAt: at(1, 2),
      observations: [{ kind: 'battery_soc', unit: 'percent', value: 80 }],
    });
    expect(world.service.ingest(world.orgId, viaRotated).status).toBe('accepted');
  });

  it('an event in flight during rotation is not grandfathered (auth happens at ingest time)', () => {
    const world = makeWorld();
    // Pre-sign an event with the OLD key, revoke BEFORE ingestion:
    const preSigned = signedEvent(world, 1, 1);
    world.registry.revoke(world.telemetrySource.keyId);
    expect(() => world.service.ingest(world.orgId, preSigned)).toThrow(
      /UNREGISTERED_SOURCE|not registered/i,
    );
  });

  it('revoking an unknown keyId is a no-op returning false', () => {
    const world = makeWorld();
    expect(world.registry.revoke('never-registered-key')).toBe(false);
  });
});
