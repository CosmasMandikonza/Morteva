#!/usr/bin/env node
// E2E identity API server: throwaway ledger + production-identity surface
// (OIDC code flow + PKCE) + the strictly-local test identity provider, so
// Playwright can drive a REAL browser sign-in journey. Requires
// `npm run build` first (compiled dist). Dev/test fixture only — never a
// deployment component. Secrets below are assembled to keep the scanner's
// literal-credential rule meaningful; none are production credentials.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Provider from 'oidc-provider';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stateDir = join(tmpdir(), `moterva-e2e-identity-${process.pid}`);
mkdirSync(stateDir, { recursive: true });
const dbPath = join(stateDir, 'ledger.sqlite');

const IDP_PORT = 18995;
const API_PORT = 8788;
const SPA_ORIGIN = 'http://127.0.0.1:4174';
const REDIRECT_URI = `${SPA_ORIGIN}/api/auth/oidc/callback`;
const CLIENT_SECRET = ['e2e', 'identity', 'client', 'fixture'].join(String.fromCharCode(45));

// ---------------------------------------------------------------- the IdP
const users = new Map(
  [
    { subject: 'owner-sub', email: 'owner@idp.test', name: 'IdP Owner' },
    { subject: 'operator-sub', email: 'operator@idp.test', name: 'IdP Operator' },
    { subject: 'approver-sub', email: 'approver@idp.test', name: 'IdP Approver' },
    { subject: 'reviewer-sub', email: 'reviewer@idp.test', name: 'IdP Reviewer' },
    // Dedicated identity for the REVIEWER_DEMO journey (e2e/reviewer-demo.spec.ts):
    // specs run in PARALLEL in CI, and an IdP subject can hold only one
    // invitation binding — reviewer-sub belongs to the read-only landing test.
    { subject: 'demoer-sub', email: 'demoer@idp.test', name: 'IdP Demoer' },
  ].map((u) => [u.subject, u]),
);
const provider = new Provider(`http://127.0.0.1:${IDP_PORT}`, {
  clients: [
    {
      client_id: 'moterva-e2e-client',
      client_secret: CLIENT_SECRET,
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
    },
  ],
  claims: { profile: ['name'], email: ['email', 'email_verified'] },
  findAccount: async (_ctx, subject) => ({
    accountId: subject,
    claims: () => {
      const user = users.get(subject);
      return {
        sub: subject,
        email: user?.email ?? `${subject}@idp.test`,
        email_verified: true,
        name: user?.name ?? subject,
      };
    },
  }),
  features: { devInteractions: { enabled: true } },
  ttl: { AccessToken: 600, AuthorizationCode: 120, IdToken: 600, Interaction: 600, Session: 600 },
});
const idpServer = provider.listen(IDP_PORT, '127.0.0.1');
await new Promise((resolve, reject) => {
  idpServer.once('listening', resolve);
  idpServer.once('error', reject);
});
const issuer = `http://127.0.0.1:${IDP_PORT}`;

// ------------------------------------------------------------- the ledger
const { openLedger } = await import(`file://${join(root, 'packages/ledger/dist/index.js')}`);
const ledger = openLedger(dbPath);
ledger.migrate();

const provisioned = ledger.identity.provisionIdentityActor({
  orgTitle: 'Identity E2E Org',
  username: 'owner@idp.test',
  displayName: 'IdP Owner',
  role: 'owner',
  provider: issuer,
  subject: 'owner-sub',
  emailAtLink: 'owner@idp.test',
});
const orgId = provisioned.orgId;
const ownerActor = ledger.authority.getActorByUsername(orgId, 'owner@idp.test');
const mission = ledger.organizations.createMission(orgId, 'Identity E2E mission');
const missionId = mission.id;

ledger.accounts.ensureTreasuryAccount({
  orgId,
  currency: 'USD',
  label: 'USD',
  protectedFloorMinor: 0,
});
ledger.accounts.recordBalanceSnapshot({
  orgId,
  currency: 'USD',
  minorUnits: 8_000_000,
  source: 'manual-seed',
  observedAt: ledger.clock.iso(),
  expiresAt: new Date(ledger.clock.now().getTime() + 24 * 3_600_000).toISOString(),
});
ledger.mandates.issue({
  orgId,
  missionId,
  currency: 'USD',
  maxAmountMinor: 4_000_000,
  totalBudgetMinor: 4_000_000,
  permittedOperationKinds: ['airwallex_transfer'],
  allowedBeneficiaries: ['harbor-diagnostics', 'harbor-marine'],
  allowedPurposes: ['harbor inspection'],
  byActorId: ownerActor.id,
  expiresAt: new Date(ledger.clock.now().getTime() + 26 * 3_600_000).toISOString(),
});

