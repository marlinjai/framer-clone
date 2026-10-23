// src/server/books/render/legacyV1.ts
//
// FROZEN (visual template composer plan, decision 4): the renderer of every
// document whose template snapshot is version 1 (issued before the template
// model version 2). It is kept exactly as it was (renderer id
// `books-pdf-lib-2`), so such a document re-renders to the bytes it was first
// stored with; it is never changed again. New documents are rendered by the
// layout engine (render/engine). What follows is the original description.
//
// Lay a render model out as an A4 PDF with pdf-lib, a pure JavaScript library:
// no headless browser, no native module, no system font, so it runs unchanged
// in the existing node:22-bookworm-slim image on linux/arm64. The text is set in
// the embedded DejaVu Sans faces (fonts.ts), subset to the glyphs used, so every
// European name prints exactly as written.
//
// Deterministic by construction: the same model gives the same bytes. The
// metadata dates are the document's own `issued_at` (never "now"), the producer
// and creator strings are fixed, and pdf-lib's font subsetting and resource
// names are deterministic (pdf-lib writes no random id). That is what lets an
// issued document be re-rendered byte for byte from its frozen snapshots, and
// what the tests assert.
//
// Layout (DIN 5008 in spirit): the sender line and the recipient block in the
// address window on the left, the document data on the right, the title, an
// optional reference and intro, the line table (repeating its header on every
// page), the totals, the legal notes, the payment terms, the outro, the
// template's small print, and the sender footer on every page with "Seite n
// von m".

import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';

import { fontFiles, fontkit } from './fonts';
import type { RenderModel } from './model';

/** Recorded on every stored file, so a later renderer change is traceable. */
export const LEGACY_V1_RENDERER_ID = 'books-pdf-lib-2';

export const A4: [number, number] = [595.28, 841.89];
const MARGIN_X = 56.7; // 20 mm
/** The footer's top rule sits just above this; footer text is drawn below it. */
export const FOOTER_TOP = 70;
/** No body text is drawn below this line (the footer zone starts under it). */
export const CONTENT_BOTTOM = FOOTER_TOP + 24;
const BODY = 9.5;
const SMALL = 7.5;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.38, 0.38, 0.42);

function accent(hex: string | null): RGB {
  const m = hex ? /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex) : null;
  if (!m) return rgb(0.2, 0.2, 0.25);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

/**
 * Break `text` into lines no wider than `width`, at spaces. A single word wider
 * than a whole line is the only thing split inside a word (last resort).
 */
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  if (text === '') return [''];
  const lines: string[] = [];
  let current = '';
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= width;
  for (const word of text.split(' ')) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current !== '') lines.push(current);
    if (fits(word)) {
      current = word;
      continue;
    }
    let piece = '';
    for (const ch of word) {
      if (fits(piece + ch)) piece += ch;
      else {
        lines.push(piece);
        piece = ch;
      }
    }
    current = piece;
  }
  if (current !== '') lines.push(current);
  return lines;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

class Writer {
  page!: PDFPage;
  y = 0;
  readonly pages: PDFPage[] = [];
  readonly width = A4[0] - 2 * MARGIN_X;

  constructor(
    readonly pdf: PDFDocument,
    readonly fonts: Fonts,
    readonly model: RenderModel,
    readonly color: RGB,
  ) {}

  newPage(): void {
    this.page = this.pdf.addPage(A4);
    this.pages.push(this.page);
    this.y = A4[1] - 50;
    if (this.model.draft) {
      this.page.drawText('ENTWURF - KEINE RECHNUNG', {
        x: MARGIN_X,
        y: A4[1] - 32,
        size: 9,
        font: this.fonts.bold,
        color: rgb(0.75, 0.15, 0.15),
      });
    }
  }

  text(s: string, x: number, opts: { size?: number; bold?: boolean; color?: RGB; right?: boolean } = {}): void {
    const size = opts.size ?? BODY;
    const font = opts.bold ? this.fonts.bold : this.fonts.regular;
    const drawX = opts.right ? x - font.widthOfTextAtSize(s, size) : x;
    this.page.drawText(s, { x: drawX, y: this.y, size, font, color: opts.color ?? INK });
  }

