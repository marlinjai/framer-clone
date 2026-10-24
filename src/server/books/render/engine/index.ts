// src/server/books/render/engine/index.ts
//
// The layout engine of the Books (visual template composer plan, decision 10):
// a template document version 2 plus a render model gives the PDF bytes and a
// layout map, in three pure steps.
//
//   1. Bind      every block of the template turns into measured chunks of
//                text and shapes, filled from the render model (model.ts stays
//                the one place that builds printed strings).
//   2. Paginate  the regions are measured (footer and following-page header
//                first, they reserve their space on every page), then the
//                body flows into pages by the rules of decision 5: only the
//                line table (between rows, and a row taller than a page line
//                by line) and the long texts break; everything else moves to
//                the next page whole; totals and the tax note stay together;
//                the table header repeats on every page it continues on.
//   3. Draw      pdf-lib draws the chunks page by page, then the footer and
//                "Seite n von m".
//
// The text of each field is drawn in reading order, label then value,
// quantity then unit, whatever the positions: the completeness check
// (completeness.ts) reads the drawn text back in drawing order.
//
// Deterministic by construction: no clock, no Intl, no random ids (pdf-lib
// seeds its font name suffixes), a fixed producer string, the document's own
// date as the metadata date, and every position rounded to 1/100 pt. The
// engine imports nothing Node-only: the font bytes are passed in, so it could
// run in a browser worker (decision 12's fallback).
//
// The layout map (every block's page and rectangle, the table's column
// positions, and the layout issues) is returned next to the bytes and never
// stored; the composer draws its selection outlines from it, and the save gate
// refuses a template whose layout has issues.
//
// The field map (invoice editor plan, decisions 1 and 1a): next to the block
// rectangles, the map lists every editable FIELD of the document (each
// recipient line, each document data value, the intro and closing text, each
// line's title, description, quantity, unit, price, discount, rate and amount,
// the payment terms, the tax note and the totals) with the API field it edits,
// one rectangle per page it is printed on, and the text style an inline editor
// must match; and the anchors of the page's actions (each line's row, and the
// slot under the line table's last row where "+ Add line" goes). The binder
// marks chunks with what they show; the marks never draw and never take space,
// so the map cannot change one byte of the PDF. Where an optional field is
// empty, the map marks the slot it would print in (`empty: true`), measured
// from what is drawn, never by drawing anything.
//
// Logos (decision 15): the caller passes the bytes of the company's assets the
// template names (`options.assets`, by SHA-256), checked at upload
// (render/logoImage.ts) and loaded by repository/assets.ts. Each one is
// embedded once per document from streams prepared once per process
// (images.ts), then a logo block draws it at its width in millimetres with
// the image's own aspect ratio, aligned by the block style, kept together. A
// logo naming an asset the caller did not pass draws nothing and is a layout
// issue (LOGO_ASSET_MISSING), which refuses a document of record like any
// other issue: an invoice is never issued with its logo silently missing.

import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';

import { label, pageOf } from '../../template/labels';
import {
  logoBlocks,
  type Block,
  type CellBlock,
  type FontFamily,
  type MetaItem,
  type RegionName,
  type TableColumn,
  type TemplateDocumentV2,
  type ThemeColor,
} from '../../template/schema';
import { darkRuns, epcPayload, qrMatrix, QUIET_ZONE_MODULES } from '../epcQr';
import type { ModelLine, PaymentLineField, RecipientLineField, RenderModel } from '../model';
import {
  ADDRESS_FIELD_HEIGHT,
  accentTint,
  blockBold,
  blockColor,
  blockSize,
  COLUMN_GAP,
  FOOTER_GAP,
  WIDEST,
  geometry,
  gridWidth,
  hexToRgb,
  lead,
  MIN_TITLE_WIDTH,
  minColumnWidths,
  MM,
  PAGE_HEIGHT,
  PAGE_NUMBER_BAND,
  PAGE_NUMBER_SIZE,
  PAGE_WIDTH,
  r2,
  secondarySize,
  TOP_MARGIN,
  type Measure,
  type PageGeometry,
} from './style';
import { EMBED_SUBSET } from './fontEmbedding';
import { embedAsset, type EngineImage } from './images';
import { wrapText } from './text';

export type { EngineImage };

/** Recorded on every stored file rendered by this engine. */
export const RENDERER_ID = 'books-pdf-lib-3';

export interface EngineFonts {
  regular: Uint8Array;
  bold: Uint8Array;
}

export interface EngineOptions {
  /** Stamp every page "VORSCHAU, KEIN BELEG" (the template preview route). */
  preview?: boolean;
  /** The page cap (MAX_PAGES unless a test lowers it). */
  maxPages?: number;
  /** The company's assets the template's logo blocks name, by SHA-256 (others are ignored). */
  assets?: ReadonlyMap<string, EngineImage>;
}

