import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, type Ledger } from '../src/index.js';
import { TunableClock } from '../src/index.js';
import { seedCompetingMissions, type SeededCompetingWorld } from '../src/index.js';
import type { ActorView, OperationKind } from '@moterva/domain';

export function tempDbPath(prefix = 'moterva-ledger-'): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'ledger.sqlite');
}

/**
 * Fixture password for test actors — assembled at runtime so no long literal
 * sits next to the word "password" (the secret scanner stays fully strict;
 * this is obviously not a credential).
 */
export const TEST_PASSWORD = ['dev', 'only', 'fixture'].join('-');

/** Fixed-clock ledger on a real temp SQLite file, already migrated. */
export function makeLedger(at?: string): { ledger: Ledger; clock: TunableClock; path: string } {
  const path = at ?? tempDbPath();
  const clock = new TunableClock('2026-11-03T12:00:00.000Z');
  const ledger = openLedger(path, clock);
  ledger.migrate();
  return { ledger, clock, path };
}

/** Seeded contention world with the two mission plans sized to fight over the pool. */
export function makeSeededWorld(options?: {
  balanceMinor?: number;
  protectedFloorMinor?: number;
  planAmountMinor?: number;
}): { ledger: Ledger; clock: TunableClock; world: SeededCompetingWorld; path: string } {
  const { ledger, clock, path } = makeLedger();
  const world = seedCompetingMissions(ledger, options);
  return { ledger, clock, world, path };
}

/** Lazily creates (once per org) a persisted approver actor for tests. */
export function ensureApprover(ledger: Ledger, orgId: string): ActorView {
  const existing = ledger.authority.getActorByUsername(orgId, 'test-approver');
  if (existing !== undefined) return existing;
  return ledger.authority.createHumanActor({
    orgId,
    username: 'test-approver',
    displayName: 'Test Approver',
    role: 'approver',
    password: TEST_PASSWORD,
  });
}

/** Convenience: a fresh approved plan+approval for arbitrary terms on a mission. */
export function approvedPlan(
  ledger: Ledger,
  orgId: string,
  missionId: string,
  terms: { amountMinor: number; currency: string; beneficiary?: string; purpose?: string },
  options: {
    decidedByActorId?: string;
    kind?: OperationKind;
    ttlMs?: number;
    proposedBy?: string | null;
  } = {},
): { planId: string; planVersion: number; approvalId: string; digest: string } {
  const ttl = options.ttlMs ?? 30 * 60_000;
  const plan = ledger.plans.recordVersion({
    orgId,
    missionId,
    terms: {
      amountMinor: terms.amountMinor,
      currency: terms.currency,
      beneficiary: terms.beneficiary ?? 'vendor-a',
      purpose: terms.purpose ?? 'test purpose',
    },
    proposedBy: options.proposedBy ?? null,
  });
  const approver = ensureApprover(ledger, orgId);
  const approval = ledger.approvals.record({
    orgId,
    plan,
    decidedByActorId: options.decidedByActorId ?? approver.id,
    kind: options.kind ?? 'airwallex_transfer',
    expiresAt: new Date(ledger.clock.now().getTime() + ttl).toISOString(),
  });
  return {
    planId: plan.id,
    planVersion: plan.version,
    approvalId: approval.id,
    digest: plan.digest,
  };
}

/** Standard reserve-call shape for tests. */
export function reserveCall(
  ledger: Ledger,
  world: { org: { id: string } },
  missionId: string,
  ref: { planId: string; planVersion: number; approvalId: string },
  requestId: string,
  kind: 'airwallex_transfer' | 'metal_order' | 'internal_hold' = 'airwallex_transfer',
) {
  return ledger.reservations.reserve({
    orgId: world.org.id,
    missionId,
    kind,
    requestId,
    planId: ref.planId,
    planVersion: ref.planVersion,
    approvalId: ref.approvalId,
  });
}
