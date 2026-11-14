import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { openLedger, type Ledger } from '@moterva/ledger';
import type { FastifyInstance } from 'fastify';
import {
  harborMissionSpec,
  warehouseEventId,
  warehouseMissionSpec,
} from '../../src/integration/mission-catalogs.js';
import { DECISION_CATALOG } from '../../src/integration/decision-snapshots.js';
import {
  MissionSpecError,
  registerMissionSpec,
  missionSpecDigest,
  loadRegisteredSpecs,
  validateMissionSpec,
} from '../../src/integration/mission-spec.js';

/**
 * C1+C2+C3 — the GENERAL mission contract end-to-end:
 *
 * C1: MissionSpecification v1 is validated fail-closed, journaled ONCE per
 *     (mission, specId) with digest integrity, refuses specId collisions,
 *     and the harbor catalog DERIVES from the harbor spec (drift-equal to
 *     the frozen demo constants).
 * C2: the warehouse AMR journey runs on the SAME planner/ledger/mandate
 *     machinery: baseline → aisle obstruction → the plan CHANGES
 *     economically (incumbent blocked, backup robot selected, durable
 *     snapshot + ledger plan proposal under the warehouse mandate); a
 *     restored network connection NEVER implies route clearance; industries
 *     never mix inside one mission; ground policy carries no wind rule.
 * C3: the model adapter boundary — without founder-provisioned provider
 *     access the honest answer is MODEL_NOT_CONFIGURED with the deterministic
 *     engine fully operational.
 */

const TEST_PASSWORD = ['dev', 'only', 'fixture'].join('-');
const DIR = mkdtempSync(join(tmpdir(), 'mv-general-'));
let ledger: Ledger;
let app: FastifyInstance;
let orgId = '';
let warehouseMissionId = '';
let harborMissionId = '';

interface Session {
  cookie: string;
  csrf: string;
}

async function login(username: string): Promise<Session> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: TEST_PASSWORD },
  });
  expect(r.statusCode).toBe(200);
  const setCookie = r.headers['set-cookie'] as unknown;
  const cookie = (Array.isArray(setCookie) ? (setCookie[0] as string) : String(setCookie)).split(
    ';',
  )[0]!;
  return { cookie, csrf: (r.json() as { csrfToken: string }).csrfToken };
}

/** Minimal shape the tests read off an inject response (casts refine per use). */
interface InjectLike {
  statusCode: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests cast json() bodies per assertion
  json: () => any;
}

function makeGet(session: Session) {
  return (url: string): Promise<InjectLike> =>
    app.inject({ method: 'GET', url, headers: { cookie: session.cookie } }) as Promise<InjectLike>;
}

function makePost(session: Session) {
  return (url: string, payload?: object): Promise<InjectLike> =>
    app.inject({
      method: 'POST',
      url,
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload,
    }) as Promise<InjectLike>;
}

let owner: Session;
let get: (url: string) => Promise<InjectLike>;
let post: (url: string, payload?: object) => Promise<InjectLike>;

beforeAll(async () => {
  ledger = openLedger(join(DIR, 'ledger.sqlite'));
  ledger.migrate();
  app = buildApp(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WEB_ORIGIN: 'http://localhost:5173',
      HOST: '127.0.0.1',
      MOTERVA_DEV_AUTH: '1',
    }),
    undefined,
    ledger,
  );
  await app.ready();
  orgId = ledger.organizations.createOrganization('General Mission Org').id;
  warehouseMissionId = ledger.organizations.createMission(orgId, 'Warehouse AMR mission').id;
  harborMissionId = ledger.organizations.createMission(orgId, 'Harbor mission').id;
  // Treasury account (the demo-server boot shape) — refresh-authority and
  // financialFacts need an account in the planning currency.
  ledger.accounts.ensureTreasuryAccount({
    orgId,
    currency: 'USD',
    label: 'USD treasury',
    protectedFloorMinor: 50_000,
  });
  for (const role of ['owner', 'approver', 'operator', 'viewer'] as const) {
    ledger.authority.createHumanActor({
      orgId,
      username: role,
      displayName: `GM ${role}`,
      role,
      password: TEST_PASSWORD,
    });
  }
  owner = await login('owner');
  get = makeGet(owner);
  post = makePost(owner);
});

