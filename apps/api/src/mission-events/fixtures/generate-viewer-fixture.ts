/**
 * Viewer fixture generator (MTV-09/12) — journal-derived, deterministic.
 *
 * Runs the REAL MissionEventIngestService against a REAL temp SQLite ledger
 * with seeded synthetic sources, replays the journal, and serializes the
 * public PhysicalViewSnapshot v1 (typed observations only — no payloads).
 * Every adversarial variant is genuine journal output of a real fault
 * injected through the real pipeline — nothing here is hand-invented.
 *
 * Run from repo root:
 *   npx tsx apps/api/src/mission-events/fixtures/generate-viewer-fixture.ts
 *
 * Artifacts land in apps/web/src/mission-viewer/fixtures/ and are committed;
 * the harness serves them to the browser. All content SIMULATED_OPERATION.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openLedger, TunableClock } from '@moterva/ledger';
import { MissionEventIngestService } from '../src/ingest.js';
import { SourceRegistry } from '../src/registry.js';
import type { RegisteredSource } from '../src/registry.js';
import { sourceSignature } from '../src/digest.js';
import { fixtureSourceKey } from '../src/rng.js';
import type { EnvelopeWire } from '../src/schema.js';
import type { MissionTimelineView } from '../src/view.js';

const T0 = Date.parse('2026-11-06T09:00:00.000Z');
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../web/src/mission-viewer/fixtures',
);

const CLEAR = [
  { kind: 'wind_speed', unit: 'kt', value: '14.2' },
  { kind: 'weather_hold', unit: 'state', value: 'clear' },
  { kind: 'asset_comms', unit: 'state', value: 'online' },
  { kind: 'asset_position_status', unit: 'state', value: 'on_station' },
] as const;
const GALE = [
  { kind: 'wind_speed', unit: 'kt', value: '24.6' },
  { kind: 'weather_hold', unit: 'state', value: 'active' },
] as const;
const ONLINE = [{ kind: 'asset_comms', unit: 'state', value: 'online' }] as const;
const OFFLINE = [{ kind: 'asset_comms', unit: 'state', value: 'offline' }] as const;
const DOCKED = [
  { kind: 'asset_comms', unit: 'state', value: 'online' },
  { kind: 'asset_position_status', unit: 'state', value: 'docked' },
] as const;

interface World {
  orgId: string;
  missionId: string;
  telemetry: RegisteredSource;
  gateway: RegisteredSource;
  service: MissionEventIngestService;
  clock: TunableClock;
  ledgerPath: string;
  ledger: ReturnType<typeof openLedger>;
  envId: string;
}

let worldCounter = 0;

function makeWorld(seed: string): World {
  const dir = mkdtempSync(join(tmpdir(), 'mtv09-fixture-'));
  const clock = new TunableClock(new Date(T0).toISOString());
  const ledger = openLedger(join(dir, 'ledger.sqlite'), clock);
  ledger.migrate();
  const n = worldCounter++;
  const org = ledger.organizations.createOrganization(`mtv09-org-${n}`);
  const mission = ledger.organizations.createMission(org.id, 'harbor-inspection');
  const asset = 'uav-seeker-1';
  const telemetry: RegisteredSource = {
    orgId: org.id,
    missionId: mission.id,
    sourceId: 'src-telemetry',
    sourceType: 'asset_telemetry',
    keyId: `key-tel-${n}`,
    secretKey: fixtureSourceKey(seed, 'src-telemetry'),
    provenance: 'SYNTHETIC',
    assetIds: [asset],
    trustedForRecovery: false,
  };
  const gateway: RegisteredSource = {
    orgId: org.id,
    missionId: mission.id,
    sourceId: 'vessel-gateway',
    sourceType: 'vessel_gateway',
    keyId: `key-gw-${n}`,
    secretKey: fixtureSourceKey(seed, 'src-gateway'),
    provenance: 'SYNTHETIC',
    assetIds: [asset],
    trustedForRecovery: true,
  };
  const registry = new SourceRegistry();
  registry.registerAll([telemetry, gateway]);
  const service = new MissionEventIngestService(ledger, clock, registry);
  return {
    orgId: org.id,
    missionId: mission.id,
    telemetry,
    gateway,
    service,
    clock,
    ledgerPath: dir,
    ledger,
    envId: seed,
  };
}

/** Signed envelope with a deterministic event id; advances the clock to the anchor. */
function env(
  w: World,
  spec: {
    source?: RegisteredSource;
    sequence: number;
    atMin: number;
    eventId: string;
    observations: readonly { kind: string; unit: string; value: number | string }[];
  },
): EnvelopeWire {
  const source = spec.source ?? w.telemetry;
  const observedAt = new Date(T0 + spec.atMin * 60_000).toISOString();
  const ingestedAt = new Date(T0 + spec.atMin * 60_000 + 2_000).toISOString();
  // Mirror the scenario runner: the ingest clock moves to the emission anchor.
  const anchor = Date.parse(ingestedAt);
  if (anchor > w.clock.now().getTime()) w.clock.advance(anchor - w.clock.now().getTime());
  const unsigned = {
    contractVersion: 1,
    eventId: spec.eventId,
    sequence: spec.sequence,
    orgId: w.orgId,
    missionId: w.missionId,
    assetId: 'uav-seeker-1',
    observedAt,
    ingestedAt,
    source: {
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      keyId: source.keyId,
      provenance: source.provenance,
    },
    observations: [...spec.observations],
  };
  return {
    ...unsigned,
    source: { ...unsigned.source, signature: sourceSignature(unsigned as never, source.secretKey) },
  } as EnvelopeWire;
}