  /** Make room for `height`; start a new page (with `onNewPage`) when it does not fit. */
  ensure(height: number, onNewPage?: () => void): void {
    if (this.y - height < CONTENT_BOTTOM) {
      this.newPage();
      onNewPage?.();
    }
  }

  paragraph(s: string, opts: { size?: number; bold?: boolean; color?: RGB; gapAfter?: number } = {}): void {
    const size = opts.size ?? BODY;
    const lead = size * 1.35;
    for (const line of wrapText(s, opts.bold ? this.fonts.bold : this.fonts.regular, size, this.width)) {
      this.ensure(lead);
      this.text(line, MARGIN_X, opts);
      this.y -= lead;
    }
    this.y -= opts.gapAfter ?? 0;
  }
}

// Column x positions of the line table (left edges, amounts right-aligned).
const COL = {
  pos: MARGIN_X,
  title: MARGIN_X + 22,
  // Wide enough for the largest amount (21.474.836,47 EUR) in DejaVu Sans.
  qtyRight: MARGIN_X + 262,
  unit: MARGIN_X + 268,
  priceRight: MARGIN_X + 362,
  rateRight: MARGIN_X + 396,
  amountRight: A4[0] - MARGIN_X,
};
const TITLE_WIDTH = COL.qtyRight - 40 - COL.title;

function tableHeader(w: Writer): void {
  const m = w.model;
  w.text('Pos.', COL.pos, { bold: true, size: 8 });
  w.text('Bezeichnung', COL.title, { bold: true, size: 8 });
  w.text('Menge', COL.qtyRight, { bold: true, size: 8, right: true });
  w.text('Einheit', COL.unit, { bold: true, size: 8 });
  w.text('Einzelpreis', COL.priceRight, { bold: true, size: 8, right: true });
  if (m.showRate) w.text('USt', COL.rateRight, { bold: true, size: 8, right: true });
  w.text(m.amountHeader, COL.amountRight, { bold: true, size: 8, right: true });
  w.y -= 5;
  w.page.drawLine({
    start: { x: MARGIN_X, y: w.y },
    end: { x: A4[0] - MARGIN_X, y: w.y },
    thickness: 0.6,
    color: w.color,
  });
  w.y -= 12;
}

function header(w: Writer): void {
  const m = w.model;
  const top = 841.89 - 140; // the address window starts 45 mm from the top edge
  w.y = top;
  if (m.senderLine) {
    w.text(m.senderLine, MARGIN_X, { size: 7, color: MUTED });
  }
  w.y -= 16;
  for (const line of m.recipientBlock) {
    w.text(line, MARGIN_X);
    w.y -= BODY * 1.35;
  }
  const leftBottom = w.y;

  // Document data on the right.
  w.y = top;
  const labelX = MARGIN_X + 290;
  for (const item of m.meta) {
    w.text(item.label, labelX, { size: 8, color: MUTED });
    w.text(item.value, COL.amountRight, { size: 8, right: true });
    w.y -= 12;
  }
  w.y = Math.min(leftBottom, w.y) - 26;

  w.text(m.title, MARGIN_X, { size: 15, bold: true, color: w.color });
  w.y -= 22;
  if (m.reference) w.paragraph(m.reference, { bold: true, gapAfter: 4 });
  if (m.intro) w.paragraph(m.intro, { gapAfter: 8 });
}

