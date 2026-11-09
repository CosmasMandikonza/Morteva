import { describe, expect, it } from 'vitest';
import { reviewEvidence } from '@moterva/planner';
import { proposedGroundSafety } from '../../src/integration/ground-safety-proposal.js';
import type { MissionEvidenceInput } from '@moterva/planner';

/**
 * Ground-safety proposal matrix (MTV-07; audit gap G5). Proves the proposed
 * mapping (planner-adapter-request extension 1) over every ground fact
 * combination AND proves the current planner contract refuses the new
 * reasons — the fail-closed evidence that the type change must come from
 * Agent A and that nothing can ride in through the existing whitelist.
 */

describe('proposed ground safety mapping (pure function, full matrix)', () => {
  it('precedence 1: comms offline blocks regardless of aisle/charger state', () => {
    expect(proposedGroundSafety({ comms: 'offline', aisle: 'clear', charger: 'free' })).toEqual({
      kind: 'asset-safety',
      domain: 'ground',
      state: 'blocked',
      reason: 'comms-offline',
    });
    expect(proposedGroundSafety({ comms: 'offline', aisle: 'obstructed', charger: 'fault' })).toMatchObject({
      state: 'blocked',
      reason: 'comms-offline',
    });
  });

  it('precedence 2: obstructed aisle blocks even when comms are healthy', () => {
    expect(proposedGroundSafety({ comms: 'online', aisle: 'obstructed', charger: 'free' })).toEqual({
      kind: 'asset-safety',
      domain: 'ground',
      state: 'blocked',
      reason: 'aisle-obstructed',
    });
    expect(proposedGroundSafety({ comms: 'online', aisle: 'obstructed', charger: 'fault' })).toMatchObject({
      reason: 'aisle-obstructed',
    });
  });

  it('precedence 3: charger fault blocks when comms ok and aisle clear', () => {
    expect(proposedGroundSafety({ comms: 'online', aisle: 'clear', charger: 'fault' })).toEqual({
      kind: 'asset-safety',
      domain: 'ground',
      state: 'blocked',
      reason: 'charger-fault',
    });
  });

  it('precedence 4: missing readings and DEGRADED comms are unknown, never clear', () => {
    expect(proposedGroundSafety({ comms: undefined, aisle: 'clear', charger: 'free' })).toMatchObject({
      state: 'unknown',
      reason: 'insufficient-evidence',
    });
    expect(proposedGroundSafety({ comms: 'online', aisle: undefined, charger: 'free' })).toMatchObject({
      state: 'unknown',
    });
    expect(proposedGroundSafety({ comms: 'online', aisle: 'clear', charger: undefined })).toMatchObject({
      state: 'unknown',
    });
    expect(proposedGroundSafety({ comms: 'degraded', aisle: 'clear', charger: 'free' })).toMatchObject({
      state: 'unknown',
      reason: 'insufficient-evidence',
    });
  });

  it('all healthy readings clear the robot — the ONLY clear path, and only in the proposal', () => {
    expect(proposedGroundSafety({ comms: 'online', aisle: 'clear', charger: 'docked_charging' })).toEqual({
      kind: 'asset-safety',
      domain: 'ground',
      state: 'clear',
      reason: 'nominal',
    });
    expect(proposedGroundSafety({ comms: 'online', aisle: 'clear', charger: 'free' })).toMatchObject({
      state: 'clear',
    });
  });

  it('TODAY’s planner whitelist REFUSES the proposed ground reasons (fail-closed; why Agent A must change the type)', () => {
    // Build an evidence input carrying the PROPOSED constraint and feed the
    // existing reviewer: the new reason must be rejected, not silently
    // accepted — proving no ground rule can ride in without Agent A's change.
    const proposed = proposedGroundSafety({ comms: 'online', aisle: 'obstructed', charger: 'free' });
    const input: MissionEvidenceInput = {
      version: 1,
      tenant: { orgId: 'org-1', missionId: 'msn-1' },
      asset: { id: 'robot-1', kind: 'physical-asset' },
      event: {
        id: 'evt-proposed-1',
        sequence: 1,
        observedAt: '2026-11-06T09:00:00.000Z',
        ingestedAt: '2026-11-06T09:00:01.000Z',
      },
      source: {
        kind: 'vehicle-telemetry',
        digest: 'sha256-proposal-proof',
        physicalSourceId: 'robot-telemetry',
        physicalSequence: 1,
        provenance: 'SYNTHETIC',
      },
      constraint: proposed,
    };
    const review = reviewEvidence([input], new Date('2026-11-06T09:00:02.000Z'), {
      orgId: 'org-1',
      missionId: 'msn-1',
    });
    expect(review.accepted).toHaveLength(0);
    expect(review.rejected).toHaveLength(1);
  });
});
