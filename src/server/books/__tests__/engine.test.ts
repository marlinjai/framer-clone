// src/server/books/__tests__/engine.test.ts
//
// The layout engine (render/engine, visual template composer plan, decisions
// 5, 7 and 10): every block type in every region it may stand in, the
// pagination rules, the minimum widths against the largest values, nothing
// drawn off the page or under the footer, the stamps, and determinism (twice
// in one process, and in a fresh process).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { MAX_PAGES, renderTemplate, RENDERER_ID, type EngineResult } from '../render/engine';
import { extractDrawnText, extractPdfText } from '../render/extractText';
import { fontFiles } from '../render/fonts';
import { buildRenderModel } from '../render/model';
import { PRESETS, preset } from '../template/presets';
import { probe, probeInput, type ProbeName } from '../template/probes';
import { ALLOWED_REGIONS } from '../template/rules';
import { REGIONS, type Block, type BlockType, type RegionName, type TemplateDocumentV2 } from '../template/schema';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function render(doc: TemplateDocumentV2, name: ProbeName = 'regular', opts: { draft?: boolean; preview?: boolean } = {}): Promise<EngineResult> {
  return renderTemplate(buildRenderModel(probeInput(probe(name), opts.draft ?? false)), doc, fontFiles('dejavu-sans'), { preview: opts.preview });
}

/** A sample block of each type. */
function sample(type: BlockType, id: string): Block {
  const base = { id, style: {} };
  switch (type) {
    case 'logo':
      return { ...base, type, widthMm: 40, assetSha256: null };
    case 'documentMeta':
      return { ...base, type, items: ['number', 'issueDate', 'serviceDate', 'recipientVatId'] };
    case 'lineTable':
      return { ...preset('klassisch').regions.body.find((b) => b.type === 'lineTable')!, id };
    case 'paymentDetails':
      return { ...base, type, heading: 'Zahlung' };
    case 'paymentQr':
      return { ...base, type, caption: 'Bitte scannen.', sizeMm: 30 };
    case 'senderColumns':
      return { ...base, type, columns: ['identity', 'legal'], layout: 'columns' };
    case 'freeText':
      return { ...base, type, heading: 'Hinweis', text: 'Ein kurzer Hinweis.', variant: 'normal' };
    case 'spacer':
      return { ...base, type, heightPt: 8 };
    case 'divider':
      return { ...base, type, thicknessPt: 0.5, lineColor: 'muted' };
    case 'columns':
      return {
        ...base,
        type,
        cells: [
          { width: 6, blocks: [{ id: `${id}-a`, type: 'freeText', style: {}, heading: null, text: 'Links', variant: 'normal' }] },
          { width: 6, blocks: [{ id: `${id}-b`, type: 'divider', style: {}, thicknessPt: 0.5, lineColor: 'accent' }] },
        ],
      };
    default:
      return { ...base, type } as Block;
  }
}

/** Klassisch with the block added to a region (replacing a block of the same type there, ids kept unique). */
function withBlock(type: BlockType, region: RegionName): TemplateDocumentV2 {
  const doc = structuredClone(preset('klassisch'));
  const strip = (blocks: Block[]) => (['spacer', 'divider', 'freeText', 'columns', 'logo', 'title'].includes(type) ? blocks : blocks.filter((b) => b.type !== type));
  doc.regions.firstPageHeader = strip(doc.regions.firstPageHeader);
  doc.regions.addressZone.left = strip(doc.regions.addressZone.left);
  doc.regions.addressZone.right = strip(doc.regions.addressZone.right);
  doc.regions.body = strip(doc.regions.body);
  doc.regions.followingPageHeader = strip(doc.regions.followingPageHeader);
  doc.regions.footer = strip(doc.regions.footer);
  const block = sample(type, 'probe-block');
  const target =
    region === 'addressZone.left' ? doc.regions.addressZone.left : region === 'addressZone.right' ? doc.regions.addressZone.right : doc.regions[region];
  target.push(block);
  return doc;
}

