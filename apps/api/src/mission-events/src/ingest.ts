/**
 * Mission-event ingestion service (issue #9).
 *
 * ONE pipeline for every physical domain (offshore, warehouse, future): strict
 * envelope validation → authority-vocabulary rejection → tenant/mission/asset
 * binding → source authentication (HMAC over the canonical event) →
 * provenance consistency → duplicate/ordering checks → time checks →
 * physical-state consistency → append through the EXISTING permitted evidence
 * boundary (EvidenceService, topic `operational`, append-only, org-scoped,
 * duplicate-suppressed by event key). There is no second store and no
 * financial write path anywhere in this file.
 *
 * SAFETY LAW: no accepted or rejected event can approve, reserve, settle or
 * dispatch money. This module never imports reservations, approvals, mandates,
 * accounts, outbox or worker code; the observation vocabulary contains no
 * financial terms (and rejects them); the journal topic is `operational` only.
 */
import { canonicalJson } from '@moterva/domain';
import type { Ledger } from '@moterva/ledger';
import { LedgerError } from '@moterva/ledger';
import type { Clock } from '@moterva/ledger';
import { createHash } from 'node:crypto';
import { MissionEventError } from './errors.js';
import type { RegisteredSource, SourceRegistry } from './registry.js';
import { eventDigest, signatureMatches, sourceSignature } from './digest.js';
import {
  parseEnvelope,
  parseNormalizedEvent,
  signedEvent,
  type NormalizedEvent,
} from './schema.js';
import { INGEST_VALIDATOR_VERSION } from './version.js';
import { containsAuthorityTerm } from './vocabulary.js';
import {
  applyEvent,
  commsState,
  DEFAULT_FRESHNESS_POLICY,
  freshnessOf,
  lastObservation,
  newIngestState,
  projectTimeline,
  streamKey,
} from './view.js';
import type { FreshnessPolicy, IngestState, JournaledEvent, MissionTimelineView } from './view.js';
import { observationKindSpec } from './vocabulary.js';
export const JOURNAL_EVENT_TYPE = 'mission.event.ingested';

export interface IngestOptions {
  /** Reject events whose observations are already older than maxAgeMs at arrival. */
  readonly policy?: FreshnessPolicy;
  /** Allowed clock skew for ingestedAt/observedAt in the future (default 2 min). */
  readonly futureToleranceMs?: number;
}

export interface IngestAccepted {
  readonly status: 'accepted';
  readonly journalSeq: number;
  readonly eventId: string;
  readonly eventDigest: string;
  readonly recordedAt: string;
  readonly freshness: string;
}

export interface IngestRejection {
  readonly status: 'rejected';
  readonly eventId: string | null;
  readonly code: string;
  readonly message: string;
}

export type IngestOutcome = IngestAccepted | IngestRejection;

export class MissionEventIngestService {
  private state: IngestState = newIngestState();
  private readonly policy: FreshnessPolicy;
  private readonly futureToleranceMs: number;
  /**
   * (org, mission) scopes whose validation state has been loaded from the
   * journal. Admission NEVER trusts empty state for an existing stream
   * (correction B): the first ingest/rehydrate for a scope rebuilds it from
   * the journal before any check runs, and a corrupt journal fails closed.
   */
  private readonly hydratedScopes = new Set<string>();

  constructor(
    private readonly ledger: Ledger,
    private readonly clock: Clock,
    private readonly registry: SourceRegistry,
    options: IngestOptions = {},
  ) {
    this.policy = options.policy ?? DEFAULT_FRESHNESS_POLICY;
    this.futureToleranceMs = options.futureToleranceMs ?? 120_000;
  }

  /**
   * Rebuild the validation state for ONE (org, mission) scope from the journal
   * (startup/explicit path). Additive and idempotent: the journal is
   * append-only, so re-applying a scope's rows can never contradict rows of
   * another scope, and other missions' in-memory state is never touched
   * (correction A — rehydrating mission A must not erase mission B).
   */
  rehydrate(orgId: string, missionId: string): void {
    for (const row of this.readJournal(orgId, missionId)) {
      applyEvent(this.state, row.event);
    }
    this.hydratedScopes.add(scopeKey(orgId, missionId));
  }

