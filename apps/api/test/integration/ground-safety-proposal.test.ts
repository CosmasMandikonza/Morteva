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
    expect(
      proposedGroundSafety({ comms: 'offline', aisle: 'obstructed', charger: 'fault' }),
    ).toMatchObject({
      state: 'blocked',
      reason: 'comms-offline',
    });
  });

  it('precedence 2: obstructed aisle blocks even when comms are healthy', () => {
    expect(proposedGroundSafety({ comms: 'online', aisle: 'obstructed', charger: 'free' })).toEqual(
      {
        kind: 'asset-safety',
        domain: 'ground',
        state: 'blocked',
        reason: 'aisle-obstructed',
      },
    );
    expect(
      proposedGroundSafety({ comms: 'online', aisle: 'obstructed', charger: 'fault' }),
    ).toMatchObject({
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
    expect(
      proposedGroundSafety({ comms: undefined, aisle: 'clear', charger: 'free' }),
    ).toMatchObject({
      state: 'unknown',
      reason: 'insufficient-evidence',
    });
    expect(
      proposedGroundSafety({ comms: 'online', aisle: undefined, charger: 'free' }),
    ).toMatchObject({
      state: 'unknown',
    });
    expect(
      proposedGroundSafety({ comms: 'online', aisle: 'clear', charger: undefined }),
    ).toMatchObject({
      state: 'unknown',
    });
    expect(
      proposedGroundSafety({ comms: 'degraded', aisle: 'clear', charger: 'free' }),
    ).toMatchObject({
      state: 'unknown',
      reason: 'insufficient-evidence',
    });
  });

  it('all healthy readings clear the robot — the ONLY clear path, and only in the proposal', () => {
    expect(
      proposedGroundSafety({ comms: 'online', aisle: 'clear', charger: 'docked_charging' }),
    ).toEqual({
      kind: 'asset-safety',
      domain: 'ground',
      state: 'clear',
      reason: 'nominal',
    });
    expect(
      proposedGroundSafety({ comms: 'online', aisle: 'clear', charger: 'free' }),
    ).toMatchObject({
      state: 'clear',
    });
  });

  it('the ACCEPTED ground reasons now pass the reviewer — with domain/reason coherence enforced', () => {
    // C2: planner extension 1 is ACCEPTED — the proposed ground constraint
    // (with its domain discriminator) is now a legitimate MissionConstraint.
    // Cross-domain mislabeling is still refused: a ground verdict carrying
    // an aerial wind reason (or an aerial verdict carrying a ground reason)
    // fails validation — domains can never borrow each other's semantics.
    const accepted = proposedGroundSafety({
      comms: 'online',
      aisle: 'obstructed',
      charger: 'free',
    });
    const base: MissionEvidenceInput = {
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
      validity: { notAfter: '2026-11-06T09:15:02.000Z' },
      constraint: accepted,
    };
    const review = reviewEvidence([base], new Date('2026-11-06T09:00:02.000Z'), {
      orgId: 'org-1',
      missionId: 'msn-1',
    });
    expect(review.rejected).toHaveLength(0);
    expect(review.accepted).toHaveLength(1);
    expect(review.accepted[0]?.input.constraint).toMatchObject({
      domain: 'ground',
      state: 'blocked',
      reason: 'aisle-obstructed',
    });
    // Ground verdict carrying an AERIAL reason → refused.
    const aerialReasonOnGround = {
      ...base,
      event: { ...base.event, id: 'evt-x1' },
      constraint: {
        kind: 'asset-safety',
        domain: 'ground',
        state: 'blocked',
        reason: 'wind-limit',
      } as MissionEvidenceInput['constraint'],
    };
    const r2 = reviewEvidence([aerialReasonOnGround], new Date('2026-11-06T09:00:02.000Z'), {
      orgId: 'org-1',
      missionId: 'msn-1',
    });
    expect(r2.accepted).toHaveLength(0);
    expect(r2.rejected[0]?.reason).toContain('ground verdicts never carry aerial');
    // Aerial verdict carrying a GROUND reason → refused.
    const groundReasonOnAerial = {
      ...base,
      event: { ...base.event, id: 'evt-x2' },
      constraint: {
        kind: 'asset-safety',
        domain: 'aerial',
        state: 'blocked',
        reason: 'aisle-obstructed',
      } as MissionEvidenceInput['constraint'],
    };
    const r3 = reviewEvidence([groundReasonOnAerial], new Date('2026-11-06T09:00:02.000Z'), {
      orgId: 'org-1',
      missionId: 'msn-1',
    });
    expect(r3.accepted).toHaveLength(0);
    expect(r3.rejected[0]?.reason).toContain('aerial verdicts never carry ground');
  });
});
