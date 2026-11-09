/**
 * ISOLATED TYPED PROPOSAL — ground-domain asset safety (MTV-07, issue #9;
 * audit gap G5). This module implements the exact planner-contract extension
 * requested in `contract/planner-adapter-request.v1.md` (extension 1) as a
 * PURE, side-effect-free function over journaled ground readings, so Agent A
 * can accept the type change against proven behavior instead of a sketch.
 *
 * It is deliberately NOT wired into the live decision path: the planner's
 * `MissionConstraint` whitelist currently admits only
 * {wind-limit, weather-hold, comms-offline, insufficient-evidence, nominal},
 * so a ground constraint with a NEW reason would be REFUSED by
 * `reviewEvidence` (see ground-safety-proposal.test.ts — that refusal is the
 * fail-closed proof that the type change is required). Until Agent A accepts
 * the change, the live bridge keeps ground verdicts at
 * `unknown/insufficient-evidence` and never `clear`.
 *
 * This is a REQUEST, not a second permission engine: the module computes a
 * safety STATE only. It grants no spending, approval, reservation or provider
 * authority; the planner's existing ASSET_SAFETY gate remains the sole
 * arbiter of whether asset-dependent spend may proceed.
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
  if (readings.comms === undefined || readings.aisle === undefined || readings.charger === undefined) {
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
