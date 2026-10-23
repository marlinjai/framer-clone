// src/server/books/template/rules.ts
//
// The structural check of the save gate (visual template composer plan,
// decisions 3, 5, 7 and 8): every required block present once in an allowed
// region, every legal document item and table column visible, the size,
// contrast and width rules. Fast and pure (text widths come in through a
// `Measure`), so the composer can run it live in phase 4; the server runs it
// on every save before the probe render (gate.ts).
//
// A problem is a stable code with an English message and the block, region
// and field it concerns; the interface words it for the user.

import {
  accentTint,
  blockSize,
  contrast,
  geometry,
  gridWidth,
  hexToRgb,
  LEGAL_BLOCKS,
  MIN_CONTRAST,
  MIN_FOOTER_SIZE,
  MIN_LEGAL_SIZE,
  MIN_TITLE_WIDTH,
  minColumnWidths,
  r2,
  WHITE,
  type Measure,
} from '../render/engine/style';
import { label } from './labels';
import {
  allBlocks,
  regionBlocks,
  type Block,
  type BlockType,
  type CellBlock,
  type MetaItem,
  type RegionName,
  type TableColumn,
  type TemplateDocumentV2,
} from './schema';

export type ProblemCode =
  | 'DUPLICATE_BLOCK_ID'
  | 'BLOCK_NOT_ALLOWED_HERE'
  | 'REQUIRED_BLOCK_MISSING'
  | 'BLOCK_DUPLICATED'
  | 'LEGAL_ITEM_MISSING'
  | 'ITEM_DUPLICATED'
  | 'LEGAL_COLUMN_HIDDEN'
  | 'COLUMN_TOO_NARROW'
  | 'TITLE_COLUMN_TOO_NARROW'
  | 'SENDER_COLUMN_MISSING'
  | 'TOTALS_BEFORE_TABLE'
  | 'TAX_NOTE_NOT_AFTER_TOTALS'
  | 'ADDRESS_ORDER'
  | 'SIZE_TOO_SMALL'
  | 'CONTRAST_TOO_LOW'
  | 'CELLS_TOO_WIDE'
  | 'LOGO_ASSETS_DIFFER'
  // The gate (gate.ts) adds these: the company's assets, the font coverage and the probe render.
  | 'LOGO_ASSET_MISSING'
  | 'UNDRAWABLE_TEXT'
  | 'LAYOUT_PROBLEM'
  | 'PROBE_INCOMPLETE';

export interface TemplateProblem {
  code: ProblemCode;
  message: string;
  region?: RegionName;
  blockId?: string;
  /** The item, column, colour or field concerned. */
  field?: string;
  /** The probe document that showed it (probe render only). */
  probe?: string;
}

/** Where each block type may stand (decision 3). Blocks in a `columns` cell count as their row's region. */
export const ALLOWED_REGIONS: Record<BlockType, readonly RegionName[]> = {
  logo: ['firstPageHeader', 'addressZone.right', 'followingPageHeader', 'footer'],
  senderLine: ['addressZone.left', 'firstPageHeader'],
  recipient: ['addressZone.left'],
  documentMeta: ['addressZone.right', 'body'],
  title: ['body', 'followingPageHeader'],
  introText: ['body'],
  outroText: ['body'],
  lineTable: ['body'],
  totals: ['body'],
  taxNote: ['body'],
  paymentDetails: ['body'],
  paymentQr: ['body'],
  senderColumns: ['footer'],
  freeText: ['firstPageHeader', 'addressZone.right', 'body', 'followingPageHeader', 'footer'],
  // The address field holds only the return line and the address (DIN 5008), so nothing can push the address out of the window.
  spacer: ['firstPageHeader', 'addressZone.right', 'body', 'followingPageHeader', 'footer'],
  divider: ['firstPageHeader', 'addressZone.right', 'body', 'followingPageHeader', 'footer'],
  columns: ['firstPageHeader', 'body', 'followingPageHeader', 'footer'],
};