describe('every block type in every region it may stand in', () => {
  const cases = (Object.keys(ALLOWED_REGIONS) as BlockType[]).flatMap((type) => ALLOWED_REGIONS[type].map((region) => [type, region] as const));
  it.each(cases)('%s in %s', async (type, region) => {
    // The long invoice reaches a second page, so the following-page header is drawn; only a
    // small-business invoice carries a tax note.
    const { layout } = await render(withBlock(type, region), type === 'taxNote' ? 'smallBusiness' : 'longInvoice');
    const rects = layout.blocks.filter((r) => r.blockId === 'probe-block');
    if (type === 'logo') {
      // A logo without an asset draws nothing and takes no space (with one: engineLogo.test.ts).
      expect(rects).toEqual([]);
      return;
    }
    expect(rects.length).toBeGreaterThan(0);
    for (const r of rects) {
      expect(r.region).toBe(region);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(layout.page.width);
      expect(r.y + r.height).toBeLessThanOrEqual(layout.page.height);
    }
    if (type === 'columns') expect(layout.blocks.some((r) => r.blockId === 'probe-block-a')).toBe(true);
    expect(layout.issues).toEqual([]);
  });

  it('covers all 17 block types and every region', () => {
    expect(Object.keys(ALLOWED_REGIONS)).toHaveLength(17);
    const regions = new Set(Object.values(ALLOWED_REGIONS).flat());
    for (const r of REGIONS) expect(regions.has(r)).toBe(true);
  });
});

describe('pagination', () => {
  it('repeats the table header and prints the following-page header on every further page', async () => {
    const { bytes, layout } = await render(preset('klassisch'), 'longInvoice');
    expect(layout.pageCount).toBeGreaterThanOrEqual(3);
    const drawn = await extractDrawnText(bytes);
    const tablePages = new Set(layout.blocks.filter((r) => r.blockId === 'lineTable').map((r) => r.page));
    expect(tablePages.size).toBeGreaterThanOrEqual(2);
    for (let p = 1; p <= layout.pageCount; p += 1) {
      const onPage = drawn.filter((d) => d.page === p);
      expect(onPage.filter((d) => d.text === 'Bezeichnung')).toHaveLength(tablePages.has(p) ? 1 : 0);
      expect(onPage.some((d) => d.text === `Seite ${p} von ${layout.pageCount}`)).toBe(true);
      if (p > 1) expect(onPage.some((d) => d.text === `Rechnung 2026-0042, Seite ${p} von ${layout.pageCount}`)).toBe(true);
    }
  });

  it('keeps the totals and the tax note on one page wherever the page breaks', async () => {
    for (let h = 0; h <= 30; h += 1) {
      const doc = structuredClone(preset('klassisch'));
      const at = doc.regions.body.findIndex((b) => b.type === 'totals');
      doc.regions.body.splice(at, 0, ...Array.from({ length: h }, (_, i) => ({ id: `gap${i}`, type: 'spacer' as const, style: {}, heightPt: 24 as const })));
      const { layout } = await render(doc, 'smallBusiness');
      const page = (id: string) => layout.blocks.filter((r) => r.blockId === id).map((r) => r.page);
      expect(page('totals')).toHaveLength(1);
      expect(page('taxNote')).toEqual(page('totals'));
    }
  });

  it('breaks a row taller than a page line by line and never draws under the footer', async () => {
    for (const name of PRESETS) {
      const { bytes, layout } = await render(preset(name), 'longDescription');
      expect(layout.pageCount).toBeGreaterThanOrEqual(2);
      expect(layout.issues).toEqual([]);
      const footerTop = Math.min(...layout.blocks.filter((r) => r.region === 'footer').map((r) => r.y));
      for (const r of layout.blocks.filter((b) => b.region === 'body')) expect(r.y + r.height).toBeLessThanOrEqual(footerTop);
      // Every drawn text baseline is on the page.
      for (const d of await extractDrawnText(bytes)) {
        expect(d.x).toBeGreaterThanOrEqual(0);
        expect(d.x).toBeLessThan(layout.page.width);
        expect(d.y).toBeGreaterThan(0);
        expect(d.y).toBeLessThan(layout.page.height);
      }
    }
  });

  it('moves a block that does not fit to the next page whole', async () => {
    const doc = structuredClone(preset('klassisch'));
    doc.regions.body.push({ id: 'terms', type: 'paymentDetails', style: {}, heading: 'Zahlung' });
    doc.regions.body = doc.regions.body.filter((b) => b.id !== 'paymentDetails');
    const { layout } = await render(doc, 'longInvoice');
    expect(layout.blocks.filter((r) => r.blockId === 'terms')).toHaveLength(1);
  });

  it('places the recipient in the DIN 5008 address field', async () => {
    for (const layoutName of ['din5008-b', 'din5008-a'] as const) {
      const doc = structuredClone(preset('klassisch'));
      doc.page.addressLayout = layoutName;
      const { layout } = await render(doc);
      const sender = layout.blocks.find((r) => r.blockId === 'senderLine')!;
      const mm = (pt: number) => (pt * 25.4) / 72;
      expect(Math.round(mm(sender.y))).toBe(layoutName === 'din5008-b' ? 45 : 27);
      expect(Math.round(mm(sender.x))).toBe(20);
    }
  });
});