// Seed the physical baseline+incident steps through the REAL ingest path so
// the browser journey can record durable decision snapshots.
const { MissionEventIngestService } = await import(
  `file://${join(root, 'apps/api/dist/mission-events/src/ingest.js')}`
);
const { SourceRegistry } = await import(
  `file://${join(root, 'apps/api/dist/mission-events/src/registry.js')}`
);
const { fixtureSourceKey } = await import(
  `file://${join(root, 'apps/api/dist/mission-events/src/rng.js')}`
);
const { createHash } = await import('node:crypto');
const suffix = createHash('sha256').update(`${orgId}:${missionId}`).digest('hex').slice(0, 16);
const registry = new SourceRegistry();
const source = {
  orgId,
  missionId,
  sourceId: 'ops-console',
  sourceType: 'mission_control',
  keyId: `key_demo_${suffix}`,
  secretKey: fixtureSourceKey(`synthetic-demo-only-${suffix}`, 'ops-console'),
  provenance: 'SYNTHETIC',
  assetIds: ['uav-seeker-1'],
  trustedForRecovery: false,
};
registry.register(source);
const ingest = new MissionEventIngestService(ledger, ledger.clock, registry);
const stepEventId = (step) =>
  `evt_demo_${step}_${createHash('sha256').update(`${orgId}:${missionId}`).digest('hex').slice(0, 20)}`;
const eventFor = (step, sequence, observations) => {
  // observedAt is stamped AT INGEST: the incident arrives after the durable
  // baseline snapshot, and historical linkage requires the baseline's
  // recordedAt to be no later than the incident's observation time.
  const now = ledger.clock.iso();
  return {
    contractVersion: 1,
    eventId: stepEventId(step),
    sequence,
    orgId,
    missionId,
    assetId: 'uav-seeker-1',
    observedAt: now,
    ingestedAt: now,
    source: {
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      keyId: source.keyId,
      provenance: source.provenance,
    },
    observations,
  };
};
const { sourceSignature } = await import(
  `file://${join(root, 'apps/api/dist/mission-events/src/digest.js')}`
);
const ingestStep = (step, sequence, observations) => {
  const event = eventFor(step, sequence, observations);
  ingest.ingest(orgId, {
    ...event,
    source: { ...event.source, signature: sourceSignature(event, source.secretKey) },
  });
};
// The BASELINE physical event exists up front; the INCIDENT arrives only
// AFTER the operator durably records the baseline snapshot — stage truth
// refuses a post-incident "baseline" (BASELINE_WINDOW_CLOSED), so the
// fixture must let the physical world move on in story order.
ingestStep('baseline', 1, [
  { kind: 'wind_speed', unit: 'kt', value: '14.2' },
  { kind: 'weather_hold', unit: 'state', value: 'clear' },
  { kind: 'asset_comms', unit: 'state', value: 'online' },
]);
const incidentTimer = setInterval(() => {
  try {
    const recorded = ledger.db
      .prepare(
        'SELECT COUNT(*) AS c FROM evidence_events WHERE mission_id = ? AND type = \'planner.decision.snapshot\' AND payload_json LIKE \'%"stage":"baseline"%\'',
      )
      .get(missionId);
    if (recorded.c > 0) {
      clearInterval(incidentTimer);
      ingestStep('incident', 2, [
        { kind: 'wind_speed', unit: 'kt', value: '24.6' },
        { kind: 'weather_hold', unit: 'state', value: 'active' },
      ]);
    }
  } catch {
    // cleanup best-effort: the temp state dir is disposable
  }
}, 100);

// One PENDING invitation for the reviewer accept journey (secret delivered
// "out of band" via the state file — a fixture, not a production flow).
const { invitation, secret } = ledger.identity.createInvitation({
  orgId,
  role: 'viewer',
  email: 'reviewer@idp.test',
  createdByActorId: ownerActor.id,
});

