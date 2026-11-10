# Planner adapter request v1 — Agent A (packages/planner + integration)

**From Agent C (mission-events, issue #9/15 lane); updated by Agent D (MTV-07 second-domain work,
2026-11-09). This is a typed contract REQUEST — `packages/planner` is still untouched.** Everything
below is grounded in measured behavior from the reliability matrix (`reliability/results/summary.md`,
cases PE-24 / FI-12) plus the MTV-07 ground-domain tests, not speculation.

**Status after MTV-07 (2026-11-09):**

- **Extension 2 (per-asset-kind policy input) is IMPLEMENTED** in the bridge —
  `apps/api/src/integration/physical-to-planner.ts` now accepts the optional
  `assetKinds?: Readonly<Record<string, 'aerial' | 'ground'>>` field exactly as requested below.
  Aerial/undeclared semantics are byte-for-byte unchanged; declared-ground assets never consume
  wind/hold for their verdict and are never `clear` (blocked on comms-offline, otherwise
  unknown/insufficient-evidence). Proven by `apps/api/test/integration/ground-domain.test.ts`.
- **Extension 1 (planner type change) is IMPLEMENTED AS AN ISOLATED PROPOSAL** at
  `apps/api/src/integration/ground-safety-proposal.ts` with a full matrix test
  (`ground-safety-proposal.test.ts`) — including the fail-closed proof that TODAY's
  `reviewEvidence` whitelist refuses the new reasons. Agent A's acceptance is the type change in
  `packages/planner/src/contracts.ts` (+ the `evidence.ts` whitelist) after which the bridge can
  emit ground constraints and the proposal function becomes the mapping of record.

## What works today (verified, keep as-is)

- The bridge `physicalTimelineToPlannerSafety` maps fresh `wind_speed`/`weather_hold`/`asset_comms`
  readings into `asset-safety` constraints; stale/expired events are withheld; per-source sequences
  survive as `physicalSequence`; no forecast window is ever invented.
- The offshore golden path (wind → blocked UAV → vessel alternative) behaves correctly through the
  full public chain (FI-01..FI-11 all PASS).

## Requested extension 1 — domain-aware constraint mapping (warehouse)

Today a warehouse event carrying only `asset_comms: online` for `robot-counter-3` maps to
`asset-safety: state 'unknown', reason 'insufficient-evidence'` because the state machine demands
wind+hold+comms. That is honest fail-closed behavior for an AERIAL asset, but for a warehouse robot
wind is irrelevant: the asset is effectively clear when comms are online.

**Exact request:** extend `MissionConstraint` with a domain-scoped safety variant, e.g.

```ts
| {
    readonly kind: 'asset-safety';
    readonly domain: 'aerial' | 'ground';        // NEW discriminator
    readonly state: 'clear' | 'blocked' | 'unknown';
    readonly reason:
      | 'wind-limit' | 'weather-hold' | 'comms-offline'
      | 'aisle-obstructed' | 'charger-fault'      // NEW ground reasons
      | 'insufficient-evidence' | 'nominal';
    readonly observedWindKt?: number;
    readonly maxWindKt?: number;
  }
```

Mapping table requested (ground domain): `aisle_access: obstructed → state 'blocked', reason
'aisle-obstructed'`; `charger_status: fault → 'blocked', 'charger-fault'`; `asset_comms: online` +
no blocked ground reading → `clear`. Aerial mapping unchanged.

## Requested extension 2 — per-asset-kind policy input

`PhysicalSafetyPolicy` currently carries one `uavWindLimitKt` for the whole mission. With two
domains in one mission the limit must not apply to ground assets. **Exact request:** add optional
`assetKinds?: Readonly<Record<string, 'aerial' | 'ground'>>` to the policy (or derive from the
asset registry), and skip wind-limit evaluation for non-aerial assets. Until then the reliability
matrix documents the current conservative behavior as a known limitation.

## What is NOT requested

- No new payment kinds, no financial authority changes, no model adapter changes.
- No removal of the conservative fail-closed default: an unmapped asset kind stays `unknown`.

## Verification offer

Both extensions can be proven by the existing matrix: PE-24/FI-12 currently assert the CONSERVATIVE
behavior; flipping them to assert domain-aware mapping would be the acceptance test for this
request (one-line expectation changes on my side once your adapter lands).
