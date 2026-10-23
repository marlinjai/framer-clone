// src/server/books/__tests__/engineChild.ts
//
// Run in a fresh Node process by engine.test.ts and engineLogo.test.ts
// (another time zone, cold caches): renders one probe with one preset and
// prints the SHA-256 of the bytes, which must equal the parent's. Without
// arguments: Modern in DejaVu Sans, no logo. With `<family> <png|jpeg>`: Modern
// set in that family with a generated logo (logoCase in testImages.ts).

import { createHash } from 'node:crypto';

import { renderTemplate } from '../render/engine';
import { fontFiles } from '../render/fonts';
import { buildRenderModel } from '../render/model';
import { preset } from '../template/presets';
import { probe, probeInput } from '../template/probes';
import type { FontFamily } from '../template/schema';
import { logoCase } from './testImages';

const [family, kind] = process.argv.slice(2) as [FontFamily | undefined, 'png' | 'jpeg' | undefined];
const run = family && kind ? logoCase(family, kind) : { doc: preset('modern'), assets: new Map() };

void renderTemplate(buildRenderModel(probeInput(probe('reverseCharge'))), run.doc, fontFiles(run.doc.theme.fontFamily), { assets: run.assets }).then(
  ({ bytes }) => {
    process.stdout.write(`${createHash('sha256').update(bytes).digest('hex')}\n`);
  },
);
