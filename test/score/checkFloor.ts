// pnpm check:score-floor: the floor (docs/primitives-score/baseline.json) on its own, and
// against a run, row by row, with no browser.
//
// On its own it must be sound: a lowered row holds its reason, a reason names a row that
// lowers something, and the file is not the old column totals. That is all a pull request
// can be checked for without running the score (--sound-only, in the verify job): the rows
// it raises come from its own run, which is not committed.
//
// Against a run, the run must meet it: every pass still a pass, every lowered cell still
// its gap. The run is the last local one (test/score/.out/latest.json) when there is one,
// otherwise the one main published (docs/primitives-score/latest.json). On main, after
// each published run, this is what catches a floor the run does not reach, such as a
// refusal a merge took back.
//
//   exit 0  the floor is sound and, unless --sound-only, the run meets it
//   exit 1  it is not, and each reason is printed

import fs from 'node:fs';
import path from 'node:path';
import { OUT_DIR, REPORT_DIR } from './lib/io';
import { floorDrops, floorProblems, floorTotals, type Floor, type Scored } from './lib/floor';
import { SURFACES } from './lib/types';

const soundOnly = process.argv.includes('--sound-only');

const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
const shown = (file: string) => path.relative(process.cwd(), file);

const floorFile = path.join(REPORT_DIR, 'baseline.json');
if (!fs.existsSync(floorFile)) {
  console.error(`${shown(floorFile)} is missing`);
  process.exit(1);
}
const floor = read(floorFile);

const problems = floorProblems(floor);
if (problems.length > 0) {
  console.error(`${shown(floorFile)} is not a sound floor:`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
const totals = floorTotals(floor as Floor);
const held = `The floor holds ${SURFACES.map((s) => `${s} ${totals[s]}`).join(', ')}, with ${Object.keys((floor as Floor).lowered).length} rows lowered on purpose`;

if (soundOnly) {
  console.log(`${held}, and it is sound.`);
  process.exit(0);
}

const runFile = [path.join(OUT_DIR, 'latest.json'), path.join(REPORT_DIR, 'latest.json')].find((file) => fs.existsSync(file));
if (!runFile) {
  console.error('No run to check the floor against: run pnpm score:primitives, or pass --sound-only.');
  process.exit(1);
}
const drops = floorDrops(read(runFile) as Scored, floor as Floor);
if (drops.length > 0) {
  console.error(`${shown(runFile)} does not meet ${shown(floorFile)}:`);
  for (const drop of drops) console.error(`  ${drop}`);
  process.exit(1);
}
console.log(`${held}, and ${shown(runFile)} meets it.`);
