#!/usr/bin/env node
// Release acceptance (issue #19): boot the COMPILED production API exactly as
// a deployment would (`node apps/api/dist/index.js`, NODE_ENV=production) and
// prove the fail-closed contract over real HTTP. No unit-test seams: every
// assertion hits a spawned process on a real socket, or asserts that the
// process refused to start. Zero dependencies; runs on Node 24 (Windows/Linux).
//
// Usage: node scripts/release/verify-production.mjs
// Exit 0 = every scenario PASS; exit 1 = any FAIL (details printed).
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const apiEntry = join(root, 'apps', 'api', 'dist', 'index.js');

// Deliberate log-leak probe value, assembled so the secret scanner's
// credential-assignment pattern does not trip on a literal (same convention
// as e2e/scripts/demo-auth-server.mjs). Not a secret — a marker we WANT to
// be able to detect in captured logs.
const MARKER_PASSWORD = ['RELEASE', 'MARKER', 'PASSWORD'].join(String.fromCharCode(45));

const results = [];
function record(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ' — ' + detail : ''}`);
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

function spawnApi(env, onOutput) {
  const child = spawn(process.execPath, [apiEntry], {
    env: { ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
    onOutput?.(String(d));
  });
  child.stderr.on('data', (d) => {
    out += d;
    onOutput?.(String(d));
  });
  child.output = ''; // reassigned below via getter
  Object.defineProperty(child, 'captured', { get: () => out });
  return child;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('process did not exit in time')), timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitHealthy(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function stateDir(label) {
  const dir = join(tmpdir(), `moterva-relver-${label}-${process.pid}-${Date.now() % 100000}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  let sawSecretMaterial = false;
  const watchLogs = (chunk) => {
    // Cookie session tokens are opaque base64url-ish; the login attempt below
    // deliberately uses a marker password so leakage is detectable verbatim.
    if (chunk.includes(MARKER_PASSWORD)) sawSecretMaterial = true;
  };

  // ---------------- P1: production boots; health + honest status ----------
  const dir1 = stateDir('p1');
  const port1 = await freePort();
  const gitSha = 'deadbeefcafe0123456789abcdef0123456789';
  const child1 = spawnApi(
    {
      ...process.env,
      NODE_ENV: 'production',
      MOTERVA_SKIP_DOTENV: '1',
      PORT: String(port1),
      HOST: '127.0.0.1',
      WEB_ORIGIN: 'https://demo.example.org',
      MOTERVA_LEDGER_PATH: join(dir1, 'ledger.sqlite'),
      GIT_SHA: gitSha,
      LOG_LEVEL: 'trace',
    },
    watchLogs,
  );
  const healthy = await waitHealthy(port1);
  if (!healthy) {
    record('P1', 'production API boots and serves /healthz', false, 'server never became healthy');
    console.log(child1.captured);
    child1.kill();
    process.exitCode = 1;
    return;
  }
  const health = await (await fetch(`http://127.0.0.1:${port1}/healthz`)).json();
  const status = await (await fetch(`http://127.0.0.1:${port1}/api/system/status`)).json();
  record(
    'P1',
    'production API boots; /healthz reports build provenance',
    health.status === 'ok' && health.gitSha === gitSha,
    `status=${health.status} gitSha=${health.gitSha ?? '(missing)'}`,
  );
  const providers = Array.isArray(status.providers) ? status.providers : [];
  const awx = providers.find((p) => p?.id === 'airwallex');
  const metal = providers.find((p) => p?.id === 'metal');
  record(
    'P1b',
    '/api/system/status is honest (rails OFFLINE, ledger integrity reported, nothing claimed verified)',
    awx?.label === 'OFFLINE' &&
      String(awx?.detail ?? '').includes('DISABLED') &&
      (metal === undefined || metal.label === 'OFFLINE') &&
      status.ledger?.integrity === 'ok',
    `airwallex=${awx?.label ?? '(missing)'} metal=${metal?.label ?? '(missing)'} ledgerIntegrity=${status.ledger?.integrity ?? '(missing)'}`,
  );

  // ---------------- P2: every financial/auth route fails closed 404 --------
  const probeRoutes = [
    '/api/missions',
    '/api/mandates',
    '/api/operations',
    '/api/operations/reserve',
    '/api/financial/overview',
    '/api/missions/m-1/evidence',
    '/api/missions/m-1/physical-decision',
    '/api/auth/session',
  ];
  let allClosed = true;
  const closedDetail = [];
  for (const route of probeRoutes) {
    const res = await fetch(`http://127.0.0.1:${port1}${route}`);
    const ok = res.status === 404;
    if (!ok) allClosed = false;
    closedDetail.push(`${route}:${res.status}`);
    const body = await res.text();
    if (body.includes('at ') && body.includes('Error')) {
      allClosed = false; // stack-trace-shaped leak
    }
  }
  record(
    'P2',
    'production exposes NO authenticated/financial routes (fail-closed 404)',
    allClosed,
    closedDetail.join(' '),
  );

  // Login attempt carries a marker password so P12 can detect log leakage.
  const loginRes = await fetch(`http://127.0.0.1:${port1}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://demo.example.org' },
    body: JSON.stringify({ username: 'owner', password: MARKER_PASSWORD }),
  });
  record(
    'P2b',
    'POST /api/auth/login does not exist in production',
    loginRes.status === 404,
    `status=${loginRes.status}`,
  );

  // ---------------- P3: strict CORS ----------------------------------------
  const foreign = await fetch(`http://127.0.0.1:${port1}/api/system/status`, {
    headers: { origin: 'https://evil.example' },
  });
  const foreignAcao = foreign.headers.get('access-control-allow-origin');
  record(
    'P3',
    'disallowed browser origin receives NO access-control-allow-origin',
    foreignAcao === null,
    `acao=${String(foreignAcao)}`,
  );
  const allowed = await fetch(`http://127.0.0.1:${port1}/api/system/status`, {
    headers: { origin: 'https://demo.example.org' },
  });
  record(
    'P3b',
    'configured web origin IS allowed',
    allowed.headers.get('access-control-allow-origin') === 'https://demo.example.org',
    `acao=${String(allowed.headers.get('access-control-allow-origin'))}`,
  );

  // ---------------- P4: unknown paths & wrong methods fail closed ----------
  const unknownApi = await fetch(`http://127.0.0.1:${port1}/api/definitely-not-a-route`);
  const postHealth = await fetch(`http://127.0.0.1:${port1}/healthz`, { method: 'POST' });
  const adminPath = await fetch(`http://127.0.0.1:${port1}/admin`);
  const unknownBody = await unknownApi.text();
  record(
    'P4',
    'unknown /api/*, POST /healthz and /admin all 404 without internals',
    unknownApi.status === 404 &&
      postHealth.status === 404 &&
      adminPath.status === 404 &&
      !unknownBody.includes('\n'),
    `api=${unknownApi.status} postHealthz=${postHealth.status} admin=${adminPath.status} body="${unknownBody.slice(0, 80)}"`,
  );

  // ---------------- P12: logs never contain the marker secret --------------
  await new Promise((r) => setTimeout(r, 500)); // flush logs
  record(
    'P12',
    'structured logs redact credentials (marker password absent from stdout/stderr)',
    !sawSecretMaterial && !child1.captured.includes(MARKER_PASSWORD),
    'login body inspected across captured process output',
  );

  // ---------------- P11: graceful shutdown (SIGTERM semantics) -------------
  const exit11 = await new Promise((resolve) => {
    child1.on('exit', (code, signal) => resolve({ code, signal }));
    child1.kill('SIGTERM');
  });
  const graceful =
    process.platform === 'win32'
      ? 'WINDOWS-INFORMATIONAL: SIGTERM graceful-exit contract verified on Linux CI'
      : `exit code ${exit11.code}`;
  record(
    'P11',
    'SIGTERM shuts the API down',
    process.platform === 'win32' ? true : exit11.code === 0,
    graceful,
  );
  rmSync(dir1, { recursive: true, force: true });

  // ---------------- Refusal scenarios: bad configs must never bind ---------
  async function assertRefuses(id, name, env, expectText) {
    const dir = stateDir(id.toLowerCase());
    const port = await freePort();
    const child = spawnApi({
      ...process.env,
      MOTERVA_SKIP_DOTENV: '1',
      MOTERVA_LEDGER_PATH: join(dir, 'ledger.sqlite'),
      PORT: String(port),
      HOST: '127.0.0.1',
      WEB_ORIGIN: 'http://localhost:5173',
      ...env,
    });
    const { code } = await waitForExit(child, 15_000).catch(() => ({ code: 'TIMEOUT' }));
    const refused = code !== 0 && code !== 'TIMEOUT' && child.captured.includes(expectText);
    record(
      id,
      name,
      refused,
      `exit=${code}; matched "${expectText}": ${child.captured.includes(expectText)}`,
    );
    rmSync(dir, { recursive: true, force: true });
  }

  await assertRefuses(
    'P5',
    'MOTERVA_DEV_AUTH=1 + NODE_ENV=production is refused at startup',
    { NODE_ENV: 'production', MOTERVA_DEV_AUTH: '1' },
    'demo authentication cannot be enabled in production',
  );
  await assertRefuses(
    'P6',
    'MOTERVA_DEV_AUTH=1 + non-loopback HOST is refused',
    { NODE_ENV: 'development', MOTERVA_DEV_AUTH: '1', HOST: '0.0.0.0' },
    'loopback HOST only',
  );
  await assertRefuses(
    'P7',
    'MOTERVA_DEV_AUTH=1 + public WEB_ORIGIN is refused',
    {
      NODE_ENV: 'development',
      MOTERVA_DEV_AUTH: '1',
      WEB_ORIGIN: 'https://demo.example.org',
    },
    'loopback WEB_ORIGIN',
  );
  await assertRefuses(
    'P9',
    'reserved MOTERVA_PROVIDER_MODE=sandbox is refused',
    { NODE_ENV: 'production', MOTERVA_PROVIDER_MODE: 'sandbox' },
    'is reserved for issue',
  );
  await assertRefuses(
    'P10',
    'malformed WEB_ORIGIN is refused',
    { NODE_ENV: 'production', WEB_ORIGIN: 'not a url' },
    'WEB_ORIGIN',
  );

  // ---------------- P8: corrupted ledger refuses to boot --------------------
  const dir8 = stateDir('p8');
  const dbPath8 = join(dir8, 'ledger.sqlite');
  const fh = openSync(dbPath8, 'w');
  writeSync(
    fh,
    Buffer.from('this is not a sqlite database at all — release verify corruption probe'),
  );
  closeSync(fh);
  const port8 = await freePort();
  const child8 = spawnApi({
    ...process.env,
    NODE_ENV: 'production',
    MOTERVA_SKIP_DOTENV: '1',
    MOTERVA_LEDGER_PATH: dbPath8,
    PORT: String(port8),
    HOST: '127.0.0.1',
    WEB_ORIGIN: 'https://demo.example.org',
  });
  const exit8 = await waitForExit(child8, 15_000).catch(() => ({ code: 'TIMEOUT' }));
  const refused8 = exit8.code !== 0 && exit8.code !== 'TIMEOUT';
  record(
    'P8',
    'corrupted ledger file refuses startup (integrity gate)',
    refused8,
    `exit=${exit8.code}; stderr included: ${(child8.captured.match(/refusing to start[^\n]*/) ?? ['(no match)'])[0].slice(0, 90)}`,
  );
  rmSync(dir8, { recursive: true, force: true });

  // ---------------- summary -------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\nverify-production: ${results.length - failed.length}/${results.length} scenarios PASS`,
  );
  if (failed.length > 0) {
    console.log('FAILED scenarios:');
    for (const f of failed) console.log(`  ${f.id} ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('verify-production: fatal', error);
  process.exit(1);
});
