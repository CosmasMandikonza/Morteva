/**
 * CTO follow-up — cross-source concurrency invariant (PR #39 final safety pass).
 *
 * `validateAndCheck()` enforces physical-state consistency (offline rule,
 * monotonic readings) against the instance's IN-MEMORY state, which can
 * predate another service instance's committed journal write. The serialized
 * `BEGIN IMMEDIATE` admission boundary previously rechecked only stream
 * SEQUENCING inside the transaction — so a gateway's authoritative
 * "asset offline" event and a telemetry event from a DIFFERENT source stream
 * could interleave: telemetry validated while the asset was online, the
 * gateway's offline event committed first, and the telemetry append then
 * succeeded anyway because its own stream sequence was fine.
 *
 * The invariant under test: an event may not be committed after an
 * authoritative offline state unless an authorized recovery has occurred, and
 * monotonic observations are enforced across sources — both re-derived from
 * the journal INSIDE the admission transaction, where concurrent commits are
 * visible. (The tests create the exact stale-memory window two live
 * instances hit: the telemetry instance's memory predates the gateway
 * instance's commit.)
 */
import { describe, expect, it } from 'vitest';
import { MissionEventIngestService, SourceRegistry } from '../../src/mission-events/index.js';
import { at, envelope, makeWorld, type TestWorld } from './helpers.js';

const ONLINE = { kind: 'asset_comms', unit: 'state', value: 'online' };
const OFFLINE = { kind: 'asset_comms', unit: 'state', value: 'offline' };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const match = /\[([A-Z_]+)\]/.exec(error instanceof Error ? error.message : String(error));
    if (match === null) throw error;
    return match[1]!;
  }
  throw new Error('expected rejection');
}

/** A second live service instance over the same ledger (its own memory). */
function newInstance(world: TestWorld): MissionEventIngestService {
  const registry = new SourceRegistry();
  registry.registerAll([world.telemetrySource, world.gatewaySource]);
  return new MissionEventIngestService(world.ledger, world.clock, registry);
}

describe('CTO follow-up — cross-source physical-state race inside the admission boundary', () => {
  it('telemetry validated before the gateway offline COMMIT cannot be admitted after it', () => {
    const world = makeWorld();
    const telemetry = world.service;
    // The telemetry instance validates+commits its baseline while online.
    telemetry.ingest(
      world.orgId,
      envelope(world, {
        sequence: 1,
        observedAt: at(1),
        ingestedAt: at(1),
        observations: [ONLINE],
      }),
    );
    // A DIFFERENT instance (gateway source) commits the authoritative offline
    // event; the telemetry instance's memory still says online.
    const gateway = newInstance(world);
    expect(
      gateway.ingest(
        world.orgId,
        envelope(world, {
          source: world.gatewaySource,
          sequence: 1,
          observedAt: at(2),
          ingestedAt: at(2),
          observations: [OFFLINE],
        }),
      ).status,
    ).toBe('accepted');
    // Telemetry seq 2 passes every in-memory check (its memory predates the
    // offline commit) and its own stream sequence is correct — but it must
    // NOT be committable after the authoritative offline state.
    expect(
      codeOf(() =>
        telemetry.ingest(
          world.orgId,
          envelope(world, {
            sequence: 2,
            observedAt: at(3),
            ingestedAt: at(3),
            observations: [{ kind: 'inspection_progress', unit: 'percent', value: 20 }],
          }),
        ),
      ),
    ).toBe('ASSET_OFFLINE');
    // An exact replay of the same stale race still rejects (fail-closed, not
    // a one-shot).
    expect(
      codeOf(() =>
        telemetry.ingest(
          world.orgId,
          envelope(world, {
            sequence: 2,
            observedAt: at(4),
            ingestedAt: at(4),
            observations: [{ kind: 'inspection_progress', unit: 'percent', value: 21 }],
          }),
        ),
      ),
    ).toBe('ASSET_OFFLINE');
    // Only the authorized recovery (trustedForRecovery gateway carrying
    // asset_comms=online) reopens the asset…
    expect(
      gateway.ingest(
        world.orgId,
        envelope(world, {
          source: world.gatewaySource,
          sequence: 2,
          observedAt: at(5),
          ingestedAt: at(5),
          observations: [ONLINE],
        }),
      ).status,
    ).toBe('accepted');
    // …after which the SAME telemetry sequence is admissible.
    expect(
      telemetry.ingest(
        world.orgId,
        envelope(world, {
          sequence: 2,
          observedAt: at(6),
          ingestedAt: at(6),
          observations: [{ kind: 'inspection_progress', unit: 'percent', value: 25 }],
        }),
      ).status,
    ).toBe('accepted');
    world.ledger.close();
  });

  it('monotonic observations are enforced ACROSS SOURCES under the same race', () => {
    const world = makeWorld();
    const telemetry = world.service;
    telemetry.ingest(
      world.orgId,
      envelope(world, {
        sequence: 1,
        observedAt: at(1),
        ingestedAt: at(1),
        observations: [{ kind: 'inspection_progress', unit: 'percent', value: 53 }],
      }),
    );
    // The gateway instance (second source, same asset) commits progress 66.
    const gateway = newInstance(world);
    expect(
      gateway.ingest(
        world.orgId,
        envelope(world, {
          source: world.gatewaySource,
          sequence: 1,
          observedAt: at(2),
          ingestedAt: at(2),
          observations: [{ kind: 'inspection_progress', unit: 'percent', value: 66 }],
        }),
      ).status,
    ).toBe('accepted');
    // Telemetry's stale memory (prior 53) passes 55 — but the journal now
    // says 66, so the admission boundary must reject the decrease.
    expect(
      codeOf(() =>
        telemetry.ingest(
          world.orgId,
          envelope(world, {
            sequence: 2,
            observedAt: at(3),
            ingestedAt: at(3),
            observations: [{ kind: 'inspection_progress', unit: 'percent', value: 55 }],
          }),
        ),
      ),
    ).toBe('MONOTONIC_VIOLATION');
    // Equal-to-journaled is allowed (non-decreasing), and per-source
    // sequencing is untouched: telemetry seq 2 is still its next.
    expect(
      telemetry.ingest(
        world.orgId,
        envelope(world, {
          sequence: 2,
          observedAt: at(4),
          ingestedAt: at(4),
          observations: [{ kind: 'inspection_progress', unit: 'percent', value: 66 }],
        }),
      ).status,
    ).toBe('accepted');
    expect(
      gateway.ingest(
        world.orgId,
        envelope(world, {
          source: world.gatewaySource,
          sequence: 2,
          observedAt: at(5),
          ingestedAt: at(5),
          observations: [{ kind: 'inspection_progress', unit: 'percent', value: 67 }],
        }),
      ).status,
    ).toBe('accepted');
    world.ledger.close();
  });
});