describe('a malformed stored document', () => {
  it('fails loudly, naming the path, instead of drawing a wrong page', async () => {
    const cases: Array<[string, (d: Record<string, any>) => void]> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      ['regions.body.0.type', (d) => (d.regions.body[0].type = 'image')],
      ['page.addressLayout', (d) => (d.page.addressLayout = 'din5008-c')],
      ['page.marginsMm.left', (d) => delete d.page.marginsMm.left],
      ['regions.footer.0.lineColor', (d) => (d.regions.footer[0].lineColor = 'red')],
      ['theme.accent', (d) => (d.theme.accent = 'blue')],
    ];
    for (const [path, mutate] of cases) {
      const doc = structuredClone(preset('klassisch')) as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      mutate(doc);
      await expect(render(doc as unknown as TemplateDocumentV2)).rejects.toThrow(path);
    }
  });
});

describe('bounds', () => {
  it('stops at two pages when the footer leaves no room, and caps every document at MAX_PAGES', async () => {
    const footer = structuredClone(preset('klassisch'));
    footer.regions.footer.push(...Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, type: 'spacer' as const, style: {}, heightPt: 32 as const })));
    const t0 = performance.now();
    const { layout } = await render(footer, 'longInvoice');
    expect(layout.pageCount).toBeLessThanOrEqual(2);
    expect(layout.issues).toContainEqual(expect.objectContaining({ code: 'FOOTER_TOO_TALL' }));
    expect(performance.now() - t0).toBeLessThan(5000);

    expect(MAX_PAGES).toBe(200);
    const capped = await renderTemplate(buildRenderModel(probeInput(probe('longInvoice'))), preset('klassisch'), fontFiles('dejavu-sans'), { maxPages: 2 });
    expect(capped.layout.pageCount).toBe(2);
    expect(capped.layout.issues).toContainEqual(expect.objectContaining({ code: 'PAGE_LIMIT', region: 'body' }));
  });
});