/** Required exactly once, and where (decision 3). */
export const REQUIRED: ReadonlyArray<{ type: BlockType; region: RegionName | null }> = [
  { type: 'recipient', region: 'addressZone.left' },
  { type: 'documentMeta', region: null },
  { type: 'title', region: 'body' },
  { type: 'lineTable', region: null },
  { type: 'totals', region: null },
  { type: 'taxNote', region: null },
  { type: 'senderColumns', region: 'footer' },
];

/** At most once per document (every block bound to document data). */
export const SINGLETONS: ReadonlySet<BlockType> = new Set<BlockType>([
  'senderLine',
  'recipient',
  'documentMeta',
  'introText',
  'outroText',
  'lineTable',
  'totals',
  'taxNote',
  'paymentDetails',
  'paymentQr',
  'senderColumns',
]);

/** The document data items that cannot be hidden: number, dates, and the recipient's VAT id under reverse charge. */
export const LEGAL_META_ITEMS: readonly MetaItem[] = ['number', 'issueDate', 'serviceDate', 'recipientVatId'];
/** The table columns that cannot be hidden: the quantity and kind of each service, and its amount. */
export const LEGAL_COLUMNS: readonly TableColumn[] = ['title', 'quantity', 'unit', 'amount'];

/** The table header labels (the amount column's longer gross label is the wider one). */
export function tableHeaders(): Record<TableColumn, string> {
  return {
    pos: label('table.pos'),
    title: label('table.title'),
    quantity: label('table.quantity'),
    unit: label('table.unit'),
    unitPrice: label('table.unitPrice'),
    rate: label('table.rate'),
    amount: label('table.amountGross'),
  };
}

