// src/server/books/__tests__/engineFields.test.ts
//
// The field map of the layout engine (invoice editor plan, phase 2): for every
// template preset, every probe document and every font family, each field's
// rectangles lie on the page and above the footer, the text drawn for the
// field lies inside them (read back from the PDF, measured with the same
// faces), a field that breaks across pages has one rectangle per page, the
// add-line slot sits under the table's last row on the table's last page, and
// read-only fields are marked read-only. Then the empty-field slots, a field
// inside a `columns` cell, the API keys the fields name, and that the map
// leaves the PDF's bytes alone. With FIELD_OVERLAY_DIR set, the last test
// writes the pages with the rectangles outlined (fieldOverlay.ts) to look at.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { PDFDocument, type PDFFont } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';

import { lineFieldsBody } from '../http/bodies';
import { renderTemplate, type LayoutField, type LayoutMap } from '../render/engine';
import { extractDrawnText, type DrawnText } from '../render/extractText';
import { fontFiles, fontkit } from '../render/fonts';
import { buildRenderModel, type RenderInput, type RenderModel } from '../render/model';
import { label } from '../template/labels';
import { PRESETS, preset } from '../template/presets';
import { PROBE_NAMES, probe, probeInput } from '../template/probes';
import { FONT_FAMILIES, type FontFamily, type TemplateDocumentV2 } from '../template/schema';
import { overlayPages } from './fieldOverlay';

const EPS = 0.05;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const squash = (s: string) => s.replace(/\s+/g, '');

const withFamily = (doc: TemplateDocumentV2, fontFamily: FontFamily): TemplateDocumentV2 => ({ ...doc, theme: { ...doc.theme, fontFamily } });

const faces = new Map<FontFamily, { regular: PDFFont; bold: PDFFont }>();
beforeAll(async () => {
  for (const family of FONT_FAMILIES) {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const files = fontFiles(family);
    faces.set(family, { regular: await pdf.embedFont(files.regular), bold: await pdf.embedFont(files.bold) });
  }
});

async function render(doc: TemplateDocumentV2, input: RenderInput) {
  const model = buildRenderModel(input);
  const result = await renderTemplate(model, doc, fontFiles(doc.theme.fontFamily));
  return { model, ...result };
}

/** The text the model gives a field (null for an id the model does not know). */
function expectedText(model: RenderModel, id: string): string | null {
  const n = (prefix: string) => Number(id.slice(prefix.length)) - 1;
  if (id.startsWith('recipient.line.')) return model.recipientBlock[n('recipient.line.')] ?? null;
  if (id.startsWith('meta.')) return model.metaItems[id.slice(5) as keyof RenderModel['metaItems']]?.value ?? null;
  if (id.startsWith('totals.')) return model.totals[n('totals.')]?.value ?? null;
  if (id === 'introText') return model.intro;
  if (id === 'outroText') return model.outro;
  if (id === 'taxNote') return model.notes.join(' ');
  if (id === 'payment.terms') return model.payment.find((p) => p.startsWith(label('payment.termsPrefix')) || p.startsWith(label('payment.dueBy'))) ?? null;
  if (id === 'payment.reference') return model.payment.find((p) => p.startsWith(label('payment.reference'))) ?? null;
  const m = /^line\.(.+)\.(title|description|discount|quantity|unit|unitPrice|rate|amount)$/.exec(id);
  if (!m) return null;
  const l = model.lines.find((x) => x.id === m[1]);
  if (!l) return null;
  const part = m[2];
  if (part === 'description' || part === 'discount') return l.details[l.detailFields.indexOf(part)] ?? null;
  return l[part as 'title' | 'quantity' | 'unit' | 'unitPrice' | 'rate' | 'amount'];
}

/** A drawn piece's box, from its baseline (bottom-up) to the engine's top-down coordinates. */
function box(d: DrawnText, field: LayoutField, height: number) {
  const face = faces.get(field.style.fontFamily)![field.style.bold ? 'bold' : 'regular'];
  const top = height - d.y - d.size;
  return { left: d.x, right: d.x + face.widthOfTextAtSize(d.text, d.size), top, bottom: top + d.size };
}