export interface LayoutRect {
  blockId: string;
  region: RegionName;
  /** 1-based page number. */
  page: number;
  /** Points from the page's left and TOP edge. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutIssueCode =
  | 'HEADER_TOO_TALL'
  | 'FOOTER_TOO_TALL'
  | 'BLOCK_TOO_TALL'
  | 'BLOCK_TOO_WIDE'
  | 'TABLE_TOO_NARROW'
  | 'ADDRESS_FIELD_OVERFLOW'
  | 'ADDRESS_ZONE_TOO_TALL'
  | 'PAGE_LIMIT'
  | 'LOGO_ASSET_MISSING';

/** The most pages one document may run to; beyond it nothing more is placed (and the layout has an issue). */
export const MAX_PAGES = 200;
/** DIN 5008: the return line and remarks sit in the top band of the address field; the address starts below it at the latest. */
const REMARK_ZONE = { 'din5008-b': r2(17.7 * MM), 'din5008-a': r2(12.7 * MM) } as const;
const ADDRESS_TOP_KEYS = { 'din5008-b': true, 'din5008-a': true } as const;

export interface LayoutIssue {
  code: LayoutIssueCode;
  blockId: string | null;
  region: RegionName;
}

/**
 * How a field is edited in place: `text` one line (it may wrap when printed),
 * `multiline` paragraphs, `date` a date or a period, `number` an integer in
 * the field's `valueUnit`, `money` an amount in cents, `select` a choice from
 * a list (the tax class, the customer), `readonly` never edited on the page
 * (assigned at issue, computed by the server, or the customer's data, which no
 * draft request can change).
 */
export type FieldKind = 'text' | 'multiline' | 'date' | 'number' | 'money' | 'select' | 'readonly';

/** Which request a field's edit becomes: `document` a PATCH of the draft (PUT .../customer for `customerId`), `line` a PATCH of the line `lineId`. */
export type FieldSource = 'document' | 'line';

/** The draft's request keys a field can edit (PATCH /api/books/documents/<id>, and `customerId` through PUT .../customer). */
export type DocumentFieldKey = 'serviceDate' | 'servicePeriod' | 'paymentTermsDays' | 'contractReference' | 'subject' | 'introText' | 'outroText' | 'customerId';
/** A line's request keys a field can edit (PATCH .../lines/<lineId>, `lineFieldsBody`). */
export type LineFieldKey = 'title' | 'description' | 'quantity' | 'unitLabel' | 'unitPrice' | 'discountBp' | 'taxClass';

/** The integer scale of a `number` or `money` field's value: a quantity in thousandths, a discount in basis points, days, cents. */
export type FieldValueUnit = 'thousandths' | 'basisPoints' | 'days' | 'cents';

/** A rectangle on one page: points from the page's left and TOP edge, page 1-based. */
export interface FieldRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The text style an inline editor must match to sit exactly on the printed text. */
export interface FieldTextStyle {
  fontFamily: FontFamily;
  bold: boolean;
  sizePt: number;
  /** The resolved theme colour, #rrggbb. */
  color: string;
  /** Within the field's rectangle (a right-aligned field's rectangle is its whole column or value box). */
  align: 'left' | 'center' | 'right';
  lineHeightPt: number;
}

export interface LayoutField {
  /**
   * Stable within a document: `recipient.line.<n>` (1-based, printed order),
   * `recipient.customer` (the slot when there is no customer yet),
   * `meta.<item>`, `introText`, `outroText`, `line.<lineId>.<part>` (title,
   * description, quantity, unit, unitPrice, discount, rate, amount),
   * `payment.terms`, `payment.reference`, `taxNote`, `totals.<n>` (1-based).
   */
  id: string;
  /** `readonly` exactly when `source` and `documentField` are null. */
  kind: FieldKind;
  /** The request the edit becomes, null when read-only. */
  source: FieldSource | null;
  /** The request body key the field edits, null when read-only. */
  documentField: DocumentFieldKey | LineFieldKey | null;
  /** The scale of a `number` or `money` value, else null. */
  valueUnit: FieldValueUnit | null;
  /** For a recipient line: the customer's property it shows (`postalCity` is postal code and city), else null. */
  recipientField: RecipientLineField | null;
  /** The line a `line.*` field belongs to, else null. */
  lineId: string | null;
  /** The template block that prints the field, and its region. */
  blockId: string;
  region: RegionName;
  /**
   * Nothing is printed: the rectangle is the slot the value would print in (a
   * "+ Add ..." placeholder). A typed value pushes what follows down, so the
   * slot may overlap it; `room` says how much of it is free.
   */
  empty: boolean;
  /** For an empty field: the points free below the slot's top before the next printed content (0 when it starts right there), else null. */
  room: number | null;
  /** One rectangle per page the field is printed on, in page order. */
  rects: FieldRect[];
  style: FieldTextStyle;
}

/** A line's row in the line table (the anchor of its toolbar): one rectangle per page it is printed on. */
export interface LayoutRow {
  lineId: string;
  blockId: string;
  rects: FieldRect[];
}

export interface LayoutAnchors {
  rows: LayoutRow[];
  /** Directly under the line table's last row, on the last page the table occupies: where the next line would print. */
  addLine: Array<{
    blockId: string;
    /** One row high (a single-line row and the gap after it). */
    rect: FieldRect;
    /** The points free below the rectangle's top before the next printed content (the totals, the page's end). */
    room: number;
  }>;
}

export interface LayoutMap {
  page: { width: number; height: number };
  pageCount: number;
  blocks: LayoutRect[];
  /** The line table's columns (points from the left edge), the same on every page. */
  tables: Array<{ blockId: string; columns: Partial<Record<TableColumn, { x: number; width: number }>> }>;
  issues: LayoutIssue[];
  /** The document's fields (decision 5: not the template's labels, title, sender or bank line), in reading order. */
  fields: LayoutField[];
  anchors: LayoutAnchors;
}

export interface EngineResult {
  bytes: Uint8Array;
  layout: LayoutMap;
}

// --- Drawing primitives. ---

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

interface DrawContext {
  page: PDFPage;
  /** 0-based. */
  pageIndex: number;
  pageCount: number;
}

interface InnerBox {
  blockId: string;
  dx: number;
  dy: number;
  width: number;
  height: number;
}

/** The style a field is printed in, before the theme resolves it. */
interface FieldStyleIn {
  size: number;
  bold: boolean;
  color: ThemeColor;
  align?: 'left' | 'center' | 'right';
}

/** A field as the binder sees it (the map adds where it was placed). */
type FieldSpec = Omit<LayoutField, 'rects' | 'region' | 'room'>;

/** What a mark stands for. */
type MarkOf = { type: 'field'; spec: FieldSpec } | { type: 'row'; lineId: string; blockId: string } | { type: 'addLine'; blockId: string };

/** A rectangle inside a chunk (x absolute, `dy` from the chunk's top) for the field map; never drawn, takes no space. */
interface Mark {
  of: MarkOf;
  x: number;
  dy: number;
  width: number;
  height: number;
}

/** The smallest unit placed on a page: a height and what to draw at a top position. */
interface Chunk {
  blockId: string | null;
  x: number;
  width: number;
  h: number;
  draw?: (dc: DrawContext, top: number) => void;
  /** Blocks inside this chunk (the cells of a `columns` row), relative to the chunk. */
  inner?: InnerBox[];
  /** What the chunk shows, for the field map. */
  marks?: Mark[];
}

const mark = (chunk: Chunk, m: Mark): void => {
  (chunk.marks ??= []).push(m);
};

/** Chunks that stay on one page when they fit on one (`keep`), or may break between chunks. */
interface Unit {
  chunks: Chunk[];
  keep: boolean;
}

interface Measured {
  units: Unit[];
  /** Drawn first on every page the block continues on (the table header). */
  repeat?: Chunk;
}

const allChunks = (m: Measured): Chunk[] => m.units.flatMap((u) => u.chunks);
const heightOf = (chunks: Chunk[]): number => chunks.reduce((s, c) => s + c.h, 0);

class Binder {
  readonly colors: Record<ThemeColor, RGB>;
  readonly measure: Measure;
  readonly issues: LayoutIssue[] = [];
  readonly tables: LayoutMap['tables'] = [];
  readonly multipleRates: boolean;

  constructor(
    readonly model: RenderModel,
    readonly doc: TemplateDocumentV2,
    readonly fonts: Fonts,
    readonly geo: PageGeometry,
    readonly images: ReadonlyMap<string, PDFImage>,
  ) {
    const c = (hex: string) => {
      const [r, g, b] = hexToRgb(hex);
      return rgb(r, g, b);
    };
    this.colors = { ink: c(doc.theme.ink), accent: c(doc.theme.accent), muted: c(doc.theme.muted) };
    this.measure = (text, size, bold) => (bold ? fonts.bold : fonts.regular).widthOfTextAtSize(text, size);
    this.multipleRates = new Set(model.lines.filter((l) => !l.text).map((l) => l.rate)).size > 1;
  }

  font(bold: boolean): PDFFont {
    return bold ? this.fonts.bold : this.fonts.regular;
  }

  wrap(text: string, size: number, bold: boolean, width: number): string[] {
    return wrapText(text, this.font(bold), size, Math.max(width, 1));
  }

  /** Draw one line of text with its top at `top` (the baseline sits one size below). */
  text(
    dc: DrawContext,
    s: string,
    x: number,
    top: number,
    opts: { size: number; bold: boolean; color: RGB; align?: 'left' | 'center' | 'right'; width?: number },
  ): void {
    if (s === '') return;
    const font = this.font(opts.bold);
    let drawX = x;
    if (opts.align === 'right' || opts.align === 'center') {
      const w = font.widthOfTextAtSize(s, opts.size);
      const room = (opts.width ?? 0) - w;
      drawX = opts.align === 'right' ? x + room : x + room / 2;
    }
    dc.page.drawText(s, { x: r2(drawX), y: r2(PAGE_HEIGHT - top - opts.size), size: opts.size, font, color: opts.color });
  }

  /** A field of a block, styled as the block prints it. */
  field(
    blockId: string,
    id: string,
    kind: FieldKind,
    edit: { source: FieldSource; documentField: DocumentFieldKey | LineFieldKey; valueUnit?: FieldValueUnit } | null,
    style: FieldStyleIn,
    extra: { empty?: boolean; lineId?: string; recipientField?: RecipientLineField } = {},
  ): FieldSpec {
    return {
      id,
      kind: edit ? kind : 'readonly',
      source: edit?.source ?? null,
      documentField: edit?.documentField ?? null,
      valueUnit: edit?.valueUnit ?? null,
      recipientField: extra.recipientField ?? null,
      lineId: extra.lineId ?? null,
      blockId,
      empty: extra.empty ?? false,
      style: {
        fontFamily: this.doc.theme.fontFamily,
        bold: style.bold,
        sizePt: style.size,
        color: this.doc.theme[style.color].toLowerCase(),
        align: style.align ?? 'left',
        lineHeightPt: lead(style.size),
      },
    };
  }

  /**
   * One chunk per line of wrapped text. `field(i)` names the field text `i`
   * shows (each of its lines is marked, the paragraph gap left out).
   */
  lines(
    blockId: string,
    x: number,
    width: number,
    texts: string[],
    opts: {
      size: number;
      bold: boolean;
      color: RGB;
      align?: 'left' | 'center' | 'right';
      gapAfter?: number;
      field?: (i: number) => FieldSpec | null;
    },
  ): Chunk[] {
    const out: Chunk[] = [];
    const { field, ...drawOpts } = opts;
    texts.forEach((t, ti) => {
      const wrapped = this.wrap(t, opts.size, opts.bold, width);
      const spec = field?.(ti) ?? null;
      wrapped.forEach((line, li) => {
        const last = li === wrapped.length - 1 && ti < texts.length - 1;
        const chunk: Chunk = {
          blockId,
          x,
          width,
          h: r2(lead(opts.size) + (last ? (opts.gapAfter ?? 0) : 0)),
          draw: (dc, top) => this.text(dc, line, x, top, { ...drawOpts, width }),
        };
        if (spec) mark(chunk, { of: { type: 'field', spec }, x, dy: 0, width, height: lead(opts.size) });
        out.push(chunk);
      });
    });
    return out;
  }

