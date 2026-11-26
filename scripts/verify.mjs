#!/usr/bin/env node
// scripts/verify.mjs
//
// The one check command of this repository (`pnpm verify`): every stage a change must pass,
// in CI's order, one after the other, one line per stage with pass or fail. A branch is proven
// by this before anyone reviews it.
//
//   pnpm verify           guards, plugin payload, score floor, typecheck, lint, unit tests
//   pnpm verify --all     the above, then integration (needs Docker), render gate and
//                         behaviour (need Playwright's browsers)
//   pnpm verify --only=typecheck,unit   only the named stages
//
// Stages run serially on purpose: the machine is often shared, and one stage's output is
// easier to read than four interleaved. A failed stage does not stop the others, so one run
// shows everything that is wrong; the exit code is 1 when any stage failed.

import { spawnSync } from 'node:child_process';

const FAST = [
  ['guards', 'pnpm lint:guards'],
  ['plugin', './scripts/sync-plugin-repo.sh --check-payload'],
  ['score-floor', 'pnpm check:score-floor --sound-only'],
  ['typecheck', 'pnpm exec tsc --noEmit'],
  ['lint', 'pnpm lint'],
  ['unit', 'pnpm test'],
];
const SLOW = [
  ['integration', 'pnpm test:integration'],
  ['render-gate', 'pnpm test:render-gate'],
  ['behaviour', 'pnpm test:behaviour'],
];

const args = process.argv.slice(2);
const only = args.find((arg) => arg.startsWith('--only='))?.slice('--only='.length).split(',');
const all = [...FAST, ...SLOW];
const unknown = only?.filter((name) => !all.some(([stage]) => stage === name)) ?? [];
if (unknown.length > 0) {
  console.error(`verify: no stage named ${unknown.join(', ')}; the stages are ${all.map(([stage]) => stage).join(', ')}`);
  process.exit(2);
}
const stages = only ? all.filter(([name]) => only.includes(name)) : args.includes('--all') ? all : FAST;

const results = [];
for (const [name, command] of stages) {
  const started = Date.now();
  console.log(`\n=== ${name}: ${command}`);
  const run = spawnSync(command, { shell: true, stdio: 'inherit' });
  results.push({ name, ok: run.status === 0, seconds: Math.round((Date.now() - started) / 1000) });
}

console.log('\nverify:');
for (const { name, ok, seconds } of results) console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name} (${seconds} s)`);
process.exit(results.every(({ ok }) => ok) ? 0 : 1);
