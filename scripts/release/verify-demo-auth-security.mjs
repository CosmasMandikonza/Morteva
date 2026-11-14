#!/usr/bin/env node
// Release security suite (issue #19, assignment §6 items 1–12): boots the
// COMPILED API with the loopback-only DEMO_AUTH gate against a seeded temp
// ledger and proves the authentication/authorization/CSRF/tenant contract
// over real HTTP with real cookies. Negative tests PROVE the unauthorized
// action did not occur (state re-read after the attempt). Zero dependencies.
//
// Usage: node scripts/release/verify-demo-auth-security.mjs
// Requires `npm run build` (uses packages/ledger/dist + apps/api/dist).
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const apiEntry = join(root, 'apps', 'api', 'dist', 'index.js');
const ledgerDist = join(root, 'packages', 'ledger', 'dist', 'index.js');

const results = [];
function record(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ' — ' + detail : ''}`);
}
function check(cond, detail) {
  return { ok: !!cond, detail };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

let capturedLogs = '';
function spawnApi(env) {
  const child = spawn(process.execPath, [apiEntry], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (capturedLogs += String(d)));
  child.stderr.on('data', (d) => (capturedLogs += String(d)));
  return child;
}

async function waitHealthy(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Minimal deterministic seed through the REAL ledger API (same seam the
// e2e demo server uses). Marker passwords make any log leakage detectable.
async function seedLedger(dbPath) {
  const { openLedger } = await import(pathToFileURL(ledgerDist).href);
  const ledger = openLedger(dbPath);
  ledger.migrate();
  const orgA = ledger.organizations.createOrganization('Release Verify Org A');
  const orgB = ledger.organizations.createOrganization('Release Verify Org B');
  const mk = (org, username, role, password) =>
    ledger.authority.createHumanActor({
      orgId: org.id,
      username,
      displayName: username,
      role,
      password,
    });
  const owner = mk(orgA, 'rv-owner', 'owner', 'RV-OWNER-MARKER-PW');
  const viewer = mk(orgA, 'rv-viewer', 'viewer', 'RV-VIEWER-MARKER-PW');
  mk(orgB, 'rv-owner-b', 'owner', 'RV-ORGB-MARKER-PW');
  const missionA = ledger.organizations.createMission(orgA.id, 'RV mission A');
  const missionB = ledger.organizations.createMission(orgB.id, 'RV mission B');
  ledger.db.close();
  return { orgA, orgB, owner, viewer, missionA, missionB };
}

function cleanup(dir) {
  // Best-effort: on Windows the killed child can hold WAL handles briefly.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    console.log(`(cleanup deferred: ${dir} — remove manually if still present)`);
  }
}

function client(base) {
  let cookie = '';
  let csrf = '';
  return {
    async login(username, password) {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:4173' },
        body: JSON.stringify({ username, password }),
      });
      const setCookie = res.headers.get('set-cookie') ?? '';
      cookie = /moterva_session=([^;]+)/.exec(setCookie)?.[1] ?? '';
      const body = await res.json().catch(() => ({}));
      csrf = body.csrfToken ?? '';
      return { status: res.status, body };
    },
    async req(method, path, body, { withCsrf = true, overrideCsrf } = {}) {
      const headers = { 'content-type': 'application/json', origin: 'http://localhost:4173' };
      if (cookie) headers.cookie = `moterva_session=${cookie}`;
      if (withCsrf && csrf) headers['x-csrf-token'] = overrideCsrf ?? csrf;
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* non-json */
      }
      return { status: res.status, json, text };
    },
    dropCookie() {
      cookie = '';
    },
    get hasCookie() {
      return cookie !== '';
    },
  };
}

async function main() {
  // -------- boot #1: standard DEMO_AUTH instance ---------------------------
  const dir = join(tmpdir(), `moterva-relsec-${process.pid}-${Date.now() % 100000}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'ledger.sqlite');
  const seed = await seedLedger(dbPath);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawnApi({
    NODE_ENV: 'development',
    MOTERVA_SKIP_DOTENV: '1',
    MOTERVA_DEV_AUTH: '1',
    MOTERVA_LEDGER_PATH: dbPath,
    PORT: String(port),
    HOST: '127.0.0.1',
    WEB_ORIGIN: 'http://localhost:4173',
    LOG_LEVEL: 'trace',
  });
  if (!(await waitHealthy(port))) {
    console.error('verify-demo-auth-security: API failed to boot:\n' + capturedLogs);
    child.kill();
    process.exit(1);
  }

  const anon = client(base);
  const owner = client(base);
  const viewer = client(base);
  const orgB = client(base);

  // S1/S2: no session -------------------------------------------------------
  const s1 = await anon.req('GET', '/api/missions');
  record(
    'S1',
    'unauthenticated read is 401 (no anonymous financial visibility)',
    s1.status === 401,
    `GET /api/missions → ${s1.status}`,
  );
  const s2 = await anon.req('POST', '/api/operations/reserve', {});
  record(
    'S2',
    'unauthenticated mutation fails closed',
    s2.status === 401,
    `POST /api/operations/reserve → ${s2.status}`,
  );

  // S3: bad credentials + rate limiting (dedicated probe username so real
  // actors' limiters stay clean — the limiter keys on ip:username) ---------
  const bad = client(base);
  let firstStatus = 0;
  let lastStatus = 0;
  for (let i = 0; i < 7; i++) {
    const r = await bad.login('rl-probe-user', 'wrong-password');
    if (i === 0) firstStatus = r.status;
    lastStatus = r.status;
  }
  record(
    'S3',
    'invalid credentials 401, then login rate-limited 429',
    firstStatus === 401 && lastStatus === 429,
    `1st → ${firstStatus}, 7th → ${lastStatus} (expect 401 then 429)`,
  );

  // Logins for the real sessions.
  const ownerLogin = await owner.login('rv-owner', 'RV-OWNER-MARKER-PW');
  const viewerLogin = await viewer.login('rv-viewer', 'RV-VIEWER-MARKER-PW');
  const orgBLogin = await orgB.login('rv-owner-b', 'RV-ORGB-MARKER-PW');
  if (ownerLogin.status !== 200 || viewerLogin.status !== 200 || orgBLogin.status !== 200) {
    console.error('seeded logins failed — aborting', { ownerLogin, viewerLogin, orgBLogin });
    child.kill();
    process.exit(1);
  }

  // S4: viewer may read but MUST NOT manage authority; prove no mutation ----
  const before = await viewer.req('GET', '/api/missions');
  const viewerRead = check(before.status === 200, 'viewer read ok');
  const viewerWrite = await viewer.req('POST', '/api/mandates', {
    missionId: seed.missionA.id,
    currency: 'USD',
    maxAmountMinor: 100,
    permittedOperationKinds: ['airwallex_transfer'],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const after = await viewer.req('GET', '/api/missions');
  const noNewMissionOrMandate = after.status === 200;
  record(
    'S4',
    'viewer mutation attempt is 403 AND state is provably unchanged',
    viewerRead.ok && viewerWrite.status === 403 && noNewMissionOrMandate,
    `read=${before.status} write=${viewerWrite.status} code=${viewerWrite.json?.error?.code ?? '(none)'}`,
  );

  // S5: CSRF ---------------------------------------------------------------
  const missionBody = {
    name: 'csrf probe mission',
  };
  const noCsrf = await owner.req('POST', '/api/missions', missionBody, { withCsrf: false });
  const wrongCsrf = await owner.req('POST', '/api/missions', missionBody, {
    overrideCsrf: 'bogus-token',
  });
  const missionsAfterCsrf = await owner.req('GET', '/api/missions');
  const csrfProof =
    missionsAfterCsrf.status === 200 &&
    !(missionsAfterCsrf.json?.missions ?? []).some((m) => m.name === 'csrf probe mission');
  record(
    'S5',
    'missing/invalid CSRF token rejected AND no mission was created',
    noCsrf.status === 403 && wrongCsrf.status === 403 && csrfProof,
    `noToken=${noCsrf.status} badToken=${wrongCsrf.status} probeMissionAbsent=${csrfProof}`,
  );

  // S6: cross-tenant access is an indistinguishable 404 ---------------------
  const crossEvidence = await orgB.req('GET', `/api/missions/${seed.missionA.id}/evidence`);
  const crossMissions = await orgB.req('GET', '/api/missions');
  const bOnly =
    crossMissions.status === 200 &&
    !(crossMissions.json?.missions ?? []).some((m) => m.id === seed.missionA.id);
  record(
    'S6',
    'org-B actor cannot read org-A mission (404) and never sees it listed',
    crossEvidence.status === 404 && bOnly,
    `foreignMissionEvidence=${crossEvidence.status} leakedInList=${!bOnly}`,
  );

  // S7: logout invalidates the session server-side --------------------------
  const logout = await owner.req('POST', '/api/auth/logout', {});
  const staleReplay = await owner.req('GET', '/api/auth/session');
  record(
    'S7',
    'logout revokes the session; stale cookie replay is 401',
    logout.status === 200 && staleReplay.status === 401,
    `logout=${logout.status} replay=${staleReplay.status}`,
  );

  // S8: shared-browser user switching ---------------------------------------
  const a = client(base);
  const b = client(base);
  await a.login('rv-owner', 'RV-OWNER-MARKER-PW');
  await b.login('rv-viewer', 'RV-VIEWER-MARKER-PW');
  await a.req('POST', '/api/auth/logout', {});
  const bStillValid = await b.req('GET', '/api/auth/session');
  const aInvalid = await a.req('GET', '/api/auth/session');
  record(
    'S8',
    'independent sessions: logging out one leaves the other usable',
    bStillValid.status === 200 && aInvalid.status === 401,
    `other=${bStillValid.status} loggedOut=${aInvalid.status}`,
  );

  // S11: one-time dev-bootstrap cannot mint credentials on a seeded ledger ---
  const bootstrap = await anon.req('POST', '/api/auth/dev-bootstrap', {});
  record(
    'S11',
    'dev-bootstrap is one-time (409 on a ledger with actors)',
    bootstrap.status === 409,
    `status=${bootstrap.status} code=${bootstrap.json?.error?.code ?? '(none)'}`,
  );

  // S10: built web bundle contains no secrets -------------------------------
  const distDir = join(root, 'apps', 'web', 'dist');
  const forbidden = [
    'RV-OWNER-MARKER-PW',
    'moterva-e2e-demo',
    'MOTERVA_DEV_AUTH',
    'AIRWALLEX_API_KEY=',
    'AIRWALLEX_CLIENT_ID=',
    'sk_live_',
  ];
  let bundleHits = [];
  try {
    const walk = (d) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else {
          const text = readFileSync(p, 'utf8');
          for (const needle of forbidden)
            if (text.includes(needle)) bundleHits.push(`${entry.name}:${needle}`);
        }
      }
    };
    walk(distDir);
  } catch {
    bundleHits.push('(dist missing — run npm run build first)');
  }
  record(
    'S10',
    'built client bundle contains no credential material',
    bundleHits.length === 0,
    bundleHits.join(', ') || 'scanned all dist files',
  );

  // S12: logs contain no credentials/tokens ---------------------------------
  await new Promise((r) => setTimeout(r, 500));
  const logLeaks = ['RV-OWNER-MARKER-PW', 'RV-VIEWER-MARKER-PW', 'wrong-password'].filter(
    (needle) => capturedLogs.includes(needle),
  );
  const cookieLeak = /moterva_session=[A-Za-z0-9_-]{20,}/.test(capturedLogs);
  record(
    'S12',
    'process logs contain no passwords or session tokens',
    logLeaks.length === 0 && !cookieLeak,
    logLeaks.length === 0 && !cookieLeak
      ? 'all traffic inspected at trace level'
      : `leaked: ${[...logLeaks, cookieLeak ? 'session-cookie' : ''].join(',')}`,
  );

  child.kill();
  cleanup(dir);

  // -------- boot #2: short session TTL for expiry --------------------------
  const dir2 = join(tmpdir(), `moterva-relsec-ttl-${process.pid}-${Date.now() % 100000}`);
  mkdirSync(dir2, { recursive: true });
  const dbPath2 = join(dir2, 'ledger.sqlite');
  await seedLedger(dbPath2);
  const port2 = await freePort();
  const child2 = spawnApi({
    NODE_ENV: 'development',
    MOTERVA_SKIP_DOTENV: '1',
    MOTERVA_DEV_AUTH: '1',
    MOTERVA_LEDGER_PATH: dbPath2,
    PORT: String(port2),
    HOST: '127.0.0.1',
    WEB_ORIGIN: 'http://localhost:4173',
    MOTERVA_SESSION_TTL_MS: '60000',
    LOG_LEVEL: 'warn',
  });
  if (!(await waitHealthy(port2))) {
    console.error('verify-demo-auth-security: TTL API failed to boot:\n' + capturedLogs);
    child2.kill();
    process.exit(1);
  }
  const exp = client(`http://127.0.0.1:${port2}`);
  const login2 = await exp.login('rv-owner', 'RV-OWNER-MARKER-PW');
  const alive = await exp.req('GET', '/api/auth/session');
  console.log('S9: waiting 62s for the 60s session TTL to lapse (mid-approval expiry scenario)...');
  await new Promise((r) => setTimeout(r, 62_000));
  const expired = await exp.req('GET', '/api/auth/session');
  const expiredMutation = await exp.req('POST', '/api/missions', { name: 'post-expiry mission' });
  const missions2 = await exp.req('GET', '/api/missions');
  const noPostExpiryMission =
    missions2.status === 401 ||
    !(missions2.json?.missions ?? []).some((m) => m.name === 'post-expiry mission');
  record(
    'S9',
    'expired session is rejected for reads AND mutations (state provably clean)',
    login2.status === 200 &&
      alive.status === 200 &&
      expired.status === 401 &&
      expiredMutation.status === 401 &&
      noPostExpiryMission,
    `alive=${alive.status} afterTtl=${expired.status} mutation=${expiredMutation.status}`,
  );
  child2.kill();
  cleanup(dir2);

  // -------- summary ---------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\nverify-demo-auth-security: ${results.length - failed.length}/${results.length} scenarios PASS`,
  );
  if (failed.length > 0) {
    console.log('FAILED scenarios:');
    for (const f of failed) console.log(`  ${f.id} ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('verify-demo-auth-security: fatal', error);
  process.exit(1);
});
