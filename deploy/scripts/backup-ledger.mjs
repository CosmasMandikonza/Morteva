#!/usr/bin/env node
// Online, consistent backup of the MOTERVA financial ledger (issue #19).
//
// Uses the ledger package's own backupSqliteDatabase (SQLite `VACUUM INTO`)
// which produces a defragmented, transactionally-consistent snapshot even
// while the API is running (WAL mode), then VERIFIES the copy by opening it
// and running the same integrity verification the API runs at boot.
//
// Usage:
//   node deploy/scripts/backup-ledger.mjs [--ledger <path>] [--out <dir>]
// Defaults: ledger at deploy/env MOTERVA_LEDGER_PATH or /var/lib/moterva/ledger.sqlite
//           (docker: run inside the api container — see deploy/README.md),
//           output next to the ledger in backups/ with a UTC timestamp.
//
// Exit 0 = backup written and verified; anything else = FAILURE (monitor it).
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const repoRoot = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ledgerPath = resolve(
  arg('ledger', process.env.MOTERVA_LEDGER_PATH ?? '/var/lib/moterva/ledger.sqlite'),
);
const outDir = resolve(arg('out', join(ledgerPath, '..', 'backups')));

if (!existsSync(ledgerPath)) {
  console.error(`backup-ledger: ledger not found at ${ledgerPath}`);
  process.exit(2);
}

const { openLedger, backupSqliteDatabase } = await import(
  pathToFileURL(join(repoRoot, 'packages', 'ledger', 'dist', 'index.js')).href
);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = join(outDir, `ledger-${stamp}.sqlite`);
mkdirSync(outDir, { recursive: true });

const ledger = openLedger(ledgerPath);
try {
  backupSqliteDatabase(ledger.db, target);
} finally {
  ledger.db.close();
}

// Verify the backup independently: it must open, migrate-check and pass the
// same integrity verification the API enforces at startup.
const verify = openLedger(target);
try {
  const integrity = verify.recovery.verify();
  if (integrity.integrity !== 'ok') {
    console.error(`backup-ledger: backup at ${target} FAILED integrity verification:`);
    for (const violation of integrity.violations) console.error(`  - ${violation}`);
    process.exit(3);
  }
  console.log(
    `backup-ledger: OK ${target} (schema v${verify.schemaVersion()}, integrity ok, journal seq ${integrity.counts?.journalEvents ?? '?'})`,
  );
} finally {
  verify.db.close();
}
