// src/server/books/render/engine/fontEmbedding.ts
//
// How each font family goes into a PDF. Kept in the engine (no Node imports),
// next to the code that embeds the fonts.

import type { FontFamily } from '../../template/schema';

/**
 * Whether a family may be embedded as a SUBSET (only the glyphs a document
 * uses) or must be embedded whole. pdf-lib's subsetter (through
 * @pdf-lib/fontkit 1.1.1) writes the Noto files' glyph table so that most
 * glyphs come out empty: the text is in the PDF (the completeness check reads
 * it) but every PDF viewer draws blanks, found on app.lumitra.co on 2026-10-23
 * the day Noto went live. DejaVu subsets correctly. A whole Noto face adds
 * about 430 KB per face to a document; correct pages come first. Changing a
 * family's value changes its documents' bytes, so it is decided per family id
 * once and kept (decision 6).
 */
export const EMBED_SUBSET: Record<FontFamily, boolean> = {
  'dejavu-sans': true,
  'noto-sans': false,
  'noto-serif': false,
};
