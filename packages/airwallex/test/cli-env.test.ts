/**
 * CTO executable-path review — the smoke CLIs actually LOAD the gitignored
 * root `.env` and fail closed around it, verified in REAL child processes:
 *
 *  - missing .env + empty env  → BLOCKED exit 2 (the documented founder
 *    failure mode is explicit, never a crash);
 *  - fixture .env seen by the CLI → proven HERMETICALLY via the config's own
 *    credential-enabled base-URL lock: a fixture with credentials AND a
 *    non-sandbox AIRWALLEX_BASE_URL refuses startup with the exact lock
 *    error, before any transport exists — no network call ever happens;
 *  - malformed credentials (env tag without a full pair) → fail-closed
 *    startup error (never half-configured);
 *  - credential VALUES never appear in any child output.
 *
 * The CLIs run via tsx (root devDependency) so no pre-built dist is needed —
 * CI's unit gate runs before `npm run build`.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const TSX = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CONNECTION_CLI = join(REPO_ROOT, 'packages', 'airwallex', 'src', 'smoke', 'connection.ts');

/** The fake secret marker must NEVER surface in any child output. */
const FAKE_ID = 'fake-client-id-for-env-test';
const FAKE_KEY = 'fake-key-value-DOES-NOT-EXIST-0123456789abcdef';

interface ChildRun {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Child env = the parent env MINUS every AIRWALLEX_* key. Empty-string values
 * would NOT work: Node's --env-file never overrides pre-existing variables,
 * and an empty string still counts as pre-existing — the whole point of these
 * tests is what the fixture file alone contributes.
 */
function hermeticEnv(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('AIRWALLEX_')) clean[key] = value;
  }
  return clean;
}

function runCli(envFile: string | null, extraEnv: Record<string, string> = {}): ChildRun {
  const args = [TSX, CONNECTION_CLI];
  if (envFile !== null) args.unshift(`--env-file-if-exists=${envFile}`);
  const r = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...hermeticEnv(), ...extraEnv },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function assertNoSecrets(run: ChildRun): void {
  const all = run.stdout + run.stderr;
  expect(all).not.toContain(FAKE_KEY);
  expect(all).not.toContain(FAKE_ID);
  expect(all).not.toMatch(/Bearer\s/i);
}

describe('smoke CLI env loading (real child processes, hermetic)', () => {
  it('BLOCKED exit 2 when no .env exists and env is empty (documented failure mode)', () => {
    const run = runCli(null);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('BLOCKED');
    expect(run.stderr).toContain('AIRWALLEX_CLIENT_ID');
    assertNoSecrets(run);
  });

  it('CLI sees a fixture .env (credential-enabled base-URL lock fires BEFORE any network)', () => {
    // The only hermetic way to PROVE the fixture was read: credentials present
    // + a non-sandbox base URL is a startup REFUSAL (exfiltration lock) whose
    // message includes the refused URL from the fixture. No transport is ever
    // constructed, so nothing leaves the machine.
    const dir = mkdtempSync(join(tmpdir(), 'awx-env-fixture-'));
    try {
      const fixture = join(dir, 'fixture.env');
      writeFileSync(
        fixture,
        [
          '# fixture for the child-process env-loading proof',
          'AIRWALLEX_ENV=sandbox',
          `AIRWALLEX_CLIENT_ID=${FAKE_ID}`,
          `AIRWALLEX_API_KEY=${FAKE_KEY}`,
          'AIRWALLEX_BASE_URL=https://127.0.0.1:1/locked-out',
          '',
        ].join('\n'),
      );
      const run = runCli(fixture);
      expect(run.status).not.toBe(0);
      expect(run.stderr + run.stdout).toContain(
        'not allowed while sandbox credentials are configured',
      );
      expect(run.stderr + run.stdout).toContain('127.0.0.1:1'); // the REFUSED url — not a secret
      assertNoSecrets(run);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('malformed credentials (env tag without a full pair) fail closed, never half-configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awx-env-fixture-'));
    try {
      const fixture = join(dir, 'fixture.env');
      writeFileSync(
        fixture,
        ['AIRWALLEX_ENV=sandbox', `AIRWALLEX_CLIENT_ID=${FAKE_ID}`, ''].join('\n'),
      );
      const run = runCli(fixture);
      expect(run.status).not.toBe(0);
      expect(run.stderr + run.stdout).toContain(
        'requires AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY',
      );
      assertNoSecrets(run);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('write-config separation: the transfer CLI BLOCKS without the distinct Transfers-Write pair', () => {
    const transferCli = join(REPO_ROOT, 'packages', 'airwallex', 'src', 'smoke', 'transfer.ts');
    const dir = mkdtempSync(join(tmpdir(), 'awx-env-fixture-'));
    try {
      // Read-only pair present, NO write pair: the transfer run must refuse
      // BEFORE any provider interaction — the read key is never upgraded.
      const fixture = join(dir, 'fixture.env');
      writeFileSync(
        fixture,
        [
          'AIRWALLEX_ENV=sandbox',
          `AIRWALLEX_CLIENT_ID=${FAKE_ID}`,
          `AIRWALLEX_API_KEY=${FAKE_KEY}`,
          'AIRWALLEX_SANDBOX_BENEFICIARY_ID=bene_fixture',
          '',
        ].join('\n'),
      );
      const r = spawnSync(process.execPath, [`--env-file-if-exists=${fixture}`, TSX, transferCli], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 120_000,
        env: hermeticEnv(),
      });
      const run = { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('Transfers-Write credential is not configured');
      expect(run.stderr).toContain('never reused for write authority');
      assertNoSecrets(run);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('write-config separation: a write pair IDENTICAL to the read pair is refused (same key ≠ separation)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awx-env-fixture-'));
    try {
      const fixture = join(dir, 'fixture.env');
      writeFileSync(
        fixture,
        [
          'AIRWALLEX_ENV=sandbox',
          `AIRWALLEX_CLIENT_ID=${FAKE_ID}`,
          `AIRWALLEX_API_KEY=${FAKE_KEY}`,
          `AIRWALLEX_WRITE_CLIENT_ID=${FAKE_ID}`,
          `AIRWALLEX_WRITE_API_KEY=${FAKE_KEY}`,
          '',
        ].join('\n'),
      );
      const r = spawnSync(
        process.execPath,
        [
          `--env-file-if-exists=${fixture}`,
          TSX,
          join(REPO_ROOT, 'packages', 'airwallex', 'src', 'smoke', 'transfer.ts'),
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: 120_000,
          env: hermeticEnv(),
        },
      );
      const run = { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('identical to the read-only credential');
      assertNoSecrets(run);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
