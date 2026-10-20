// src/server/books/render/fonts.ts
//
// The fonts every Books PDF is set in: DejaVu Sans and DejaVu Sans Bold, open
// licence (Bitstream Vera licence plus public-domain DejaVu changes, see
// assets/fonts/DejaVu-LICENSE.txt), committed in `assets/fonts/` and embedded
// into each PDF as a SUBSET (only the glyphs the document uses, a few
// kilobytes). They draw Latin with every European diacritic, Greek, Cyrillic
// and many symbols and emoji, so a legal name prints exactly as written: no
// transliteration, no replacement.
//
// What the fonts cannot draw (CJK, many emoji, other scripts) is NEVER printed
// as a substitute on a document of record: `undrawable()` finds it and issue
// refuses with the field named (UNDRAWABLE_TEXT). Only a draft preview, which is
// not a document, shows a "?" in its place.
//
// The files are read from disk once per process. The production image gets
// them through `outputFileTracingIncludes` in next.config.ts (the standalone
// output only copies what is traced); the tests read them from the checkout.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import fontkit from '@pdf-lib/fontkit';

export interface FontFiles {
  regular: Uint8Array;
  bold: Uint8Array;
}

const FONT_DIR = path.join(process.cwd(), 'assets', 'fonts');

let files: FontFiles | undefined;
let coverage: { hasGlyphForCodePoint(cp: number): boolean }[] | undefined;

/** The two font files (read once). */
export function fontFiles(): FontFiles {
  files ??= {
    regular: new Uint8Array(readFileSync(path.join(FONT_DIR, 'DejaVuSans.ttf'))),
    bold: new Uint8Array(readFileSync(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'))),
  };
  return files;
}

/** True when BOTH faces can draw the code point (a field may be set in either). */
export function canDraw(cp: number): boolean {
  coverage ??= [fontkit.create(fontFiles().regular as unknown as Buffer), fontkit.create(fontFiles().bold as unknown as Buffer)];
  return coverage.every((f) => f.hasGlyphForCodePoint(cp));
}

/** The characters of `text` the fonts cannot draw (each once, in order). */
export function undrawable(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // Variation selectors and joiners are invisible modifiers; they draw nothing.
    if (cp === 0xfe0f || cp === 0xfe0e || cp === 0x200d) continue;
    if (!canDraw(cp) && !out.includes(ch)) out.push(ch);
  }
  return out;
}

export { fontkit };