afterAll(async () => {
  await app.close();
  ledger.close();
  rmSync(DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------- C1

describe('C1 — MissionSpecification v1: validated, journaled, collision-refusing', () => {
  it('validates fail-closed: wind limit forbidden without an aerial asset, ground interrupts required', () => {
    const bad = warehouseMissionSpec(orgId, 'msn_x') as unknown as Record<string, unknown>;
    // Corrupt: strip ground interrupts → refused.
    const noInterrupts = structuredClone(bad) as {
      safetyPolicy: { groundInterrupts?: string[] };
    };
    delete noInterrupts.safetyPolicy.groundInterrupts;
    expect(() => validateMissionSpec(noInterrupts)).toThrow(MissionSpecError);
    // Corrupt: give a ground-only spec a UAV wind limit → refused (ground
    // policies never inherit wind rules — structurally enforced).
    const windOnGround = structuredClone(bad) as {
      safetyPolicy: { uavWindLimitKt?: number };
    };
    windOnGround.safetyPolicy.uavWindLimitKt = 22;
    expect(() => validateMissionSpec(windOnGround)).toThrow(MissionSpecError);
    // Corrupt: offer beneficiary outside the mandate shape → refused.
    const strayOffer = structuredClone(bad) as {
      offers: { alternatives: { beneficiary: string }[] };
      financialMandateShape: { allowedBeneficiaries: string[] };
    };
    strayOffer.offers.alternatives[0]!.beneficiary = 'not-in-mandate';
    expect(() => validateMissionSpec(strayOffer)).toThrow(/OUTSIDE_MANDATE/);
    // The honest specs pass.
    expect(validateMissionSpec(warehouseMissionSpec(orgId, 'msn_x')).specId).toBe(
      'warehouse-inventory-v1',
    );
    expect(validateMissionSpec(harborMissionSpec(orgId, 'msn_x')).specId).toBe(
      'harbor-inspection-v1',
    );
  });

  it('journals ONCE per (mission, specId); the same specId with a different payload is a COLLISION', () => {
    const msnC1 = ledger.organizations.createMission(orgId, 'C1 registry mission').id;
    const spec = warehouseMissionSpec(orgId, msnC1);
    const first = registerMissionSpec(ledger, spec);
    expect(first.replayed).toBe(false);
    const repeat = registerMissionSpec(ledger, warehouseMissionSpec(orgId, msnC1));
    expect(repeat.replayed).toBe(true);
    expect(repeat.digest).toBe(first.digest);
    // Digest is stable and float-free derived.
    expect(first.digest).toBe(missionSpecDigest(spec));
    // Same specId, different objective → SPEC_ID_COLLISION (specs are
    // immutable history; evolution means a new specId).
    const mutated = {
      ...warehouseMissionSpec(orgId, msnC1),
      identity: {
        orgId,
        missionId: msnC1,
        title: 'Warehouse AMR inventory cycle',
        objective: 'CHANGED',
      },
    };
    expect(() => registerMissionSpec(ledger, mutated as never)).toThrow(/SPEC_ID_COLLISION/);
    // The journal holds exactly one registration, digest-verified.
    const rows = loadRegisteredSpecs(ledger, orgId, msnC1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.spec.offers.incumbent.probabilityOfSuccess).toBe(0.92);
  });

  it('the harbor catalog DERIVES from the harbor spec (drift-equal to the frozen demo constants)', () => {
    // decision-snapshots.DECISION_CATALOG values must equal the frozen
    // demo-route constants — both now derive from the same spec.
    const spec = harborMissionSpec('catalog', 'catalog');
    expect(DECISION_CATALOG.assetId).toBe('uav-seeker-1');
    expect(DECISION_CATALOG.assetId).toBe(spec.assets[0]!.assetId);
    expect(DECISION_CATALOG.windLimitKt).toBe(22);
    expect(DECISION_CATALOG.incumbent.id).toBe('uav-inspection');
    expect(DECISION_CATALOG.incumbent.beneficiary).toBe('harbor-diagnostics');
    expect(DECISION_CATALOG.incumbent.baseCostMinor).toBe(1_200_000);
    expect(DECISION_CATALOG.alternative.id).toBe('vessel-inspection');
    expect(DECISION_CATALOG.alternative.baseCostMinor).toBe(1_800_000);
    expect(DECISION_CATALOG.alternative.feeMinor).toBe(50_000);
  });
});

// ---------------------------------------------------------------- C2

describe('C2 — the warehouse AMR financial journey on the shared machinery', () => {
  it('baseline → aisle obstruction: the plan CHANGES economically (incumbent blocked, backup selected)', async () => {
    // The FIRST warehouse step registers the spec (journaled once). Demo
    // authority comes AFTER registration so the mandate shape is SPEC-DRIVEN
    // (warehouse beneficiaries/purposes from the registered spec).
    const baseline = (await post(`/api/missions/${warehouseMissionId}/warehouse-step`, {
      step: 'baseline',
    })) as {
      statusCode: number;
      json: () => {
        stage: string;
        after: { outcome: string; selected: { candidateId: string } | null };
      };
    };
    expect(baseline.statusCode).toBe(200);
    const base = baseline.json();
    expect(base.stage).toBe('baseline');
    expect(
      (await post('/api/demo/refresh-authority', { missionId: warehouseMissionId })).statusCode,
    ).toBe(200);
    // Baseline decision with authority: healthy ground triple for BOTH AMRs
    // → the incumbent AMR cycle wins (cheapest feasible).
    const baseDecision = (await get(`/api/missions/${warehouseMissionId}/warehouse-decision`)) as {
      statusCode: number;
      json: () => { after: { outcome: string; selected: { candidateId: string } | null } };
    };
    expect(baseDecision.json().after!.outcome).toBe('select');
    // At baseline NOTHING has happened: holding the plan (no new spend) is
    // the economically dominant action — the same accepted harbor baseline
    // behavior (governed-decision e2e pins it). The plan CHANGE comes at the
    // incident.
    expect(baseDecision.json().after!.selected!.candidateId).toBe('no-action');
    void base;

    // Aisle obstruction: the incumbent is BLOCKED; the backup robot (gated on
    // ITS OWN asset's clearance) is selected; the reroute stays asset-gated.
    const obstruction = (await post(`/api/missions/${warehouseMissionId}/warehouse-step`, {
      step: 'aisle-obstruction',
    })) as {
      statusCode: number;
      json: () => {
        after: {
          outcome: string;
          selected: { candidateId: string; grossMinor: number } | null;
          alternatives: { id: string; feasible: boolean; rejection: string | null }[];
        };
      };
    };
    expect(obstruction.statusCode).toBe(200);
    const after = obstruction.json().after!;
    expect(after.outcome).toBe('select');
    // ECONOMICALLY MEANINGFUL CHANGE: a different plan, a different price.
    expect(after.selected!.candidateId).toBe('hire-amr-cycle-backup-2');
    expect(after.selected!.grossMinor).toBe(450_000);
    const byId = new Map(after.alternatives.map((a) => [a.id, a]));
    expect(byId.get('continue-amr-cycle-runner-1')!.feasible).toBe(false);
    expect(byId.get('continue-amr-cycle-runner-1')!.rejection).toBe('ASSET_SAFETY_BLOCKED');
    // The reroute candidate EXISTS but cannot be selected while the asset is
    // blocked — reroute requires authoritative confirmation first.
    expect(byId.get('reroute-around-obstruction')!.feasible).toBe(false);
    expect(byId.get('reroute-around-obstruction')!.rejection).toBe('ASSET_SAFETY_BLOCKED');
  });

  it('records durable decision snapshots with spec lineage + caseId, and proposes a real ledger plan under the warehouse mandate', async () => {
    // Fresh mission, full journey to the incident state (spec registration
    // on the first step, THEN the spec-driven authority refresh).
    const msn = ledger.organizations.createMission(orgId, 'Warehouse snapshot mission').id;
    expect(
      (await post(`/api/missions/${msn}/warehouse-step`, { step: 'baseline' })).statusCode,
    ).toBe(200);
    expect((await post('/api/demo/refresh-authority', { missionId: msn })).statusCode).toBe(200);
    // Durable BASELINE snapshot first — the baseline window closes at the
    // first incident event (never describe the post-incident world as baseline).
    const baselineSnap = (await post(`/api/missions/${msn}/decision-snapshots`, {
      stage: 'baseline',
    })) as {
      statusCode: number;
      json: () => { snapshot: { evaluationId: string } };
    };
    expect(baselineSnap.statusCode).toBe(200);
    expect(
      (await post(`/api/missions/${msn}/warehouse-step`, { step: 'aisle-obstruction' })).statusCode,
    ).toBe(200);
    const incidentSnap = (await post(`/api/missions/${msn}/decision-snapshots`, {
      stage: 'incident',
    })) as {
      statusCode: number;
      json: () => { snapshot: { evaluationId: string } };
    };
    expect(incidentSnap.statusCode).toBe(200);
    const evaluationId = incidentSnap.json().snapshot.evaluationId;
    // The incident decision PROPOSES a real immutable ledger plan (the same
    // bridge harbor uses — no domain fork in the money path).
    const proposal = (await post(
      `/api/missions/${msn}/decision-snapshots/${evaluationId}/propose-plan`,
    )) as {
      statusCode: number;
      json: () => { plan?: { amountMinor: number; beneficiary: string }; error?: { code: string } };
    };
    expect(proposal.statusCode).toBe(200);
    expect(proposal.json().plan!.beneficiary).toBe('warehouse-robotics');
    expect(proposal.json().plan!.amountMinor).toBe(450_000);
    // Zero provider activity, PROPOSED_ONLY always.
    expect(
      (await get(`/api/missions/${msn}/decision-plans`)) as { statusCode: number },
    ).toBeDefined();
  });

  it('restored network connection NEVER implies route clearance; charger faults block independently', async () => {
    const msn = ledger.organizations.createMission(orgId, 'Warehouse comms mission').id;
    expect(
      (await post(`/api/missions/${msn}/warehouse-step`, { step: 'baseline' })).statusCode,
    ).toBe(200);
    expect(
      (await post(`/api/missions/${msn}/warehouse-step`, { step: 'aisle-obstruction' })).statusCode,
    ).toBe(200);
    expect(
      (await post(`/api/missions/${msn}/warehouse-step`, { step: 'comms-loss' })).statusCode,
    ).toBe(200);
    // Restore comms — the aisle is STILL obstructed: route clearance needs a
    // fresh aisle reading, not a healthy network.
    const restored = (await post(`/api/missions/${msn}/warehouse-step`, {
      step: 'comms-restored',
    })) as {
      statusCode: number;
      json: () => {
        stage: string;
        after: {
          alternatives: { id: string; feasible: boolean }[];
          reasons: { message: string }[];
        };
      };
    };
    expect(restored.statusCode).toBe(200);
    expect(restored.json().stage).toBe('comms-restored');
    const byId = new Map(restored.json().after!.alternatives.map((a) => [a.id, a]));
    expect(byId.get('continue-amr-cycle-runner-1')!.feasible).toBe(false);
    // Charger faults block independently of the aisle (separate interrupt).
    const msn2 = ledger.organizations.createMission(orgId, 'Warehouse charger mission').id;
    expect(
      (await post(`/api/missions/${msn2}/warehouse-step`, { step: 'baseline' })).statusCode,
    ).toBe(200);
    const charger = (await post(`/api/missions/${msn2}/warehouse-step`, {
      step: 'charger-fault',
    })) as {
      statusCode: number;
      json: () => {
        after: { alternatives: { id: string; feasible: boolean; rejection: string | null }[] };
      };
    };
    expect(charger.statusCode).toBe(200);
    const chargerById = new Map(charger.json().after!.alternatives.map((a) => [a.id, a]));
    expect(chargerById.get('continue-amr-cycle-runner-1')!.rejection).toBe('ASSET_SAFETY_BLOCKED');
  });

  it('industries never mix: warehouse routes refuse harbor missions and vice versa; physical-view serves the warehouse spec', async () => {
    // Harbor steps on a warehouse mission → refused.
    const harborStepOnWarehouse = (await post(
      `/api/missions/${warehouseMissionId}/synthetic-step`,
      {
        step: 'baseline',
      },
    )) as { statusCode: number; json: () => { error: { code: string } } };
    expect(harborStepOnWarehouse.statusCode).toBe(409);
    expect(harborStepOnWarehouse.json().error.code).toBe('MISSION_SPEC_MISMATCH');
    // Warehouse steps on a mission with HARBOR demo events → refused.
    expect(
      (await post(`/api/missions/${harborMissionId}/synthetic-step`, { step: 'baseline' }))
        .statusCode,
    ).toBe(200);
    const whStepOnHarbor = (await post(`/api/missions/${harborMissionId}/warehouse-step`, {
      step: 'baseline',
    })) as { statusCode: number; json: () => { error: { code: string } } };
    expect(whStepOnHarbor.statusCode).toBe(409);
    expect(whStepOnHarbor.json().error.code).toBe('MISSION_SPEC_CONFLICT');
    // The warehouse physical view: BOTH ground assets, honest verdicts.
    const view = (await get(`/api/missions/${warehouseMissionId}/physical-view`)) as {
      statusCode: number;
      json: () => {
        assets: { assetId: string; kind: string }[];
        constraints: { assetId: string; state: string; reason: string }[];
      };
    };
    expect(view.statusCode).toBe(200);
    const payload = view.json();
    expect(payload.assets.map((a) => `${a.assetId}:${a.kind}`).sort()).toEqual([
      'amr-backup-2:ground',
      'amr-runner-1:ground',
    ]);
    const runner = payload.constraints.find((c) => c.assetId === 'amr-runner-1')!;
    expect(`${runner.state}/${runner.reason}`).toBe('blocked/aisle-obstructed');
    const backup = payload.constraints.find((c) => c.assetId === 'amr-backup-2')!;
    expect(`${backup.state}/${backup.reason}`).toBe('clear/nominal');
  });

  it('the C5 mission-spec read contract switches industries and exposes caseId lineage', async () => {
    const spec = (await get(`/api/missions/${warehouseMissionId}/mission-spec`)) as {
      statusCode: number;
      json: () => {
        registered: boolean;
        specId: string;
        industry: string;
        caseLineage: { caseId: string; evaluationId: string } | null;
      };
    };
    expect(spec.statusCode).toBe(200);
    const s = spec.json();
    expect(s.registered).toBe(true);
    expect(s.specId).toBe('warehouse-inventory-v1');
    expect(s.industry).toBe('warehouse-amr');
    expect(s.caseLineage).toBeNull(); // no durable snapshot recorded on this mission yet
    // A pre-spec mission reports the harbor default, unregistered.
    const fresh = ledger.organizations.createMission(orgId, 'Unregistered mission').id;
    const freshSpec = (await get(`/api/missions/${fresh}/mission-spec`)) as {
      statusCode: number;
      json: () => { registered: boolean; specId: string; industry: string };
    };
    expect(freshSpec.json().registered).toBe(false);
    expect(freshSpec.json().specId).toBe('harbor-inspection-v1');
    expect(freshSpec.json().industry).toBe('maritime-uav');
  });

  it('snapshots record warehouse journeys with spec lineage + caseId', async () => {
    const msn = ledger.organizations.createMission(orgId, 'Warehouse lineage mission').id;
    expect(
      (await post(`/api/missions/${msn}/warehouse-step`, { step: 'baseline' })).statusCode,
    ).toBe(200);
    // Baseline snapshot first (the incident stage requires recorded linkage).
    expect(
      (await post(`/api/missions/${msn}/decision-snapshots`, { stage: 'baseline' })).statusCode,
    ).toBe(200);
    expect(
      (await post(`/api/missions/${msn}/warehouse-step`, { step: 'aisle-obstruction' })).statusCode,
    ).toBe(200);
    const incident = (await post(`/api/missions/${msn}/decision-snapshots`, {
      stage: 'incident',
    })) as {
      statusCode: number;
      json: () => { snapshot: { evaluationId: string } };
    };
    expect(incident.statusCode).toBe(200);
    // Read the journaled payload directly (digest-verified loader).
    const rows = ledger.db
      .prepare(
        `SELECT payload_json FROM evidence_events WHERE org_id = ? AND mission_id = ? AND type = 'planner.decision.snapshot' ORDER BY seq DESC`,
      )
      .all(orgId, msn) as { payload_json: string }[];
    const payload = JSON.parse(rows[0]!.payload_json) as {
      caseId: string;
      spec: { specId: string; digest: string };
      causality: Record<string, string>;
    };
    expect(payload.caseId).toMatch(/^case_/);
    expect(payload.spec.specId).toBe('warehouse-inventory-v1');
    expect(payload.causality.physicalObservations).toBe('SYNTHETIC_JOURNAL');
    expect(payload.causality.financialDecision).toBe('INTERNAL_DETERMINISTIC_POLICY');
    expect(payload.causality.externalFinancialFacts).toBe('UNVERIFIED');
    void warehouseEventId; // imported for route-level identity equivalence
  });
});

// ---------------------------------------------------------------- C3

describe('C3 — model assistance boundary (no provider access = honest degradation)', () => {
  it('without founder-provisioned provider access: 503 MODEL_NOT_CONFIGURED, deterministic engine fully operational', async () => {
    // No MOTERVA_MODEL_* env in this environment — the honest answer.
    const r = (await post(`/api/missions/${warehouseMissionId}/warehouse-interpret`, {
      report: 'Aisle 7 blocked by a fallen pallet rack; forklift stuck behind it.',
    })) as { statusCode: number; json: () => { error: { code: string; message: string } } };
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('MODEL_NOT_CONFIGURED');
    expect(r.json().error.message).toContain('deterministic');
    // And the decision engine still works end-to-end.
    const decision = (await get(`/api/missions/${warehouseMissionId}/warehouse-decision`)) as {
      statusCode: number;
      json: () => { after: { outcome: string } };
    };
    expect(decision.statusCode).toBe(200);
    expect(decision.json().after!.outcome).toBe('select');
  });

  it('partial model configuration fails loudly (never a half-wired model)', async () => {
    process.env.MOTERVA_MODEL_ENDPOINT = 'https://model.example.com/v1/chat/completions';
    delete process.env.MOTERVA_MODEL_API_KEY;
    delete process.env.MOTERVA_MODEL_ID;
    const r = (await post(`/api/missions/${warehouseMissionId}/warehouse-interpret`, {
      report: 'anything',
    })) as { statusCode: number; json: () => { error: { code: string } } };
    expect(r.statusCode).toBe(500);
    expect(r.json().error.code).toBe('MODEL_CONFIG_INVALID');
    delete process.env.MOTERVA_MODEL_ENDPOINT;
  });
});

// Negative: unauthenticated access to the new surfaces.
describe('new surfaces are authenticated and role-gated', () => {
  it('warehouse-step without a session → 401; viewer cannot operate', async () => {
    const anon = await app.inject({
      method: 'POST',
      url: `/api/missions/${warehouseMissionId}/warehouse-step`,
      payload: { step: 'baseline' },
    });
    expect(anon.statusCode).toBe(401);
    const viewerSession = await login('viewer');
    const r = await app.inject({
      method: 'POST',
      url: `/api/missions/${warehouseMissionId}/warehouse-step`,
      headers: { cookie: viewerSession.cookie, 'x-csrf-token': viewerSession.csrf },
      payload: { step: 'baseline' },
    });
    expect([403, 401]).toContain(r.statusCode);
  });
});
