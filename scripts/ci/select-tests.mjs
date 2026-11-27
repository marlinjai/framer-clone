#!/usr/bin/env node
// Which behaviour proofs and which render gate form a CI run asks, as GitHub Actions matrices.
// Plan: knowledge-base docs/plans/2026-11-27-ci-under-ten-minutes.md, section 4.1. The tiers:
//
//   pr       the proofs the change can affect, sharded; the render gate as a short deterministic form (one
//            engine, a fixed-seed sample), or its long form when the renderer, the gate or a stored-node
//            format changes. Nothing is asked of a change that only touches docs or tests of other suites.
//   main     after a merge: every behaviour proof and the whole render gate in every engine, in parallel.
//   nightly  main's set, with the render gate's full cross (RENDER_GATE_FULL=1) shuffled by a fresh seed.
//
// It fails open: a path it does not know selects the proofs that always run, and a change to CI itself, the
// toolchain or the shared harness selects everything. No proof is removed by this file, only placed: the
// main tier asks every spec and gate file there is (scripts/ci/__tests__/select-tests.test.ts holds that).
//
// Usage in a workflow:
//   node scripts/ci/select-tests.mjs --tier pr --base <sha> --head <sha>   (writes to $GITHUB_OUTPUT)
//   node scripts/ci/select-tests.mjs --tier main
//   node scripts/ci/select-tests.mjs --tier nightly [--seed <integer>]

import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ---------------------------------------------------------------------------
// The map. Order matters only in classify(): the first rule that matches wins.
// ---------------------------------------------------------------------------

/** Paths no behaviour proof or render gate case can see: docs, unit and integration tests, the container build. Checked first. */
export const IGNORED = [
  /^docs\//,
  /\.md$/,
  /^plugin\//,
  /^\.claude\//,
  /^deploy\//,
  /^test\/integration\//,
  /^test\/score\//,
  /(^|\/)__tests__\//,
  /\.(test|itest)\.tsx?$/,
  /^Dockerfile$/,
  /^\.dockerignore$/,
  /^\.gitignore$/,
  /^\.coderabbit\.ya?ml$/,
  /^LICENSE/,
];

/** CI itself, the toolchain and what every page goes through: everything runs, the render gate in its long form. */
export const GLOBAL = [
  /^\.github\/workflows\//,
  /^scripts\/ci\//,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^\.nvmrc$/,
  /^next\.config\.\w+$/,
  /^tsconfig\.json$/,
  /^postcss\.config\.\w+$/,
  /^tailwind\.config\.\w+$/,
  /^vitest\.behaviour\.config\.ts$/,
  /^vitest\.integration\.setup\.ts$/,
  /^prisma\//,
  /^src\/middleware\.ts$/,
  /^src\/lib\/renderer\//,
  /^src\/app\/\(site\)\//,
  /^test\/stubs\//,
];

/** The renderer, the gate and the stored-node formats: the render gate runs its long form. */
export const RENDER_GATE_LONG = [
  /^test\/renderGate\//,
  /^vitest\.renderGate\.config\.ts$/,
  /^src\/models\//,
  /^src\/lib\/customCode\//,
  /^src\/components\/customCode\//,
  /^src\/components\/ComponentRenderer\.tsx$/,
  /^src\/lib\/site\//,
  /^src\/components\/site\//,
  /^src\/lib\/behaviour\//,
  /^src\/lib\/consent\//,
  /^src\/lib\/rules\//,
  /^src\/lib\/styles\//,
  /^src\/lib\/color\//,
  /^src\/lib\/mapEmbed\//,
  /^src\/lib\/responsive\//,
];

/** Effects (fx), two thirds of the behaviour proofs' time, asked only when effects or the canvas they draw on change. */
export const FX_SOURCES = [/^src\/.*(fx|scene|effect)/i, /^src\/components\/Canvas\.tsx$/, /^src\/lib\/canvas\//, /^src\/components\/ComponentRenderer\.tsx$/];
const isFxSpec = (file) => /^test\/behaviour\/fx[^/]*\.spec\.ts$/.test(file);
const isFxHelper = (file) => /^test\/behaviour\/fx[^/]*\.entry\.tsx$/.test(file);

const matches = (rules, file) => rules.some((rule) => rule.test(file));

// ---------------------------------------------------------------------------
// The files there are
// ---------------------------------------------------------------------------

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

/** Every behaviour spec, as vitest.behaviour.config.ts includes them (test/behaviour/**\/*.spec.ts). */
export const behaviourSpecs = () => walk('test/behaviour').filter((file) => file.endsWith('.spec.ts')).sort();
/** Every render gate file, as vitest.renderGate.config.ts includes them (test/renderGate/**\/*.gate.{ts,tsx}). */
export const gateFiles = () => walk('test/renderGate').filter((file) => /\.gate\.tsx?$/.test(file)).sort();

/** The engines a spec launches, read from its playwright import; none found means all three, never fewer. */
export function enginesOf(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const named = [...text.matchAll(/import\s*{([^}]*)}\s*from\s*'playwright'/g)].flatMap((m) => m[1].split(','));
  const engines = ['chromium', 'webkit', 'firefox'].filter((engine) => named.some((name) => name.trim() === engine));
  return engines.length > 0 ? engines : ['chromium', 'webkit', 'firefox'];
}