  /** Ingest one wire envelope. Throws MissionEventError on rejection. */
  ingest(callerOrgId: string, raw: unknown): IngestAccepted {
    const envelope = parseEnvelope(raw);
    const event: NormalizedEvent = {
      contractVersion: envelope.contractVersion,
      eventId: envelope.eventId,
      sequence: envelope.sequence,
      orgId: envelope.orgId,
      missionId: envelope.missionId,
      assetId: envelope.assetId,
      observedAt: envelope.observedAt,
      ingestedAt: envelope.ingestedAt,
      source: {
        sourceId: envelope.source.sourceId,
        sourceType: envelope.source.sourceType,
        keyId: envelope.source.keyId,
        provenance: envelope.source.provenance,
      },
      observations: envelope.observations,
    };
    // Correction B: no admission before the target scope's state is loaded
    // from the journal — a fresh instance must not trust empty state.
    this.ensureHydrated(event.orgId, event.missionId);
    const registered = this.validateAndCheck(callerOrgId, event, envelope.source.signature);
    return this.journal(event, registered);
  }

  private ensureHydrated(orgId: string, missionId: string): void {
    if (!this.hydratedScopes.has(scopeKey(orgId, missionId))) {
      this.rehydrate(orgId, missionId);
    }
  }

  /**
   * Batch ingestion used by fixtures/replay tooling: every rejection is
   * captured (code + message) and ingestion continues with the next event.
   * Rejected events are never journaled.
   */
  ingestAll(callerOrgId: string, envelopes: readonly unknown[]): IngestOutcome[] {
    return envelopes.map((raw) => {
      try {
        return this.ingest(callerOrgId, raw);
      } catch (error) {
        if (error instanceof MissionEventError) {
          const rawEventId = (raw as { eventId?: unknown } | null)?.eventId;
          const eventId = typeof rawEventId === 'string' ? rawEventId : null;
          return { status: 'rejected', eventId, code: error.code, message: error.message };
        }
        throw error;
      }
    });
  }

