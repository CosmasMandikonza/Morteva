#!/usr/bin/env node
// TEST-ONLY jq shim: implements the exact jq programs used by the deploy
// scripts and kek-provision.test.sh, so the harness can run on hosts
// without jq (this Windows Git Bash box). On CI (ubuntu) and CloudShell the
// REAL jq exists and is used; this shim is never installed there.
// Supported: -n -s -e -j -r, --arg N V, and the program forms:
//   .                        (validate/identity)
//   has("KEY")
//   .KEY // ""
//   . + {KEY: $var}
//   .[0] * .[1]
//   .[0] * (.[1] | del(.K1, .K2, ...))
//   {KEY: $var, KEY2: "literal", ...}
//   .KEY == "literal"
// Anything else → exit 3 (loud, never silently wrong).
'use strict';
const args = process.argv.slice(2);
const flags = new Set();
const vars = {};
let program = null;
let file = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--arg') {
    vars[args[i + 1]] = args[i + 2];
    i += 2;
  } else if (a === '--argjson') {
    try {
      vars[args[i + 1]] = JSON.parse(args[i + 2]);
    } catch {
      console.error('jq-shim: invalid --argjson value');
      process.exit(3);
    }
    i += 2;
  } else if (a.startsWith('-') && a !== '-' && !a.startsWith('--')) {
    for (const ch of a.slice(1)) flags.add(ch);
  } else if (program === null) {
    program = a;
  } else if (a === '-' && file === null) {
    // stdin marker — already the default input
  } else if (file === null) {
    file = a; // single input file argument (real jq supports this)
  } else {
    console.error('jq-shim: unexpected extra arg ' + a);
    process.exit(3);
  }
}
if (program === null) process.exit(3);

function readAllStdin() {
  return new Promise((resolve) => {
    let data = '';
    // A file argument (or -n) means stdin is not consumed.
    if (file !== null || process.stdin.isTTY) return resolve(data);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}
import { readFileSync } from 'node:fs';
const readFile = (path) => readFileSync(path, 'utf8');
function parseDocs(text) {
  const docs = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let start = i;
    for (; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      else if (c === '\n' && depth === 0) break;
    }
    docs.push(JSON.parse(text.slice(start, i)));
  }
  return docs;
}
function deepMerge(a, b) {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return b;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = k in out ? deepMerge(out[k], b[k]) : b[k];
  return out;
}
function evalObjectLiteral(text, v) {
  // {KEY: $var, KEY: "literal", KEY: "1"} — top-level commas only.
  const body = text.trim().replace(/^\{/, '').replace(/\}$/, '');
  const parts = [];
  let depth = 0,
    inStr = false,
    esc = false,
    cur = '';
  for (const c of body) {
    if (inStr) {
      cur += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      cur += c;
    } else if (c === '{' || c === '[') {
      depth++;
      cur += c;
    } else if (c === '}' || c === ']') {
      depth--;
      cur += c;
    } else if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim() !== '') parts.push(cur);
  const out = {};
  for (const part of parts) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/.exec(part);
    if (!m) throw new Error('jq-shim: unsupported object entry: ' + part);
    const valExpr = m[2];
    if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(valExpr)) {
      const name = valExpr.slice(1);
      if (!(name in v)) throw new Error('jq-shim: undefined --arg $' + name);
      out[m[1]] = v[name];
    } else if (/^".*"$/.test(valExpr)) {
      out[m[1]] = JSON.parse(valExpr);
    } else {
      throw new Error('jq-shim: unsupported value expr: ' + valExpr);
    }
  }
  return out;
}

async function main() {
  let input = null;
  const inputs = [];
  if (!flags.has('n')) {
    let text;
    try {
      text = file !== null ? readFile(file) : await readAllStdin();
    } catch {
      process.stderr.write('jq-shim: cannot read input\n');
      process.exit(2);
    }
    try {
      const docs = parseDocs(text);
      if (flags.has('s')) inputs.push(...docs);
      else if (docs.length > 0) input = docs[0];
    } catch {
      process.stderr.write('jq-shim: parse error\n');
      process.exit(2);
    }
  }
  let result;
  const p = program.trim();
  let m;
  if (p === '.') {
    result = input;
    if (input === undefined) {
      process.exit(4);
    }
  } else if ((m = /^has\("([A-Za-z_][A-Za-z0-9_]*)"\)$/.exec(p))) {
    result = typeof input === 'object' && input !== null && m[1] in input;
  } else if ((m = /^\.([A-Za-z_][A-Za-z0-9_]*)\s*\/\/\s*""$/.exec(p))) {
    const val = input?.[m[1]];
    result = val === undefined || val === null ? '' : val;
  } else if ((m = /^\. \+ \{([A-Za-z_][A-Za-z0-9_]*): \$([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(p))) {
    if (!(m[2] in vars)) {
      process.stderr.write('jq-shim: undefined --arg\n');
      process.exit(3);
    }
    result = { ...(input ?? {}), [m[1]]: vars[m[2]] };
  } else if (p === '.[0] * .[1]') {
    result = deepMerge(inputs[0] ?? {}, inputs[1] ?? {});
  } else if ((m = /^\.\[0\] \* \(\.\[1\] \| del\(([^)]*)\)\)$/.exec(p))) {
    const delKeys = m[1]
      .split(',')
      .map((s) => s.trim().replace(/^\./, ''))
      .filter(Boolean);
    const incoming = { ...(inputs[1] ?? {}) };
    for (const k of delKeys) delete incoming[k];
    result = deepMerge(inputs[0] ?? {}, incoming);
  } else if ((m = /^\.\[0\] \* \(\$([A-Za-z_][A-Za-z0-9_]*) \| del\(([^)]*)\)\)$/.exec(p))) {
    if (!(m[1] in vars)) {
      process.stderr.write('jq-shim: undefined --argjson $' + m[1] + '\n');
      process.exit(3);
    }
    const delKeys = m[2]
      .split(',')
      .map((s) => s.trim().replace(/^\./, ''))
      .filter(Boolean);
    const incoming = { ...vars[m[1]] };
    for (const k of delKeys) delete incoming[k];
    result = deepMerge(inputs[0] ?? {}, incoming);
  } else if (p.startsWith('{') && p.endsWith('}')) {
    result = evalObjectLiteral(p, vars);
  } else if ((m = /^\.([A-Za-z_][A-Za-z0-9_]*) == "(.*)"$/.exec(p))) {
    result = input?.[m[1]] === m[2];
  } else {
    process.stderr.write('jq-shim: unsupported program: ' + p + '\n');
    process.exit(3);
  }
  if (flags.has('e') && (result === false || result === null || result === undefined))
    process.exit(1);
  const raw = flags.has('r') || flags.has('j');
  const out = typeof result === 'string' && raw ? result : JSON.stringify(result);
  process.stdout.write(out + (flags.has('j') ? '' : '\n'));
}
main();
