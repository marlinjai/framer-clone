// What a behaviour shard (.github/workflows/proofs.yml, "Wait for the build") does about the shared build job.
// "Re-run failed jobs" after a good build does not run the build again, so the shard accepts a successful build of
// an earlier attempt of the same run, whether or not GitHub lists a carried over copy under the new attempt. A
// failure of an earlier attempt never ends the wait: its rebuild may not be listed yet.
//
// stdin: one "<attempt> <status> <conclusion>" line per build job of the run, every attempt, in any order.
// stdout: "<ready|failed|wait> <what was found>".
//   node scripts/ci/pick-build.mjs <this attempt>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function pickBuild(listing, attempt) {
  const [newest] = listing
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [n, status, conclusion = ''] = line.trim().split(/\s+/);
      return { attempt: Number(n), status, conclusion };
    })
    .filter((job) => job.attempt <= attempt)
    .sort((a, b) => b.attempt - a.attempt);
  if (!newest) return { verdict: 'wait', found: 'not found' };
  const found = `attempt ${newest.attempt}: ${newest.status} ${newest.conclusion}`.trim();
  if (newest.status !== 'completed') return { verdict: 'wait', found };
  if (newest.conclusion === 'success') return { verdict: 'ready', found };
  return { verdict: newest.attempt === attempt ? 'failed' : 'wait', found };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const attempt = Number(process.argv[2]);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('usage: pick-build.mjs <this attempt>');
  const { verdict, found } = pickBuild(fs.readFileSync(0, 'utf8'), attempt);
  process.stdout.write(`${verdict} ${found}\n`);
}
