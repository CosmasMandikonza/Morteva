/**
 * GROUND-DOMAIN ASSET SAFETY — now ACCEPTED and WIRED (MTV-07, issue #9;
 * audit gap G5; completed in the general-mission work, Nov 10 2026). This
 * module's proposed constraint shape (extension 1 of
 * `contract/planner-adapter-request.v1.md`) is now part of the planner's
 * `MissionConstraint`: the `domain` discriminator and the
 * `aisle-obstructed` / `charger-fault` reasons pass `reviewEvidence`, and
 * the SAME precedence lives in the live bridge (`physical-to-planner.ts`),
 * the physical-view engine (`physical-view.ts::constraintFor`) and the
 * viewer (`scene-state.ts::constraintFromPrefix`) — matched-verdict law.
 *
 * STILL NOT A SECOND PERMISSION ENGINE: the module computes a safety STATE
 * only. It grants no spending, approval, reservation or provider authority;
 * the planner's ASSET_SAFETY gate remains the sole arbiter of whether
 * asset-dependent spend may proceed.
 */

export interface GroundSafetyReadings {
  /** Latest journaled `asset_comms` reading (domain-neutral). */
  readonly comms: 'online' | 'degraded' | 'offline' | undefined;
  /** Latest journaled `aisle_access` reading (warehouse). */
  readonly aisle: 'clear' | 'obstructed' | undefined;
  /** Latest journaled `charger_status` reading (warehouse). */
  readonly charger: 'docked_charging' | 'free' | 'fault' | undefined;
}

/**
 * The constraint shape PROPOSED for `MissionConstraint` (planner-adapter
 * request extension 1). Structurally identical to today's `asset-safety`
 * variant plus the `domain` discriminator and the two ground reasons.
 */
export interface ProposedGroundConstraint {
  readonly kind: 'asset-safety';
  readonly domain: 'aerial' | 'ground';
  readonly state: 'clear' | 'blocked' | 'unknown';
  readonly reason:
    | 'wind-limit'
    | 'weather-hold'
    | 'comms-offline'
    | 'aisle-obstructed'
    | 'charger-fault'
    | 'insufficient-evidence'
    | 'nominal';
}

/**
 * Precedence (first match wins):
 *   1. comms offline      → blocked / comms-offline   (cannot operate or observe)
 *   2. aisle obstructed   → blocked / aisle-obstructed
 *   3. charger fault      → blocked / charger-fault
 *   4. anything missing   → unknown / insufficient-evidence (degraded comms included:
 *                            degraded is NOT a healthy-ground verdict)
 *   5. all healthy        → clear / nominal
 */
export function proposedGroundSafety(readings: GroundSafetyReadings): ProposedGroundConstraint {
  if (readings.comms === 'offline') {
    return { kind: 'asset-safety', domain: 'ground', state: 'blocked', reason: 'comms-offline' };
  }
  if (readings.aisle === 'obstructed') {
    return { kind: 'asset-safety', domain: 'ground', state: 'blocked', reason: 'aisle-obstructed' };
  }
  if (readings.charger === 'fault') {
    return { kind: 'asset-safety', domain: 'ground', state: 'blocked', reason: 'charger-fault' };
  }
  if (
    readings.comms === undefined ||
    readings.aisle === undefined ||
    readings.charger === undefined
  ) {
    return {
      kind: 'asset-safety',
      domain: 'ground',
      state: 'unknown',
      reason: 'insufficient-evidence',
    };
  }
  if (readings.comms !== 'online') {
    return {
      kind: 'asset-safety',
      domain: 'ground',
      state: 'unknown',
      reason: 'insufficient-evidence',
    };
  }
  return { kind: 'asset-safety', domain: 'ground', state: 'clear', reason: 'nominal' };
}
