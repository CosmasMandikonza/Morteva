/**
 * Domain catalogs as REGISTRATIONS of the general mission-spec contract
 * (C1) — harbor first (the accepted flagship experience, values preserved
 * bit-for-bit), warehouse second (C2, the proof that no harbor value remains
 * in shared integration logic).
 *
 * These are the ONLY places where industry values live. Shared integration
 * code (decision snapshots, physical view, authority refresh) reads a
 * mission's REGISTERED spec; it never mentions an asset id, beneficiary,
 * purpose, wind limit or offer again. Adding a third industry = adding a
 * registration factory + its fixtures — no money-engine cloning (see
 * docs/industry-onboarding.md).
 *
 * TRUTH: every number is an explicit SYNTHETIC demo assumption
 * (SIMULATED_OPERATION). Nothing here is banking authority.
 */
import type { MissionSpecification, SpecOffer } from './mission-spec.js';
import { createHash } from 'node:crypto';

export type WarehouseStep =
  'baseline' | 'aisle-obstruction' | 'charger-fault' | 'comms-loss' | 'comms-restored';

/**
 * Deterministic warehouse demo event identity — shared by the step routes
 * AND the snapshot recorder (so durable decision snapshots reference the
 * same journaled evidence ids). The SOURCE is part of the identity: one
 * asset can legitimately receive baseline readings from TWO sources (the
 * WMS and the facility gateway), and those are distinct events.
 */
export function warehouseEventId(
  orgId: string,
  missionId: string,
  step: WarehouseStep,
  assetId: string,
  sourceId: string,
): string {
  return (
    'evt_wh_' +
    step.replaceAll('-', '_') +
    '_' +
    createHash('sha256')
      .update(orgId + ':' + missionId + ':' + step + ':' + assetId + ':' + sourceId)
      .digest('hex')
      .slice(0, 20)
  );
}

/**
 * The baseline event ids the warehouse step route actually journals: every
 * registered asset × the two facility-observing sources (WMS + gateway).
 */
export function warehouseBaselineEventIds(
  orgId: string,
  missionId: string,
  spec: MissionSpecification,
): string[] {
  const baselineSourceIds = ['warehouse-wms', 'facility-gateway'];
  const ids: string[] = [];
  for (const asset of spec.assets) {
    for (const sourceId of baselineSourceIds) {
      ids.push(warehouseEventId(orgId, missionId, 'baseline', asset.assetId, sourceId));
    }
  }
  return ids;
}

/**
 * HARBOR — offshore hull inspection (flagship). The supplier economics
 * mirror the accepted DECISION_CATALOG exactly; a drift test asserts the
 * derived catalog still equals the historical constants.
 */
export function harborMissionSpec(orgId: string, missionId: string): MissionSpecification {
  const incumbent: SpecOffer = {
    id: 'uav-inspection',
    kind: 'inspection-service',
    beneficiary: 'harbor-diagnostics',
    purpose: 'harbor inspection',
    currency: 'USD',
    baseCostMinor: 1_200_000,
    feeMinor: 0,
    leadTimeMinutes: 60,
    durationMinutes: 180,
    probabilityOfSuccess: 0.9,
    availability: 'confirmed',
    requiresAssetId: 'uav-seeker-1',
  };
  return {
    specVersion: 1,
    specId: 'harbor-inspection-v1',
    industry: 'maritime-uav',
    identity: {
      orgId,
      missionId,
      title: 'Offshore hull inspection',
      objective:
        'Complete the scheduled hull inspection of the berthed vessel within the mission deadline using the modeled-authorized inspection UAV or an equivalent qualified service.',
    },
    assets: [{ assetId: 'uav-seeker-1', domainKind: 'aerial', label: 'Inspection UAV' }],
    sources: [
      {
        sourceId: 'ops-console',
        sourceType: 'mission_control',
        assetIds: ['uav-seeker-1'],
        trustedForRecovery: false,
        provenance: 'SYNTHETIC',
      },
    ],
    safetyPolicy: {
      version: 1,
      clearanceAuthority: 'deterministic-domain-policy',
      uavWindLimitKt: 22,
    },
    economics: {
      currency: 'USD',
      missionValueMinor: 5_000_000,
      failureCostMinor: 1_500_000,
      protectedReserveMinor: 50_000,
      deadlineOffsetMinutes: 720, // 12 h — the historical inline assumption
    },
    offers: {
      incumbent,
      alternatives: [
        {
          id: 'vessel-inspection',
          kind: 'inspection-service',
          beneficiary: 'harbor-marine',
          purpose: 'harbor inspection',
          currency: 'USD',
          baseCostMinor: 1_800_000,
          feeMinor: 50_000,
          leadTimeMinutes: 45,
          durationMinutes: 180,
          probabilityOfSuccess: 0.85,
          availability: 'confirmed',
        },
      ],
    },
    financialMandateShape: {
      currency: 'USD',
      allowedBeneficiaries: ['harbor-diagnostics', 'harbor-marine'],
      allowedPurposes: ['harbor inspection'],
    },
    truthLabel: 'SIMULATED_OPERATION — POLICY-ONLY',
  };
}

