# Physical-view contract v1 — for Agent B (visual experience)

**Status: proposal from Agent C (issue #9/15 lane). No UI code was written or modified.**
This is a small, honest data contract a future 2D/3D view can synchronize to. It adds NOTHING the
timeline does not already verify — every field is derivable from `MissionEventIngestService.replay()`
(Agent C's module) and carries the same truth labels.

## Design rules for the view layer

1. **The journal is the only state.** A view renders `MissionTimelineView` (or a projection of it);
   it never holds independent mission state. Browser reload must re-derive from replay — see
   `snapshotExample` below for why a stale cached render is labeled, not trusted.
2. **Provenance is always visible.** Every event renders with its `SYNTHETIC`/`FIELD` provenance and
   source type. A synthetic source is never styled as field-verified.
3. **Freshness is part of the visual state.** `fresh` / `stale` / `expired` must be visually
   distinct; `expired` events are history (dimmed/archived styles) and can NEVER be presented as
   current operating state.
4. **Planning validity ≠ journal validity.** `planningValid: false` events still render (audit
   truth); they must not drive "current status" indicators.
5. **A weather hold is a present-tense block, not a forecast.** The contract deliberately has NO
   `windowOpensAt` for holds. A view may not animate or promise a reopening time from this data.
6. **No financial semantics.** This contract contains amounts nowhere. Asset state changes may be
   shown next to decisions (via `planner.decision` journal rows on the mission timeline), but the
   view must never imply payment success from physical recovery or mission completion.

## Snapshot shape (one render frame)

```json
{
  "contractVersion": 1,
  "tenant": { "orgId": "org_…", "missionId": "msn_…" },
  "asOf": "2026-11-06T10:46:05.000Z",
  "truthLabel": "SIMULATED_OPERATION",
  "assets": [
    {
      "assetId": "uav-seeker-1",
      "comms": "online",
      "positionStatus": "docked",
      "latest": {
        "asset_comms": {
          "value": "online",
          "unit": "state",
          "eventId": "mevt_…",
          "observedAt": "2026-11-06T09:52:00.000Z",
          "freshness": "expired"
        },
        "wind_speed": {
          "value": "24.6",
          "unit": "kt",
          "eventId": "mevt_…",
          "observedAt": "…",
          "freshness": "expired"
        }
      }
    }
  ],
  "recentEvents": [
    {
      "eventId": "mevt_…",
      "journalSeq": 12,
      "assetId": "uav-seeker-1",
      "sourceId": "vessel-gateway",
      "sourceType": "vessel_gateway",
      "provenance": "SYNTHETIC",
      "observedAt": "2026-11-06T09:52:00.000Z",
      "eventDigest": "sha256-hex",
      "observations": [{ "kind": "asset_comms", "unit": "state", "value": "online" }],
      "freshness": "expired",
      "planningValid": false
    }
  ],
  "constraints": [
    {
      "assetId": "uav-seeker-1",
      "kind": "asset-safety",
      "state": "unknown",
      "reason": "insufficient-evidence",
      "basis": "no fresh wind/hold/comms readings asOf this snapshot"
    }
  ]
}
```

Field semantics:

| Field                                    | Meaning                                                                                                                                                              | Source                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `eventId` / `journalSeq` / `eventDigest` | Immutable event identity; a view may link evidence pins to these                                                                                                     | `MissionTimelineView.events[]` |
| `comms` / `positionStatus`               | Latest per-asset readings (or `null` when never observed)                                                                                                            | `assets[assetId]`              |
| `latest[kind]`                           | Latest typed reading with its evidence reference and freshness                                                                                                       | `assets[assetId].latest`       |
| `freshness`                              | `fresh` < 15 min · `stale` 15–30 min · `expired` ≥ 30 min at `asOf`                                                                                                  | computed at read time          |
| `planningValid`                          | TRUE only while fresh — false means "history, not current state"                                                                                                     | correction C rule              |
| `provenance`                             | `SYNTHETIC` fixtures must always render labeled                                                                                                                      | source registration            |
| `constraints[]`                          | Human-readable operational constraints derived from fresh readings ONLY (mirrors the planner bridge's per-asset state machine: `clear`/`blocked`/`unknown` + reason) | integration bridge semantics   |

## What the view may NOT invent

- Reopening times, forecasts, ETA promises (no such field exists).
- "Asset recovered ⇒ payment/reimbursement OK" narratives.
- Field-verified styling for synthetic sources.
- Current-status styling for stale/expired readings (misleading-status-after-reload is a tested
  failure mode: PE-13/PE-14 in the reliability matrix pin the ageing behavior).

## Change process

This contract is versioned like the event envelope. Visual needs that require NEW fields (e.g. a
3D position stream) go through a v2 proposal coordinated on the mission-events contract directory —
not ad-hoc view-side parsing of journal payloads.