// ---------------------------------------------------------------------------
// Behaviour proofs
// ---------------------------------------------------------------------------

/** The behaviour specs a set of changed files can affect, and why. */
/** @param {string[]} changed @param {string[]} [specs] */
export function selectBehaviour(changed, specs = behaviourSpecs()) {
  const fx = specs.filter(isFxSpec);
  const core = specs.filter((spec) => !isFxSpec(spec));
  const picked = new Set();
  const reasons = new Set();
  for (const file of changed) {
    if (matches(IGNORED, file)) {
      continue;
    } else if (matches(GLOBAL, file)) {
      specs.forEach((spec) => picked.add(spec));
      reasons.add(`everything (${file})`);
    } else if (specs.includes(file)) {
      picked.add(file);
      reasons.add(`the changed spec ${file}`);
    } else if (isFxHelper(file)) {
      fx.forEach((spec) => picked.add(spec));
      reasons.add(`effects (${file})`);
    } else if (file.startsWith('test/behaviour/')) {
      // A shared helper (site.ts, pages.ts, setup.ts, an entry): every spec may stand on it.
      specs.forEach((spec) => picked.add(spec));
      reasons.add(`everything (${file})`);
    } else if (file.startsWith('test/renderGate/') || file === 'vitest.renderGate.config.ts') {
      continue;
    } else {
      core.forEach((spec) => picked.add(spec));
      reasons.add('the proofs that always run');
      if (matches(FX_SOURCES, file)) {
        fx.forEach((spec) => picked.add(spec));
        reasons.add(`effects (${file})`);
      }
    }
  }
  return { files: specs.filter((spec) => picked.has(spec)), reasons: [...reasons] };
}

/**
 * Longest first into the emptiest shard: shards finish together, so the slowest one is as short as it can be.
 * Each shard pays about 180 s before its first test (browsers, Postgres, a build; run 46067309775), so a target of
 * 120 s of tests puts the proofs that always run (about 790 s) on 7 runners and keeps one shard near five minutes.
 */
