#!/usr/bin/env node
// Production-boot KEK probe (CTO PR#62 comment 6808567133).
// Runs the REAL loadConfig startup gate of a target checkout against the
// exact KEK encodings bootstrap provisioning can produce:
//   A. production + identity + NO KEK            → must REFUSE (SOURCE_KEK_REQUIRED)
//   B. production + identity + valid 64-hex KEK  → must boot-config
//   C. production + identity + 44-char base64 KEK (the exact form
//      deploy/aws/ensure-kek.sh generates)       → must boot-config
//   D. production + identity + malformed KEK     → must REFUSE (SOURCE_KEK_INVALID)
//
// Usage: node deploy/aws/test/kek-boot-probe.mjs [<target-repo-root>]
// The target must be BUILT (apps/api/dist). When the target does not
// contain the source-key-custody module (PR #64 not merged there yet) the
// probe SKIPS with exit 0 and a notice — it activates automatically once
// the custody code lands on the checked-out branch.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(process.argv[2] ?? '.');
const dist = resolve(target, 'apps/api/dist');
const custodyPath = resolve(dist, 'integration/source-key-custody.js');
if (!existsSync(custodyPath)) {
  console.log(
    'SKIP kek-boot-probe: no source-key-custody module in ' +
      target +
      ' (PR #64 not merged here yet)',
  );
  process.exit(0);
}

const { loadConfig } = await import('file://' + resolve(dist, 'config.js').replace(/\\/g, '/'));
const { randomBytes } = await import('node:crypto');

const identityEnv = {
  NODE_ENV: 'production',
  HOST: '0.0.0.0',
  WEB_ORIGIN: 'https://judge.example.com',
  MOTERVA_LEDGER_PATH: 'data/probe.sqlite',
  // Origin-only issuer so the probe isolates the KEK gate on ANY branch:
  // C's branch still rejects path-bearing (real Cognito) issuers; PR #62
  // carries that fix and the two compose at merge.
  MOTERVA_OIDC_ISSUER: 'https://idp.probe.example.com',
  MOTERVA_OIDC_CLIENT_ID: 'probe-client',
  MOTERVA_OIDC_CLIENT_SECRET: 'probe-server-side-secret-not-real',
  MOTERVA_OIDC_REDIRECT_URI: 'https://judge.example.com/api/auth/oidc/callback',
  MOTERVA_TRUST_PROXY: '1',
};
const HEX_KEK = randomBytes(32).toString('hex'); // canonical form 1
const B64_KEK = randomBytes(32).toString('base64'); // canonical form 3 — EXACTLY what ensure-kek.sh stores

let pass = 0;
let fail = 0;
const check = (id, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${detail ?? ''}`);
  if (ok) pass++;
  else fail++;
};

// A: refusal without a KEK.
try {
  loadConfig({ ...identityEnv });
  check('A', false, 'production boot SUCCEEDED without a KEK — custody gate missing');
} catch (error) {
  check(
    'A',
    /SOURCE_KEK/.test(String(error.message)),
    'refused: ' + String(error.message).split('\n')[0].slice(0, 100),
  );
}

// B: valid hex KEK boots.
try {
  const config = loadConfig({ ...identityEnv, MOTERVA_SOURCE_KEY_KEK: HEX_KEK });
  check('B', config.identity !== null, 'boots with a 64-hex KEK');
} catch (error) {
  check('B', false, 'refused a valid 64-hex KEK: ' + String(error.message).slice(0, 100));
}

// C: the EXACT form ensure-kek.sh provisions (44-char base64) boots.
try {
  const config = loadConfig({ ...identityEnv, MOTERVA_SOURCE_KEY_KEK: B64_KEK });
  check('C', config.identity !== null, 'boots with the bootstrap-generated 44-char base64 KEK');
} catch (error) {
  check(
    'C',
    false,
    'refused the bootstrap-generated KEK form: ' + String(error.message).slice(0, 100),
  );
}

// D: malformed KEK (31 bytes → 62 hex) refused.
try {
  loadConfig({ ...identityEnv, MOTERVA_SOURCE_KEY_KEK: randomBytes(31).toString('hex') });
  check('D', false, 'malformed KEK was ACCEPTED');
} catch (error) {
  check(
    'D',
    /SOURCE_KEK_INVALID|must be exactly 32 bytes/.test(String(error.message)),
    'refused malformed: ' + String(error.message).split('\n')[0].slice(0, 100),
  );
}

// The probe must never print key material: only lengths/fingerprints above.
console.log(`\nkek-boot-probe: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
