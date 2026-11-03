#!/usr/bin/env node
// Design-token contract check (issue #29, ADR 0004).
// Validates design/tokens.json structure + traceability and computes every
// declared WCAG contrast pair for BOTH modes, failing below the declared
// minimum. Zero dependencies; run: node scripts/check-design-tokens.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokens = JSON.parse(readFileSync(join(root, 'design/tokens.json'), 'utf8'));
const webPkg = JSON.parse(readFileSync(join(root, 'apps/web/package.json'), 'utf8'));

const errors = [];
const fail = (msg) => errors.push(msg);

// --- structure ------------------------------------------------------------
if (
  !Array.isArray(tokens.modes) ||
  !tokens.modes.includes('dark') ||
  !tokens.modes.includes('light')
) {
  fail('modes must include dark and light');
}
if (!tokens.contrastRequirements?.length) fail('contrastRequirements missing');

const dotted = {};
for (const [group, entry] of Object.entries(tokens.color)) {
  for (const mode of tokens.modes ?? ['dark', 'light']) {
    if (!entry[mode]) fail(`color.${group} missing ${mode} value`);
  }
  if (!entry.source) fail(`color.${group} missing traceability source`);
  else if (!/lab-[ab]\.css|format\.ts|base\.css|origin:new/.test(entry.source)) {
    fail(`color.${group} source not traceable to the design lab: ${entry.source}`);
  }
  dotted[`color.${group}`] = entry;
}
dotted['focus.ring'] = tokens.focus?.ring;
if (!dotted['focus.ring']) fail('focus.ring missing');

// --- value parsing --------------------------------------------------------
const HEX = /^#[0-9a-f]{6}$/i;
const RGBA = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/;
const parse = (v) => {
  if (HEX.test(v))
    return {
      rgb: [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)],
      a: 1,
    };
  const m = RGBA.exec(v);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] };
  return null;
};
const toHex = (rgb) => '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');

// --- WCAG 2.x relative luminance / contrast -------------------------------
const channel = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (rgb) =>
  0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
const contrast = (a, b) => {
  const la = luminance(a.rgb),
    lb = luminance(b.rgb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

// --- resolution (composite rgba blends over surface.card) ------------------
const resolve = (name, mode) => {
  const entry = dotted[name] ?? dotted[`color.${name}`];
  if (!entry) {
    fail(`contrast pair references unknown token ${name}`);
    return null;
  }
  const parsed = parse(entry[mode]);
  if (!parsed) {
    fail(`token ${name} (${mode}) is not a concrete color: ${entry[mode]}`);
    return null;
  }
  return parsed;
};
const cardOf = (mode) => resolve('color.surface.card', mode);

const rows = [];
for (const req of tokens.contrastRequirements) {
  for (const mode of tokens.modes) {
    const fg = resolve(req.fg, mode);
    let bg = resolve(req.bg, mode);
    if (!fg || !bg) continue;
    if (req.composite && bg.a < 1) {
      const base = cardOf(mode);
      bg = { rgb: bg.rgb.map((c, i) => c * bg.a + base.rgb[i] * (1 - bg.a)), a: 1 };
    }
    const ratio = contrast(fg, bg);
    const ok = ratio >= req.min;
    const level = req.min >= 4.5 ? (ratio >= 7 ? 'AAA' : 'AA') : ratio >= 3 ? 'UI-3:1' : 'FAIL';
    rows.push({
      mode,
      name: req.name,
      fg: toHex(fg.rgb),
      bg: toHex(bg.rgb),
      ratio,
      min: req.min,
      ok,
      level,
    });
    if (!ok)
      fail(
        `${mode} · ${req.name}: ${ratio.toFixed(2)}:1 < required ${req.min}:1 (${req.fg} on ${req.bg})`,
      );
  }
}

// --- typography licensing traceability ------------------------------------
const fontDeps = Object.keys(webPkg.dependencies ?? {});
for (const [name, fam] of Object.entries(tokens.typography ?? {})) {
  if (fam?.package && !fontDeps.includes(fam.package)) {
    fail(
      `typography.${name} declares package ${fam.package} which is not a dependency of @moterva/web`,
    );
  }
}
const requiredFonts = [
  '@fontsource-variable/space-grotesk',
  '@fontsource-variable/inter',
  '@fontsource-variable/geist-mono',
];
for (const p of requiredFonts) {
  if (!fontDeps.includes(p)) fail(`production font dependency missing from apps/web: ${p}`);
}

// --- status ladder sanity ---------------------------------------------------
const expected = new Set([
  'PROPOSED',
  'RESERVED',
  'APPROVED',
  'SUBMITTING',
  'SUBMITTED',
  'STATUS_UNKNOWN',
  'SETTLED',
  'RECONCILED',
  'REJECTED',
  'EXPIRED',
]);
const ladderStates = new Set((tokens.statusSemantics?.ladder ?? []).map((s) => s.state));
for (const s of expected) if (!ladderStates.has(s)) fail(`status ladder missing state ${s}`);
for (const s of ladderStates) if (!expected.has(s)) fail(`status ladder has unexpected state ${s}`);
const verifiedUsers = (tokens.statusSemantics?.ladder ?? [])
  .filter((s) => s.tone === 'verified')
  .map((s) => s.state);
if (verifiedUsers.join(',') !== 'SETTLED,RECONCILED') {
  fail(
    `green/verified tone must be reserved for SETTLED+RECONCILED only, found: ${verifiedUsers.join(',')}`,
  );
}

// --- report -----------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log(
  `design/tokens.json — ${tokens.version} — ${rows.length} contrast pairs × ${tokens.modes.length} modes\n`,
);
for (const mode of tokens.modes) {
  console.log(`[${mode}]`);
  for (const r of rows.filter((x) => x.mode === mode)) {
    console.log(
      `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.ratio.toFixed(2).padStart(5)}:1 (min ${r.min})  ${pad(r.level, 7)} ${pad(r.name, 38)} ${r.fg} on ${r.bg}`,
    );
  }
}
const aaa = rows.filter((r) => r.level === 'AAA').length;
console.log(
  `\n${rows.length} pairs checked · ${aaa} reach AAA (≥7:1) · ${rows.length - aaa} at AA/UI minimums`,
);
if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(
  '\nDesign token contract OK: structure, lab traceability, font licensing, status-ladder semantics and all declared contrast minimums verified for dark and light.',
);
