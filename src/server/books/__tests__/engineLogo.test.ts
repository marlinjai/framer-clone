// src/server/books/__tests__/engineLogo.test.ts
//
// The logo block in the layout engine (render/engine, visual template composer
// plan decisions 3, 10 and 15): drawn at its width in millimetres with the
// image's own aspect ratio, aligned left, centre or right in its box, in every
// region a logo may stand in and inside `columns` cells; a PNG and a JPEG; one
// embedded image however many blocks name it; a missing asset is a named
// layout issue and draws nothing; a logo wider than its cell is a layout
// issue; and the bytes are deterministic with a logo in each of the three
// families (twice in one process and in a fresh process).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { renderTemplate, type EngineImage, type EngineResult, type LayoutRect } from '../render/engine';
import { clearPreparedImages } from '../render/engine/images';
import { geometry, MM, PAGE_HEIGHT, r2 } from '../render/engine/style';
import { fontFiles } from '../render/fonts';
import { buildRenderModel } from '../render/model';
import { preset } from '../template/presets';
import { probe, probeInput, type ProbeName } from '../template/probes';
import { ALLOWED_REGIONS } from '../template/rules';
import { FONT_FAMILIES, withOnlyLogo, type Block, type CellBlock, type RegionName, type TemplateDocumentV2 } from '../template/schema';
import { assetSha, logoCase, makeJpeg, makePng } from './testImages';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const WIDE_PNG = makePng(300, 100, { colorType: 2 });
const TALL_JPEG = makeJpeg(100, 300);
const ASSETS = new Map<string, EngineImage>([
  [assetSha(WIDE_PNG), { contentType: 'image/png', bytes: WIDE_PNG }],
  [assetSha(TALL_JPEG), { contentType: 'image/jpeg', bytes: TALL_JPEG }],
]);

function logo(id: string, sha256: string | null, widthMm: number, align?: 'left' | 'center' | 'right'): Extract<Block, { type: 'logo' }> {
  return { id, type: 'logo', style: align ? { align } : {}, widthMm, assetSha256: sha256 };
}

function render(doc: TemplateDocumentV2, name: ProbeName = 'longInvoice', assets: ReadonlyMap<string, EngineImage> = ASSETS): Promise<EngineResult> {
  return renderTemplate(buildRenderModel(probeInput(probe(name))), doc, fontFiles(doc.theme.fontFamily), { assets });
}

/** Klassisch with blocks pushed onto a region. */
function withBlocks(region: RegionName, ...blocks: Block[]): TemplateDocumentV2 {
  const doc = structuredClone(preset('klassisch'));
  const target =
    region === 'addressZone.left' ? doc.regions.addressZone.left : region === 'addressZone.right' ? doc.regions.addressZone.right : doc.regions[region];
  target.push(...blocks);
  return doc;
}

/** Every image drawn, per page: its rectangle in points from the bottom left (as drawn) and the XObject it shows. */
async function drawnImages(bytes: Uint8Array): Promise<Array<{ page: number; x: number; y: number; width: number; height: number; name: string }>> {
  const pdf = await PDFDocument.load(bytes);
  const out: Array<{ page: number; x: number; y: number; width: number; height: number; name: string }> = [];
  pdf.getPages().forEach((page, i) => {
    const contents = page.node.get(PDFName.of('Contents'));
    const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
    const text = refs
      .map((r) => {
        const s = pdf.context.lookup(r as PDFRef);
        return s instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(s).decode()).toString('latin1') : '';
      })
      .join('\n');
    // pdf-lib's drawImage: translate to the corner, rotate (none), scale to the size, skew (none), show.
    const num = '(-?[\\d.]+)';
    const op = new RegExp(`1 0 0 1 ${num} ${num} cm\\s+1 0 0 1 0 0 cm\\s+${num} 0 0 ${num} 0 0 cm\\s+1 0 0 1 0 0 cm\\s+/(\\S+) Do`, 'g');
    for (const m of text.matchAll(op)) {
      out.push({ page: i + 1, x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]), name: m[5] });
    }
  });
  return out;
}

