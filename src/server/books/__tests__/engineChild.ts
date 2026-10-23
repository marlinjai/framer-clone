// src/server/books/__tests__/engineChild.ts
//
// Run in a fresh Node process by engine.test.ts (another time zone, cold
// caches): renders one probe with one preset and prints the SHA-256 of the
// bytes, which must equal the parent's.

import { createHash } from 'node:crypto';

import { renderTemplate } from '../render/engine';
import { fontFiles } from '../render/fonts';
import { buildRenderModel } from '../render/model';
import { preset } from '../template/presets';
import { probe, probeInput } from '../template/probes';

void renderTemplate(buildRenderModel(probeInput(probe('reverseCharge'))), preset('modern'), fontFiles('dejavu-sans')).then(({ bytes }) => {
  process.stdout.write(`${createHash('sha256').update(bytes).digest('hex')}\n`);
});