  /**
   * Deterministic pre-journal validation pipeline (fast path over in-memory
   * state). Returns the authenticated registered source for the authoritative
   * re-check inside the admission transaction.
   */
  private validateAndCheck(
    callerOrgId: string,
    event: NormalizedEvent,
    signature: string,
  ): RegisteredSource {
    this.rejectAuthorityTerms(event);

    // --- tenant binding -----------------------------------------------------
    if (event.orgId !== callerOrgId) {
      throw new MissionEventError(
        'CROSS_ORG_EVENT',
        `event declares organization ${event.orgId} but caller is ${callerOrgId}`,
      );
    }
    this.requireMissionInOrg(event.orgId, event.missionId);

    // --- source authentication ----------------------------------------------
    const registered = this.registry.findByKeyId(event.source.keyId);
    if (registered === undefined) {
      throw new MissionEventError(
        'UNAUTHENTICATED_SOURCE',
        `keyId "${event.source.keyId}" is not registered`,
      );
    }
    if (
      registered.orgId !== callerOrgId ||
      registered.missionId !== event.missionId ||
      registered.sourceId !== event.source.sourceId ||
      registered.sourceType !== event.source.sourceType
    ) {
      throw new MissionEventError(
        'CROSS_ORG_EVENT',
        `keyId "${event.source.keyId}" is not registered for this organization/mission/source`,
      );
    }
    const missionAssets = this.registry.assetsForMission(callerOrgId, event.missionId);
    if (!missionAssets.has(event.assetId)) {
      throw new MissionEventError(
        'UNKNOWN_ASSET',
        `asset "${event.assetId}" is not registered for this mission`,
      );
    }
    if (!registered.assetIds.includes(event.assetId)) {
      throw new MissionEventError(
        'SOURCE_NOT_AUTHORIZED_FOR_ASSET',
        `source "${registered.sourceId}" is not authorized to report for asset "${event.assetId}"`,
      );
    }
    if (!signatureMatches(sourceSignature(event, registered.secretKey), signature)) {
      throw new MissionEventError(
        'SIGNATURE_INVALID',
        `HMAC does not verify for keyId "${event.source.keyId}"`,
      );
    }
    if (registered.provenance !== event.source.provenance) {
      throw new MissionEventError(
        'PROVENANCE_MISMATCH',
        `source "${registered.sourceId}" is registered ${registered.provenance}; event claims ${event.source.provenance}`,
      );
    }

    // --- duplication (org-scoped: journal keys are unique per organization) --
    if (this.state.eventIdsByOrg.get(callerOrgId)?.has(event.eventId)) {
      throw new MissionEventError(
        'DUPLICATE_EVENT',
        `eventId "${event.eventId}" was already ingested; replays are rejected`,
      );
    }

    // --- time -----------------------------------------------------------------
    const observedMs = Date.parse(event.observedAt);
    const ingestedMs = Date.parse(event.ingestedAt);
    const nowMs = this.clock.now().getTime();
    if (ingestedMs < observedMs) {
      throw new MissionEventError(
        'TIMESTAMP_ORDER',
        `ingestedAt ${event.ingestedAt} precedes observedAt ${event.observedAt}`,
      );
    }
    if (
      ingestedMs > nowMs + this.futureToleranceMs ||
      observedMs > nowMs + this.futureToleranceMs
    ) {
      throw new MissionEventError(
        'FUTURE_EVENT',
        `event timestamps are ahead of the clock beyond the ${this.futureToleranceMs}ms tolerance`,
      );
    }
    if (nowMs - observedMs > this.policy.maxAgeMs) {
      throw new MissionEventError(
        'STALE_EVENT',
        `observedAt ${event.observedAt} is older than the ${this.policy.maxAgeMs}ms arrival limit`,
      );
    }

    // --- ordering (per org/mission/asset/source stream) ------------------------
    const key = streamKey(event.orgId, event.missionId, event.assetId, event.source.sourceId);
    const stream = this.state.streams.get(key);
    if (stream !== undefined && event.sequence <= stream.sequence) {
      throw new MissionEventError(
        'SEQUENCE_REGRESSION',
        `sequence ${event.sequence} for stream ${key} does not exceed ${stream.sequence}`,
      );
    }
    if (stream === undefined && event.sequence !== 1) {
      throw new MissionEventError(
        'SEQUENCE_GAP',
        `sequence ${event.sequence} for new stream ${key} skips missing event 1; a stream must start at sequence 1 (fail closed)`,
        { expectedNext: 1 },
      );
    }
    if (stream !== undefined && event.sequence > stream.sequence + 1) {
      throw new MissionEventError(
        'SEQUENCE_GAP',
        `sequence ${event.sequence} for stream ${key} skips missing event ${stream.sequence + 1} (lost update); fail closed`,
        { expectedNext: stream.sequence + 1 },
      );
    }

    // --- physical-state consistency ---------------------------------------------
    const comms = commsState(this.state, event.orgId, event.missionId, event.assetId);
    if (comms === 'offline') {
      const isRecovery =
        event.source.sourceType !== 'asset_telemetry' &&
        registered.trustedForRecovery &&
        event.observations.some((o) => o.kind === 'asset_comms' && o.value === 'online');
      if (!isRecovery) {
        throw new MissionEventError(
          'ASSET_OFFLINE',
          `asset "${event.assetId}" is offline; only a trustedForRecovery source carrying asset_comms=online may speak for it`,
        );
      }
    }

    const seenKinds = new Set<string>();
    for (const observation of event.observations) {
      if (seenKinds.has(observation.kind)) {
        throw new MissionEventError(
          'CONFLICTING_OBSERVATIONS',
          `kind "${observation.kind}" appears more than once in event ${event.eventId}`,
        );
      }
      seenKinds.add(observation.kind);
      const spec = observationKindSpec(observation.kind);
      if (spec?.monotonic === true) {
        const prior = lastObservation(
          this.state,
          event.orgId,
          event.missionId,
          event.assetId,
          observation.kind,
        );
        if (prior !== undefined && Number(observation.value) < Number(prior.value)) {
          throw new MissionEventError(
            'MONOTONIC_VIOLATION',
            `kind "${observation.kind}" is monotonic non-decreasing; ${String(observation.value)} < prior ${String(prior.value)} (event ${prior.eventId})`,
          );
        }
      }
    }
    return registered;
  }