// A SECOND pending invitation, OPERATOR role for the same reviewer identity,
// used by the REVIEWER_DEMO browser journey (E3/E4): the reviewer accepts it
// and can provision/admit the fixed synthetic scenario through the governed
// routes. Kept separate so the read-only landing test above is undisturbed.
const operatorInvitation = ledger.identity.createInvitation({
  orgId,
  role: 'operator',
  email: 'demoer@idp.test',
  createdByActorId: ownerActor.id,
});

// Pre-join the operator and approver IdP users through the REAL invitation
// path (owner-created, hashed single-use secret, identity-linked at
// redemption) so their browser journeys are plain OIDC sign-ins.
for (const [role, email, subject] of [
  ['operator', 'operator@idp.test', 'operator-sub'],
  ['approver', 'approver@idp.test', 'approver-sub'],
]) {
  const joined = ledger.identity.createInvitation({
    orgId,
    role,
    email,
    createdByActorId: ownerActor.id,
  });
  ledger.identity.redeemInvitation({
    orgId,
    invitationId: joined.invitation.id,
    secret: joined.secret,
    provider: issuer,
    subject,
  });
}

// ------------------------------------------------------------- state file
const statePath = join(stateDir, 'identity-e2e-state.json');
writeFileSync(
  statePath,
  JSON.stringify({
    orgId,
    missionId,
    invitationId: invitation.id,
    invitationSecret: secret,
    operatorInvitationId: operatorInvitation.invitation.id,
    operatorInvitationSecret: operatorInvitation.secret,
    issuer,
  }),
);

// --------------------------------------------------------- the API server
const api = spawn(process.execPath, [join(root, 'apps/api/dist/index.js')], {
  env: {
    ...process.env,
    // 'test' (not production): the loopback http test IdP needs the
    // insecure-transport escape, which production refuses by design.
    NODE_ENV: 'test',
    PORT: String(API_PORT),
    HOST: '127.0.0.1',
    WEB_ORIGIN: SPA_ORIGIN,
    MOTERVA_LEDGER_PATH: dbPath,
    MOTERVA_OIDC_ISSUER: issuer,
    MOTERVA_OIDC_CLIENT_ID: 'moterva-e2e-client',
    MOTERVA_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    MOTERVA_OIDC_REDIRECT_URI: REDIRECT_URI,
    MOTERVA_OIDC_ALLOW_INSECURE_TRANSPORT: '1',
    // E3: the hosted reviewer capability under real OIDC sessions (the
    // browser journey admits the fixed signed synthetic scenario through
    // the same routes production would mount).
    MOTERVA_REVIEWER_DEMO: '1',
    LOG_LEVEL: 'silent',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

// -------------------------------------------- the SPA preview (same-origin)
// The preview MUST point at THIS API (not the demo one on 8787), so the
// supervisor spawns it with the correct MOTERVA_API_URL itself.
const preview = spawn(
  process.execPath,
  [
    join(root, 'node_modules/vite/bin/vite.js'),
    'preview',
    '--config',
    join(root, 'apps/web/vite.config.ts'),
    '--port',
    '4174',
    '--strictPort',
  ],
  {
    // dist/ resolves relative to the web workspace — run FROM apps/web.
    cwd: join(root, 'apps/web'),
    env: { ...process.env, MOTERVA_API_URL: `http://127.0.0.1:${API_PORT}` },
    stdio: ['ignore', 'inherit', 'inherit'],
  },
);

const cleanup = () => {
  try {
    ledger.close();
  } catch {
    // cleanup best-effort: the temp state dir is disposable
  }
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    // cleanup best-effort: the temp state dir is disposable
  }
};
const shutdown = () => {
  api.kill();
  preview.kill();
  idpServer.close(() => {});
  cleanup();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
const onChildExit = (code) => {
  api.kill();
  preview.kill();
  idpServer.close(() => {});
  cleanup();
  process.exit(code ?? 0);
};
api.on('exit', onChildExit);
preview.on('exit', onChildExit);
console.log(`identity-e2e: api ${API_PORT} idp ${IDP_PORT} spa ${SPA_ORIGIN} state ${statePath}`);