function m(min: number): string {
  return new Date(T0 + min * 60_000).toISOString();
}

function toSnapshot(view: MissionTimelineView) {
  return {
    contractVersion: 1 as const,
    tenant: { orgId: view.orgId, missionId: view.missionId },
    asOf: view.asOf,
    truthLabel: 'SIMULATED_OPERATION',
    policy: {
      maxAgeMs: 15 * 60_000,
      expiredMs: 30 * 60_000,
      uavAssetId: 'uav-seeker-1',
      uavWindLimitKt: 22,
    },
    assets: [
      { assetId: 'uav-seeker-1', kind: 'aerial' as const, label: 'Inspection UAV' },
      { assetId: 'vessel-prospect', kind: 'surface' as const, label: 'Moored vessel' },
    ],
    events: view.events.map((e) => ({
      eventId: e.eventId,
      journalSeq: e.journalSeq,
      sequence: e.sequence,
      assetId: e.assetId,
      sourceId: e.sourceId,
      sourceType: e.sourceType,
      provenance: e.provenance,
      observedAt: e.observedAt,
      ingestedAt: e.ingestedAt,
      recordedAt: e.recordedAt,
      eventDigest: e.eventDigest,
      observations: e.observations.map((o) => ({ kind: o.kind, unit: o.unit, value: o.value })),
      freshnessAtSnapshot: e.freshness,
      planningValidAtSnapshot: e.planningValid,
    })),
  };
}

interface FixtureFile {
  name: string;
  description: string;
  snapshot: ReturnType<typeof toSnapshot>;
}

const fixtures: FixtureFile[] = [];
function finishWorld(w: World, name: string, description: string): void {
  const view = w.service.replay(w.orgId, w.missionId);
  fixtures.push({ name, description, snapshot: toSnapshot(view) });
  w.ledger.close();
  rmSync(w.ledgerPath, { recursive: true, force: true });
}

// ---- PRIMARY: the flagship harbor incident arc (S0→S1→S2/S3) ----------------
{
  const w = makeWorld('primary');
  w.service.ingest(
    w.orgId,
    env(w, { sequence: 1, atMin: 1, eventId: 'mevt_pri01', observations: CLEAR }),
  );
  w.service.ingest(
    w.orgId,
    env(w, {
      sequence: 2,
      atMin: 9,
      eventId: 'mevt_pri02',
      observations: [...CLEAR, { kind: 'inspection_progress', unit: 'percent', value: 12 }],
    }),
  );
  w.service.ingest(
    w.orgId,
    env(w, {
      source: w.gateway,
      sequence: 1,
      atMin: 18,
      eventId: 'mevt_pri03',
      observations: GALE,
    }),
  );
  finishWorld(
    w,
    'primary',
    'Baseline clear conditions then the admitted 24.6 kt incident (modeled limit 22 kt)',
  );
}

// ---- NO-EVIDENCE: S0 ---------------------------------------------------------
{
  const w = makeWorld('empty');
  finishWorld(w, 'empty', 'No admitted evidence — status unknown by design (S0)');
}

// ---- STALE-ONLY: all evidence aged past the planning boundary ----------------
{
  const w = makeWorld('stale');
  w.service.ingest(
    w.orgId,
    env(w, { sequence: 1, atMin: 1, eventId: 'mevt_st01', observations: CLEAR }),
  );
  w.clock.advance(20 * 60_000); // asOf moves past maxAge but inside expired
  finishWorld(
    w,
    'stale',
    'Evidence aged to stale — visible as history, not current clearance (S5)',
  );
}

