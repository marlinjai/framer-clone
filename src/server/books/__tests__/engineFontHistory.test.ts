// src/server/books/__tests__/engineFontHistory.test.ts
//
// A document's bytes do not depend on what the process drew before it. fontkit
// caches a glyph with the code points of its first use, and pdf-lib writes them
// into the ToUnicode map, so one parsed face shared between renders would let
// an earlier document change a later one: a literal U+FB01 first, and the plain
// "fi" of the next document reads back as the ligature character. Issued
// documents must re-render byte for byte, so the engine parses its faces per
// render (renderTemplate), which costs real time and must not be "optimized".
//
// In a file of its own: the first document must be the first use of the glyph
// in the module graph, which Vitest creates anew per file.

import { describe, expect, it } from 'vitest';

import { renderTemplate } from '../render/engine';
import { extractPdfText } from '../render/extractText';
import { fontFiles } from '../render/fonts';
import { buildRenderModel } from '../render/model';
import { preset } from '../template/presets';
import { probe, probeInput } from '../template/probes';

const LIGATURE = 'Proﬁt';
const PLAIN = 'Profit';

async function drawn(text: string): Promise<string> {
  const doc = structuredClone(preset('klassisch'));
  doc.regions.body.push({ id: 'note', type: 'freeText', style: {}, heading: null, text, variant: 'normal' });
  const { bytes } = await renderTemplate(buildRenderModel(probeInput(probe('regular'))), doc, fontFiles('dejavu-sans'));
  return extractPdfText(bytes);
}

describe('a document drawn after another', () => {
  it('reads back as its own text, not as the glyph mapping of the one before', async () => {
    expect(await drawn(LIGATURE)).toContain(LIGATURE);
    const second = await drawn(PLAIN);
    expect(second).toContain(PLAIN);
    expect(second).not.toContain(LIGATURE);
  }, 30_000);
});
