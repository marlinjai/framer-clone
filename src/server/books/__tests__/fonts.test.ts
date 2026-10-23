// src/server/books/__tests__/fonts.test.ts
//
// The three font families (render/fonts.ts, visual template composer plan
// decision 6):
//   - each family loads its two pinned files (the static Regular and Bold
//     faces, checked against their SHA-256), an unknown family fails loudly;
//   - the drawable check uses the coverage of the family the document is set
//     in: a character one family draws and another does not is refused only
//     under the other (issue, the gate) and shown as "?" only in its preview;
//   - a document issued under DejaVu Sans before phase 5 re-renders to the
//     same bytes: the golden hashes in dejavuGolden.json were recorded on
//     2026-10-23 from the engine as it stood on main BEFORE the font family
//     became a parameter (the three presets as they stood then, frozen in the
//     same file, against every probe document). A change to them is a
//     regression, never an update.

import { createHash } from 'node:crypto';

import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { familyOf, previewSafe, previewSafeTemplate, undrawableFields } from '../render/drawable';
import { renderTemplate } from '../render/engine';
import { canDraw, FONT_FILES, fontFiles, fontkit, undrawable } from '../render/fonts';
import { buildRenderModel } from '../render/model';
import { templateProblems } from '../template/gate';
import { preset } from '../template/presets';
import { PROBE_NAMES, probe, probeInput } from '../template/probes';
import { FONT_FAMILIES, type FontFamily, type TemplateDocumentV2 } from '../template/schema';
import golden from './dejavuGolden.json';
import { issuedInput, regularInvoice } from './renderFixtures';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The BaseFont names of every font a PDF embeds (pdf-lib appends a seeded number). */
async function baseFonts(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes);
  const out = new Set<string>();
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of('Type')) === PDFName.of('Font')) {
      const base = obj.get(PDFName.of('BaseFont'));
      if (base instanceof PDFName) out.add(base.decodeText());
    }
  }
  return [...out].sort();
}

const withFamily = (doc: TemplateDocumentV2, family: FontFamily): TemplateDocumentV2 => ({ ...doc, theme: { ...doc.theme, fontFamily: family } });

describe('the font files', () => {
  it.each(FONT_FAMILIES)('%s loads its pinned static Regular and Bold faces', (family) => {
    const files = fontFiles(family);
    expect(sha(files.regular)).toBe(FONT_FILES[family].regular.sha256);
    expect(sha(files.bold)).toBe(FONT_FILES[family].bold.sha256);
    const regular = fontkit.create(files.regular as unknown as Buffer) as unknown as { subfamilyName: string; directory: { tables: Record<string, unknown> } };
    const bold = fontkit.create(files.bold as unknown as Buffer) as unknown as { subfamilyName: string; directory: { tables: Record<string, unknown> } };
    expect(['Regular', 'Book']).toContain(regular.subfamilyName);
    expect(bold.subfamilyName).toBe('Bold');
    // Static faces: a variable font (fvar) would draw its default instance and could change with an update.
    expect(regular.directory.tables.fvar).toBeUndefined();
    expect(bold.directory.tables.fvar).toBeUndefined();
  });

  it('pins six distinct files, one pair per family', () => {
    const digests = FONT_FAMILIES.flatMap((f) => [FONT_FILES[f].regular.sha256, FONT_FILES[f].bold.sha256]);
    expect(new Set(digests).size).toBe(6);
  });

  it('refuses an unknown family loudly (a malformed stored document never draws in a fallback font)', () => {
    expect(() => fontFiles('comic-sans' as FontFamily)).toThrow(/unknown font family/);
    expect(() => canDraw(0x41, 'comic-sans' as FontFamily)).toThrow(/unknown font family/);
  });
});