  // --- Bind: one function per block type. ---

  bind(block: Block | CellBlock, x: number, width: number, region: RegionName): Measured | null {
    const m = this.model;
    const size = blockSize(block, this.doc);
    const bold = blockBold(block);
    const colorName = blockColor(block);
    const color = this.colors[colorName];
    const align = block.style.align ?? 'left';
    const style = { size, bold, color: colorName, align };
    const keep = (chunks: Chunk[]): Measured | null => (chunks.length === 0 ? null : { units: [{ chunks, keep: true }] });
    const flow = (chunks: Chunk[]): Measured | null =>
      chunks.length === 0 ? null : { units: chunks.map((c) => ({ chunks: [c], keep: false })) };

    switch (block.type) {
      case 'logo':
        return keep(this.logo(block, x, width, region));
      case 'senderLine':
        return keep(m.senderLine ? this.lines(block.id, x, width, [m.senderLine], { size, bold, color, align }) : []);
      case 'recipient':
        // The address is the customer's contact, which no draft request changes: read-only, with the property each line shows.
        return keep(
          this.lines(block.id, x, width, m.recipientBlock, {
            size,
            bold,
            color,
            align,
            field: (i) => this.field(block.id, `recipient.line.${i + 1}`, 'readonly', null, style, { recipientField: m.recipientFields[i] }),
          }),
        );
      case 'documentMeta':
        return keep(this.meta(block, x, width, size, color));
      case 'title':
        return keep(region === 'followingPageHeader' ? this.continuationTitle(block.id, x, width, size, bold, color, align) : this.title(block.id, x, width, size, bold, color, align));
      case 'subject': {
        const spec = this.field(block.id, 'subject', 'text', { source: 'document', documentField: 'subject' }, style);
        return keep(m.subject ? this.lines(block.id, x, width, [m.subject], { size, bold, color, align, field: () => spec }) : []);
      }
      case 'introText':
      case 'outroText': {
        const text = block.type === 'introText' ? m.intro : m.outro;
        const spec = this.field(block.id, block.type, 'multiline', { source: 'document', documentField: block.type }, style);
        return flow(text ? this.lines(block.id, x, width, paragraphs(text), { size, bold, color, align, gapAfter: 4, field: () => spec }) : []);
      }
      case 'lineTable':
        return this.lineTable(block, x, width, size);
      case 'totals':
        return keep(this.totals(block.id, x, width, size, color, colorName));
      case 'taxNote': {
        const spec = this.field(block.id, 'taxNote', 'readonly', null, style);
        return keep(this.lines(block.id, x, width, m.notes, { size, bold, color, align, gapAfter: 4, field: () => spec }));
      }
      case 'paymentDetails': {
        if (m.payment.length === 0) return null;
        const head = block.heading ? this.lines(block.id, x, width, [block.heading], { size, bold: true, color: this.colors.ink, align }) : [];
        return keep([
          ...head,
          ...this.lines(block.id, x, width, m.payment, { size, bold, color, align, gapAfter: 2, field: (i) => this.paymentField(block.id, m.paymentFields[i], style) }),
        ]);
      }
      case 'paymentQr':
        return keep(this.paymentQr(block, x, width, size, color, region));
      case 'senderColumns':
        return keep(this.senderColumns(block, x, width, size, bold, color));
      case 'freeText': {
        const headColor = block.variant === 'smallPrint' ? this.colors.ink : color;
        const head = block.heading ? this.lines(block.id, x, width, [block.heading], { size, bold: true, color: headColor, align }) : [];
        return flow([...head, ...this.lines(block.id, x, width, paragraphs(block.text), { size, bold, color, align, gapAfter: 2 })]);
      }
      case 'spacer':
        return keep([{ blockId: block.id, x, width, h: block.heightPt }]);
      case 'divider': {
        const t = block.thicknessPt;
        const lineColor = this.colors[block.lineColor];
        return keep([
          {
            blockId: block.id,
            x,
            width,
            h: t,
            draw: (dc, top) =>
              dc.page.drawLine({
                start: { x: r2(x), y: r2(PAGE_HEIGHT - top - t / 2) },
                end: { x: r2(x + width), y: r2(PAGE_HEIGHT - top - t / 2) },
                thickness: t,
                color: lineColor,
              }),
          },
        ]);
      }
      case 'columns':
        return keep(this.columns(block, x, width, region));
      default:
        // Unreachable for a checked document (assertRenderableTemplate); never skip a block silently.
        throw new Error(`renderTemplate: unknown block type ${(block as { type?: unknown }).type as string}`);
    }
  }

  /**
   * The slot of a document block that prints nothing (no customer yet, no
   * intro or closing text): an empty field one line high where its first line
   * would print, or null for every other block.
   */
  emptySlot(block: Block, x: number, width: number): { spec: FieldSpec; x: number; width: number; height: number } | null {
    const style: FieldStyleIn = { size: blockSize(block, this.doc), bold: blockBold(block), color: blockColor(block), align: block.style.align ?? 'left' };
    const at = (spec: FieldSpec) => ({ spec, x, width, height: lead(style.size) });
    switch (block.type) {
      case 'recipient':
        return at(this.field(block.id, 'recipient.customer', 'select', { source: 'document', documentField: 'customerId' }, style, { empty: true }));
      case 'subject':
        return at(this.field(block.id, 'subject', 'text', { source: 'document', documentField: 'subject' }, style, { empty: true }));
      case 'introText':
      case 'outroText':
        return at(this.field(block.id, block.type, 'multiline', { source: 'document', documentField: block.type }, style, { empty: true }));
      default:
        return null;
    }
  }

  /** The field a payment line shows: the terms (editable until a due date is set at issue), the reference, or none (the bank line is the sender's). */
  paymentField(blockId: string, shows: PaymentLineField | undefined, style: FieldStyleIn): FieldSpec | null {
    switch (shows) {
      case 'terms':
        return this.field(blockId, 'payment.terms', 'number', { source: 'document', documentField: 'paymentTermsDays', valueUnit: 'days' }, style);
      case 'dueBy':
        return this.field(blockId, 'payment.terms', 'readonly', null, style);
      case 'reference':
        return this.field(blockId, 'payment.reference', 'readonly', null, style);
      default:
        return null;
    }
  }

  /** The field of a document data item (only the service date and the contract reference are edited on a draft). */
  metaField(blockId: string, item: MetaItem, style: FieldStyleIn, empty = false): FieldSpec {
    const id = `meta.${item}`;
    if (item === 'serviceDate') {
      const documentField = this.model.servicePeriod ? 'servicePeriod' : 'serviceDate';
      return this.field(blockId, id, 'date', { source: 'document', documentField }, style, { empty });
    }
    if (item === 'contract') return this.field(blockId, id, 'text', { source: 'document', documentField: 'contractReference' }, style, { empty });
    return this.field(blockId, id, 'readonly', null, style, { empty });
  }

  /** The logo at its width with the image's aspect ratio, aligned in its box; nothing without an asset. */
  logo(block: Extract<Block | CellBlock, { type: 'logo' }>, x: number, width: number, region: RegionName): Chunk[] {
    if (block.assetSha256 === null) return [];
    const image = this.images.get(block.assetSha256);
    if (!image) {
      this.issues.push({ code: 'LOGO_ASSET_MISSING', blockId: block.id, region });
      return [];
    }
    const w = r2(block.widthMm * MM);
    const h = r2((w * image.height) / image.width);
    // A logo wider than its box (a narrow cell, the address zone's right side) would run into its neighbour.
    if (w > width) this.issues.push({ code: 'BLOCK_TOO_WIDE', blockId: block.id, region });
    const room = Math.max(0, width - w);
    const align = block.style.align ?? 'left';
    const left = r2(align === 'right' ? x + room : align === 'center' ? x + room / 2 : x);
    return [
      {
        blockId: block.id,
        x: left,
        width: w,
        h,
        draw: (dc, top) => dc.page.drawImage(image, { x: left, y: r2(PAGE_HEIGHT - top - h), width: w, height: h }),
      },
    ];
  }

