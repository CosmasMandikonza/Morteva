/**
 * Shared helpers for the isolated mission-event test suite (issue #9).
 * Everything runs against a REAL migrated SQLite ledger on a temp file —
 * no mocks of the journal or the ledger.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, TunableClock, type Ledger } from '@moterva/ledger';
import { MissionEventIngestService } from '../../src/mission-events/index.js';
import { SourceRegistry } from '../../src/mission-events/index.js';
import { fixtureSourceKey } from '../../src/mission-events/index.js';
import { sourceSignature } from '../../src/mission-events/index.js';
import type { EnvelopeWire } from '../../src/mission-events/index.js';
import type { RegisteredSource } from '../../src/mission-events/index.js';

export const TEST_T0 = '2026-11-06T09:00:00.000Z';
export const TEST_SEED = 'test-seed';

export interface TestWorld {
  ledger: Ledger;
  clock: TunableClock;
  orgId: string;
  missionId: string;
  foreignOrgId: string;
  foreignMissionId: string;
  registry: SourceRegistry;
  service: MissionEventIngestService;
  telemetrySource: RegisteredSource;
  gatewaySource: RegisteredSource;
}

export function makeWorld(options: { startAt?: string } = {}): TestWorld {
  const path = join(mkdtempSync(join(tmpdir(), 'moterva-mev-')), 'ledger.sqlite');
  const ledger = openLedger(path);
  ledger.migrate();
  const clock = new TunableClock(options.startAt ?? TEST_T0);
  const org = ledger.organizations.createOrganization('mev-org');
  const mission = ledger.organizations.createMission(org.id, 'mev-mission');
  const foreignOrg = ledger.organizations.createOrganization('mev-foreign');
  const foreignMission = ledger.organizations.createMission(foreignOrg.id, 'foreign-mission');

  const asset = 'asset-uav-1';
  const telemetrySource: RegisteredSource = {
    orgId: org.id,
    missionId: mission.id,
    sourceId: 'src-telemetry',
    sourceType: 'asset_telemetry',
    keyId: 'key-tel-v1',
    secretKey: fixtureSourceKey(TEST_SEED, 'src-telemetry'),
    provenance: 'SYNTHETIC',
    assetIds: [asset],
    trustedForRecovery: false,
  };
  const gatewaySource: RegisteredSource = {
    orgId: org.id,
    missionId: mission.id,
    sourceId: 'src-gateway',
    sourceType: 'vessel_gateway',
    keyId: 'key-gw-v1',
    secretKey: fixtureSourceKey(TEST_SEED, 'src-gateway'),
    provenance: 'SYNTHETIC',
    assetIds: [asset],
    trustedForRecovery: true,
  };
  const registry = new SourceRegistry();
  registry.registerAll([telemetrySource, gatewaySource]);
  const service = new MissionEventIngestService(ledger, clock, registry);
  return {
    ledger,
    clock,
    orgId: org.id,
    missionId: mission.id,
    foreignOrgId: foreignOrg.id,
    foreignMissionId: foreignMission.id,
    registry,
    service,
    telemetrySource,
    gatewaySource,
  };
}

export interface EnvelopeSpec {
  /** Defaults to the world's asset-telemetry source. */
  source?: RegisteredSource;
  assetId?: string;
  sequence?: number;
  observedAt?: string;
  ingestedAt?: string;
  eventId?: string;
  observations?: EnvelopeWire['observations'];
  orgId?: string;
  missionId?: string;
  signature?: string;
  provenance?: 'SYNTHETIC' | 'FIELD';
}

export function envelope(world: TestWorld, spec: EnvelopeSpec): EnvelopeWire {
  const source = spec.source ?? world.telemetrySource;
  const observedAt = spec.observedAt ?? world.clock.iso();
  const ingestedAt = spec.ingestedAt ?? world.clock.iso();
  // Mirror the scenario runner: the ingest clock moves forward to the
  // emission anchor so future-tolerance checks measure real skew, not lag.
  const anchorMs = Date.parse(ingestedAt);
  if (anchorMs > world.clock.now().getTime())
    world.clock.advance(anchorMs - world.clock.now().getTime());
  const unsigned = {
    contractVersion: 1,
    eventId: spec.eventId ?? `mevt_test${Math.random().toString(16).slice(2, 10)}`,
    sequence: spec.sequence ?? 1,
    orgId: spec.orgId ?? world.orgId,
    missionId: spec.missionId ?? world.missionId,
    assetId: spec.assetId ?? source.assetIds[0] ?? 'asset-uav-1',
    observedAt,
    ingestedAt,
    source: {
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      keyId: source.keyId,
      provenance: spec.provenance ?? source.provenance,
    },
    observations: spec.observations ?? [{ kind: 'battery_soc', unit: 'percent', value: 80 }],
  };
  return {
    ...unsigned,
    source: {
      ...unsigned.source,
      signature: spec.signature ?? sourceSignature(unsigned as never, source.secretKey),
    },
  } as EnvelopeWire;
}

/** Timestamp helper: T0 + minutes. */
export function at(minute: number, second = 0): string {
  return new Date(Date.parse(TEST_T0) + minute * 60_000 + second * 1000).toISOString();
}
