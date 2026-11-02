import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';

const root = resolve(process.cwd());
const omitted = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage']);
const errors = [];
let checked = 0;

async function walk(folder) {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    if (item.isDirectory()) {
      if (!omitted.has(item.name)) await walk(join(folder, item.name));
    } else if (item.isFile() && item.name.endsWith('.md')) {
      await checkFile(join(folder, item.name));
    }
  }
}

async function checkFile(file) {
  checked++;
  const content = await readFile(file, 'utf8');
  const label = relative(root, file);
  const secrets = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bsk-[A-Za-z0-9_-]{32,}\b/,
  ];
  if (secrets.some(regex => regex.test(content))) errors.push(label + ': probable private credential material');
  for (const match of content.matchAll(/\[[^\]\n]+\]\(([^)]+)\)/g)) {
    let target = match[1].trim().split(/\s+"/)[0];
    if (/^(https?:|mailto:|data:|#|javascript:)/i.test(target)) continue;
    target = target.split('#')[0].split('?')[0];
    if (!target) continue;
    try { target = decodeURIComponent(target); }
    catch { errors.push(label + ': invalid percent-encoded link ' + match[1]); continue; }
    const full = resolve(dirname(file), target);
    if (!(full === root || full.startsWith(root + '/'))) {
      errors.push(label + ': local link escapes repository: ' + match[1]);
      continue;
    }
    try { await stat(full); }
    catch { errors.push(label + ': broken local link: ' + match[1]); }
  }
}

await walk(root);
for (const error of errors) console.error('ERROR ' + error);
console.log('Documentation integrity: checked ' + checked + ' Markdown files; ' + errors.length + ' error(s).');
if (errors.length) process.exitCode = 1;