  meta(block: Extract<Block, { type: 'documentMeta' }>, x: number, width: number, size: number, color: RGB): Chunk[] {
    const out: Chunk[] = [];
    const muted = this.colors.muted;
    const style: FieldStyleIn = { size, bold: false, color: blockColor(block), align: 'right' };
    // An empty contract reference: its slot is where it would print (under the item before it, or over the one after it;
    // the number and the issue date always print, so a block listing the contract has one of them).
    let pendingSlot: FieldSpec | null = null;
    for (const item of block.items) {
      const entry = this.model.metaItems[item];
      if (!entry) {
        if (item === 'contract') {
          const slot = this.metaField(block.id, item, style, true);
          const prev = out[out.length - 1];
          if (prev) mark(prev, { of: { type: 'field', spec: slot }, x, dy: prev.h, width, height: lead(size) });
          else pendingSlot = slot;
        }
        continue;
      }
      const spec = this.metaField(block.id, item, style);
      const first = out.length;
      const lw = this.measure(entry.label, size, false);
      const vw = this.measure(entry.value, size, false);
      if (lw + 8 + vw <= width) {
        const chunk: Chunk = {
          blockId: block.id,
          x,
          width,
          h: lead(size),
          draw: (dc, top) => {
            this.text(dc, entry.label, x, top, { size, bold: false, color: muted });
            this.text(dc, entry.value, x, top, { size, bold: false, color, align: 'right', width });
          },
        };
        // The value's box: from just after the label to the right edge (the value is right-aligned in it).
        mark(chunk, { of: { type: 'field', spec }, x: r2(x + lw + 8), dy: 0, width: r2(width - lw - 8), height: lead(size) });
        out.push(chunk);
      } else {
        // Too wide for one line: the label, then the value right-aligned under it (still label before value).
        out.push(...this.lines(block.id, x, width, [entry.label], { size, bold: false, color: muted }));
        out.push(...this.lines(block.id, x, width, [entry.value], { size, bold: false, color, align: 'right', field: () => spec }));
      }
      if (pendingSlot) {
        mark(out[first], { of: { type: 'field', spec: pendingSlot }, x, dy: 0, width, height: lead(size) });
        pendingSlot = null;
      }
    }
    return out;
  }

  title(id: string, x: number, width: number, size: number, bold: boolean, color: RGB, align: 'left' | 'center' | 'right'): Chunk[] {
    const out = this.lines(id, x, width, [this.model.title], { size, bold, color, align });
    if (this.model.reference) {
      const refSize = this.doc.theme.baseSizePt;
      out.push(...this.lines(id, x, width, [this.model.reference], { size: Math.max(7, refSize), bold: true, color: this.colors.ink, align }));
    }
    return out;
  }

  continuationTitle(id: string, x: number, width: number, size: number, bold: boolean, color: RGB, align: 'left' | 'center' | 'right'): Chunk[] {
    return [
      {
        blockId: id,
        x,
        width,
        h: lead(size),
        draw: (dc, top) =>
          this.text(dc, `${this.model.shortTitle}, ${pageOf(dc.pageIndex + 1, dc.pageCount)}`, x, top, { size, bold, color, align, width }),
      },
    ];
  }

  lineTable(block: Extract<Block, { type: 'lineTable' }>, x: number, width: number, size: number): Measured {
    const m = this.model;
    const hs = secondarySize(size);
    const ds = secondarySize(size);
    const headers: Record<TableColumn, string> = {
      pos: label('table.pos'),
      title: label('table.title'),
      quantity: label('table.quantity'),
      unit: label('table.unit'),
      unitPrice: label('table.unitPrice'),
      rate: label('table.rate'),
      amount: m.amountHeader,
    };
    const mins = minColumnWidths(size, this.measure, headers);
    const c = block.columns;
    // Title, quantity, unit and amount are legally required and always shown;
    // the rate shows under regular taxation when the template asks for it or the
    // document has more than one rate (decision 5).
    const visible: Record<TableColumn, boolean> = {
      pos: c.pos.visible,
      title: true,
      quantity: true,
      unit: true,
      unitPrice: c.unitPrice.visible,
      rate: m.showRate && (c.rate.visible || this.multipleRates),
      amount: true,
    };
    const order: TableColumn[] = ['pos', 'title', 'quantity', 'unit', 'unitPrice', 'rate', 'amount'];
    const widths: Partial<Record<TableColumn, number>> = {};
    let fixed = 0;
    for (const col of order) {
      if (col === 'title' || !visible[col]) continue;
      widths[col] = r2(Math.max(gridWidth(c[col].width, width), mins[col]));
      fixed += widths[col]!;
    }
    let titleWidth = r2(width - fixed);
    if (titleWidth < MIN_TITLE_WIDTH) {
      this.issues.push({ code: 'TABLE_TOO_NARROW', blockId: block.id, region: 'body' });
      titleWidth = Math.max(titleWidth, 40);
    }
    widths.title = titleWidth;
    const cols: Partial<Record<TableColumn, { x: number; width: number }>> = {};
    let cx = x;
    for (const col of order) {
      if (!visible[col]) continue;
      cols[col] = { x: r2(cx), width: widths[col]! };
      cx += widths[col]!;
    }
    this.tables.push({ blockId: block.id, columns: cols });
    const right = new Set<TableColumn>(['quantity', 'unitPrice', 'rate', 'amount']);
    const cellText = (dc: DrawContext, col: TableColumn, s: string, top: number, opts: { size: number; bold: boolean; color: RGB }) => {
      const cell = cols[col];
      if (!cell) return;
      if (right.has(col)) this.text(dc, s, cell.x, top, { ...opts, align: 'right', width: cell.width - COLUMN_GAP / 2 });
      else this.text(dc, s, cell.x, top, opts);
    };
    const ink = this.colors.ink;
    const headerH = r2(lead(hs) + 8);
    const tint = block.headerBand ? accentTint(this.doc.theme.accent) : null;
    const header: Chunk = {
      blockId: block.id,
      x,
      width,
      h: headerH,
      draw: (dc, top) => {
        if (tint) {
          dc.page.drawRectangle({
            x: r2(x),
            y: r2(PAGE_HEIGHT - top - lead(hs) - 3),
            width: r2(width),
            height: r2(lead(hs) + 3),
            color: rgb(tint[0], tint[1], tint[2]),
          });
        }
        for (const col of order) cellText(dc, col, headers[col], top + 1, { size: hs, bold: true, color: ink });
        dc.page.drawLine({
          start: { x: r2(x), y: r2(PAGE_HEIGHT - top - lead(hs) - 3) },
          end: { x: r2(x + width), y: r2(PAGE_HEIGHT - top - lead(hs) - 3) },
          thickness: 0.6,
          color: this.colors.accent,
        });
      },
    };
    const textWidth = (l: ModelLine) => (l.text ? r2(x + width - cols.title!.x) : r2(cols.title!.width - COLUMN_GAP));
    const units: Unit[] = m.lines.map((l, i) => {
      const titleLines = this.wrap(l.title, size, !l.text, textWidth(l));
      const unitLines = l.text ? [] : this.wrap(l.unit, size, false, cols.unit!.width - COLUMN_GAP);
      const headRows = Math.max(titleLines.length, unitLines.length, 1);
      const lineField = (part: string, kind: FieldKind, edit: { documentField: LineFieldKey; valueUnit?: FieldValueUnit } | null, st: FieldStyleIn, empty = false) =>
        this.field(block.id, `line.${l.id}.${part}`, kind, edit ? { source: 'line', ...edit } : null, st, { empty, lineId: l.id });
      const lineMarks: Mark[] = [];
      const markCell = (col: TableColumn, spec: FieldSpec, rows = 1) => {
        const cell = cols[col];
        if (!cell) return;
        const w = right.has(col) ? cell.width - COLUMN_GAP / 2 : cell.width - COLUMN_GAP;
        lineMarks.push({ of: { type: 'field', spec }, x: cell.x, dy: 0, width: r2(w), height: r2(rows * lead(size)) });
      };
      const cellStyle = (align: 'left' | 'right'): FieldStyleIn => ({ size, bold: false, color: 'ink', align });
      lineMarks.push({
        of: { type: 'field', spec: lineField('title', 'text', { documentField: 'title' }, { size, bold: !l.text, color: 'ink' }) },
        x: cols.title!.x,
        dy: 0,
        width: textWidth(l),
        height: r2(titleLines.length * lead(size)),
      });
      if (!l.text) {
        markCell('quantity', lineField('quantity', 'number', { documentField: 'quantity', valueUnit: 'thousandths' }, cellStyle('right')));
        markCell('unit', lineField('unit', 'text', { documentField: 'unitLabel' }, cellStyle('left')), Math.max(unitLines.length, 1));
        markCell('unitPrice', lineField('unitPrice', 'money', { documentField: 'unitPrice', valueUnit: 'cents' }, cellStyle('right')));
        // The rate follows the tax class only without an override and under a regular treatment (not reverse charge).
        markCell('rate', lineField('rate', 'select', l.rateByClass ? { documentField: 'taxClass' } : null, cellStyle('right')));
        markCell('amount', lineField('amount', 'readonly', null, cellStyle('right')));
      }
      const detailStyle: FieldStyleIn = { size: ds, bold: false, color: 'muted' };
      if (!l.detailFields.includes('description')) {
        // The description would print directly under the title (and push the discount line down).
        lineMarks.push({
          of: { type: 'field', spec: lineField('description', 'multiline', { documentField: 'description' }, detailStyle, true) },
          x: cols.title!.x,
          dy: r2(headRows * lead(size)),
          width: textWidth(l),
          height: lead(ds),
        });
      }
      const head: Chunk = {
        marks: lineMarks,
        blockId: block.id,
        x,
        width,
        h: r2(headRows * lead(size)),
        draw: (dc, top) => {
          const o = { size, bold: false, color: ink };
          if (!l.text) {
            // Reading order: quantity directly before its unit (the completeness check reads "1,5 Std").
            cellText(dc, 'pos', l.pos, top, o);
            cellText(dc, 'quantity', l.quantity, top, o);
            unitLines.forEach((u, ui) => cellText(dc, 'unit', u, top + ui * lead(size), o));
            cellText(dc, 'unitPrice', l.unitPrice, top, o);
            cellText(dc, 'rate', l.rate, top, o);
            cellText(dc, 'amount', l.amount, top, o);
          }
          titleLines.forEach((t, ti) => this.text(dc, t, cols.title!.x, top + ti * lead(size), { size, bold: !l.text, color: ink }));
        },
      };
      const details = l.details.flatMap((d, di) => {
        const kind = l.detailFields[di];
        const spec =
          kind === 'description'
            ? lineField('description', 'multiline', { documentField: 'description' }, detailStyle)
            : kind === 'discount'
              ? lineField('discount', 'number', { documentField: 'discountBp', valueUnit: 'basisPoints' }, detailStyle)
              : null;
        return this.wrap(d, ds, false, textWidth(l)).map((text) => ({ text, spec }));
      });
      const detailChunks: Chunk[] = details.map((d) => ({
        blockId: block.id,
        x,
        width,
        h: lead(ds),
        draw: (dc, top) => this.text(dc, d.text, cols.title!.x, top, { size: ds, bold: false, color: this.colors.muted }),
        marks: d.spec ? [{ of: { type: 'field', spec: d.spec }, x: cols.title!.x, dy: 0, width: textWidth(l), height: lead(ds) }] : [],
      }));
      const chunks = [head, ...detailChunks];
      // The row's rectangle (the toolbar's anchor), without the gap after it.
      for (const c of chunks) (c.marks ??= []).push({ of: { type: 'row', lineId: l.id, blockId: block.id }, x, dy: 0, width, height: c.h });
      // The gap after a row belongs to its last chunk.
      chunks[chunks.length - 1] = { ...chunks[chunks.length - 1], h: r2(chunks[chunks.length - 1].h + 6) };
      return { chunks: i === 0 ? [header, ...chunks] : chunks, keep: true };
    });
    const rule: Chunk = {
      blockId: block.id,
      x,
      width,
      h: 8,
      // The rule follows the last row: its top is where the next line would print.
      marks: [{ of: { type: 'addLine', blockId: block.id }, x, dy: 0, width, height: r2(lead(size) + 6) }],
      draw: (dc, top) =>
        dc.page.drawLine({
          start: { x: r2(x), y: r2(PAGE_HEIGHT - top - 2) },
          end: { x: r2(x + width), y: r2(PAGE_HEIGHT - top - 2) },
          thickness: 0.4,
          color: this.colors.muted,
        }),
    };
    if (units.length === 0) units.push({ chunks: [header], keep: true });
    units[units.length - 1].chunks.push(rule);
    return { units, repeat: header };
  }