/** @param {string[]} files @param {Record<string, number>} durations @param {{ targetMs?: number, maxShards?: number }} [options] */
export function shard(files, durations, { targetMs = 120_000, maxShards = 8 } = {}) {
  if (files.length === 0) return [];
  const weight = (file) => durations[file] ?? 60_000;
  const sorted = [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  const total = sorted.reduce((sum, file) => sum + weight(file), 0);
  const target = Math.max(targetMs, weight(sorted[0]));
  const count = Math.min(maxShards, sorted.length, Math.max(1, Math.ceil(total / target)));
  const shards = Array.from({ length: count }, () => ({ files: [], ms: 0 }));
  for (const file of sorted) {
    const emptiest = shards.reduce((best, s) => (s.ms < best.ms ? s : best));
    emptiest.files.push(file);
    emptiest.ms += weight(file);
  }
  return shards.map((s) => ({ ...s, files: s.files.sort() }));
}

export function behaviourMatrix(files, durations) {
  const shards = shard(files, durations);
  return shards.map((s, index) => ({
    name: `${index + 1} of ${shards.length}`,
    files: s.files.join(' '),
    engines: [...new Set(s.files.flatMap(enginesOf))].sort().join(' '),
    estimate: `${Math.round(s.ms / 1000)} s`,
  }));
}

// ---------------------------------------------------------------------------
// Render gate
// ---------------------------------------------------------------------------

/** The share of probes the pull request form asks, and its fixed seed: the same probes on every pull request. */
export const PR_SAMPLE = '0.125';
export const PR_SEED = '20261127';
/**
 * Slices of the editor gate and of the fuzz on main, in the long pull request form, and at night. Few and long on
 * purpose: an account runs 20 jobs at once, and in run 46068825364 six editor slices of about 70 s each waited up to
 * 5.7 minutes for a runner. Two editor slices take about 3 minutes each; the WebKit fuzz (418 s whole) halves.
 */
export const EDITOR_SLICES = 2;
export const FUZZ_SLICES = { long: 1, main: 2, nightly: 8 };

/** 'skip' (nothing it can see changed), 'sample' (the short form) or 'long' (every probe, in Chromium). */
export function renderGateForm(changed) {
  let form = 'skip';
  for (const file of changed) {
    if (matches(IGNORED, file)) continue;
    if (matches(GLOBAL, file) || matches(RENDER_GATE_LONG, file)) return 'long';
    if (!file.startsWith('test/behaviour/') && file !== 'vitest.behaviour.config.ts') form = 'sample';
  }
  return form;
}

const entry = (name, files, install, extra = {}) => ({ name, files: files.join(' '), install, engines: '', seed: '', sample: '', slice: '', full: '', ...extra });

/**
 * The render gate as matrix entries, by form:
 *   sample   a pull request: one job in Chromium on the fixed sample.
 *   long     a pull request touching the renderer, the gate or a stored-node format: every probe, in Chromium only,
 *            as the standard's pull request tier says (one browser; the browser matrix runs after merge). Four jobs,
 *            so the path that asks everything stays within the account's 20 jobs at once: in runs 46068825364 and
 *            46070223983 the long form in all engines (11 to 17 jobs) made shards wait up to 5.7 minutes.
 *   main     after merge: every probe in Chromium and WebKit, the custom code bridge in Firefox too.
 *   nightly  main's set with the fuzz's full cross, shuffled by a fresh seed.
 * Per engine: the gate files without the two long ones, the fuzz (in slices on main and at night) and the editor gate
 * in slices. Firefox runs only the custom code bridge, the one file that uses it.
 */
export function renderGateMatrix(form, { files = gateFiles(), seed = '' } = {}) {
  if (form === 'skip') return [];
  if (form === 'sample') {
    return [entry('chromium, fixed sample', files, 'chromium', { engines: 'chromium', seed: PR_SEED, sample: PR_SAMPLE })];
  }
  const nightly = form === 'nightly';
  const engines = form === 'long' ? ['chromium'] : ['chromium', 'webkit'];
  const editor = files.filter((file) => file.endsWith('/editor.gate.ts'));
  const fuzz = files.filter((file) => file.endsWith('/fuzz.gate.ts'));
  const rest = files.filter((file) => !editor.includes(file) && !fuzz.includes(file));
  const bridge = files.filter((file) => file.endsWith('/customCodeBridge.gate.ts'));
  const shared = nightly ? { seed, full: '1' } : {};
  const out = [];
  for (const engine of engines) {
    out.push(entry(`${engine}, gate files`, rest, engine, { engines: engine }));
    const fuzzSlices = FUZZ_SLICES[form];
    for (let k = 1; k <= fuzzSlices; k++) {
      out.push(entry(`${engine}, fuzz ${k} of ${fuzzSlices}`, fuzz, engine, { engines: engine, ...shared, slice: fuzzSlices > 1 ? `${k}/${fuzzSlices}` : '' }));
    }
    for (let k = 1; k <= EDITOR_SLICES; k++) {
      // The editor gate asks the default probes (no RENDER_GATE_FULL); at night the seed reorders them.
      out.push(entry(`${engine}, editor ${k} of ${EDITOR_SLICES}`, editor, engine, { engines: engine, seed: nightly ? seed : '', slice: `${k}/${EDITOR_SLICES}` }));
    }
  }
  if (form !== 'long') out.push(entry('firefox, custom code bridge', bridge, 'firefox', { engines: 'firefox' }));
  return out.filter((e) => e.files.length > 0);
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

function changedFiles(base, head) {
  return execFileSync('git', ['diff', '--name-only', `${base}`, `${head}`], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * @param {{ tier: 'pr' | 'main' | 'nightly', changed?: string[], seed?: string | number }} options
 */
export function plan({ tier, changed = [], seed }) {
  const durations = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/test-durations.json'), 'utf8')).behaviour;
  if (tier === 'pr') {
    const behaviour = selectBehaviour(changed);
    const form = renderGateForm(changed);
    return { behaviour: behaviourMatrix(behaviour.files, durations), behaviourReasons: behaviour.reasons, renderGate: renderGateMatrix(form), form, seed: '' };
  }
  const all = behaviourSpecs();
  const nightlySeed = tier === 'nightly' ? String(seed ?? randomInt(1, 2 ** 31 - 1)) : '';
  return {
    behaviour: behaviourMatrix(all, durations),
    behaviourReasons: ['everything'],
    renderGate: renderGateMatrix(tier, { seed: nightlySeed }),
    form: tier,
    seed: nightlySeed,
  };
}

function main(argv) {
  const arg = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const tier = arg('tier');
  if (!['pr', 'main', 'nightly'].includes(tier)) throw new Error('--tier must be pr, main or nightly');
  const changed = tier === 'pr' ? changedFiles(arg('base') ?? 'HEAD^1', arg('head') ?? 'HEAD') : [];
  const result = plan({ tier, changed, seed: arg('seed') });

  const lines = [
    `Tier: ${tier}${tier === 'pr' ? `, ${changed.length} changed files` : ''}`,
    `Behaviour proofs: ${result.behaviour.length === 0 ? 'none' : `${result.behaviour.reduce((n, s) => n + s.files.split(' ').length, 0)} specs in ${result.behaviour.length} shards`} (${result.behaviourReasons.join('; ') || 'nothing they can see changed'})`,
    ...result.behaviour.map((s) => `  shard ${s.name} (about ${s.estimate}, ${s.engines}): ${s.files}`),
    `Render gate: ${result.form}${result.seed ? `, RENDER_GATE_SEED=${result.seed}` : ''}, ${result.renderGate.length} jobs`,
    ...result.renderGate.map((e) => `  ${e.name}`),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);

  const outputs = {
    behaviour: JSON.stringify({ include: result.behaviour }),
    behaviour_run: String(result.behaviour.length > 0),
    render_gate: JSON.stringify({ include: result.renderGate }),
    render_gate_run: String(result.renderGate.length > 0),
    render_gate_form: result.form,
    seed: result.seed,
  };
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### What this run asks\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
