/**
 * Trusted-source registry — the authentication boundary for mission events.
 *
 * A source is registered per (org, mission) with a key id and secret. In this
 * issue the registry is programmatic and its keys are FIXTURE-ONLY, derived
 * deterministically from a scenario seed (see keys.ts) so traces reproduce
 * byte-identically. A production deployment would provision keys from a secret
 * manager into the same registry shape — no ingest code changes.
 *
 * The registry encodes physical trust, NOT financial trust: nothing here grants
 * spending, approval or provider authority. `trustedForRecovery` exists so an
 * offline asset can only be declared back online by an independent authorized
 * observer (e.g. the support vessel's gateway), never by the asset's own
 * telemetry — an offline vehicle cannot speak.
 */
import type { ProvenanceLabel, SourceType } from './vocabulary.js';

export interface RegisteredSource {
  readonly orgId: string;
  readonly missionId: string;
  readonly sourceId: string;
  readonly sourceType: SourceType;
  readonly keyId: string;
  /** Fixture-only keys are derived from the scenario seed; never a real secret. */
  readonly secretKey: string;
  readonly provenance: ProvenanceLabel;
  /** Assets this source may report for. asset_telemetry sources list exactly one. */
  readonly assetIds: readonly string[];
  /** May deliver the event that restores an offline asset's comms. */
  readonly trustedForRecovery: boolean;
}

export class SourceRegistry {
  private readonly bySourceId = new Map<string, RegisteredSource>();
  private readonly byKeyId = new Map<string, RegisteredSource>();

  register(source: RegisteredSource): void {
    if (source.sourceType === 'asset_telemetry' && source.assetIds.length !== 1) {
      throw new Error(
        `asset_telemetry source "${source.sourceId}" must be bound to exactly one asset`,
      );
    }
    const existingKey = this.byKeyId.get(source.keyId);
    if (existingKey !== undefined && existingKey.keyId === source.keyId) {
      throw new Error(`keyId "${source.keyId}" is already registered`);
    }
    this.bySourceId.set(source.sourceId, source);
    this.byKeyId.set(source.keyId, source);
  }

  registerAll(sources: readonly RegisteredSource[]): void {
    for (const source of sources) this.register(source);
  }

  /** Key ids are globally unique across orgs: a key pins the org it belongs to. */
  findByKeyId(keyId: string): RegisteredSource | undefined {
    return this.byKeyId.get(keyId);
  }

  findBySourceId(sourceId: string): RegisteredSource | undefined {
    return this.bySourceId.get(sourceId);
  }

  /** All assets any source has registered for one (org, mission) scope. */
  assetsForMission(orgId: string, missionId: string): Set<string> {
    const assets = new Set<string>();
    for (const source of this.bySourceId.values()) {
      if (source.orgId === orgId && source.missionId === missionId) {
        for (const assetId of source.assetIds) assets.add(assetId);
      }
    }
    return assets;
  }

  all(): readonly RegisteredSource[] {
    return [...this.bySourceId.values()];
  }
}