  /**
   * Journal append with DB-AUTHORITATIVE admission (correction B + CTO
   * follow-up).
   *
   * The in-memory checks above are a fast path; this is the authority. Inside
   * one BEGIN IMMEDIATE write transaction the journal is re-read and BOTH
   * orderings are re-enforced against what has ACTUALLY committed:
   *   1. stream sequencing (regression / gap / first-event-must-be-1), and
   *   2. asset-wide physical state — the latest offline/monotonic readings
   *      across ALL sources for this asset — because another instance may
   *      have committed, say, a gateway "asset offline" event after this
   *      instance validated against its older in-memory state. Independent
   *      source streams make sequencing alone insufficient for that.
   * The append happens in the SAME transaction, so concurrent instances
   * cannot interleave a state-changing commit between the recheck and the
   * write. This holds because every mission-event writer goes through this
   * method; raw writers bypassing it are still detected at replay by the
   * stream-continuity check.
   */
  private journal(event: NormalizedEvent, registered: RegisteredSource): IngestAccepted {
    const digest = eventDigest(event);
    const receivedAt = this.clock.iso();
    const payload = {
      event: signedEvent(event),
      eventDigest: digest,
      ingest: { receivedAt, validatorVersion: INGEST_VALIDATOR_VERSION },
    };
    let recorded: { seq: number; recordedAt: string };
    try {
      recorded = this.ledger.db.transaction(() => {
        this.admitByJournal(event, registered);
        const view = this.ledger.evidence.append({
          orgId: event.orgId,
          missionId: event.missionId,
          topic: 'operational',
          type: JOURNAL_EVENT_TYPE,
          eventKey: `mevt:${event.eventId}`,
          payload,
          occurredAt: event.observedAt,
        });
        return { seq: view.seq, recordedAt: view.recordedAt };
      }, 'immediate');
    } catch (error) {
      if (error instanceof MissionEventError) throw error;
      if (error instanceof LedgerError && error.code === 'DUPLICATE_EVENT') {
        throw new MissionEventError(
          'DUPLICATE_EVENT',
          `eventId "${event.eventId}" is already journaled; replay suppression engaged`,
        );
      }
      throw error;
    }
    // State advances ONLY after a committed journal row (correction A: a
    // failed append must never advance in-memory validation state).
    applyEvent(this.state, event);
    return {
      status: 'accepted',
      journalSeq: recorded.seq,
      eventId: event.eventId,
      eventDigest: digest,
      recordedAt: recorded.recordedAt,
      freshness: freshnessOf(event.observedAt, this.clock.now().getTime(), this.policy),
    };
  }