/** The structural problems of a template document (empty when it may be saved, pending the probe render). */
export function structuralProblems(doc: TemplateDocumentV2, measure: Measure): TemplateProblem[] {
  const out: TemplateProblem[] = [];
  const entries = allBlocks(doc);

  // Ids are unique across the document (the layout map and the composer address blocks by id).
  const seen = new Set<string>();
  for (const { block, region } of entries) {
    if (seen.has(block.id)) out.push({ code: 'DUPLICATE_BLOCK_ID', message: `the block id "${block.id}" is used more than once`, blockId: block.id, region });
    seen.add(block.id);
  }

  // Regions.
  for (const { block, region, inColumns } of entries) {
    if (!ALLOWED_REGIONS[block.type].includes(region)) {
      out.push({
        code: 'BLOCK_NOT_ALLOWED_HERE',
        message: `a ${block.type} block cannot stand in ${region}${inColumns ? ' (inside columns)' : ''}`,
        blockId: block.id,
        region,
      });
    }
  }

  // Required and single blocks.
  const count = new Map<BlockType, number>();
  for (const { block } of entries) count.set(block.type, (count.get(block.type) ?? 0) + 1);
  for (const req of REQUIRED) {
    const inRegion = req.region
      ? entries.filter((e) => e.block.type === req.type && e.region === req.region).length
      : (count.get(req.type) ?? 0);
    if (inRegion === 0) {
      out.push({
        code: 'REQUIRED_BLOCK_MISSING',
        message: `the template needs a ${req.type} block${req.region ? ` in ${req.region}` : ''}`,
        field: req.type,
        region: req.region ?? undefined,
      });
    }
  }
  for (const type of SINGLETONS) {
    if ((count.get(type) ?? 0) > 1) out.push({ code: 'BLOCK_DUPLICATED', message: `the template may hold one ${type} block`, field: type });
  }
  const titles = (region: RegionName) => regionBlocks(doc, region).filter((b) => b.type === 'title').length;
  if (titles('body') > 1) out.push({ code: 'BLOCK_DUPLICATED', message: 'the body may hold one title block', field: 'title', region: 'body' });
  if (titles('followingPageHeader') > 1) {
    out.push({ code: 'BLOCK_DUPLICATED', message: 'the following-page header may hold one title block', field: 'title', region: 'followingPageHeader' });
  }

  for (const { block, region } of entries) {
    if (block.type === 'documentMeta') {
      const items = new Set<MetaItem>();
      for (const item of block.items) {
        if (items.has(item)) out.push({ code: 'ITEM_DUPLICATED', message: `the document data list names ${item} twice`, blockId: block.id, region, field: item });
        items.add(item);
      }
      for (const item of LEGAL_META_ITEMS) {
        if (!items.has(item)) {
          out.push({ code: 'LEGAL_ITEM_MISSING', message: `the document data must show ${item}`, blockId: block.id, region, field: item });
        }
      }
    }
    if (block.type === 'senderColumns') {
      for (const col of ['identity', 'legal'] as const) {
        if (!block.columns.includes(col)) {
          out.push({
            code: 'SENDER_COLUMN_MISSING',
            message: `the sender footer must show the ${col} column (the sender's ${col === 'identity' ? 'name and address' : 'tax number and VAT id'})`,
            blockId: block.id,
            region,
            field: col,
          });
        }
      }
      if (new Set(block.columns).size !== block.columns.length) {
        out.push({ code: 'ITEM_DUPLICATED', message: 'the sender footer names a column twice', blockId: block.id, region });
      }
    }
    if (block.type === 'lineTable') out.push(...tableProblems(block, region, doc, measure));
    if (block.type === 'columns') {
      const sum = block.cells.reduce((s, c) => s + c.width, 0);
      if (sum > 12) out.push({ code: 'CELLS_TOO_WIDE', message: `the cells of a columns row add up to ${sum} of 12`, blockId: block.id, region });
    }
    out.push(...sizeProblems(block, region, doc));
  }

  // The line table comes before the totals.
  const body = doc.regions.body;
  const tableAt = body.findIndex((b) => b.type === 'lineTable');
  const totalsAt = body.findIndex((b) => b.type === 'totals');
  if (tableAt >= 0 && totalsAt >= 0 && totalsAt < tableAt) {
    out.push({ code: 'TOTALS_BEFORE_TABLE', message: 'the totals must follow the line table', blockId: body[totalsAt].id, region: 'body' });
  }
  // The tax note stands directly after the totals, so the two always share a page (decision 5).
  const noteAt = body.findIndex((b) => b.type === 'taxNote');
  if (totalsAt >= 0 && noteAt >= 0 && noteAt !== totalsAt + 1) {
    out.push({ code: 'TAX_NOTE_NOT_AFTER_TOTALS', message: 'the tax note must come directly after the totals', blockId: body[noteAt].id, region: 'body' });
  }
  // One template, one logo (decision 15): every logo block names the same asset, which the issue snapshot freezes.
  const firstLogo = entries.find((e) => e.block.type === 'logo' && e.block.assetSha256 !== null);
  if (firstLogo && firstLogo.block.type === 'logo') {
    for (const { block, region } of entries) {
      if (block.type === 'logo' && block.assetSha256 !== null && block.assetSha256 !== firstLogo.block.assetSha256) {
        out.push({
          code: 'LOGO_ASSETS_DIFFER',
          message: `the logo blocks name different images; a template has one logo (the one of block "${firstLogo.block.id}")`,
          blockId: block.id,
          region,
          field: 'assetSha256',
        });
      }
    }
  }

  // The return line sits above the address in the window, never below it.
  const left = doc.regions.addressZone.left;
  const senderAt = left.findIndex((b) => b.type === 'senderLine');
  const recipientAt = left.findIndex((b) => b.type === 'recipient');
  if (senderAt >= 0 && recipientAt >= 0 && senderAt > recipientAt) {
    out.push({ code: 'ADDRESS_ORDER', message: 'the return line must stand above the address', blockId: left[senderAt].id, region: 'addressZone.left' });
  }

  out.push(...contrastProblems(doc));
  return out;
}

function sizeProblems(block: Block | CellBlock, region: RegionName, doc: TemplateDocumentV2): TemplateProblem[] {
  const size = blockSize(block, doc);
  const min = block.type === 'senderColumns' ? MIN_FOOTER_SIZE : LEGAL_BLOCKS.has(block.type) ? MIN_LEGAL_SIZE : null;
  if (min !== null && size < min) {
    return [{ code: 'SIZE_TOO_SMALL', message: `a ${block.type} block is set at ${size} pt, the minimum is ${min} pt`, blockId: block.id, region, field: 'sizePt' }];
  }
  return [];
}

