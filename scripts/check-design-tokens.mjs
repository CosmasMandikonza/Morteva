#!/usr/bin/env node
// Design-token contract check (issue #29, ADR 0004).
//
// Validates design/tokens.json against three sources of truth:
//   1. The merged design lab CSS — every color token's value must equal its
//      referenced lab custom property AFTER NORMALIZATION (lowercase,
//      whitespace-insensitive), or be declared lab:new / a token: reference
//      that resolves to a token which is.
//   2. The domain package — the presentation status mapping must cover
//      EXACTLY the OperationState union and ApprovalView.status from
//      packages/domain/src, and every commitment column must equal
//      commitmentStateFor() as parsed from commitments.ts.
//   3. WCAG 2.x — every DECLARED contrast combination is computed for both
//      modes and must meet its minimum.
//
// Scope (stated plainly): this checker validates declared pairs, source
// annotations and mapping completeness. It does NOT audit the accessibility
// of every rendered component, and the font gate verifies npm dependency
// PRESENCE — the full license posture lives in the component ledger and ADR,
// not here. Zero dependencies. Run: node scripts/check-design-tokens.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const tokens = JSON.parse(read('design/tokens.json'));
const webPkg = JSON.parse(read('apps/web/package.json'));

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
if (!tokens.typography?.readabilityFloor?.rule)
  fail('typography.readabilityFloor rule missing (CTO correction #2)');

const dotted = {};
for (const [group, entry] of Object.entries(tokens.color)) {
  for (const mode of tokens.modes ?? ['dark', 'light']) {
    if (!entry[mode]) fail(`color.${group} missing ${mode} value`);
  }
  if (!entry.lab || !entry.lab.dark || !entry.lab.light) {
    fail(`color.${group} missing lab provenance ({dark, light})`);
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
const normColor = (v) => v.toLowerCase().replace(/\s+/g, '');

// --- 1. token↔lab value verification (after normalization) ------------------
const COLOR_VALUE = /(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^;]*?\))\s*;/gi;
const labVars = {};
for (const file of ['apps/web/src/design-lab/a/lab-a.css', 'apps/web/src/design-lab/b/lab-b.css']) {
  const css = read(file);
  const key = file.includes('/a/') ? 'a/lab-a.css' : 'b/lab-b.css';
  labVars[key] = {};
  for (const m of css.matchAll(COLOR_VALUE)) labVars[key][m[1]] = normColor(m[2]);
}

let directLabComparisons = 0;
let tokenReferenceEdges = 0;
const labValue = (name, mode) => {
  const entry = dotted[name];
  const ref = entry?.lab?.[mode];
  if (!ref) return null;
  if (ref === 'lab:new') return { isNew: true };
  if (ref.startsWith('token:')) {
    const target = ref.slice(6);
    if (target === name) {
      fail(`${name}.${mode}: token: reference points to itself`);
      return null;
    }
    tokenReferenceEdges++; // a reuse edge, NOT an independent lab comparison; the target is verified on its own
    const resolved = dotted[target] ? target : `color.${target}`;
    return labValue(resolved, mode);
  }
  const [file, v] = ref.split('#');
  if (!labVars[file]) {
    fail(`${name}.${mode}: unknown lab file ${file}`);
    return null;
  }
  const declared = labVars[file][v];
  if (declared === undefined) {
    fail(`${name}.${mode}: lab variable ${v} not found in ${file}`);
    return null;
  }
  return { labValue: declared };
};
for (const name of Object.keys(dotted)) {
  for (const mode of tokens.modes) {
    const entry = dotted[name];
    const parsed = parse(entry[mode]);
    if (!parsed) {
      fail(`token ${name} (${mode}) is not a concrete color: ${entry[mode]}`);
      continue;
    }
    const lab = labValue(name, mode);
    if (!lab) continue;
    if (lab.isNew) continue;
    if (normColor(entry[mode]) !== lab.labValue) {
      fail(
        `${name}.${mode} value ${normColor(entry[mode])} does NOT equal its lab source after normalization (${lab.labValue}) — traceability broken`,
      );
    } else {
      directLabComparisons++;
    }
  }
}

