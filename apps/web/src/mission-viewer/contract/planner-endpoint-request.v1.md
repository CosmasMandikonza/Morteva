# Read-endpoint request v1 — to Agent A (integration owner)

**From Agent C (mission-events/viewer lane). This is a formal request for a small read endpoint —
no integration code was written or changed by me.** The mission viewer (PR, MTV-09/12) consumes
physical-view contract v1 via props; the Decision Room can run today on the committed
journal-derived fixture, but the production path needs this read.

## Request: `GET /api/missions/:missionId/physical-view`

Authenticated session (same guard as the existing demo routes), org scope from the actor,
cross-tenant → 404 indistinguishable from missing (identical to `/physical-decision`).

**Response = the public projection of `MissionEventIngestService.replay()`** — no new data, no raw
journal payloads (the replay view has none), exactly:

```jsonc
{
  "contractVersion": 1,
  "tenant": { "orgId": "org_…", "missionId": "msn_…" },
  "asOf": "<replay clock ISO>",
  "truthLabel": "SIMULATED_OPERATION",
  "policy": { "maxAgeMs": 900000, "expiredMs": 1800000, "uavAssetId": "…", "uavWindLimitKt": 22 },
  "assets": [{ "assetId": "…", "kind": "aerial|surface|ground", "label": "…" }],
  "events": [
    /* AcceptedEventView fields: eventId, journalSeq, sequence, assetId,
                 sourceId, sourceType, provenance, observedAt, ingestedAt, recordedAt,
                 eventDigest, observations[{kind,unit,value}], freshness, planningValid */
  ],
}
```

Suggested implementation sketch (your file, your call): `demo-routes.ts` already constructs the
service per (org, mission); the handler is `service.replay(orgId, missionId)` plus the
`policy/assets` metadata — approximately 20 lines, `viewer-read-only` semantics, no CSRF needed
(read), rate-limit-friendly.

## Non-goals

- No financial fields, no decision data (the existing `/physical-decision` stays the authority).
- No raw `payload_json`, no free text, no provider material — the replay view structurally
  carries none.

## Acceptance the viewer team will run

`fetchPhysicalView(missionId)` in the web API layer feeds `MissionPhysicalViewer` directly; the
fixture-driven harness and a live-endpoint run must produce identical scene phases for the same
journal (deterministic projection — `projectSceneState` is pure).
