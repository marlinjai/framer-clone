// pnpm score:framer: the "Framer, native" comparison column.
//
// Reads the published primitive score (docs/primitives-score/latest.json), gives every matrix row
// a Framer verdict from the typings of framer-plugin (test/score/lib/framer), and writes
// docs/primitives-score/framer.json and framer.md. It runs no probes and never writes latest.* or
// baseline.json.
//
//   exit 0  written
//   exit 2  the input could not be read, or a row was dropped or of an unknown kind

import fs from 'node:fs';
import path from 'node:path';
import { REPORT_DIR } from './lib/io';
import { buildFramerScore, renderFramerReport, type PublishedScore } from './lib/framer/report';

const input = path.join(REPORT_DIR, 'latest.json');

try {
  const published = JSON.parse(fs.readFileSync(input, 'utf8')) as PublishedScore;
  const score = buildFramerScore(published, path.relative(process.cwd(), input));
  fs.writeFileSync(path.join(REPORT_DIR, 'framer.json'), `${JSON.stringify(score, null, 2)}\n`);
  fs.writeFileSync(path.join(REPORT_DIR, 'framer.md'), renderFramerReport(score));

  const { totals } = score;
  console.log('Framer, native (docs/primitives-score/framer.md)');
  console.log(`  native    ${totals.framer.native} of ${totals.rows}`);
  console.log(`  partial   ${totals.framer.partial} of ${totals.rows}`);
  console.log(`  code-only ${totals.framer['code-only']} of ${totals.rows}`);
  console.log(`  unknown   ${totals.framer.unknown} of ${totals.rows}`);
  console.log(`  ours: published renderer ${totals.ourRenderer}, panel ${totals.ourPanel} of ${totals.rows}`);
} catch (error) {
  console.error(`score:framer failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