function tableProblems(block: Extract<Block, { type: 'lineTable' }>, region: RegionName, doc: TemplateDocumentV2, measure: Measure): TemplateProblem[] {
  const out: TemplateProblem[] = [];
  for (const col of LEGAL_COLUMNS) {
    if (!block.columns[col].visible) {
      out.push({ code: 'LEGAL_COLUMN_HIDDEN', message: `the ${col} column of the line table cannot be hidden`, blockId: block.id, region, field: col });
    }
  }
  const size = blockSize(block, doc);
  const contentWidth = geometry(doc).contentWidth;
  const mins = minColumnWidths(size, measure, tableHeaders());
  // The worst case: the rate column counted even when hidden (it shows on a document with two rates).
  let fixed = 0;
  for (const col of ['pos', 'quantity', 'unit', 'unitPrice', 'rate', 'amount'] as const) {
    const optional = col === 'pos' || col === 'unitPrice';
    if (optional && !block.columns[col].visible) continue;
    const units = block.columns[col].width;
    const width = gridWidth(units, contentWidth);
    if (units > 0 && width < mins[col]) {
      const need = Math.ceil((mins[col] / contentWidth) * 100);
      out.push({
        code: 'COLUMN_TOO_NARROW',
        message: `the ${col} column needs at least ${need} of 100 units (or 0 for its minimum) to print the widest value`,
        blockId: block.id,
        region,
        field: col,
      });
    }
    fixed += Math.max(width, mins[col]);
  }
  if (r2(contentWidth - fixed) < MIN_TITLE_WIDTH) {
    out.push({
      code: 'TITLE_COLUMN_TOO_NARROW',
      message: `the other columns leave the description column ${Math.max(0, Math.floor(contentWidth - fixed))} pt, the minimum is ${MIN_TITLE_WIDTH} pt`,
      blockId: block.id,
      region,
      field: 'title',
    });
  }
  return out;
}

function contrastProblems(doc: TemplateDocumentV2): TemplateProblem[] {
  const out: TemplateProblem[] = [];
  for (const name of ['ink', 'accent', 'muted'] as const) {
    const ratio = contrast(hexToRgb(doc.theme[name]), WHITE);
    if (ratio < MIN_CONTRAST) {
      out.push({
        code: 'CONTRAST_TOO_LOW',
        message: `the ${name} colour has a contrast of ${ratio.toFixed(2)}:1 on white, at least ${MIN_CONTRAST}:1 is needed`,
        field: `theme.${name}`,
      });
    }
  }
  const banded = allBlocks(doc).filter((e) => e.block.type === 'lineTable' && e.block.headerBand);
  if (banded.length > 0) {
    const ratio = contrast(hexToRgb(doc.theme.ink), accentTint(doc.theme.accent));
    if (ratio < MIN_CONTRAST) {
      out.push({
        code: 'CONTRAST_TOO_LOW',
        message: `the table header text has a contrast of ${ratio.toFixed(2)}:1 on the accent band, at least ${MIN_CONTRAST}:1 is needed`,
        blockId: banded[0].block.id,
        region: 'body',
        field: 'headerBand',
      });
    }
  }
  return out;
}

/** Every text the template itself prints (free texts, headings, captions), for the drawable check. */
export function templateTexts(doc: TemplateDocumentV2): Array<{ blockId: string; field: string; text: string }> {
  const out: Array<{ blockId: string; field: string; text: string }> = [];
  for (const { block } of allBlocks(doc)) {
    if (block.type === 'freeText') {
      if (block.heading) out.push({ blockId: block.id, field: 'heading', text: block.heading });
      out.push({ blockId: block.id, field: 'text', text: block.text });
    }
    if (block.type === 'paymentDetails' && block.heading) out.push({ blockId: block.id, field: 'heading', text: block.heading });
    if (block.type === 'paymentQr' && block.caption) out.push({ blockId: block.id, field: 'caption', text: block.caption });
  }
  return out;
}
