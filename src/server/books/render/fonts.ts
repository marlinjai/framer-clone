// src/server/books/render/fonts.ts
//
// The fonts every Books PDF is set in (visual template composer plan, decision
// 6): three families, each a regular and a bold face, committed in
// `assets/fonts/` with their licences and embedded into each PDF as a SUBSET
// (only the glyphs the document uses, a few kilobytes).
//
//   dejavu-sans  DejaVu Sans (Bitstream Vera licence plus public-domain DejaVu
//                changes, assets/fonts/DejaVu-LICENSE.txt). Every document
//                issued before phase 5 is set in it.
//   noto-sans    Noto Sans 2.015, static unhinted faces (SIL Open Font
//                Licence 1.1, assets/fonts/Noto-OFL.txt).
//   noto-serif   Noto Serif 2.015, static unhinted faces (same licence).
//
// All three draw Latin with every European diacritic, Greek and Cyrillic, so a
// legal name prints exactly as written: no transliteration, no replacement.
// Where and what each file came from: assets/fonts/README.md.
//
// A family id names exactly one pair of files, pinned below by their SHA-256:
// a file that differs from its pin refuses to load (the process fails loudly
// instead of drawing an issued document with other glyphs). A newer version of
// a font is a NEW family id, never new bytes under an old id, so an issued
// document re-renders with the bytes it was issued with.
//
// What a family cannot draw (CJK, many emoji, other scripts) is NEVER printed
// as a substitute on a document of record: `undrawable()` finds it, per family,
// and issue refuses with the field named (UNDRAWABLE_TEXT). Only a draft
// preview, which is not a document, shows a "?" in its place.
//
// The files are read from disk once per process and family. The production
// image gets them through `outputFileTracingIncludes` in next.config.ts (a glob
// over assets/fonts; the standalone output only copies what is traced); the
// tests read them from the checkout.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import fontkit from '@pdf-lib/fontkit';

import { FONT_FAMILIES, type FontFamily } from '../template/schema';

export interface FontFiles {
  regular: Uint8Array;
  bold: Uint8Array;
}

interface PinnedFile {
  file: string;
  sha256: string;
}

/** Each family's files and their pinned digests (decision 6: a family id never changes its files). */
export const FONT_FILES: Record<FontFamily, { regular: PinnedFile; bold: PinnedFile }> = {
  'dejavu-sans': {
    regular: { file: 'DejaVuSans.ttf', sha256: '7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954' },
    bold: { file: 'DejaVuSans-Bold.ttf', sha256: 'e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724' },
  },
  'noto-sans': {
    regular: { file: 'NotoSans-Regular.ttf', sha256: 'f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8' },
    bold: { file: 'NotoSans-Bold.ttf', sha256: '87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9' },
  },
  'noto-serif': {
    regular: { file: 'NotoSerif-Regular.ttf', sha256: 'a15cfbbc1539d707115111d672d590a3d70d4f74b4c0a315956da20ae19a14e1' },
    bold: { file: 'NotoSerif-Bold.ttf', sha256: '24ad531e6b05ddad8c3d89572d2c93eb86a6b74e652ce7ee3c3e171de68e84c3' },
  },
};

const FONT_DIR = path.join(process.cwd(), 'assets', 'fonts');

const files = new Map<FontFamily, FontFiles>();
const coverage = new Map<FontFamily, Array<{ hasGlyphForCodePoint(cp: number): boolean }>>();

/** A family id of the template model, or a loud failure (a stored document naming an unknown family is malformed). */
function known(family: string): FontFamily {
  if (!(FONT_FAMILIES as readonly string[]).includes(family)) {
    throw new Error(`fonts: unknown font family ${JSON.stringify(family)}`);
  }
  return family as FontFamily;
}

function readPinned(pin: PinnedFile): Uint8Array {
  const bytes = new Uint8Array(readFileSync(path.join(FONT_DIR, pin.file)));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== pin.sha256) {
    throw new Error(`fonts: ${pin.file} is not the pinned file (sha256 ${digest}, expected ${pin.sha256})`);
  }
  return bytes;
}

/** The two font files of a family (read and checked against their pins once per process). */
export function fontFiles(family: FontFamily): FontFiles {
  const id = known(family);
  let f = files.get(id);
  if (!f) {
    f = { regular: readPinned(FONT_FILES[id].regular), bold: readPinned(FONT_FILES[id].bold) };
    files.set(id, f);
  }
  return f;
}

/** True when BOTH faces of the family can draw the code point (a field may be set in either). */
export function canDraw(cp: number, family: FontFamily): boolean {
  const id = known(family);
  let faces = coverage.get(id);
  if (!faces) {
    const f = fontFiles(id);
    faces = [fontkit.create(f.regular as unknown as Buffer), fontkit.create(f.bold as unknown as Buffer)];
    coverage.set(id, faces);
  }
  return faces.every((face) => face.hasGlyphForCodePoint(cp));
}

/** The characters of `text` the family cannot draw (each once, in order). */
export function undrawable(text: string, family: FontFamily): string[] {
  const out: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // Variation selectors and joiners are invisible modifiers; they draw nothing.
    if (cp === 0xfe0f || cp === 0xfe0e || cp === 0x200d) continue;
    if (!canDraw(cp, family) && !out.includes(ch)) out.push(ch);
  }
  return out;
}

export { fontkit };
