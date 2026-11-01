// pnpm gen:web-vocabulary: write src/lib/ai/pageGen/webVocabulary.ts, the lists the
// AI generator accepts, from the same data and exclusions the primitive score
// reads (test/score/lib/universe.ts), and the data attributes the source uses.
// The data packages are development dependencies and far too large for a client
// bundle, so the lists are checked in;
// src/lib/ai/pageGen/__tests__/webVocabulary.test.ts fails when they drift.

import fs from 'node:fs';
import path from 'node:path';
import { buildWebVocabulary, renderWebVocabulary } from '../test/score/lib/vocabulary';

const target = path.join(process.cwd(), 'src/lib/ai/pageGen/webVocabulary.ts');
fs.writeFileSync(target, renderWebVocabulary(buildWebVocabulary()));
console.log(`wrote ${path.relative(process.cwd(), target)}`);