/** The top of the footer region on a page (the page's bottom when there is no footer). */
function footerTop(layout: LayoutMap, page: number): number {
  const ys = layout.blocks.filter((b) => b.region === 'footer' && b.page === page).map((b) => b.y);
  return ys.length > 0 ? Math.min(...ys) : layout.page.height;
}

/** Every structural check of one rendering's field map. */
function checkMap(model: RenderModel, layout: LayoutMap, drawn: DrawnText[], where: string): void {
  const { width: pw, height: ph } = layout.page;
  const ids = layout.fields.map((f) => `${f.id}@${f.blockId}`);
  expect(new Set(ids).size, where).toBe(ids.length);
  for (const f of layout.fields) {
    const at = `${where} ${f.id}`;
    expect(f.rects.length, at).toBeGreaterThan(0);
    // One rectangle per page, in page order.
    for (let i = 1; i < f.rects.length; i += 1) expect(f.rects[i].page, at).toBeGreaterThan(f.rects[i - 1].page);
    for (const r of f.rects) {
      expect(r.page, at).toBeGreaterThanOrEqual(1);
      expect(r.page, at).toBeLessThanOrEqual(layout.pageCount);
      expect(r.x, at).toBeGreaterThanOrEqual(0);
      expect(r.y, at).toBeGreaterThanOrEqual(0);
      expect(r.width, at).toBeGreaterThan(0);
      expect(r.height, at).toBeGreaterThan(0);
      expect(r.x + r.width, at).toBeLessThanOrEqual(pw + EPS);
      expect(r.y + r.height, at).toBeLessThanOrEqual(ph + EPS);
      if (f.region !== 'footer') expect(r.y + r.height, at).toBeLessThanOrEqual(footerTop(layout, r.page) + EPS);
    }
    // Read-only means nothing to edit, and an editable field names what it edits.
    if (f.kind === 'readonly') {
      expect(f.source, at).toBeNull();
      expect(f.documentField, at).toBeNull();
    } else {
      expect(f.source, at).not.toBeNull();
      expect(f.documentField, at).not.toBeNull();
    }
    if (f.id.startsWith('line.')) expect(f.lineId, at).not.toBeNull();
    expect(f.style.color, at).toMatch(/^#[0-9a-f]{6}$/);
    expect(f.style.lineHeightPt, at).toBeGreaterThan(f.style.sizePt);
    if (f.empty) {
      // A slot says how much of it is free, and nothing is drawn where it says it is free.
      expect(f.room, at).not.toBeNull();
      expect(f.room!, at).toBeGreaterThanOrEqual(0);
      const r = f.rects[0];
      const free = Math.min(f.room!, r.height);
      const covered = drawn.filter((d) => {
        const top = ph - d.y - d.size;
        return d.page === r.page && top >= r.y + EPS && top < r.y + free - EPS && d.x >= r.x - EPS && d.x < r.x + r.width;
      });
      expect(covered.map((d) => d.text), at).toEqual([]);
      continue;
    }
    expect(f.room, at).toBeNull();

    // The text drawn inside the field's rectangles is exactly the field's text, and lies wholly inside them.
    // A piece belongs to the field when its origin (left edge, top of the text) is inside one of its rectangles.
    const inside = drawn.filter((d) =>
      f.rects.some((r) => {
        const top = ph - d.y - d.size;
        return d.page === r.page && d.x >= r.x - EPS && d.x < r.x + r.width && top >= r.y - EPS && top < r.y + r.height - EPS;
      }),
    );
    const want = expectedText(model, f.id);
    expect(want, `${at}: the model has no text for it`).not.toBeNull();
    expect(squash(inside.map((d) => d.text).join('')), at).toBe(squash(want!));
    for (const d of inside) {
      const r = f.rects.find((x) => x.page === d.page)!;
      const b = box(d, f, ph);
      expect(b.right, `${at} "${d.text}" right edge`).toBeLessThanOrEqual(r.x + r.width + EPS);
      expect(b.bottom, `${at} "${d.text}" baseline`).toBeLessThanOrEqual(r.y + r.height + EPS);
    }
    // A page with the field's text has a rectangle, and a rectangle has the field's text.
    expect([...new Set(inside.map((d) => d.page))], at).toEqual(f.rects.map((r) => r.page));
  }

  // Read-only by nature, whatever the document.
  for (const f of layout.fields) {
    if (/^(meta\.(number|issueDate|customerNumber|recipientVatId|dueDate)|taxNote|totals\.\d+|payment\.reference|line\..+\.amount)$/.test(f.id)) {
      expect(f.kind, `${where} ${f.id}`).toBe('readonly');
    }
  }

  // Rows: one per line, each line's fields inside its row on the same page.
  const lineIds = model.lines.map((l) => l.id);
  expect(layout.anchors.rows.map((r) => r.lineId), where).toEqual(lineIds);
  for (const row of layout.anchors.rows) {
    for (const f of layout.fields.filter((x) => x.lineId === row.lineId && !x.empty)) {
      for (const r of f.rects) {
        const rr = row.rects.find((x) => x.page === r.page);
        expect(rr, `${where} ${f.id} page ${r.page}`).toBeDefined();
        expect(r.y, `${where} ${f.id}`).toBeGreaterThanOrEqual(rr!.y - EPS);
        expect(r.y + r.height, `${where} ${f.id}`).toBeLessThanOrEqual(rr!.y + rr!.height + EPS);
      }
    }
  }

  // The add-line slot: under the last row, on the last page the table occupies, as wide as the table.
  const tables = layout.blocks.filter((b) => b.blockId === layout.tables[0]?.blockId);
  expect(layout.anchors.addLine, where).toHaveLength(layout.tables.length);
  if (tables.length > 0) {
    const [anchor] = layout.anchors.addLine;
    const lastPage = Math.max(...tables.map((t) => t.page));
    const table = tables.find((t) => t.page === lastPage)!;
    expect(anchor.rect.page, where).toBe(lastPage);
    expect(anchor.rect.x, where).toBeCloseTo(table.x, 1);
    expect(anchor.rect.width, where).toBeCloseTo(table.width, 1);
    expect(anchor.rect.y + anchor.rect.height, where).toBeLessThanOrEqual(footerTop(layout, lastPage) + EPS);
    expect(anchor.room, where).toBeGreaterThan(0);
    expect(anchor.rect.y + anchor.room, where).toBeLessThanOrEqual(footerTop(layout, lastPage) + EPS);
    // What follows the table on that page starts at the end of the free room or lower.
    for (const b of layout.blocks.filter((x) => x.page === lastPage && x.region === 'body' && x.y > anchor.rect.y + EPS)) {
      expect(b.y, `${where} ${b.blockId}`).toBeGreaterThanOrEqual(anchor.rect.y + anchor.room - EPS);
    }
    const lastRow = layout.anchors.rows.at(-1)?.rects.at(-1);
    if (lastRow) {
      expect(lastRow.page, where).toBe(lastPage);
      expect(anchor.rect.y, where).toBeGreaterThanOrEqual(lastRow.y + lastRow.height - EPS);
    }
  }
}

describe('every preset, every probe, every font family', () => {
  const cases = PRESETS.flatMap((p) => FONT_FAMILIES.map((f) => [p, f] as const));
  it.each(cases)('%s in %s', async (presetName, family) => {
    for (const name of PROBE_NAMES) {
      for (const draft of [false, true]) {
        const doc = withFamily(preset(presetName), family);
        const { model, bytes, layout } = await render(doc, probeInput(probe(name), draft));
        checkMap(model, layout, await extractDrawnText(bytes), `${presetName}/${family}/${name}${draft ? '/draft' : ''}`);
      }
    }
  }, 120_000);
});

describe('fields that break across pages', () => {
  it('gives a long description one rectangle per page it continues on, and the row too', async () => {
    for (const name of PRESETS) {
      const { model, layout } = await render(preset(name), probeInput(probe('longDescription')));
      const lineId = model.lines[0].id;
      const description = layout.fields.find((f) => f.id === `line.${lineId}.description`)!;
      expect(description.rects.length, name).toBeGreaterThanOrEqual(2);
      const row = layout.anchors.rows.find((r) => r.lineId === lineId)!;
      expect(row.rects.map((r) => r.page), name).toEqual(description.rects.map((r) => r.page));
    }
  });

  it('gives an intro text that runs over the page one rectangle per page', async () => {
    const p = probe('longInvoice');
    const paragraph = 'Wir bedanken uns für die angenehme Zusammenarbeit im vergangenen Quartal und berechnen die folgenden Leistungen.';
    p.document = { ...p.document, introText: Array.from({ length: 40 }, () => paragraph).join('\n') };
    const doc = preset('klassisch');
    const { model, bytes, layout } = await render(doc, probeInput(p));
    const intro = layout.fields.find((f) => f.id === 'introText')!;
    expect(intro.rects.map((r) => r.page)).toEqual([1, 2]);
    checkMap(model, layout, await extractDrawnText(bytes), 'long intro');
  });
});

describe('empty fields', () => {
  it('marks the slot where an empty optional field would print, without drawing anything', async () => {
    const p = probe('regular');
    p.document = { ...p.document, introText: null, outroText: null, contractReference: null };
    const input = probeInput(p, true);
    const { bytes, layout } = await render(preset('klassisch'), input);
    const byId = (id: string) => layout.fields.find((f) => f.id === id);

    for (const id of ['introText', 'outroText', 'meta.contract', 'recipient.addressLine2']) {
      const f = byId(id);
      expect(f, id).toBeDefined();
      expect(f!.empty, id).toBe(true);
      expect(f!.kind, id).not.toBe('readonly');
    }
    expect(byId('introText')!.documentField).toBe('introText');
    expect(byId('meta.contract')!.documentField).toBe('contractReference');
    expect(byId('recipient.addressLine2')!).toMatchObject({ source: 'customer', documentField: 'addressLine2' });
    // The intro's slot is between the title and the table.
    const title = layout.blocks.find((b) => b.blockId === 'title')!;
    const table = layout.blocks.find((b) => b.blockId === 'lineTable')!;
    const intro = byId('introText')!.rects[0];
    expect(intro.y).toBeGreaterThanOrEqual(title.y + title.height);
    expect(intro.y).toBeLessThanOrEqual(table.y);
    // The contract slot sits under the customer number, where the item prints.
    const customerNumber = byId('meta.customerNumber')!.rects[0];
    expect(byId('meta.contract')!.rects[0].y).toBeCloseTo(customerNumber.y + customerNumber.height, 1);
    // A line without a description has its slot directly under its title.
    const textLine = input.lines.find((l) => l.kind === 'text')!;
    const slot = byId(`line.${textLine.id}.description`)!;
    const titleRect = byId(`line.${textLine.id}.title`)!.rects[0];
    expect(slot.empty).toBe(true);
    expect(slot.rects[0].y).toBeCloseTo(titleRect.y + titleRect.height, 1);
    // Free: only the gap after the row (6 pt), then the next line's row starts.
    expect(slot.room).toBeCloseTo(6, 1);
    // The intro's slot starts right where the table starts: no room, the typed intro pushes the table down.
    expect(byId('introText')!.room).toBe(0);
    // The add-line slot is free down to the totals.
    const [anchor] = layout.anchors.addLine;
    const totals = layout.blocks.find((b) => b.blockId === 'totals')!;
    expect(anchor.rect.y + anchor.room).toBeCloseTo(totals.y, 1);

    // The slots draw nothing: no label of an empty item is printed.
    const text = (await extractDrawnText(bytes)).map((d) => d.text).join(' ');
    expect(text).not.toContain(label('meta.contract'));
  });

  it('offers the customer slot in the address window when the draft has no customer yet', async () => {
    const input = { ...probeInput(probe('regular'), true), recipient: null };
    const doc = preset('klassisch');
    const { layout } = await render(doc, input);
    const slot = layout.fields.find((f) => f.id === 'recipient.customer')!;
    expect(slot).toMatchObject({ empty: true, kind: 'select', source: 'document', documentField: 'customerId', region: 'addressZone.left' });
    const sender = layout.blocks.find((b) => b.blockId === 'senderLine')!;
    expect(slot.rects[0].y).toBeCloseTo(sender.y + sender.height + (doc.regions.addressZone.left[0].style.spaceBelowPt ?? 0), 1);
    expect(layout.fields.some((f) => f.id.startsWith('recipient.line.'))).toBe(false);
  });

  it('changes no byte of the PDF: the map is the only difference a field makes', async () => {
    // The same rendering twice gives the same bytes and the same map.
    const input = probeInput(probe('longInvoice'), true);
    const a = await render(preset('modern'), input);
    const b = await render(preset('modern'), input);
    expect(sha(a.bytes)).toBe(sha(b.bytes));
    expect(a.layout).toEqual(b.layout);
  });
});

describe('a field inside a columns cell', () => {
  it('lifts the payment lines out of the cell at their printed place', async () => {
    const doc = structuredClone(preset('klassisch'));
    const i = doc.regions.body.findIndex((b) => b.type === 'paymentDetails');
    doc.regions.body[i] = {
      id: 'payRow',
      type: 'columns',
      style: { spaceBelowPt: 8 },
      cells: [
        { width: 4, blocks: [{ id: 'cellNote', type: 'freeText', style: {}, heading: null, text: 'Hinweis links.', variant: 'normal' }] },
        { width: 8, blocks: [{ id: 'cellPay', type: 'paymentDetails', style: { spaceAbovePt: 6 }, heading: 'Zahlung' }] },
      ],
    };
    for (const family of FONT_FAMILIES) {
      const { model, bytes, layout } = await render(withFamily(doc, family), probeInput(probe('regular')));
      const terms = layout.fields.find((f) => f.id === 'payment.terms')!;
      expect(terms.blockId).toBe('cellPay');
      const cell = layout.blocks.find((b) => b.blockId === 'cellPay')!;
      expect(terms.rects[0].x).toBeCloseTo(cell.x, 1);
      expect(terms.rects[0].y).toBeGreaterThan(cell.y);
      checkMap(model, layout, await extractDrawnText(bytes), `columns/${family}`);
    }
  });
});

describe('a document data value too wide for its line', () => {
  it('maps the value on its own line under the label', async () => {
    const p = probe('regular');
    p.document = { ...p.document, contractReference: 'Rahmenvertrag über die Wartung und Weiterentwicklung der Plattform 2026' };
    const { model, bytes, layout } = await render(preset('klassisch'), probeInput(p));
    const contract = layout.fields.find((f) => f.id === 'meta.contract')!;
    const meta = layout.blocks.find((b) => b.blockId === 'documentMeta')!;
    expect(contract.rects[0].x).toBeCloseTo(meta.x, 1);
    expect(contract.rects[0].width).toBeCloseTo(meta.width, 1);
    checkMap(model, layout, await extractDrawnText(bytes), 'wide contract');
  });
});

describe('what the fields edit', () => {
  // The draft's PATCH keys (src/app/api/books/documents/[id]/route.ts) and the customer's (PUT .../customer).
  const DOCUMENT_KEYS = new Set(['serviceDate', 'servicePeriod', 'paymentTermsDays', 'contractReference', 'introText', 'outroText', 'customerId']);
  const LINE_KEYS = new Set(Object.keys(lineFieldsBody));
  const RECIPIENT_KEYS = new Set(['name', 'companyOrRole', 'addressLine1', 'addressLine2', 'postalCity', 'country']);

  it('names a real request key for every editable field', async () => {
    const seen = new Set<string>();
    for (const name of PROBE_NAMES) {
      for (const draft of [false, true]) {
        const p = probe(name);
        // A draft before issue: no due date yet, so the payment terms are editable.
        if (draft) p.document = { ...p.document, dueDate: null, introText: null, contractReference: null };
        const { layout } = await render(preset('klassisch'), probeInput(p, draft));
        for (const f of layout.fields) {
          if (f.source === null) continue;
          seen.add(`${f.source}.${f.documentField}`);
          const keys = f.source === 'document' ? DOCUMENT_KEYS : f.source === 'line' ? LINE_KEYS : RECIPIENT_KEYS;
          expect(keys.has(f.documentField!), `${name} ${f.id} -> ${f.documentField}`).toBe(true);
        }
      }
    }
    for (const key of ['document.paymentTermsDays', 'document.servicePeriod', 'document.serviceDate', 'line.taxClass', 'line.discountBp', 'line.unitPrice']) {
      expect(seen.has(key), key).toBe(true);
    }
  });

  it('lists the fields in reading order: the address before the document data, then the body top to bottom', async () => {
    const { layout } = await render(preset('klassisch'), probeInput(probe('regular')));
    const ids = layout.fields.map((f) => f.id);
    const lastRecipient = Math.max(...ids.map((id, i) => (id.startsWith('recipient.') ? i : -1)));
    const firstMeta = ids.findIndex((id) => id.startsWith('meta.'));
    expect(lastRecipient).toBeLessThan(firstMeta);
    const body = layout.fields.filter((f) => f.region === 'body').map((f) => f.rects[0]);
    for (let i = 1; i < body.length; i += 1) {
      expect(body[i].page * 10_000 + body[i].y).toBeGreaterThanOrEqual(body[i - 1].page * 10_000 + body[i - 1].y);
    }
  });

  it('gives each field the style it is printed in', async () => {
    const doc = preset('modern');
    const { layout } = await render(doc, probeInput(probe('regular')));
    const amount = layout.fields.find((f) => /^line\..+\.amount$/.test(f.id))!;
    expect(amount.style).toMatchObject({ fontFamily: doc.theme.fontFamily, align: 'right', bold: false, color: doc.theme.ink });
    const description = layout.fields.find((f) => /^line\..+\.description$/.test(f.id) && !f.empty)!;
    expect(description.style.color).toBe(doc.theme.muted);
    expect(description.style.sizePt).toBeLessThan(amount.style.sizePt);
    const total = layout.fields.find((f) => f.id === `totals.${layout.fields.filter((x) => x.id.startsWith('totals.')).length}`)!;
    expect(total.style.bold).toBe(true);
  });
});

// Writes the pictures to look at (FIELD_OVERLAY_DIR=/some/dir pnpm vitest run engineFields).
describe.runIf(process.env.FIELD_OVERLAY_DIR)('the field map, drawn', () => {
  it('writes Klassisch and a three-page sample with the rectangles outlined', async () => {
    const dir = process.env.FIELD_OVERLAY_DIR!;
    mkdirSync(dir, { recursive: true });
    const draft = probe('regular');
    draft.document = { ...draft.document, introText: null, contractReference: null, dueDate: null };
    const longer = probe('longInvoice');
    // Twelve lines and one whose description breaks across the page: three pages.
    const [long] = probe('longDescription').lines;
    longer.lines = [...longer.lines.slice(0, 12), { ...long, id: 'probe-line-long', position: 41, description: long.description!.slice(0, 2600) }];
    const samples: Array<[string, TemplateDocumentV2, RenderInput]> = [
      ['klassisch-regular', preset('klassisch'), probeInput(probe('regular'))],
      ['klassisch-draft-empty', preset('klassisch'), probeInput(draft, true)],
      ['three-pages', withFamily(preset('modern'), 'noto-serif'), probeInput(longer)],
    ];
    for (const [name, doc, input] of samples) {
      const { bytes, layout } = await render(doc, input);
      if (name === 'three-pages') expect(layout.pageCount).toBe(3);
      const pages = await overlayPages(bytes, layout);
      pages.forEach((p, i) => writeFileSync(path.join(dir, `${name}-p${i + 1}.pdf`), p));
    }
  });
});