/** The number of image XObjects in the file (an image embedded once however often it is drawn). */
async function embeddedImages(bytes: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(bytes);
  let n = 0;
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) n += 1;
  }
  return n;
}

const rect = (layout: EngineResult['layout'], id: string): LayoutRect[] => layout.blocks.filter((r) => r.blockId === id);

describe('a logo in every region it may stand in', () => {
  const doc0 = preset('klassisch');
  const geo = geometry(doc0);
  const box: Record<string, { x: number; width: number }> = {
    firstPageHeader: { x: geo.left, width: geo.contentWidth },
    followingPageHeader: { x: geo.left, width: geo.contentWidth },
    footer: { x: geo.left, width: geo.contentWidth },
    'addressZone.right': geo.addressRight,
  };
  const cases = ALLOWED_REGIONS.logo.flatMap((region) => (['left', 'center', 'right'] as const).map((align) => [region, align] as const));

  it('covers every allowed region', () => {
    expect([...ALLOWED_REGIONS.logo].sort()).toEqual(Object.keys(box).sort());
  });

  it.each(cases)('%s, aligned %s: its width, the aspect ratio and the position', async (region, align) => {
    const { bytes, layout } = await render(withBlocks(region, logo('lg', assetSha(WIDE_PNG), 30, align)));
    expect(layout.issues).toEqual([]);
    const rects = rect(layout, 'lg');
    // The following-page header and the footer repeat on every further page; the others stand on page 1.
    expect(rects.length).toBe(region === 'followingPageHeader' ? layout.pageCount - 1 : region === 'footer' ? layout.pageCount : 1);
    const w = r2(30 * MM);
    const h = r2(w / 3);
    const b = box[region];
    const x = r2(align === 'left' ? b.x : align === 'right' ? b.x + b.width - w : b.x + (b.width - w) / 2);
    for (const r of rects) {
      expect(r.region).toBe(region);
      expect(r.width).toBe(w);
      expect(r.height).toBe(h);
      expect(Math.abs(r.x - x)).toBeLessThanOrEqual(0.01);
    }
    // Drawn exactly where the layout map says (the map measures from the top, the PDF from the bottom).
    const drawn = await drawnImages(bytes);
    expect(drawn).toHaveLength(rects.length);
    for (const r of rects) {
      const d = drawn.find((i) => i.page === r.page)!;
      expect(d).toMatchObject({ width: r.width, height: r.height, x: r.x });
      expect(Math.abs(d.y - (PAGE_HEIGHT - r.y - r.height))).toBeLessThanOrEqual(0.01);
    }
  });

  it('keeps a tall JPEG at its aspect ratio and takes its height in the flow', async () => {
    const { layout } = await render(withBlocks('addressZone.right', logo('lg', assetSha(TALL_JPEG), 15)), 'regular');
    const [r] = rect(layout, 'lg');
    expect(r.width).toBe(r2(15 * MM));
    expect(r.height).toBe(r2(r2(15 * MM) * 3));
    expect(layout.issues).toEqual([]);
    // Stacked below the document data, inside the right column.
    const meta = layout.blocks.find((b) => b.blockId === 'documentMeta')!;
    expect(r.y).toBeGreaterThanOrEqual(meta.y + meta.height);
  });

  it('flags a logo too tall for the letterhead (it would push into the address field)', async () => {
    const { layout } = await render(withBlocks('firstPageHeader', logo('lg', assetSha(TALL_JPEG), 15)), 'regular');
    expect(layout.issues).toContainEqual({ code: 'HEADER_TOO_TALL', blockId: null, region: 'firstPageHeader' });
  });
});