describe('latency (decision 12)', () => {
  // The plan's targets are p95 under 150 ms (one page) and 400 ms (five pages)
  // of server time, measured by `pnpm bench:preview` on the production image
  // (Build notes). This suite runs beside the others on shared cores, so it
  // only guards against a gross regression, with four times the target.
  it('renders one page and five pages well within four times the targets', async () => {
    const run = async (name: ProbeName, lines?: number) => {
      const p = probe(name);
      if (lines) p.lines = Array.from({ length: lines }, (_, i) => ({ ...p.lines[i % p.lines.length], id: `l${i}`, position: i + 1 }));
      const model = buildRenderModel(probeInput(p));
      const doc = preset('klassisch');
      for (let i = 0; i < 3; i += 1) await renderTemplate(model, doc, fontFiles('dejavu-sans'), { preview: true });
      const times: number[] = [];
      let pages = 0;
      for (let i = 0; i < 20; i += 1) {
        const t0 = performance.now();
        pages = (await renderTemplate(model, doc, fontFiles('dejavu-sans'), { preview: true })).layout.pageCount;
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      return { p95: times[18], pages };
    };
    const one = await run('regular');
    expect(one.pages).toBe(1);
    expect(one.p95).toBeLessThan(600);
    const five = await run('longInvoice', 90);
    expect(five.pages).toBeGreaterThanOrEqual(5);
    expect(five.p95).toBeLessThan(1600);
  }, 60_000);
});

describe('widths', () => {
  it('fits the largest amount and quantity inside their columns in every preset', async () => {
    for (const name of PRESETS) {
      const p = probe('regular');
      p.lines = [{ ...p.lines[0], quantity: 999_999_999, unitPrice: 2_147_483_647, subtotal: 2_147_483_647, taxAmount: 0, discountBp: 0, description: null }];
      p.document = { ...p.document, subtotal: 2_147_483_647, taxAmount: 0, total: 2_147_483_647 };
      const doc = preset(name);
      const { bytes, layout } = await renderTemplate(buildRenderModel(probeInput(p)), doc, fontFiles('dejavu-sans'));
      const cols = layout.tables[0].columns;
      const drawn = await extractDrawnText(bytes);
      const amount = drawn.find((d) => d.text === '21.474.836,47 €' && d.x >= cols.amount!.x - 1)!;
      expect(amount).toBeDefined();
      for (const col of ['quantity', 'unitPrice', 'amount'] as const) {
        const texts = drawn.filter((d) => d.page === 1 && d.y > 0 && d.x >= cols[col]!.x - 0.01 && d.x < cols[col]!.x + cols[col]!.width);
        expect(texts.length, `${name} ${col}`).toBeGreaterThan(0);
      }
      // No value starts left of its column (a too-narrow column would push it into its neighbour).
      const qty = drawn.find((d) => d.text === '999.999,999')!;
      expect(qty.x).toBeGreaterThanOrEqual(cols.quantity!.x);
    }
  });
});

describe('stamps and the payment code', () => {
  it('stamps a draft and every page of a preview', async () => {
    const draft = await render(preset('klassisch'), 'longInvoice', { draft: true, preview: true });
    const drawn = await extractDrawnText(draft.bytes);
    for (let p = 1; p <= draft.layout.pageCount; p += 1) {
      expect(drawn.some((d) => d.page === p && d.text === 'VORSCHAU, KEIN BELEG')).toBe(true);
      expect(drawn.some((d) => d.page === p && d.text === 'ENTWURF - KEINE RECHNUNG')).toBe(true);
    }
    const issued = await extractPdfText((await render(preset('klassisch'))).bytes);
    expect(issued).not.toContain('VORSCHAU');
    expect(issued).not.toContain('ENTWURF');
  });

  it('draws a placeholder on a draft and the code on an issued invoice, nothing on a credit note', async () => {
    const doc = withBlock('paymentQr', 'body');
    const draft = await render(doc, 'regular', { draft: true });
    expect(await extractPdfText(draft.bytes)).toContain('QR-Code erscheint bei Ausstellung');
    const issued = await render(doc, 'regular');
    expect(await extractPdfText(issued.bytes)).not.toContain('QR-Code erscheint bei Ausstellung');
    expect(issued.layout.blocks.find((r) => r.blockId === 'probe-block')!.height).toBeGreaterThan(70);
    const credit = await render(doc, 'creditNote');
    expect(credit.layout.blocks.find((r) => r.blockId === 'probe-block')).toBeUndefined();
  });
});

describe('determinism', () => {
  it.each(PRESETS)('renders %s to the same bytes twice, the payment code included', async (name) => {
    const doc = preset(name);
    doc.regions.body.push(sample('paymentQr', 'qr') as Block);
    const a = await render(doc, 'longInvoice');
    const b = await render(doc, 'longInvoice');
    expect(sha(a.bytes)).toBe(sha(b.bytes));
    expect(a.layout).toEqual(b.layout);
  });

  it('renders the same bytes in a fresh process', async () => {
    const here = await render(preset('modern'), 'reverseCharge');
    const child = execFileSync(process.execPath, ['--import', 'tsx', path.join(__dirname, 'engineChild.ts')], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, TZ: 'Pacific/Kiritimati' },
    }).trim();
    expect(child).toBe(sha(here.bytes));
  });

  it('writes its renderer id and the document date', async () => {
    const { bytes } = await render(preset('klassisch'));
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(RENDERER_ID).toBe('books-pdf-lib-3');
    expect(pdf.getProducer()).toBe(RENDERER_ID);
    expect(pdf.getCreationDate()?.toISOString()).toBe('2026-10-19T09:30:00.000Z');
  });
});