  totals(id: string, x: number, width: number, size: number, color: RGB, colorName: ThemeColor): Chunk[] {
    const valueWidth = this.measure(WIDEST.amount!, size + 1, true) + COLUMN_GAP;
    return this.model.totals.map((t, i) => {
      const s = t.strong ? size + 1 : size;
      const chunk: Chunk = {
        blockId: id,
        x,
        width,
        h: r2(lead(s) + (t.strong ? 2 : 0)),
        draw: (dc, top) => {
          const top2 = top + (t.strong ? 2 : 0);
          this.text(dc, t.label, x, top2, { size: s, bold: t.strong, color, align: 'right', width: width - valueWidth });
          this.text(dc, t.value, x, top2, { size: s, bold: t.strong, color, align: 'right', width });
        },
      };
      // The value's box (right-aligned in it), the row's label stays the template's.
      const spec = this.field(id, `totals.${i + 1}`, 'readonly', null, { size: s, bold: t.strong, color: colorName, align: 'right' });
      mark(chunk, { of: { type: 'field', spec }, x: r2(x + width - valueWidth), dy: t.strong ? 2 : 0, width: r2(valueWidth), height: lead(s) });
      return chunk;
    });
  }

  paymentQr(
    block: Extract<Block | CellBlock, { type: 'paymentQr' }>,
    x: number,
    width: number,
    size: number,
    color: RGB,
    region: RegionName,
  ): Chunk[] {
    const m = this.model;
    if (!m.paymentQr && !m.paymentQrPending) return [];
    const edge = r2(block.sizeMm * MM);
    const matrix = m.paymentQr ? qrMatrix(epcPayload(m.paymentQr)) : null;
    const modules = matrix?.size ?? 33;
    const quiet = r2((edge / modules) * QUIET_ZONE_MODULES);
    const box = r2(edge + 2 * quiet);
    // The code has a fixed size: a cell narrower than it would let it run past its column (or the page).
    if (box > width) this.issues.push({ code: 'BLOCK_TOO_WIDE', blockId: block.id, region });
    const besides = width - box - 4 >= 80;
    const capX = besides ? r2(x + box + 4) : x;
    const capW = besides ? r2(width - box - 4) : width;
    const caption = block.caption ? this.wrap(block.caption, size, false, capW) : [];
    const capH = caption.length * lead(size);
    const h = besides ? Math.max(box, capH + quiet) : box + capH;
    const placeholder = this.wrap(label('payment.qrPlaceholder'), 7, false, edge - 6);
    return [
      {
        blockId: block.id,
        x,
        width: Math.max(width, box),
        h: r2(h),
        draw: (dc, top) => {
          const ox = x + quiet;
          const oy = top + quiet;
          if (matrix) {
            const unit = edge / matrix.size;
            for (const run of darkRuns(matrix)) {
              const x0 = r2(ox + run.col * unit);
              const x1 = r2(ox + (run.col + run.len) * unit);
              const y0 = r2(oy + run.row * unit);
              const y1 = r2(oy + (run.row + 1) * unit);
              dc.page.drawRectangle({ x: x0, y: r2(PAGE_HEIGHT - y1), width: r2(x1 - x0), height: r2(y1 - y0), color: rgb(0, 0, 0) });
            }
          } else {
            dc.page.drawRectangle({
              x: r2(ox),
              y: r2(PAGE_HEIGHT - oy - edge),
              width: edge,
              height: edge,
              color: rgb(0.92, 0.92, 0.92),
              borderColor: this.colors.muted,
              borderWidth: 0.5,
            });
            const textTop = oy + edge / 2 - (placeholder.length * lead(7)) / 2;
            placeholder.forEach((p, i) =>
              this.text(dc, p, ox + 3, textTop + i * lead(7), { size: 7, bold: false, color: this.colors.muted, align: 'center', width: edge - 6 }),
            );
          }
          const capTop = besides ? top + quiet : top + box;
          caption.forEach((c, i) => this.text(dc, c, capX, capTop + i * lead(size), { size, bold: false, color }));
        },
      },
    ];
  }

  senderColumns(block: Extract<Block, { type: 'senderColumns' }>, x: number, width: number, size: number, bold: boolean, color: RGB): Chunk[] {
    const cols = block.columns.map((c) => this.model.senderColumns[c]).filter((c) => c.length > 0);
    if (cols.length === 0) return [];
    if (block.layout === 'line') {
      return this.lines(block.id, x, width, [cols.flat().join(' · ')], { size, bold, color, align: block.style.align ?? 'left' });
    }
    const colWidth = width / cols.length;
    const wrapped = cols.map((col) => col.flatMap((l) => this.wrap(l, size, bold, colWidth - 8)));
    const rows = Math.max(...wrapped.map((w) => w.length));
    return [
      {
        blockId: block.id,
        x,
        width,
        h: r2(rows * lead(size)),
        draw: (dc, top) =>
          wrapped.forEach((col, ci) =>
            col.forEach((l, li) => this.text(dc, l, x + ci * colWidth, top + li * lead(size), { size, bold, color })),
          ),
      },
    ];
  }