/**
 * WAREHOUSE — autonomous mobile robot inventory cycle (C2). The AMR
 * encounters a blocked aisle / charger fault during a time-sensitive
 * inventory mission. Genuinely distinct financial alternatives: safely
 * reroute after authoritative confirmation, a backup robot, verified
 * diagnostic information, a qualified human operator, waiting, escalation —
 * ALL through the same planner candidate kinds as harbor. Ground safety
 * policy declares its own interrupting conditions and carries NO wind limit.
 */
export function warehouseMissionSpec(orgId: string, missionId: string): MissionSpecification {
  return {
    specVersion: 1,
    specId: 'warehouse-inventory-v1',
    industry: 'warehouse-amr',
    identity: {
      orgId,
      missionId,
      title: 'Warehouse AMR inventory cycle',
      objective:
        'Complete the time-sensitive inventory cycle of the pick aisle before the shift handover, using the registered AMR or one of the configured alternatives, under the ground-domain safety policy.',
    },
    assets: [
      { assetId: 'amr-runner-1', domainKind: 'ground', label: 'Primary inventory AMR' },
      { assetId: 'amr-backup-2', domainKind: 'ground', label: 'Backup inventory AMR' },
    ],
    sources: [
      {
        // The WMS reports aisle access (facility truth, not the robot's own
        // claim about its path) and stock discrepancy.
        sourceId: 'warehouse-wms',
        sourceType: 'warehouse_wms',
        assetIds: ['amr-runner-1', 'amr-backup-2'],
        trustedForRecovery: false,
        provenance: 'SYNTHETIC',
      },
      {
        sourceId: 'amr-runner-1-telemetry',
        sourceType: 'asset_telemetry',
        assetIds: ['amr-runner-1'],
        trustedForRecovery: false,
        provenance: 'SYNTHETIC',
      },
      {
        // The facility gateway is the INDEPENDENT observer authorized to
        // restore comms after an outage — an offline robot cannot speak.
        sourceId: 'facility-gateway',
        sourceType: 'vessel_gateway',
        assetIds: ['amr-runner-1', 'amr-backup-2'],
        trustedForRecovery: true,
        provenance: 'SYNTHETIC',
      },
    ],
    safetyPolicy: {
      version: 1,
      clearanceAuthority: 'deterministic-domain-policy',
      // NO uavWindLimitKt — structurally forbidden without an aerial asset.
      groundInterrupts: ['comms-offline', 'aisle-obstructed', 'charger-fault'],
    },
    economics: {
      currency: 'USD',
      missionValueMinor: 2_000_000,
      failureCostMinor: 600_000,
      protectedReserveMinor: 40_000,
      deadlineOffsetMinutes: 240, // shift handover
    },
    offers: {
      incumbent: {
        id: 'amr-cycle-runner-1',
        kind: 'inspection-service',
        beneficiary: 'warehouse-robotics',
        purpose: 'inventory cycle',
        currency: 'USD',
        baseCostMinor: 300_000,
        feeMinor: 0,
        leadTimeMinutes: 15,
        durationMinutes: 90,
        probabilityOfSuccess: 0.92,
        availability: 'confirmed',
        requiresAssetId: 'amr-runner-1',
      },
      alternatives: [
        {
          // Backup robot: gated on the BACKUP asset's own clearance — the
          // primary AMR's blocked aisle cannot leak into this verdict.
          id: 'amr-cycle-backup-2',
          kind: 'inspection-service',
          beneficiary: 'warehouse-robotics',
          purpose: 'inventory cycle',
          currency: 'USD',
          baseCostMinor: 420_000,
          feeMinor: 30_000,
          leadTimeMinutes: 30,
          durationMinutes: 90,
          probabilityOfSuccess: 0.88,
          availability: 'confirmed',
          requiresAssetId: 'amr-backup-2',
        },
        {
          // Qualified human operator: no asset clearance requirement (a
          // person is not gated by an AMR comms/charger verdict).
          id: 'human-inventory-operator',
          kind: 'inspection-service',
          beneficiary: 'flex-staffing-co',
          purpose: 'inventory cycle',
          currency: 'USD',
          baseCostMinor: 750_000,
          feeMinor: 0,
          leadTimeMinutes: 60,
          durationMinutes: 120,
          probabilityOfSuccess: 0.8,
          availability: 'confirmed',
        },
      ],
      diagnostics: {
        // Verified diagnostic information: an authoritative aisle/charger
        // survey before committing to an expensive alternative.
        id: 'amr-fault-diagnostics',
        kind: 'diagnostic-service',
        beneficiary: 'warehouse-diagnostics',
        purpose: 'inventory cycle',
        currency: 'USD',
        baseCostMinor: 120_000,
        feeMinor: 0,
        leadTimeMinutes: 20,
        durationMinutes: 30,
        probabilityOfSuccess: 0.9,
        availability: 'confirmed',
      },
    },
    financialMandateShape: {
      currency: 'USD',
      allowedBeneficiaries: ['warehouse-robotics', 'flex-staffing-co', 'warehouse-diagnostics'],
      allowedPurposes: ['inventory cycle'],
    },
    truthLabel: 'SIMULATED_OPERATION — POLICY-ONLY',
  };
}