describe('the drawable check per family', () => {
  it('knows what each family draws', () => {
    // Every family: German, the euro, Greek, Cyrillic, the capital sharp s.
    for (const family of FONT_FAMILIES) expect(undrawable('Grüße, 12 € ΩЖ ẞ', family)).toEqual([]);
    // DejaVu draws arrows and the infinity sign, Noto does not; Noto draws the bitcoin sign, DejaVu does not.
    expect(undrawable('A → B ∞', 'dejavu-sans')).toEqual([]);
    expect(undrawable('A → B ∞', 'noto-sans')).toEqual(['→', '∞']);
    expect(undrawable('A → B ∞', 'noto-serif')).toEqual(['→', '∞']);
    expect(undrawable('₿', 'dejavu-sans')).toEqual(['₿']);
    expect(undrawable('₿', 'noto-sans')).toEqual([]);
    // No family draws Chinese, Japanese or Korean.
    for (const family of FONT_FAMILIES) expect(undrawable('中', family)).toEqual(['中']);
  });

  it("checks a document's fields in its template's family (DejaVu for a version 1 layout)", () => {
    const f = regularInvoice();
    f.lines[0] = { ...f.lines[0], title: 'Umzug → Lager' };
    const input = issuedInput(f);
    expect(familyOf(null)).toBe('dejavu-sans');
    expect(undrawableFields(input, null)).toEqual([]);
    expect(undrawableFields(input, preset('klassisch'))).toEqual([]);
    expect(undrawableFields(input, withFamily(preset('klassisch'), 'noto-sans'))).toEqual(['line1.title']);
    expect(undrawableFields(input, withFamily(preset('klassisch'), 'noto-serif'))).toEqual(['line1.title']);
  });

  it("shows what the family cannot draw as ? in a preview only, the template's own texts in its family", () => {
    const f = regularInvoice();
    f.lines[0] = { ...f.lines[0], title: 'Umzug → Lager' };
    const model = buildRenderModel(issuedInput(f));
    expect(previewSafe(model, 'dejavu-sans').lines[0].title).toBe('Umzug → Lager');
    expect(previewSafe(model, 'noto-sans').lines[0].title).toBe('Umzug ? Lager');
    const doc = withFamily(preset('klassisch'), 'noto-serif');
    doc.regions.body.push({ id: 'note', type: 'freeText', style: {}, heading: null, text: 'Weiter → Seite 2', variant: 'normal' });
    expect(previewSafeTemplate(doc).regions.body.at(-1)).toMatchObject({ text: 'Weiter ? Seite 2' });
    expect(previewSafeTemplate(withFamily(doc, 'dejavu-sans')).regions.body.at(-1)).toMatchObject({ text: 'Weiter → Seite 2' });
  });

  it("refuses a template text its family cannot draw at save, naming the block", async () => {
    const doc = withFamily(preset('klassisch'), 'noto-sans');
    doc.regions.body.push({ id: 'note', type: 'freeText', style: {}, heading: null, text: 'Weiter → Seite 2', variant: 'normal' });
    expect(await templateProblems(doc)).toEqual([expect.objectContaining({ code: 'UNDRAWABLE_TEXT', blockId: 'note', field: 'text' })]);
    expect(await templateProblems(withFamily(doc, 'dejavu-sans'))).toEqual([]);
  }, 60_000);
});

describe('every family on every preset', () => {
  it.each(FONT_FAMILIES)('passes the whole save gate in %s', async (family) => {
    for (const name of ['klassisch', 'modern', 'kompakt'] as const) {
      expect(await templateProblems(withFamily(preset(name), family)), `${name} in ${family}`).toEqual([]);
    }
  }, 120_000);

  it('embeds the family it is set in', async () => {
    const names = new Map<FontFamily, string>([
      ['dejavu-sans', 'DejaVuSans'],
      ['noto-sans', 'NotoSans'],
      ['noto-serif', 'NotoSerif'],
    ]);
    for (const family of FONT_FAMILIES) {
      const { bytes } = await renderTemplate(buildRenderModel(probeInput(probe('regular'))), withFamily(preset('klassisch'), family), fontFiles(family));
      const fonts = await baseFonts(bytes);
      expect(fonts.length).toBeGreaterThan(0);
      for (const f of fonts) expect(f, `${family} embeds ${f}`).toMatch(new RegExp(`^${names.get(family)!}(-Regular|-Bold)?-\\d+$`));
    }
  });
});

describe('documents issued under DejaVu Sans before phase 5', () => {
  it('re-render to their recorded bytes', async () => {
    const docs = golden.documents as unknown as Record<string, TemplateDocumentV2>;
    const got: Record<string, string> = {};
    for (const name of Object.keys(docs)) {
      for (const p of PROBE_NAMES) {
        const { bytes } = await renderTemplate(buildRenderModel(probeInput(probe(p))), docs[name], fontFiles('dejavu-sans'));
        got[`${name}/${p}`] = sha(bytes);
      }
    }
    expect(got).toEqual(golden.hashes);
  }, 60_000);
});