  /**
   * Authoritative admission against the journal itself, inside the write
   * transaction so the re-read and the append are atomic (a concurrent
   * instance cannot commit between them). ONE newest-first scan derives, for
   * this (org, mission):
   *   - the target stream's last sequence,
   *   - the asset-wide latest comms state (ANY source — the offline rule is
   *     not per-stream), and
   *   - the asset-wide latest value of each monotonic kind in the incoming
   *     event (ANY source — progress reported through a gateway binds a
   *     telemetry source too).
   */
  private admitByJournal(event: NormalizedEvent, registered: RegisteredSource): void {
    const rows = this.ledger.db
      .prepare(
        `SELECT payload_json FROM evidence_events
          WHERE org_id = ? AND mission_id = ? AND topic = 'operational' AND type = ?
          ORDER BY seq DESC`,
      )
      .all(event.orgId, event.missionId, JOURNAL_EVENT_TYPE) as Record<string, unknown>[];

    const monotonicKinds = new Set(
      event.observations
        .filter((o) => observationKindSpec(o.kind)?.monotonic === true)
        .map((o) => o.kind),
    );
    let streamSequence: number | null = null;
    let assetComms: string | null = null;
    const monotonicLatest = new Map<string, { value: unknown; eventId: unknown }>();

    for (const row of rows) {
      // Payload shape and digests were verified at write time; a corrupt row
      // here surfaces as JOURNAL_TAMPERED (fail closed) rather than a wrong
      // admission.
      let payload: unknown;
      try {
        payload = JSON.parse(String(row.payload_json));
      } catch {
        throw new MissionEventError(
          'JOURNAL_TAMPERED',
          'admission check found a non-JSON journal payload; journal is inconsistent',
        );
      }
      const stored = (
        payload as {
          event?: {
            eventId?: unknown;
            assetId?: unknown;
            source?: { sourceId?: unknown };
            sequence?: unknown;
            observations?: unknown;
          };
        }
      ).event;
      if (stored === undefined || typeof stored.assetId !== 'string') {
        throw new MissionEventError(
          'JOURNAL_TAMPERED',
          'admission check found a journal payload without a normalized event; journal is inconsistent',
        );
      }
      if (stored.assetId !== event.assetId) continue;
      if (streamSequence === null && stored.source?.sourceId === event.source.sourceId) {
        const last = stored.sequence;
        if (typeof last !== 'number' || !Number.isSafeInteger(last)) {
          throw new MissionEventError(
            'JOURNAL_TAMPERED',
            `stored sequence for asset "${event.assetId}" is not an integer; journal is inconsistent`,
          );
        }
        streamSequence = last;
      }
      if (Array.isArray(stored.observations)) {
        for (const observation of stored.observations) {
          const o = observation as { kind?: unknown; value?: unknown };
          if (o.kind === 'asset_comms' && assetComms === null && typeof o.value === 'string') {
            assetComms = o.value;
          }
          if (
            typeof o.kind === 'string' &&
            monotonicKinds.has(o.kind) &&
            !monotonicLatest.has(o.kind)
          ) {
            monotonicLatest.set(o.kind, { value: o.value, eventId: stored.eventId });
          }
        }
      }
      if (
        streamSequence !== null &&
        assetComms !== null &&
        monotonicLatest.size === monotonicKinds.size
      ) {
        break; // every authoritative fact is known
      }
    }

    // --- sequencing (authoritative) -----------------------------------------
    if (streamSequence !== null) {
      if (event.sequence <= streamSequence) {
        throw new MissionEventError(
          'SEQUENCE_REGRESSION',
          `journal-authoritative check: sequence ${event.sequence} does not exceed journaled ${streamSequence} for asset "${event.assetId}"`,
        );
      }
      if (event.sequence > streamSequence + 1) {
        throw new MissionEventError(
          'SEQUENCE_GAP',
          `journal-authoritative check: sequence ${event.sequence} skips journaled+1 ${streamSequence + 1} (lost update); fail closed`,
          { expectedNext: streamSequence + 1 },
        );
      }
    } else if (event.sequence !== 1) {
      // No journaled row for this stream: it must begin at sequence 1.
      throw new MissionEventError(
        'SEQUENCE_GAP',
        `journal-authoritative check: new stream for asset "${event.assetId}" must start at sequence 1, received ${event.sequence}`,
        { expectedNext: 1 },
      );
    }

    // --- physical state (authoritative, asset-wide across sources) ------------
    // CTO follow-up: the in-memory check above may have validated against a
    // state that predates another instance's commit (e.g. a gateway's offline
    // event on an independent stream). Re-derive from the journal.
    if (assetComms === 'offline') {
      const isRecovery =
        event.source.sourceType !== 'asset_telemetry' &&
        registered.trustedForRecovery &&
        event.observations.some((o) => o.kind === 'asset_comms' && o.value === 'online');
      if (!isRecovery) {
        throw new MissionEventError(
          'ASSET_OFFLINE',
          `journal-authoritative check: asset "${event.assetId}" is offline per the journal; only a trustedForRecovery source carrying asset_comms=online may speak for it`,
        );
      }
    }
    for (const observation of event.observations) {
      if (!monotonicKinds.has(observation.kind)) continue;
      const prior = monotonicLatest.get(observation.kind);
      if (prior !== undefined && Number(observation.value) < Number(prior.value)) {
        throw new MissionEventError(
          'MONOTONIC_VIOLATION',
          `journal-authoritative check: kind "${observation.kind}" is monotonic non-decreasing; ${String(observation.value)} < journaled ${String(prior.value)} (event ${String(prior.eventId)})`,
        );
      }
    }
  }

  /**
   * Replay the mission's accepted mission events from the append-only journal
   * and project the timeline view. Verifies both digests on every row and the
   * per-stream sequence continuity (readJournal): tampering or an
   * inconsistent journal fails closed.
   */
  replay(callerOrgId: string, missionId: string): MissionTimelineView {
    this.requireMissionInOrg(callerOrgId, missionId);
    const rows = this.readJournal(callerOrgId, missionId);
    return projectTimeline(callerOrgId, missionId, rows, this.clock.now().getTime(), this.policy);
  }

  /** Read-time access to the current in-memory validation state (tests). */
  currentState(): IngestState {
    return this.state;
  }