describe('a logo inside columns', () => {
  it.each(['firstPageHeader', 'body', 'followingPageHeader', 'footer'] as const)('in %s: in its cell, aligned in the cell', async (region) => {
    const cells: Array<{ width: number; blocks: CellBlock[] }> = [
      { width: 6, blocks: [{ id: 'txt', type: 'freeText', style: {}, heading: null, text: 'Links', variant: 'normal' }] },
      { width: 6, blocks: [logo('cellLogo', assetSha(WIDE_PNG), 25, 'right')] },
    ];
    const { layout } = await render(withBlocks(region, { id: 'row', type: 'columns', style: {}, cells }));
    expect(layout.issues).toEqual([]);
    const geo = geometry(preset('klassisch'));
    const cellW = r2((geo.contentWidth - 12) / 2);
    const cellX = geo.left + cellW + 12;
    const w = r2(25 * MM);
    const rects = rect(layout, 'cellLogo');
    expect(rects.length).toBeGreaterThan(0);
    for (const r of rects) {
      expect(r.width).toBe(w);
      expect(r.height).toBe(r2(w / 3));
      expect(Math.abs(r.x - (cellX + cellW - w))).toBeLessThanOrEqual(0.02);
      // The row is as tall as its tallest cell: the logo.
      const row = layout.blocks.find((b) => b.blockId === 'row' && b.page === r.page)!;
      expect(row.height).toBeGreaterThanOrEqual(r.height);
    }
  });

  it('flags a logo wider than its cell (it would run into the neighbour)', async () => {
    const cells = [1, 2, 3, 4].map((i) => ({ width: 3, blocks: i === 4 ? [logo('wide', assetSha(WIDE_PNG), 80)] : [] }));
    const { layout } = await render(withBlocks('footer', { id: 'row', type: 'columns', style: {}, cells }));
    expect(layout.issues).toContainEqual({ code: 'BLOCK_TOO_WIDE', blockId: 'wide', region: 'footer' });
  });
});

describe('assets', () => {
  it('embeds an image once however many blocks show it, and draws it on every page that has one', async () => {
    const { doc, assets } = logoCase('dejavu-sans', 'jpeg');
    const { bytes, layout } = await render(doc, 'longInvoice', assets);
    expect(layout.pageCount).toBeGreaterThan(1);
    expect(await embeddedImages(bytes)).toBe(1);
    const drawn = await drawnImages(bytes);
    expect(drawn.filter((d) => d.page === 1)).toHaveLength(1);
    for (let p = 2; p <= layout.pageCount; p += 1) expect(drawn.filter((d) => d.page === p)).toHaveLength(1);
  });

  it('draws nothing and takes no space for a logo without an asset (no issue)', async () => {
    const { bytes, layout } = await render(withBlocks('firstPageHeader', logo('lg', null, 30)));
    expect(rect(layout, 'lg')).toEqual([]);
    expect(layout.issues).toEqual([]);
    expect(await embeddedImages(bytes)).toBe(0);
  });

  it('names a logo whose asset was not passed (LOGO_ASSET_MISSING) and draws nothing for it', async () => {
    const missing = 'f'.repeat(64);
    const { bytes, layout } = await render(withBlocks('addressZone.right', logo('lg', missing, 30)));
    expect(layout.issues).toEqual([{ code: 'LOGO_ASSET_MISSING', blockId: 'lg', region: 'addressZone.right' }]);
    expect(rect(layout, 'lg')).toEqual([]);
    expect(await embeddedImages(bytes)).toBe(0);
  });

  it('ignores assets the template does not name', async () => {
    const a = await render(preset('klassisch'), 'regular', new Map());
    const b = await render(preset('klassisch'), 'regular', ASSETS);
    expect(sha(b.bytes)).toBe(sha(a.bytes));
  });

  it('refuses an asset whose bytes are not the hash it is passed under (the prepared images are shared)', async () => {
    const doc = withBlocks('firstPageHeader', logo('lg', 'a'.repeat(64), 30));
    await expect(render(doc, 'regular', new Map([['a'.repeat(64), { contentType: 'image/png', bytes: WIDE_PNG }]]))).rejects.toThrow(/other bytes/);
  });

  it('draws a layout with only the snapshot logo exactly as the engine drew logos before assets existed', async () => {
    // Before phase 5 a logo block drew nothing whatever it named: emptying the other blocks gives those bytes.
    const named = withBlocks('firstPageHeader', logo('lg', assetSha(WIDE_PNG), 30), logo('lg2', 'b'.repeat(64), 20));
    const empty = withBlocks('firstPageHeader', logo('lg', null, 30), logo('lg2', null, 20));
    const a = await render(withOnlyLogo(named, null), 'regular', new Map());
    const b = await render(empty, 'regular', new Map());
    expect(sha(a.bytes)).toBe(sha(b.bytes));
    expect(a.layout.issues).toEqual([]);
    // With the snapshot's logo, that one is drawn and the other stays empty.
    const kept = await render(withOnlyLogo(named, { sha256: assetSha(WIDE_PNG) }), 'regular');
    expect(rect(kept.layout, 'lg')).toHaveLength(1);
    expect(rect(kept.layout, 'lg2')).toEqual([]);
    expect(kept.layout.issues).toEqual([]);
  });

  it('refuses a stored logo block with a malformed width or hash before drawing', async () => {
    const bad = withBlocks('firstPageHeader', { ...logo('lg', 'NOT-A-HASH', 30) });
    await expect(render(bad)).rejects.toThrow(/regions\.firstPageHeader\.\d+\.assetSha256/);
    const zero = withBlocks('firstPageHeader', { ...logo('lg', null, 0) });
    await expect(render(zero)).rejects.toThrow(/widthMm/);
  });
});