  columns(block: Extract<Block, { type: 'columns' }>, x: number, width: number, region: RegionName): Chunk[] {
    const gap = 12;
    const units = Math.max(12, block.cells.reduce((s, c) => s + c.width, 0));
    const usable = width - gap * (block.cells.length - 1);
    let cx = x;
    const cells = block.cells.map((cell) => {
      const w = r2((usable * cell.width) / units);
      const cellX = cx;
      cx += w + gap;
      const placed: Array<{ chunk: Chunk; dy: number }> = [];
      let y = 0;
      cell.blocks.forEach((b) => {
        const measured = this.bind(b, cellX, w, region);
        if (!measured) return;
        if (placed.length > 0) y += b.style.spaceAbovePt ?? 0;
        for (const chunk of allChunks(measured)) {
          placed.push({ chunk, dy: y });
          y += chunk.h;
        }
        y += b.style.spaceBelowPt ?? 0;
      });
      return { placed, h: y };
    });
    const h = Math.max(0, ...cells.map((c) => c.h));
    if (h === 0) return [];
    const inner: InnerBox[] = [];
    const marks: Mark[] = [];
    for (const cell of cells) {
      for (const p of cell.placed) {
        if (p.chunk.blockId) inner.push({ blockId: p.chunk.blockId, dx: p.chunk.x - x, dy: p.dy, width: p.chunk.width, height: p.chunk.h });
        for (const mk of p.chunk.marks ?? []) marks.push({ ...mk, dy: r2(p.dy + mk.dy) });
      }
    }
    return [
      {
        blockId: block.id,
        x,
        width,
        h: r2(h),
        inner,
        marks,
        draw: (dc, top) => {
          for (const cell of cells) for (const p of cell.placed) p.chunk.draw?.(dc, top + p.dy);
        },
      },
    ];
  }
}

/** A text's paragraphs (line breaks in template and document texts). */
function paragraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((p) => p.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/ {2,}/g, ' ').trim())
    .filter((p) => p !== '');
}

// --- Paginate. ---

interface Placed {
  chunk: Chunk;
  page: number;
  top: number;
  region: RegionName;
}

/** The slot of an empty document block (0-based page, top in points); never drawn. */
interface Slot {
  spec: FieldSpec;
  region: RegionName;
  page: number;
  x: number;
  top: number;
  width: number;
  height: number;
}

/** Stack a region's blocks from `top` (no page breaks: headers, the address zone, the footer). */
function stack(
  b: Binder,
  blocks: Block[],
  region: RegionName,
  x: number,
  width: number,
  top: number,
  page: number,
): { placed: Placed[]; bottom: number; slots: Slot[] } {
  const placed: Placed[] = [];
  const slots: Slot[] = [];
  let y = top;
  let first = true;
  for (const block of blocks) {
    const m = b.bind(block, x, width, region);
    if (!m) {
      const slot = b.emptySlot(block, x, width);
      if (slot) slots.push({ ...slot, region, page, top: r2(y + (first ? 0 : (block.style.spaceAbovePt ?? 0))) });
      continue;
    }
    if (!first) y += block.style.spaceAbovePt ?? 0;
    first = false;
    for (const chunk of allChunks(m)) {
      placed.push({ chunk, page, top: r2(y), region });
      y += chunk.h;
    }
    y += block.style.spaceBelowPt ?? 0;
  }
  return { placed, bottom: r2(y), slots };
}

const BLOCK_TYPES = new Set([
  'logo', 'senderLine', 'recipient', 'documentMeta', 'title', 'subject', 'introText', 'outroText', 'lineTable', 'totals', 'taxNote',
  'paymentDetails', 'paymentQr', 'senderColumns', 'freeText', 'spacer', 'divider', 'columns',
]);
const THEME_COLORS = new Set(['ink', 'accent', 'muted']);
const META = new Set(['number', 'issueDate', 'serviceDate', 'customerNumber', 'contract', 'recipientVatId', 'dueDate']);
const SENDER = new Set(['identity', 'contact', 'legal', 'bank']);
const COLUMNS = ['pos', 'title', 'quantity', 'unit', 'unitPrice', 'rate', 'amount'];

/**
 * The structure the engine relies on, checked before anything is drawn. A
 * document written through the strict schema always passes; a stored one is
 * read with a shape check only (snapshots.ts), so a malformed one fails here,
 * loudly and naming the path, instead of drawing a wrong page.
 */
export function assertRenderableTemplate(doc: TemplateDocumentV2): void {
  const fail = (path: string): never => {
    throw new Error(`renderTemplate: the template document is malformed at ${path}`);
  };
  const num = (v: unknown, path: string) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fail(path));
  const hex = (v: unknown, path: string) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fail(path));
  const d = doc as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!(d.page?.addressLayout in ADDRESS_TOP_KEYS)) fail('page.addressLayout');
  if (d.page.pageNumber !== 'right' && d.page.pageNumber !== 'center') fail('page.pageNumber');
  for (const m of ['left', 'right', 'bottom']) num(d.page.marginsMm?.[m], `page.marginsMm.${m}`);
  for (const c of ['ink', 'accent', 'muted']) hex(d.theme?.[c], `theme.${c}`);
  if (num(d.theme.baseSizePt, 'theme.baseSizePt') === 0) fail('theme.baseSizePt');
  const block = (b: any, path: string, inCell: boolean): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (typeof b !== 'object' || b === null || typeof b.id !== 'string' || !BLOCK_TYPES.has(b.type)) fail(`${path}.type`);
    if (typeof b.style !== 'object' || b.style === null) fail(`${path}.style`);
    if (b.style.color !== undefined && !THEME_COLORS.has(b.style.color)) fail(`${path}.style.color`);
    for (const k of ['sizePt', 'spaceAbovePt', 'spaceBelowPt']) if (b.style[k] !== undefined) num(b.style[k], `${path}.style.${k}`);
    if (b.type === 'divider') {
      num(b.thicknessPt, `${path}.thicknessPt`);
      if (!THEME_COLORS.has(b.lineColor)) fail(`${path}.lineColor`);
    }
    if (b.type === 'spacer') num(b.heightPt, `${path}.heightPt`);
    if (b.type === 'logo') {
      if (num(b.widthMm, `${path}.widthMm`) === 0) fail(`${path}.widthMm`);
      if (b.assetSha256 !== null && !(typeof b.assetSha256 === 'string' && /^[0-9a-f]{64}$/.test(b.assetSha256))) fail(`${path}.assetSha256`);
    }
    if (b.type === 'paymentQr') {
      num(b.sizeMm, `${path}.sizeMm`);
      if (typeof b.caption !== 'string') fail(`${path}.caption`);
    }
    if (b.type === 'freeText' && typeof b.text !== 'string') fail(`${path}.text`);
    if (b.type === 'documentMeta' && !(Array.isArray(b.items) && b.items.every((i: unknown) => META.has(i as string)))) fail(`${path}.items`);
    if (b.type === 'senderColumns' && !(Array.isArray(b.columns) && b.columns.every((c: unknown) => SENDER.has(c as string)))) fail(`${path}.columns`);
    if (b.type === 'lineTable') {
      for (const c of COLUMNS) {
        if (typeof b.columns?.[c]?.visible !== 'boolean') fail(`${path}.columns.${c}`);
        num(b.columns[c].width, `${path}.columns.${c}.width`);
      }
    }
    if (b.type === 'columns') {
      if (inCell || !Array.isArray(b.cells)) fail(`${path}.cells`);
      b.cells.forEach((cell: any, i: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        if (num(cell?.width, `${path}.cells.${i}.width`) === 0 || !Array.isArray(cell.blocks)) fail(`${path}.cells.${i}`);
        cell.blocks.forEach((cb: unknown, j: number) => block(cb, `${path}.cells.${i}.blocks.${j}`, true));
      });
    }
  };
  const r = d.regions;
  const regions: Array<[string, unknown]> = [
    ['firstPageHeader', r?.firstPageHeader],
    ['addressZone.left', r?.addressZone?.left],
    ['addressZone.right', r?.addressZone?.right],
    ['body', r?.body],
    ['followingPageHeader', r?.followingPageHeader],
    ['footer', r?.footer],
  ];
  for (const [name, blocks] of regions) {
    if (!Array.isArray(blocks)) fail(`regions.${name}`);
    (blocks as unknown[]).forEach((b, i) => block(b, `regions.${name}.${i}`, false));
  }
}

