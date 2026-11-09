#!/usr/bin/env node
// One-command reviewer demo (issue #19): seeds a throwaway ledger, boots the
// compiled API under the loopback-only DEMO_AUTH gate (the config enforces
// loopback + non-production, so this can never run as a public service) and
// serves the built web shell — exactly the stack Playwright verifies.
//
// Prerequisites: `npm ci && npm run build` at the repository root.
// Run:        node scripts/release/demo.mjs
// Then open:  http://localhost:4173  (sign in: founder / moterva-e2e-demo)
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

function busy(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(true));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(false)));
  });
}

for (const port of [8787, 4173]) {
  if (await busy(port)) {
    console.error(`demo: port ${port} is already in use — stop the other server first.`);
    process.exit(1);
  }
}

const children = [];
function shutdown() {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('demo: starting seeded DEMO_AUTH API on http://127.0.0.1:8787 ...');
children.push(spawn(process.execPath, ['e2e/scripts/demo-auth-server.mjs'], { stdio: 'inherit' }));

console.log('demo: starting web shell on http://127.0.0.1:4173 ...');
children.push(
  spawn('npm', ['run', 'preview', '-w', '@moterva/web', '--', '--port', '4173', '--strictPort'], {
    stdio: 'inherit',
    shell: true,
  }),
);

console.log(`
--------------------------------------------------------------
 MOTERVA reviewer demo is starting.
 Open:   http://localhost:4173
 Sign in: founder / moterva-e2e-demo   (also: approver, operator)

 Honest labels you will see:
  - "DEMO_AUTH · seeded internal ledger — not Airwallex funds"
  - SYNTHETIC physical evidence (never field truth)
  - Provider rails OFFLINE until sandbox credentials exist (#5)
  - Submitted ≠ settled; STATUS_UNKNOWN retains commitments
 Ctrl+C stops both servers and deletes the throwaway ledger.
--------------------------------------------------------------`);
