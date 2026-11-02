// pnpm check:score-floor: the committed floor against the committed score, row by row,
// with no browser and no run. It fails when baseline.json is not sound (a lowered row
// with no reason, a reason for a row that lowers nothing, the old column totals) or when
// latest.json, the run committed beside it, does not meet it: a floor the committed run
// does not reach was written by hand or by a stale branch, and the next real run would
// fail on it. A row whose deliberate refusal a merge took back shows up here as a pass
// the run does not have.
//
//   exit 0  baseline.json is sound and latest.json meets it
//   exit 1  it is not, and each reason is printed

import fs from 'node:fs';
import path from 'node:path';
import { REPORT_DIR } from './lib/io';
import { floorDrops, floorProblems, floorTotals, type Floor, type Scored } from './lib/floor';
import { SURFACES } from './lib/types';

const read = (name: string): unknown => {
  const file = path.join(REPORT_DIR, name);
  if (!fs.existsSync(file)) {
    console.error(`${file} is missing`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
};

const floor = read('baseline.json');
const latest = read('latest.json') as Scored;

const problems = floorProblems(floor);
if (problems.length > 0) {
  console.error('docs/primitives-score/baseline.json is not a sound floor:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

const drops = floorDrops(latest, floor as Floor);
if (drops.length > 0) {
  console.error('docs/primitives-score/latest.json does not meet docs/primitives-score/baseline.json:');
  for (const drop of drops) console.error(`  ${drop}`);
  process.exit(1);
}

const totals = floorTotals(floor as Floor);
const lowered = Object.keys((floor as Floor).lowered).length;
console.log(`The floor holds ${SURFACES.map((s) => `${s} ${totals[s]}`).join(', ')}, with ${lowered} rows lowered on purpose, and latest.json meets it.`);