/** Render a model with a template document version 2: the PDF bytes and the layout map. */
export async function renderTemplate(
  model: RenderModel,
  doc: TemplateDocumentV2,
  fontBytes: EngineFonts,
  options: EngineOptions = {},
): Promise<EngineResult> {
  assertRenderableTemplate(doc);
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  const fonts: Fonts = {
    // Subset where the subsetter is proven to keep every glyph's outline (fonts.ts EMBED_SUBSET).
    regular: await pdf.embedFont(fontBytes.regular, { subset: EMBED_SUBSET[doc.theme.fontFamily] }),
    bold: await pdf.embedFont(fontBytes.bold, { subset: EMBED_SUBSET[doc.theme.fontFamily] }),
  };
  // Every asset the logos name, embedded once, in a fixed order (the bytes do not depend on the map's order).
  const images = new Map<string, PDFImage>();
  const shas = [...new Set(logoBlocks(doc).map((l) => l.block.assetSha256).filter((s): s is string => s !== null))].sort();
  for (const sha of shas) {
    const asset = options.assets?.get(sha);
    if (!asset) continue;
    images.set(sha, await embedAsset(pdf, sha, asset));
  }
  const geo = geometry(doc);
  const b = new Binder(model, doc, fonts, geo, images);
  const full = { x: geo.left, width: geo.contentWidth };

  // The footer and the following-page header reserve their space on every page.
  const footerProbe = stack(b, doc.regions.footer, 'footer', full.x, full.width, 0, 0);
  const footerHeight = footerProbe.bottom;
  const footerTop = r2(PAGE_HEIGHT - geo.bottom - PAGE_NUMBER_BAND - footerHeight);
  const contentBottom = r2(footerTop - FOOTER_GAP);
  const followingProbe = stack(b, doc.regions.followingPageHeader, 'followingPageHeader', full.x, full.width, TOP_MARGIN, 0);
  const followingTop = followingProbe.bottom;
  if (contentBottom - followingTop < 300) b.issues.push({ code: 'FOOTER_TOO_TALL', blockId: null, region: 'footer' });

  // Page 1: the letterhead, then the address zone at its DIN 5008 position.
  const placed: Placed[] = [];
  const header = stack(b, doc.regions.firstPageHeader, 'firstPageHeader', full.x, full.width, TOP_MARGIN, 0);
  if (header.bottom > geo.addressTop) b.issues.push({ code: 'HEADER_TOO_TALL', blockId: null, region: 'firstPageHeader' });
  placed.push(...header.placed);
  const left = stack(b, doc.regions.addressZone.left, 'addressZone.left', geo.addressLeft.x, geo.addressLeft.width, geo.addressTop, 0);
  const right = stack(b, doc.regions.addressZone.right, 'addressZone.right', geo.addressRight.x, geo.addressRight.width, geo.addressTop, 0);
  placed.push(...left.placed, ...right.placed);
  const slots: Slot[] = [...header.slots, ...left.slots, ...right.slots];
  const firstTop = r2(Math.max(geo.addressTop + ADDRESS_FIELD_HEIGHT, left.bottom, right.bottom, header.bottom));
  // The recipient must start inside the window (below the return line, never further down).
  const recipientId = doc.regions.addressZone.left.find((blk) => blk.type === 'recipient')?.id;
  const recipientTop = left.placed.find((p) => p.chunk.blockId === recipientId)?.top;
  if (recipientTop !== undefined && recipientTop > geo.addressTop + REMARK_ZONE[doc.page.addressLayout]) {
    b.issues.push({ code: 'ADDRESS_FIELD_OVERFLOW', blockId: recipientId ?? null, region: 'addressZone.left' });
  }
  if (Math.max(left.bottom, right.bottom) > contentBottom) {
    b.issues.push({ code: 'ADDRESS_ZONE_TOO_TALL', blockId: null, region: left.bottom > right.bottom ? 'addressZone.left' : 'addressZone.right' });
  }
  // A footer or header that leaves no room would flow the body over hundreds of pages: stop at two.
  const cap = options.maxPages ?? MAX_PAGES;
  const pageLimit = contentBottom - followingTop < 300 ? Math.min(2, cap) : cap;

  // The body flows into pages.
  let page = 0;
  let y = firstTop;
  let atTop = true;
  let repeat: Chunk | undefined;
  const newPage = () => {
    page += 1;
    y = followingTop;
    atTop = true;
    if (repeat) {
      placed.push({ chunk: repeat, page, top: r2(y), region: 'body' });
      y += repeat.h;
    }
  };
  /** Room on a following page (below its header and a repeated table header). */
  const pageRoom = () => contentBottom - followingTop - (repeat?.h ?? 0);
  /** Whether content of height `h` should start on a new page: it does not fit here, and it would fit there (or something is already on this page). */
  const breakBefore = (h: number) => y + h > contentBottom && (!atTop || (page === 0 && h <= pageRoom()));
  let stopped = false;
  const put = (chunk: Chunk) => {
    if (stopped) return;
    if (breakBefore(chunk.h)) {
      if (page + 1 >= pageLimit) {
        stopped = true;
        if (pageLimit === cap) b.issues.push({ code: 'PAGE_LIMIT', blockId: chunk.blockId, region: 'body' });
        return;
      }
      newPage();
    }
    if (y + chunk.h > contentBottom && chunk.blockId) b.issues.push({ code: 'BLOCK_TOO_TALL', blockId: chunk.blockId, region: 'body' });
    placed.push({ chunk, page, top: r2(y), region: 'body' });
    y += chunk.h;
    atTop = false;
  };

  const body = doc.regions.body;
  for (let i = 0; i < body.length; i += 1) {
    const block = body[i];
    let measured = b.bind(block, full.x, full.width, 'body');
    if (!measured) {
      // An empty intro or closing text: its slot where it would start, inside the body's room, taking no space.
      const slot = stopped ? null : b.emptySlot(block, full.x, full.width);
      if (slot) {
        const top = y + (!atTop || page === 0 ? (block.style.spaceAbovePt ?? 0) : 0);
        slots.push({ ...slot, region: 'body', page, top: r2(Math.max(atTop ? y : 0, Math.min(top, contentBottom - slot.height))) });
      }
      continue;
    }
    let spaceBelow = block.style.spaceBelowPt ?? 0;
    // Totals and the tax note directly after them stay together (decision 5).
    if (block.type === 'totals' && body[i + 1]?.type === 'taxNote') {
      const note = body[i + 1];
      const noteMeasured = b.bind(note, full.x, full.width, 'body');
      if (noteMeasured) {
        const between: Chunk = { blockId: null, x: full.x, width: full.width, h: r2(spaceBelow + (note.style.spaceAbovePt ?? 0)) };
        measured = { units: [{ chunks: [...allChunks(measured), between, ...allChunks(noteMeasured)], keep: true }] };
        spaceBelow = note.style.spaceBelowPt ?? 0;
        i += 1;
      }
    }
    // Space above collapses at the top of a following page, never on the first.
    if (!atTop || page === 0) y += block.style.spaceAbovePt ?? 0;
    for (const unit of measured.units) {
      // A unit that fits on one page moves there whole; a taller one flows chunk by chunk.
      const h = heightOf(unit.chunks);
      if (!stopped && unit.keep && h <= pageRoom() && breakBefore(h) && page + 1 < pageLimit) newPage();
      for (const chunk of unit.chunks) {
        put(chunk);
        // From the first drawn chunk on, a page break inside the block repeats its header.
        repeat = measured.repeat;
      }
    }
    repeat = undefined;
    y += spaceBelow;
  }
  const pageCount = page + 1;

  // Draw.
  const pages: PDFPage[] = [];
  for (let p = 0; p < pageCount; p += 1) pages.push(pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]));
  const stampColor = rgb(0.75, 0.15, 0.15);
  for (let p = 0; p < pageCount; p += 1) {
    const dc: DrawContext = { page: pages[p], pageIndex: p, pageCount };
    if (model.draft) b.text(dc, label('stamp.draft'), geo.left, 20, { size: 9, bold: true, color: stampColor });
    if (options.preview) b.text(dc, label('stamp.preview'), geo.left, 20, { size: 9, bold: true, color: stampColor, align: 'right', width: geo.contentWidth });
    if (p > 0) for (const f of followingProbe.placed) f.chunk.draw?.(dc, f.top);
    for (const item of placed) if (item.page === p) item.chunk.draw?.(dc, item.top);
    for (const f of footerProbe.placed) f.chunk.draw?.(dc, footerTop + f.top);
    const n = pageOf(p + 1, pageCount);
    b.text(dc, n, geo.left, r2(PAGE_HEIGHT - geo.bottom - PAGE_NUMBER_SIZE), {
      size: PAGE_NUMBER_SIZE,
      bold: false,
      color: b.colors.muted,
      align: doc.page.pageNumber === 'center' ? 'center' : 'right',
      width: geo.contentWidth,
    });
  }

  pdf.setTitle(model.pdfTitle);
  pdf.setProducer(RENDERER_ID);
  pdf.setCreator('Lumitra Books');
  pdf.setCreationDate(model.pdfDate);
  pdf.setModificationDate(model.pdfDate);
  const bytes = await pdf.save();

  // The layout map: one rectangle per block and page (cells of a row included).
  const all: Placed[] = [...placed];
  for (let p = 1; p < pageCount; p += 1) for (const f of followingProbe.placed) all.push({ ...f, page: p });
  for (let p = 0; p < pageCount; p += 1) for (const f of footerProbe.placed) all.push({ ...f, page: p, top: r2(footerTop + f.top) });
  const rects = new Map<string, LayoutRect>();
  const add = (blockId: string, region: RegionName, pageNo: number, x: number, top: number, width: number, height: number) => {
    const key = `${blockId}@${pageNo}`;
    const prev = rects.get(key);
    if (!prev) {
      rects.set(key, { blockId, region, page: pageNo + 1, x: r2(x), y: r2(top), width: r2(width), height: r2(height) });
      return;
    }
    const x0 = Math.min(prev.x, x);
    const y0 = Math.min(prev.y, top);
    const x1 = Math.max(prev.x + prev.width, x + width);
    const y1 = Math.max(prev.y + prev.height, top + height);
    rects.set(key, { ...prev, x: r2(x0), y: r2(y0), width: r2(x1 - x0), height: r2(y1 - y0) });
  };
  for (const item of all) {
    const c = item.chunk;
    if (c.blockId) add(c.blockId, item.region, item.page, c.x, item.top, c.width, c.h);
    for (const inner of c.inner ?? []) add(inner.blockId, item.region, item.page, c.x + inner.dx, item.top + inner.dy, inner.width, inner.height);
  }
  const blocks = [...rects.values()].sort((a, c) => a.page - c.page || a.y - c.y || a.x - c.x || a.blockId.localeCompare(c.blockId));
  return {
    bytes,
    layout: {
      page: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
      pageCount,
      blocks,
      tables: b.tables,
      issues: dedupeIssues(b.issues),
      ...fieldMap(all, slots, contentBottom),
    },
  };
}

