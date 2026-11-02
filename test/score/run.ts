// pnpm score:primitives: one honest score from a clean slate.
//
//   exit 0  the run finished and nothing dropped below baseline.json
//   exit 1  the score dropped: the ratchet says which number
//   exit 2  a harness error: a probe crashed, so there is no score
//
// A low score alone never fails. --update-baseline raises the floor on purpose.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { OUT_DIR } from './lib/io';
import { buildScore, checkRatchet, writeBaseline, writeScore } from './report';

const started = Date.now();
const updateBaseline = process.argv.includes('--update-baseline');

fs.rmSync(OUT_DIR, { recursive: true, force: true });

const probes = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.score.config.ts'], { stdio: 'inherit' });
if (probes.status !== 0) {
  console.error('\nA probe crashed, so there is no score. A low score does not do this.');
  console.error('If the browser is missing: pnpm exec playwright install chromium-headless-shell');
  process.exit(2);
}

const score = buildScore(Math.round((Date.now() - started) / 1000));
writeScore(score);
if (updateBaseline) writeBaseline(score);

const { surfaces } = score.matrix;
console.log('\nPrimitive score (full report: docs/primitives-score/latest.md)');
for (const [surface, c] of Object.entries(surfaces)) {
  console.log(`  ${surface.padEnd(9)} ${c.pass} of ${c.total}${c.notTested ? `, ${c.notTested} not tested` : ''}`);
}
console.log(`  corpus    ${score.corpus.passed} of ${score.corpus.total} fixtures pass`);
console.log(`  busbasis  ${score.busbasis.passed} of ${score.busbasis.total} real pages pass`);
const { nodesToJsxToNodes: a, jsxToNodesToRender: b } = score.roundTrip;
console.log(`  roundtrip ${a.pass} of ${a.total} nodes to nodes, ${b.pass} of ${b.total} JSX to render`);
console.log(`  took ${score.durationSeconds} seconds`);

const drops = checkRatchet(score);
if (drops.length > 0) {
  console.error('\nThe score dropped below docs/primitives-score/baseline.json:');
  for (const drop of drops) console.error(`  ${drop}`);
  process.exit(1);
}