// ---- CONFLICTING: two sources disagree; latest journal evidence wins ---------
{
  const w = makeWorld('conflict');
  w.service.ingest(
    w.orgId,
    env(w, { sequence: 1, atMin: 1, eventId: 'mevt_cf01', observations: CLEAR }),
  );
  w.service.ingest(
    w.orgId,
    env(w, { source: w.gateway, sequence: 1, atMin: 4, eventId: 'mevt_cf02', observations: GALE }),
  );
  w.service.ingest(
    w.orgId,
    env(w, { sequence: 2, atMin: 7, eventId: 'mevt_cf03', observations: CLEAR }),
  );
  finishWorld(
    w,
    'conflict',
    'Conflicting source reports; the journal decides without silent favor (S1)',
  );
}

// ---- OFFLINE: ghost telemetry refused, asset stuck offline -------------------
{
  const w = makeWorld('offline');
  w.service.ingest(
    w.orgId,
    env(w, { sequence: 1, atMin: 1, eventId: 'mevt_of01', observations: ONLINE }),
  );
  w.service.ingest(
    w.orgId,
    env(w, {
      source: w.gateway,
      sequence: 1,
      atMin: 5,
      eventId: 'mevt_of02',
      observations: OFFLINE,
    }),
  );
  // Ghost telemetry attempt — rejected by the real pipeline (ASSET_OFFLINE),
  // so the journal below genuinely contains no telemetry while offline.
  try {
    w.service.ingest(
      w.orgId,
      env(w, { sequence: 2, atMin: 8, eventId: 'mevt_of03', observations: ONLINE }),
    );
  } catch {
    // expected: the accepted cross-source admission-boundary correction
  }
  finishWorld(w, 'offline', 'Gateway-declared offline; telemetry cannot speak (S5, blocked)');
}

// ---- RECOVERED: authorized recovery then docked -------------------------------
{
  const w = makeWorld('recovered');
  w.service.ingest(
    w.orgId,
    env(w, { sequence: 1, atMin: 1, eventId: 'mevt_rc01', observations: ONLINE }),
  );
  w.service.ingest(
    w.orgId,
    env(w, {
      source: w.gateway,
      sequence: 1,
      atMin: 5,
      eventId: 'mevt_rc02',
      observations: OFFLINE,
    }),
  );
  w.service.ingest(
    w.orgId,
    env(w, {
      source: w.gateway,
      sequence: 2,
      atMin: 9,
      eventId: 'mevt_rc03',
      observations: ONLINE,
    }),
  );
  w.service.ingest(
    w.orgId,
    env(w, { sequence: 2, atMin: 12, eventId: 'mevt_rc04', observations: DOCKED }),
  );
  finishWorld(
    w,
    'recovered',
    'Authorized trusted recovery, then docked — physical only, never a payment event',
  );
}

// ---- WAREHOUSE: ground-domain events in the SAME architecture ----------------
{
  const w = makeWorld('warehouse');
  w.service.ingest(
    w.orgId,
    env(w, { sequence: 1, atMin: 1, eventId: 'mevt_wh01', observations: ONLINE }),
  );
  w.service.ingest(
    w.orgId,
    env(w, {
      sequence: 2,
      atMin: 6,
      eventId: 'mevt_wh02',
      observations: [
        { kind: 'aisle_access', unit: 'state', value: 'obstructed' },
        { kind: 'inspection_progress', unit: 'percent', value: 17 },
      ],
    }),
  );
  finishWorld(w, 'warehouse', 'Ground-domain mission: no aerial wind rule applies to the robot');
}

// ---- DUPLICATE: same event id submitted twice (journal deduped) ---------------
{
  const w = makeWorld('duplicate');
  const first = env(w, { sequence: 1, atMin: 1, eventId: 'mevt_du01', observations: CLEAR });
  w.service.ingest(w.orgId, first);
  try {
    w.service.ingest(w.orgId, first);
  } catch {
    // DUPLICATE_EVENT — expected; the journal keeps one row.
  }
  finishWorld(w, 'duplicate', 'Duplicate submission; one journal row → one marker');
}

mkdirSync(OUT_DIR, { recursive: true });
const registry: Record<string, string> = {};
for (const f of fixtures) {
  const file = `${f.name}.physical-view.json`;
  writeFileSync(
    join(OUT_DIR, file),
    JSON.stringify({ description: f.description, ...f.snapshot }, null, 2) + '\n',
  );
  registry[f.name] = `./fixtures/${file}`;
}
writeFileSync(join(OUT_DIR, 'registry.json'), JSON.stringify(registry, null, 2) + '\n');
console.info(`wrote ${fixtures.length} journal-derived viewer fixtures → ${OUT_DIR}`);
for (const f of fixtures) {
  console.info(
    `  ${f.name}: ${f.snapshot.events.length} events, asOf ${f.snapshot.asOf} — ${f.description}`,
  );
}
console.info(`reference times: T0 ${m(0)}, +9m ${m(9)}, +18m ${m(18)}`);