/** The regions in reading order. */
const REGION_ORDER: readonly RegionName[] = ['firstPageHeader', 'followingPageHeader', 'addressZone.left', 'addressZone.right', 'body', 'footer'];

/** Union rectangles per key and page: a field or row printed in several pieces on one page has one rectangle there. */
class RectsByPage {
  private readonly byPage = new Map<number, FieldRect>();

  add(page: number, x: number, y: number, width: number, height: number): void {
    const prev = this.byPage.get(page);
    if (!prev) {
      this.byPage.set(page, { page, x, y, width, height });
      return;
    }
    const x0 = Math.min(prev.x, x);
    const y0 = Math.min(prev.y, y);
    this.byPage.set(page, { page, x: x0, y: y0, width: Math.max(prev.x + prev.width, x + width) - x0, height: Math.max(prev.y + prev.height, y + height) - y0 });
  }

  rects(): FieldRect[] {
    return [...this.byPage.values()]
      .sort((a, c) => a.page - c.page)
      .map((r) => ({ page: r.page, x: r2(r.x), y: r2(r.y), width: r2(r.width), height: r2(r.height) }));
  }
}

/**
 * The fields and anchors of the map, from the marks of every placed chunk
 * (the header and footer once per page) and the slots of empty blocks. A field
 * is keyed by its id and block: the save gate allows every block bound to
 * document data once (rules.ts), so an id names one field in a checked
 * template.
 */
function fieldMap(all: Placed[], slots: Slot[], contentBottom: number): { fields: LayoutField[]; anchors: LayoutAnchors } {
  const fields = new Map<string, { spec: FieldSpec; region: RegionName; rects: RectsByPage; carrier: Placed | null }>();
  const rows = new Map<string, { lineId: string; blockId: string; rects: RectsByPage }>();
  const addLine = new Map<string, { rect: FieldRect; carrier: Placed }>();
  // The drawn chunks by page (1-based), for the free room under a slot.
  const drawnByPage = new Map<number, Placed[]>();
  for (const item of all) {
    if (!item.chunk.draw || item.chunk.h <= 0) continue;
    const list = drawnByPage.get(item.page + 1) ?? [];
    list.push(item);
    drawnByPage.set(item.page + 1, list);
  }
  /**
   * The free points below `rect`'s top, up to the first drawn chunk that
   * overlaps it sideways and reaches below that top (0 when one already covers
   * it; a chunk's box counts, its trailing gap included, so the room errs on
   * the small side). The chunk carrying the slot is left out when it starts
   * above the slot (its gap below is empty), and always for the add-line slot (the table's
   * closing rule moves down with a new row).
   */
  const room = (rect: FieldRect, carrier: Placed | null, skipCarrier: boolean): number => {
    let next = Math.max(contentBottom, rect.y);
    for (const item of drawnByPage.get(rect.page) ?? []) {
      const c = item.chunk;
      if (item === carrier && (skipCarrier || item.top < rect.y - 0.005)) continue;
      if (item.top + c.h <= rect.y + 0.005) continue;
      if (c.x >= rect.x + rect.width || c.x + c.width <= rect.x) continue;
      next = Math.min(next, Math.max(item.top, rect.y));
    }
    return r2(Math.max(0, next - rect.y));
  };
  const addField = (spec: FieldSpec, region: RegionName, page: number, x: number, y: number, width: number, height: number, carrier: Placed | null) => {
    const key = `${spec.id}@${spec.blockId}`;
    const entry = fields.get(key) ?? { spec, region, rects: new RectsByPage(), carrier };
    fields.set(key, entry);
    entry.rects.add(page, x, y, width, height);
  };
  for (const item of all) {
    for (const mk of item.chunk.marks ?? []) {
      const page = item.page + 1;
      const y = item.top + mk.dy;
      const of = mk.of;
      if (of.type === 'field') addField(of.spec, item.region, page, mk.x, y, mk.width, mk.height, item);
      else if (of.type === 'row') {
        const key = `${of.lineId}@${of.blockId}`;
        const entry = rows.get(key) ?? { lineId: of.lineId, blockId: of.blockId, rects: new RectsByPage() };
        rows.set(key, entry);
        entry.rects.add(page, mk.x, y, mk.width, mk.height);
      } else {
        const prev = addLine.get(of.blockId)?.rect;
        if (!prev || page > prev.page || (page === prev.page && y > prev.y)) {
          addLine.set(of.blockId, { rect: { page, x: r2(mk.x), y: r2(y), width: r2(mk.width), height: r2(mk.height) }, carrier: item });
        }
      }
    }
  }
  for (const s of slots) addField(s.spec, s.region, s.page + 1, s.x, s.top, s.width, s.height, null);
  const reading = (a: FieldRect, c: FieldRect) => a.page - c.page || a.y - c.y || a.x - c.x;
  // Reading order: page, then region (the address before the document data beside it), then top and left.
  const out: LayoutField[] = [...fields.values()]
    .map(({ spec, region, rects, carrier }) => {
      const r = rects.rects();
      return { ...spec, region, rects: r, room: spec.empty ? room(r[0], carrier, false) : null };
    })
    .sort(
      (a, c) =>
        a.rects[0].page - c.rects[0].page ||
        REGION_ORDER.indexOf(a.region) - REGION_ORDER.indexOf(c.region) ||
        reading(a.rects[0], c.rects[0]) ||
        (a.id < c.id ? -1 : a.id > c.id ? 1 : 0),
    );
  return {
    fields: out,
    anchors: {
      rows: [...rows.values()].map((r) => ({ lineId: r.lineId, blockId: r.blockId, rects: r.rects.rects() })).sort((a, c) => reading(a.rects[0], c.rects[0])),
      addLine: [...addLine.entries()].map(([blockId, a]) => ({ blockId, rect: a.rect, room: room(a.rect, a.carrier, true) })),
    },
  };
}

function dedupeIssues(issues: LayoutIssue[]): LayoutIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.code}|${i.blockId}|${i.region}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