  private requireMissionInOrg(orgId: string, missionId: string): void {
    try {
      this.ledger.organizations.getMission(orgId, missionId);
    } catch {
      // Missing and foreign are deliberately indistinguishable (tenant safety).
      throw new MissionEventError(
        'MISSION_NOT_IN_ORG',
        `mission "${missionId}" does not exist in the caller's organization`,
      );
    }
  }

  private readJournal(orgId: string, missionId: string): JournaledEvent[] {
    const rows = this.ledger.db
      .prepare(
        `SELECT seq, event_key, payload_json, payload_digest, recorded_at
           FROM evidence_events
          WHERE org_id = ? AND mission_id = ? AND topic = 'operational' AND type = ?
          ORDER BY seq ASC`,
      )
      .all(orgId, missionId, JOURNAL_EVENT_TYPE) as Record<string, unknown>[];
    const events: JournaledEvent[] = [];
    for (const row of rows) {
      const payloadDigest = String(row.payload_digest);
      let payload: unknown;
      try {
        payload = JSON.parse(String(row.payload_json));
      } catch {
        throw new MissionEventError(
          'JOURNAL_TAMPERED',
          `journal seq ${String(row.seq)}: payload is not valid JSON`,
        );
      }
      const recomputed = digestOfJson(payload);
      if (recomputed !== payloadDigest) {
        throw new MissionEventError(
          'JOURNAL_TAMPERED',
          `journal seq ${String(row.seq)}: payload digest mismatch (stored ${payloadDigest}, recomputed ${recomputed})`,
        );
      }
      const record = payload as { event?: unknown; eventDigest?: unknown };
      const normalized = parseNormalizedEvent(record.event);
      if (
        typeof record.eventDigest !== 'string' ||
        eventDigest(normalized) !== record.eventDigest
      ) {
        throw new MissionEventError(
          'JOURNAL_TAMPERED',
          `journal seq ${String(row.seq)}: event digest does not match the stored normalized event`,
        );
      }
      events.push({
        journalSeq: Number(row.seq),
        event: normalized,
        eventDigest: record.eventDigest,
        recordedAt: String(row.recorded_at),
      });
    }
    // Continuity proof on EVERY reader (replay AND rehydrate): a journal with
    // a duplicated or regressed stream sequence is inconsistent and fails
    // closed — it is never silently accepted as a baseline.
    this.verifyStreamContinuity(events);
    return events;
  }

  private verifyStreamContinuity(rows: readonly JournaledEvent[]): void {
    const lastByStream = new Map<string, number>();
    for (const row of rows) {
      const key = streamKey(
        row.event.orgId,
        row.event.missionId,
        row.event.assetId,
        row.event.source.sourceId,
      );
      const last = lastByStream.get(key);
      if (last !== undefined && row.event.sequence !== last + 1) {
        throw new MissionEventError(
          'JOURNAL_TAMPERED',
          `journal replay found a sequence discontinuity in stream ${key}: ${row.event.sequence} after ${last}`,
        );
      }
      lastByStream.set(key, row.event.sequence);
    }
  }

  /**
   * Any string anywhere in the event (ids included) carrying a financial
   * authority term rejects the whole event: the physical channel must be
   * structurally unable to speak about money movement, so injected text can
   * never even reach the journal.
   */
  private rejectAuthorityTerms(event: NormalizedEvent): void {
    const scan = (label: string, value: string): void => {
      const term = containsAuthorityTerm(value);
      if (term !== undefined) {
        throw new MissionEventError(
          'AUTHORITY_TERMS_REJECTED',
          `${label} contains financial-authority term "${term}"; physical events cannot carry banking language`,
        );
      }
    };
    scan('eventId', event.eventId);
    scan('orgId', event.orgId);
    scan('missionId', event.missionId);
    scan('assetId', event.assetId);
    scan('source.sourceId', event.source.sourceId);
    scan('source.keyId', event.source.keyId);
    for (const [index, observation] of event.observations.entries()) {
      scan(`observations[${index}].kind`, observation.kind);
      if (typeof observation.value === 'string') {
        scan(`observations[${index}].value`, observation.value);
      }
    }
  }
}

/** Journal digest recomputation must match EvidenceService's canonical form. */
function digestOfJson(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/** Hydrated-scope identity (collision-safe JSON tuple, like the state keys). */
function scopeKey(orgId: string, missionId: string): string {
  return JSON.stringify([orgId, missionId]);
}
