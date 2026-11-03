/**
 * Secret scanning for CI and local pre-flight (issue #3).
 * Walks the repository (source-controlled files, excluding build/test noise)
 * and fails on common credential patterns. Findings are reported by file and
 * line number only — the matching text is never printed.
 *
 * Deliberately dependency-free so a cold checkout can run it before install.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());
const omittedDirs = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'playwright-report',
  'test-results',
  'docs',
  'assets',
]);
const omittedFiles = new Set(['package-lock.json', 'check-secrets.mjs']);
const MAX_BYTES = 2 * 1024 * 1024;

/** name -> regex (kept aligned with scripts/check-docs.mjs patterns). */
const patterns = [
  ['private-key-block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['openai-style-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  [
    'credential-assignment',
    /\b(?:api[_-]?key|apikey|client[_-]?secret|secret|password|passwd|signing[_-]?key|access[_-]?token)\b\s*[:=]\s*["'][^"'\s]{16,}["']/i,
  ],
];

const findings = [];
let scanned = 0;

async function walk(folder) {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    if (item.isDirectory()) {
      if (!omittedDirs.has(item.name)) await walk(join(folder, item.name));
      continue;
    }
    if (!item.isFile() || omittedFiles.has(item.name)) continue;
    const file = join(folder, item.name);
    const fileStat = await stat(file);
    if (fileStat.size > MAX_BYTES) continue;
    const buffer = await readFile(file);
    if (buffer.includes(0)) continue; // binary
    scanned++;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const [name, regex] of patterns) {
        if (regex.test(line)) {
          findings.push({ file: relative(root, file), line: index + 1, name });
        }
      }
    });
  }
}

await walk(root);
for (const finding of findings) {
  console.error(
    `ERROR ${finding.file}:${finding.line} probable secret (${finding.name}) — inspect and remove/rotate`,
  );
}
console.log(`Secret scan: ${scanned} text files checked; ${findings.length} finding(s).`);
if (findings.length) process.exitCode = 1;