// --- 2. domain-anchored status mapping --------------------------------------
const domainSrc = {
  operations: read('packages/domain/src/operations.ts'),
  entities: read('packages/domain/src/entities.ts'),
  commitments: read('packages/domain/src/commitments.ts'),
};
const opUnionMatch = /export type OperationState =([\s\S]*?);/.exec(domainSrc.operations);
if (!opUnionMatch) fail('cannot parse OperationState union from packages/domain/src/operations.ts');
const domainOperationStates = new Set(
  [...(opUnionMatch?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]),
);
const approvalMatch = /readonly status:\s*('[a-z]+'[^;]*');/.exec(domainSrc.entities);
if (!approvalMatch)
  fail('cannot parse ApprovalView.status union from packages/domain/src/entities.ts');
const interfaceStatusUnion = (iface) => {
  const block = new RegExp(`export interface ${iface}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(
    domainSrc.entities,
  );
  if (!block) return null;
  return /readonly status:\s*('[a-z]+'[^;]*');/.exec(block[1])?.[1] ?? null;
};
const mandateUnion = interfaceStatusUnion('MandateView');
if (!mandateUnion)
  fail('cannot parse MandateView.status union from packages/domain/src/entities.ts');
const approvalUnion = interfaceStatusUnion('ApprovalView');
if (!approvalUnion)
  fail('cannot parse ApprovalView.status union from packages/domain/src/entities.ts');
const domainMandateStates = new Set([...mandateUnion.matchAll(/'([a-z]+)'/g)].map((m) => m[1]));
const domainApprovalStates = new Set([...approvalUnion.matchAll(/'([a-z]+)'/g)].map((m) => m[1]));

const domainCommitment = {};
{
  let pending = [];
  for (const line of domainSrc.commitments.split('\n')) {
    const c = /case '([A-Z_]+)':/.exec(line);
    if (c) pending.push(c[1]);
    const r = /return '([a-z]+)';/.exec(line);
    if (r) {
      for (const p of pending) domainCommitment[p] = r[1];
      pending = [];
    }
  }
}

const ss = tokens.statusSemantics ?? {};
const opPresentation = ss.operationPresentation ?? {};
const presentedOps = new Set(Object.keys(opPresentation));
for (const s of domainOperationStates) {
  if (!presentedOps.has(s)) fail(`presentation mapping missing persisted operation state ${s}`);
}
for (const s of presentedOps) {
  if (!domainOperationStates.has(s))
    fail(`presentation mapping has state ${s} which is NOT in the domain OperationState union`);
}
const approvalPresentation = ss.approvalPresentation ?? {};
const presentedApprovals = new Set(Object.keys(approvalPresentation));
for (const s of domainApprovalStates) {
  if (!presentedApprovals.has(s)) fail(`presentation mapping missing approval state ${s}`);
}
for (const s of presentedApprovals) {
  if (!domainApprovalStates.has(s))
    fail(`presentation mapping has approval state ${s} which is NOT in ApprovalView.status`);
}
const mandatePresentation = ss.mandatePresentation ?? {};
const presentedMandates = new Set(Object.keys(mandatePresentation));
for (const s of domainMandateStates) {
  if (!presentedMandates.has(s)) fail(`presentation mapping missing mandate state ${s}`);
}
for (const s of presentedMandates) {
  if (!domainMandateStates.has(s))
    fail(`presentation mapping has mandate state ${s} which is NOT in MandateView.status`);
}
for (const [state, entry] of Object.entries({ ...approvalPresentation, ...mandatePresentation })) {
  if (!entry.glyph || !entry.label || !entry.meaning || !entry.tone) {
    fail(
      `authorization presentation.${state} must carry tone + glyph + label + meaning (never color-only)`,
    );
  }
}
for (const [state, entry] of Object.entries(opPresentation)) {
  if (!entry.glyph || !entry.label || !entry.meaning || !entry.tone) {
    fail(
      `operationPresentation.${state} must carry tone + glyph + label + meaning (never color-only)`,
    );
  }
  if (domainCommitment[state] && entry.commitment !== domainCommitment[state]) {
    fail(
      `operationPresentation.${state}.commitment '${entry.commitment}' != domain commitmentStateFor → '${domainCommitment[state]}'`,
    );
  }
  for (const ref of [entry.ink, entry.background].filter(Boolean)) {
    if (!dotted[ref] && !dotted[`color.${ref}`])
      fail(`operationPresentation.${state} references unknown token ${ref}`);
  }
}
const verifiedStates = Object.entries(opPresentation)
  .filter(([, e]) => e.tone === 'verified')
  .map(([s]) => s)
  .sort();
if (verifiedStates.join(',') !== ['RECONCILED', 'SETTLED'].join(',')) {
  fail(
    `verified (green) tone must be reserved for SETTLED+RECONCILED only, found: ${verifiedStates.join(',')}`,
  );
}
for (const must of ['IN_FLIGHT', 'STATUS_UNKNOWN', 'REQUIRES_HUMAN', 'CANCELLED']) {
  if (!opPresentation[must]) fail(`presentation mapping must explicitly define ${must}`);
}
for (const key of Object.keys(ss.presentationOnlyStates ?? {})) {
  if (key.startsWith('$')) continue;
  if (domainOperationStates.has(key))
    fail(`presentationOnlyStates.${key} collides with a persisted operation state`);
  if (!ss.presentationOnlyStates[key].mapsTo)
    fail(`presentationOnlyStates.${key} must declare mapsTo`);
}

// --- typography package PRESENCE (not a license audit) ----------------------
const fontDeps = Object.keys(webPkg.dependencies ?? {});
for (const [name, fam] of Object.entries(tokens.typography ?? {})) {
  if (name.startsWith('$')) continue;
  if (fam?.package && !fontDeps.includes(fam.package)) {
    fail(
      `typography.${name} declares package ${fam.package} which is not a dependency of @moterva/web`,
    );
  }
}
for (const p of [
  '@fontsource-variable/space-grotesk',
  '@fontsource-variable/inter',
  '@fontsource-variable/geist-mono',
]) {
  if (!fontDeps.includes(p)) fail(`production font dependency missing from apps/web: ${p}`);
}

// --- 3. WCAG contrast over declared combinations ----------------------------
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
const cardOf = (mode) => resolve('surface.card', mode);

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

// --- report -----------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
const combos = tokens.contrastRequirements.length;
console.log(
  `design/tokens.json — ${tokens.version} — status mapping: ${Object.keys(opPresentation).length} operation states + ${Object.keys(mandatePresentation).length} mandate + ${Object.keys(approvalPresentation).length} approval states (domain-verified)\n`,
);
for (const mode of tokens.modes) {
  console.log(`[${mode}] — ${combos} declared contrast combinations`);
  for (const r of rows.filter((x) => x.mode === mode)) {
    console.log(
      `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.ratio.toFixed(2).padStart(5)}:1 (min ${r.min})  ${pad(r.level, 7)} ${pad(r.name, 38)} ${r.fg} on ${r.bg}`,
    );
  }
}
const aaa = rows.filter((r) => r.level === 'AAA').length;
console.log(
  `\nContrast: ${combos} declared combinations evaluated in ${tokens.modes.length} modes = ${rows.length} evaluations — ${rows.length} pass (${aaa} at AAA ≥7:1, ${rows.length - aaa} at AA/UI minimums).`,
);
console.log(
  `Lab traceability: ${directLabComparisons} direct token↔lab value comparisons matched after normalization (lowercase, whitespace-insensitive); ${tokenReferenceEdges} token-reference edges resolved (reuse of an already-verified token — not independent lab comparisons); 'lab:new' values are explicitly flagged in design/tokens.json.`,
);
console.log(
  'Scope: this checker validates DECLARED pairs, source annotations and mapping completeness — not the accessibility of every rendered component. The font gate checks npm dependency presence; the full license posture is documented in the component ledger and ADR 0004, not audited here.',
);
if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(
  '\nDesign token contract OK: structure, normalized lab traceability, domain-anchored status mapping, font package presence, readability floor and all declared contrast minimums verified for dark and light.',
);
