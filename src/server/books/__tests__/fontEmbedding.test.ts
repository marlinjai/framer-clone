// src/server/books/__tests__/fontEmbedding.test.ts
//
// Every glyph a document prints has an outline in the font embedded in the
// PDF. Reading the text back (the completeness check) cannot see a glyph that
// was embedded empty: the text is there, every viewer draws a blank. That is
// how Noto went live on 2026-10-23 with most letters missing (pdf-lib's
// subsetter broke its glyph table). So this test takes each embedded font back
// out of the PDF, maps every glyph the text uses to its character through the
// PDF's own ToUnicode table, and requires an outline for every character that
// is not white space. The first test proves the check finds exactly that
// defect, so it cannot pass by accident.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import fontkit from '@pdf-lib/fontkit';
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { renderTemplate } from '../render/engine';
import { EMBED_SUBSET } from '../render/engine/fontEmbedding';
import { FONT_FILES, fontFiles } from '../render/fonts';
import { buildRenderModel } from '../render/model';
import { preset } from '../template/presets';
import { probe, probeInput } from '../template/probes';
import { FONT_FAMILIES } from '../template/schema';

interface BlankGlyph {
  font: string;
  char: string;
  gid: number;
}

/** The characters of every embedded font that the PDF prints without an outline. */
async function blankGlyphs(bytes: Uint8Array): Promise<{ fonts: number; checked: number; blanks: BlankGlyph[] }> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const blanks: BlankGlyph[] = [];
  let fonts = 0;
  let checked = 0;
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.get(PDFName.of('Subtype')) !== PDFName.of('Type0')) continue;
    fonts += 1;
    const name = String(obj.get(PDFName.of('BaseFont')));
    const toUnicode = pdf.context.lookup(obj.get(PDFName.of('ToUnicode'))) as PDFRawStream;
    const cmap = Buffer.from(decodePDFRawStream(toUnicode).decode()).toString('latin1');
    const descendant = pdf.context.lookup((pdf.context.lookup(obj.get(PDFName.of('DescendantFonts'))) as PDFArray).get(0)) as PDFDict;
    const descriptor = pdf.context.lookup(descendant.get(PDFName.of('FontDescriptor'))) as PDFDict;
    const file = pdf.context.lookup(descriptor.get(PDFName.of('FontFile2'))) as PDFRawStream;
    const font = fontkit.create(Buffer.from(decodePDFRawStream(file).decode()));
    // pdf-lib writes the glyphs it used as bfchar or bfrange entries: <gid> <utf16> or <first> <last> <utf16>.
    const entries: Array<[number, string]> = [];
    for (const [, section] of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const [, gid, uni] of section.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) entries.push([parseInt(gid, 16), utf16(uni)]);
    }
    for (const [, section] of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const [, a, b, uni] of section.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        const first = parseInt(a, 16);
        const start = utf16(uni).codePointAt(0)!;
        for (let gid = first; gid <= parseInt(b, 16); gid++) entries.push([gid, String.fromCodePoint(start + gid - first)]);
      }
    }
    for (const [gid, char] of entries) {
      // Spaces, control and format characters (a zero-width space, invisible operators) and variation selectors have no outline by design.
      // A whole font's ToUnicode lists its full character map, so these appear even when the text has none.
      if (/^[\s\p{Cc}\p{Cf}\p{Z}\p{Variation_Selector}]+$/u.test(char)) continue;
      checked += 1;
      let drawn: boolean;
      try {
        drawn = font.getGlyph(gid).path.toSVG().length > 0;
      } catch {
        // A glyph whose data runs past the font's tables (what the broken subsets look like) draws nothing either.
        drawn = false;
      }
      if (!drawn) blanks.push({ font: name, char, gid });
    }
  }
  return { fonts, checked, blanks };
}

function utf16(hex: string): string {
  const units: number[] = [];
  for (let i = 0; i < hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
  return String.fromCharCode(...units);
}

function documentIn(family: (typeof FONT_FAMILIES)[number]) {
  const doc = preset('klassisch');
  doc.theme.fontFamily = family;
  return doc;
}

describe('every printed glyph has an outline in the embedded font', () => {
  it('the check finds the defect: pdf-lib subsetting Noto embeds empty glyphs', async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    pdf.registerFontkit(fontkit);
    const file = path.join(process.cwd(), 'assets', 'fonts', FONT_FILES['noto-serif'].regular.file);
    const font = await pdf.embedFont(new Uint8Array(readFileSync(file)), { subset: true });
    pdf.addPage([300, 80]).drawText('Rechnung Nettobetrag', { x: 10, y: 30, size: 14, font });
    const { checked, blanks } = await blankGlyphs(await pdf.save());
    expect(checked).toBeGreaterThan(5);
    expect(blanks.length).toBeGreaterThan(0);
  });

  it.each(FONT_FAMILIES)('%s: no blank glyph on a regular invoice, and only DejaVu is subset', async (family) => {
    const { bytes } = await renderTemplate(buildRenderModel(probeInput(probe('regular'))), documentIn(family), fontFiles(family));
    const { fonts, checked, blanks } = await blankGlyphs(bytes);
    expect(fonts).toBe(2); // regular and bold
    expect(checked).toBeGreaterThan(40);
    expect(blanks.map((b) => `${b.char}:${b.gid}`).join(" ")).toBe("");
    expect(EMBED_SUBSET[family]).toBe(family === 'dejavu-sans');
  });

  it.each(FONT_FAMILIES)('%s: no blank glyph in formatted texts, all four faces embedded', async (family) => {
    // The italic faces are where an embedding defect would hide: Noto's subset printed blanks before (fonts.ts).
    const { bytes } = await renderTemplate(buildRenderModel(probeInput(probe('formattedTexts'))), documentIn(family), fontFiles(family));
    const { fonts, checked, blanks } = await blankGlyphs(bytes);
    expect(fonts).toBe(4); // regular, bold, italic and bold italic
    expect(checked).toBeGreaterThan(40);
    expect(blanks.map((b) => `${b.font} ${b.char}:${b.gid}`).join(' ')).toBe('');
  });

  it.each(FONT_FAMILIES)('%s: the same document twice gives the same bytes', async (family) => {
    const render = () => renderTemplate(buildRenderModel(probeInput(probe('reverseCharge'))), documentIn(family), fontFiles(family));
    const [a, b] = [await render(), await render()];
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });
});
