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
// What a family cannot draw (Chinese, Japanese and Korean, many emoji, other
// scripts) is NEVER printed as a substitute on a document of record:
// `undrawable()` finds it, per family, and issue refuses with the field named
// (UNDRAWABLE_TEXT). Only a draft preview, which is not a document, shows a
// "?" in its place.
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
import { FONT_FILES, type PinnedFile } from './fontPins';
import { undrawableWith } from './previewSafe';

export interface FontFiles {
  regular: Uint8Array;
  bold: Uint8Array;
  /** The italic faces, read with the others; the engine embeds them only when a run is italic. */
  italic: Uint8Array;
  boldItalic: Uint8Array;
}

// The pins live in fontPins.ts (no Node imports), so the browser checks the files it fetches against the same digests.
export { FONT_FILES };

const FONT_DIR = path.join(process.cwd(), 'assets', 'fonts');

const files = new Map<FontFamily, FontFiles>();
const coverage = new Map<string, Array<{ hasGlyphForCodePoint(cp: number): boolean }>>();

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

/** The font files of a family, its four faces (read and checked against their pins once per process). */
export function fontFiles(family: FontFamily): FontFiles {
  const id = known(family);
  let f = files.get(id);
  if (!f) {
    const pins = FONT_FILES[id];
    f = { regular: readPinned(pins.regular), bold: readPinned(pins.bold), italic: readPinned(pins.italic), boldItalic: readPinned(pins.boldItalic) };
    files.set(id, f);
  }
  return f;
}

function covers(family: FontFamily, italic: boolean, cp: number): boolean {
  const id = known(family);
  const key = `${id}|${italic ? 'italic' : 'upright'}`;
  let faces = coverage.get(key);
  if (!faces) {
    const f = fontFiles(id);
    const pair = italic ? [f.italic, f.boldItalic] : [f.regular, f.bold];
    faces = pair.map((bytes) => fontkit.create(bytes as unknown as Buffer));
    coverage.set(key, faces);
  }
  return faces.every((face) => face.hasGlyphForCodePoint(cp));
}

/** True when BOTH upright faces of the family can draw the code point (a field may be set in either). */
export function canDraw(cp: number, family: FontFamily): boolean {
  return covers(family, false, cp);
}

/** True when BOTH italic faces can draw the code point (an italic run may be bold too); they cover less than the upright ones. */
export function canDrawItalic(cp: number, family: FontFamily): boolean {
  return covers(family, true, cp);
}

/** The characters of `text` the family's italic faces cannot draw (each once, in order). */
export function undrawableItalic(text: string, family: FontFamily): string[] {
  return undrawableWith(text, (cp) => canDrawItalic(cp, family));
}

/** The characters of `text` the family cannot draw (each once, in order). */
export function undrawable(text: string, family: FontFamily): string[] {
  return undrawableWith(text, (cp) => canDraw(cp, family));
}

/** The bytes of the pinned font file with this digest (read and checked once per process), or null for any other digest. */
export function fontFileByDigest(sha256: string): Uint8Array | null {
  for (const family of FONT_FAMILIES) {
    for (const face of ['regular', 'bold', 'italic', 'boldItalic'] as const) {
      if (FONT_FILES[family][face].sha256 === sha256) return fontFiles(family)[face];
    }
  }
  return null;
}

export { fontkit };