function lineTable(w: Writer): void {
  const m = w.model;
  w.ensure(40);
  tableHeader(w);
  const lead = BODY * 1.35;
  const detailLead = 8 * 1.35;
  for (const line of m.lines) {
    const width = line.text ? w.width - 22 : TITLE_WIDTH;
    const titleLines = wrapText(line.title, line.text ? w.fonts.regular : w.fonts.bold, BODY, width);
    const detailLines = line.details.flatMap((d) => wrapText(d, w.fonts.regular, 8, width));
    // Keep a row together when it fits on a page; otherwise start it on a new
    // page only if not even its first line fits, and let it flow line by line
    // across pages (a 4000-character description must never run into the footer).
    const height = titleLines.length * lead + detailLines.length * detailLead + 6;
    const fitsOnePage = height <= A4[1] - 50 - CONTENT_BOTTOM - 40;
    w.ensure(fitsOnePage ? height : lead, () => tableHeader(w));
    const rowTop = w.y;
    if (!line.text) {
      w.text(line.pos, COL.pos);
      w.text(line.quantity, COL.qtyRight, { right: true });
      w.text(line.unit, COL.unit);
      w.text(line.unitPrice, COL.priceRight, { right: true });
      if (m.showRate) w.text(line.rate, COL.rateRight, { right: true });
      w.text(line.amount, COL.amountRight, { right: true });
    }
    for (const t of titleLines) {
      w.ensure(lead, () => tableHeader(w));
      w.text(t, COL.title, { bold: !line.text });
      w.y -= lead;
    }
    for (const d of detailLines) {
      w.ensure(detailLead, () => tableHeader(w));
      w.text(d, COL.title, { size: 8, color: MUTED });
      w.y -= detailLead;
    }
    w.y = (w.y < rowTop ? Math.min(w.y, rowTop - lead) : w.y) - 6;
  }
  w.ensure(14);
  w.page.drawLine({
    start: { x: MARGIN_X, y: w.y + 4 },
    end: { x: A4[0] - MARGIN_X, y: w.y + 4 },
    thickness: 0.4,
    color: MUTED,
  });
  w.y -= 10;
}

function totals(w: Writer): void {
  const labelRight = COL.priceRight + 20;
  w.ensure(w.model.totals.length * 13 + 6);
  for (const t of w.model.totals) {
    w.text(t.label, labelRight, { right: true, bold: t.strong, size: t.strong ? 10.5 : BODY });
    w.text(t.value, COL.amountRight, { right: true, bold: t.strong, size: t.strong ? 10.5 : BODY });
    w.y -= t.strong ? 16 : 13;
  }
  w.y -= 10;
}

function footer(w: Writer, page: PDFPage, index: number, count: number): void {
  const cols = w.model.footer;
  const colWidth = w.width / Math.max(cols.length, 1);
  page.drawLine({
    start: { x: MARGIN_X, y: FOOTER_TOP + 6 },
    end: { x: A4[0] - MARGIN_X, y: FOOTER_TOP + 6 },
    thickness: 0.4,
    color: MUTED,
  });
  cols.forEach((col, i) => {
    let y = FOOTER_TOP - 4;
    for (const line of col) {
      for (const part of wrapText(line, w.fonts.regular, 6.5, colWidth - 8)) {
        page.drawText(part, { x: MARGIN_X + i * colWidth, y, size: 6.5, font: w.fonts.regular, color: MUTED });
        y -= 8.5;
      }
    }
  });
  const label = `Seite ${index + 1} von ${count}`;
  page.drawText(label, {
    x: A4[0] - MARGIN_X - w.fonts.regular.widthOfTextAtSize(label, 7),
    y: 22,
    size: 7,
    font: w.fonts.regular,
    color: MUTED,
  });
}

/** Render the model to PDF bytes (deterministic: same model, same bytes). */
export async function renderLegacyV1(model: RenderModel): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  // The version 1 layout knows one font: DejaVu Sans, its files pinned in fonts.ts.
  const files = fontFiles('dejavu-sans');
  const fonts: Fonts = {
    regular: await pdf.embedFont(files.regular, { subset: true }),
    bold: await pdf.embedFont(files.bold, { subset: true }),
  };
  const w = new Writer(pdf, fonts, model, accent(model.accentColor));
  w.newPage();
  header(w);
  lineTable(w);
  totals(w);
  for (const note of model.notes) w.paragraph(note, { bold: true, gapAfter: 4 });
  if (model.notes.length > 0) w.y -= 4;
  for (const p of model.payment) w.paragraph(p, { gapAfter: 2 });
  if (model.payment.length > 0) w.y -= 6;
  if (model.outro) w.paragraph(model.outro, { gapAfter: 8 });
  for (const block of model.smallPrint) {
    if (block.heading) w.paragraph(block.heading, { size: SMALL, bold: true });
    w.paragraph(block.text, { size: SMALL, color: MUTED, gapAfter: 4 });
  }
  w.pages.forEach((page, i) => footer(w, page, i, w.pages.length));

  pdf.setTitle(model.pdfTitle);
  pdf.setProducer(LEGACY_V1_RENDERER_ID);
  pdf.setCreator('Lumitra Books');
  pdf.setCreationDate(model.pdfDate);
  pdf.setModificationDate(model.pdfDate);
  return pdf.save();
}
