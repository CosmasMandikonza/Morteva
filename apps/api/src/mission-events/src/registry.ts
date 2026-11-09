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
  /** Composite-keyed (org, mission, sourceId) — the same sourceId string may
   *  legitimately exist in many missions/orgs (correction A). */
  private readonly byScopedSourceId = new Map<string, RegisteredSource>();
  private readonly byKeyId = new Map<string, RegisteredSource>();
  /** Explicitly revoked keyIds: never silently re-registrable. */
  private readonly revokedKeyIds = new Set<string>();

  register(source: RegisteredSource): void {
    if (source.sourceType === 'asset_telemetry' && source.assetIds.length !== 1) {
      throw new Error(
        `asset_telemetry source "${source.sourceId}" must be bound to exactly one asset`,
      );
    }
    if (this.byKeyId.has(source.keyId)) {
      throw new Error(`keyId "${source.keyId}" is already registered`);
    }
    if (this.revokedKeyIds.has(source.keyId)) {
      // A revoked credential is never silently re-registrable: rotation means
      // a NEW keyId, and resurrecting the old one would defeat revocation.
      throw new Error(`keyId "${source.keyId}" was revoked and cannot be re-registered`);
    }
    const scoped = JSON.stringify([source.orgId, source.missionId, source.sourceId]);
    this.byScopedSourceId.set(scoped, source);
    this.byKeyId.set(source.keyId, source);
  }

  registerAll(sources: readonly RegisteredSource[]): void {
    for (const source of sources) this.register(source);
  }

  /**
   * Revokes a credential: the keyId stops resolving immediately, so every
   * further event signed with it is refused exactly like an unknown key
   * (UNREGISTERED_SOURCE) — and the keyId can never be silently re-registered
   * under a different identity. Rotation means registering the NEW key;
   * revocation is the removal of trust in the old one. An event in flight
   * during rotation is not grandfathered: authentication happens at ingest
   * time against the current registry.
   */
  revoke(keyId: string): boolean {
    const source = this.byKeyId.get(keyId);
    if (source === undefined) return false;
    this.byKeyId.delete(keyId);
    const scoped = JSON.stringify([source.orgId, source.missionId, source.sourceId]);
    // Only delete the scoped entry if it still points at THIS source (a
    // same-sourceId re-registration with a new keyId must survive).
    if (this.byScopedSourceId.get(scoped) === source) {
      this.byScopedSourceId.delete(scoped);
    }
    this.revokedKeyIds.add(keyId);
    return true;
  }

  /** True when the keyId was explicitly revoked (audit/debug surface). */
  isRevoked(keyId: string): boolean {
    return this.revokedKeyIds.has(keyId);
  }

  /** Key ids are globally unique across orgs: a key pins the org it belongs to. */
  findByKeyId(keyId: string): RegisteredSource | undefined {
    return this.byKeyId.get(keyId);
  }

  findBySourceId(orgId: string, missionId: string, sourceId: string): RegisteredSource | undefined {
    return this.byScopedSourceId.get(JSON.stringify([orgId, missionId, sourceId]));
  }

  /** All assets any source has registered for one (org, mission) scope. */
  assetsForMission(orgId: string, missionId: string): Set<string> {
    const assets = new Set<string>();
    for (const source of this.byScopedSourceId.values()) {
      if (source.orgId === orgId && source.missionId === missionId) {
        for (const assetId of source.assetIds) assets.add(assetId);
      }
    }
    return assets;
  }

  all(): readonly RegisteredSource[] {
    return [...this.byScopedSourceId.values()];
  }
}
