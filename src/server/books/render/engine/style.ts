// src/server/books/render/engine/style.ts
//
// How a block's style resolves to concrete values (size, weight, colour,
// spacing), the page geometry, the line table's column widths and the colour
// contrast arithmetic. Shared by the layout engine (render/engine) and the
// structural rules of the save gate (template/rules.ts), so the size, width
// and contrast a template is checked with are exactly the ones it is drawn
// with. Pure: no fonts are loaded here; text widths come in through a
// `Measure` function.

import { formatMoney, formatQuantity, formatRate } from '../format';
import type { Block, CellBlock, TableColumn, TemplateDocumentV2, ThemeColor } from '../../template/schema';

/** Text width in points: `measure(text, sizePt, bold)`. */
export type Measure = (text: string, sizePt: number, bold: boolean) => number;

export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;
export const MM = 72 / 25.4;

/** Round a position to 1/100 pt, so a floating point difference cannot change the bytes. */
export const r2 = (v: number): number => Math.round(v * 100) / 100;

/** The line height of text at a size. */
export const lead = (sizePt: number): number => r2(sizePt * 1.35);

/** The top margin of every page (the stamps sit inside it). */
export const TOP_MARGIN = r2(15 * MM);
/** DIN 5008 address field: its top edge from the page top, and its size. */
export const ADDRESS_TOP = { 'din5008-b': r2(45 * MM), 'din5008-a': r2(27 * MM) } as const;
export const ADDRESS_FIELD_WIDTH = r2(85 * MM);
export const ADDRESS_FIELD_HEIGHT = r2(45 * MM);
/** The information block (document data) starts 125 mm from the left edge. */
export const INFO_BLOCK_LEFT = r2(125 * MM);
/** The line "Seite n von m" (its height above the bottom margin). */
export const PAGE_NUMBER_SIZE = 7;
export const PAGE_NUMBER_BAND = 10;
/** The gap between the body and the footer region. */
export const FOOTER_GAP = 12;

export interface PageGeometry {
  left: number;
  right: number;
  bottom: number;
  contentWidth: number;
  addressTop: number;
  addressLeft: { x: number; width: number };
  addressRight: { x: number; width: number };
}

export function geometry(doc: TemplateDocumentV2): PageGeometry {
  const left = r2(doc.page.marginsMm.left * MM);
  const right = r2(doc.page.marginsMm.right * MM);
  const bottom = r2(doc.page.marginsMm.bottom * MM);
  // DIN 5008: the address field begins 20 mm from the left edge and is 85 mm
  // wide; the text inside it starts at the left margin (20 to 25 mm).
  const addressLeft = { x: left, width: r2(20 * MM + ADDRESS_FIELD_WIDTH - left) };
  const addressRight = { x: INFO_BLOCK_LEFT, width: r2(PAGE_WIDTH - right - INFO_BLOCK_LEFT) };
  return {
    left,
    right,
    bottom,
    contentWidth: r2(PAGE_WIDTH - left - right),
    addressTop: ADDRESS_TOP[doc.page.addressLayout],
    addressLeft,
    addressRight,
  };
}

/** The block types whose text is legal content (decision 7: never below 7 pt). */
export const LEGAL_BLOCKS = new Set(['senderLine', 'recipient', 'documentMeta', 'title', 'lineTable', 'totals', 'taxNote']);
/** The smallest size of any legal block, and of the sender footer (today's 6.5 pt). */
export const MIN_LEGAL_SIZE = 7;
export const MIN_FOOTER_SIZE = 6.5;

/** The font size a block is set in. */
export function blockSize(block: Block | CellBlock, doc: TemplateDocumentV2): number {
  if (block.style.sizePt !== undefined) return block.style.sizePt;
  const base = doc.theme.baseSizePt;
  switch (block.type) {
    case 'senderLine':
      return 7;
    case 'documentMeta':
      return Math.max(MIN_LEGAL_SIZE, base - 1.5);
    case 'title':
      return 14;
    case 'senderColumns':
      return 6.5;
    case 'paymentQr':
      return Math.max(MIN_LEGAL_SIZE, base - 1);
    case 'freeText':
      return block.variant === 'smallPrint' ? 7.5 : base;
    default:
      return base;
  }
}

/** The smaller sizes inside a block: the line table header and detail lines. */
export const secondarySize = (sizePt: number): number => Math.max(MIN_LEGAL_SIZE, sizePt - 1.5);

/** Whether a block's main text is bold. */
export function blockBold(block: Block | CellBlock): boolean {
  if (block.style.bold !== undefined) return block.style.bold;
  return block.type === 'title' || block.type === 'taxNote';
}

/** The theme colour of a block's main text. */
export function blockColor(block: Block | CellBlock): ThemeColor {
  if (block.style.color) return block.style.color;
  switch (block.type) {
    case 'senderLine':
    case 'senderColumns':
      return 'muted';
    case 'title':
      return 'accent';
    case 'freeText':
      return block.variant === 'smallPrint' ? 'muted' : 'ink';
    default:
      return 'ink';
  }
}

// --- Colour contrast (WCAG 2.x relative luminance). ---

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m) throw new Error('hexToRgb: not a #rrggbb colour');
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

function luminance([r, g, b]: [number, number, number]): number {
  const ch = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** The contrast ratio of two colours (1 to 21). */
export function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const WHITE: [number, number, number] = [1, 1, 1];
/** The light accent tint behind a line table header band. */
export function accentTint(accent: string): [number, number, number] {
  const [r, g, b] = hexToRgb(accent);
  const mix = (c: number) => Math.round((c * 0.12 + 0.88) * 1000) / 1000;
  return [mix(r), mix(g), mix(b)];
}
export const MIN_CONTRAST = 4.5;

// --- Line table columns. ---

/** The space between two table columns. */
export const COLUMN_GAP = 6;
/** The widest value each column can print, so a template cannot let an amount overflow (decision 5). */
export const WIDEST: Partial<Record<TableColumn, string>> = {
  pos: '999',
  // An editor line's quantity is at most 1,000,000 (repository/lines.ts, in thousandths); imports are never rendered.
  quantity: formatQuantity(999_999_999),
  // A unit price is 0 to 21.474.836,47 (repository/lines.ts); a line amount may be negative (a credit note).
  unitPrice: formatMoney(2147483647, 'EUR'),
  rate: formatRate(9999),
  amount: formatMoney(-2147483647, 'EUR'),
};
/** The narrowest the title column may get, in points. */
export const MIN_TITLE_WIDTH = 100;

/** The minimum width of each fixed-content column at a size, in points (header label or widest value, plus the gap). */
export function minColumnWidths(sizePt: number, measure: Measure, headers: Record<TableColumn, string>): Record<TableColumn, number> {
  const out = {} as Record<TableColumn, number>;
  for (const col of ['pos', 'title', 'quantity', 'unit', 'unitPrice', 'rate', 'amount'] as const) {
    const widest = WIDEST[col];
    const header = measure(headers[col], secondarySize(sizePt), true);
    const value = widest ? measure(widest, sizePt, false) : 0;
    out[col] = r2(Math.max(header, value) + COLUMN_GAP);
  }
  out.title = MIN_TITLE_WIDTH;
  return out;
}

/** A column's width in points from its 100-unit grid width. */
export const gridWidth = (units: number, contentWidth: number): number => r2((units / 100) * contentWidth);