describe('latency with a logo (decision 12)', () => {
  it('renders a page with a 2000 x 2000 px RGBA (red, green, blue, alpha) logo within four times the one-page target', async () => {
    // Cold: the first render prepares the image, the later ones copy the prepared streams.
    clearPreparedImages();
    const big = makePng(2000, 2000);
    const doc = withBlocks('firstPageHeader', logo('lg', assetSha(big), 25, 'right'));
    const assets = new Map<string, EngineImage>([[assetSha(big), { contentType: 'image/png', bytes: big }]]);
    const first = await render(doc, 'regular', assets);
    const times: number[] = [];
    let last: EngineResult = first;
    for (let i = 0; i < 10; i += 1) {
      const started = performance.now();
      last = await render(doc, 'regular', assets);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    // The 90th percentile of ten runs.
    expect(times[8]).toBeLessThan(600);
    // The render that prepared the image and the ones that found it prepared write the same bytes.
    expect(sha(last.bytes)).toBe(sha(first.bytes));
  }, 60_000);
});

describe('determinism with a logo', () => {
  const cases = FONT_FAMILIES.flatMap((family) => (['png', 'jpeg'] as const).map((kind) => [family, kind] as const));

  it.each(cases)('%s with a %s logo: the same bytes twice', async (family, kind) => {
    const { doc, assets } = logoCase(family, kind);
    const a = await render(doc, 'longInvoice', assets);
    const b = await render(doc, 'longInvoice', new Map(assets));
    expect(sha(a.bytes)).toBe(sha(b.bytes));
    expect(a.layout).toEqual(b.layout);
    expect(a.layout.issues).toEqual([]);
  });

  it.each([
    ['dejavu-sans', 'png'],
    ['noto-sans', 'jpeg'],
    ['noto-serif', 'png'],
  ] as const)('%s with a %s logo: the same bytes in a fresh process', async (family, kind) => {
    const { doc, assets } = logoCase(family, kind);
    const here = await renderTemplate(buildRenderModel(probeInput(probe('reverseCharge'))), doc, fontFiles(family), { assets });
    const child = execFileSync(process.execPath, ['--import', 'tsx', path.join(__dirname, 'engineChild.ts'), family, kind], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, TZ: 'Pacific/Kiritimati' },
    }).trim();
    expect(child).toBe(sha(here.bytes));
  }, 60_000);

  it('gives each family different bytes for the same document', async () => {
    const hashes = await Promise.all(FONT_FAMILIES.map(async (f) => sha((await render(logoCase(f, 'png').doc, 'regular', logoCase(f, 'png').assets)).bytes)));
    expect(new Set(hashes).size).toBe(3);
  });
});
