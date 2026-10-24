// src/app/projects/books/composer/doc.ts
//
// The template composer's document operations (visual template composer plan,
// decision 11): finding, adding, moving and removing blocks of a template
// document (model version 2, src/server/books/template/schema.ts). Pure
// functions over the plain JSON document; the mutating ones take an Immer
// draft, so every change goes through the one undo history
// (`useUndoableState`).
//
// Where a block may stand, which blocks are required and which may occur only
// once (per document, or the title once per region) come from the save gate's
// own rules (template/rules.ts), so the composer never adds or moves a block
// where the gate would refuse it, never moves the required instance out of its
// required region, and never removes a required block. The gate's ORDER rules
// (totals after the line table, the tax note right after the totals, the
// return line above the address) are deliberately not enforced on a move:
// reordering often passes through such a state (move the table, then the
// totals), so a broken order shows live in the problems list next to the
// block, and the gate refuses it on save.

import { ALLOWED_REGIONS, REQUIRED, SINGLETONS } from '@/server/books/template/rules';
import {
  META_ITEMS,
  REGIONS,
  SENDER_COLUMNS,
  templateLogo,
  type Block,
  type BlockType,
  type CellBlock,
  type MetaItem,
  type RegionName,
  type SenderColumn,
  type TableColumn,
  type TemplateDocumentV2,
} from '@/server/books/template/schema';

export { REGIONS };
export type { Block, BlockType, CellBlock, MetaItem, RegionName, SenderColumn, TableColumn, TemplateDocumentV2 };

/** What the composer calls each region (the editor is English; the documents stay German). */
export const REGION_LABELS: Record<RegionName, string> = {
  firstPageHeader: 'Letterhead (first page)',
  'addressZone.left': 'Address field',
  'addressZone.right': 'Beside the address',
  body: 'Body',
  followingPageHeader: 'Header (page 2 and later)',
  footer: 'Footer (every page)',
};

/** Each block type's name and a one-line description for the palette and the inspector. */
export const BLOCK_INFO: Record<BlockType, { label: string; description: string }> = {
  logo: { label: 'Logo', description: 'The company logo.' },
  senderLine: { label: 'Return line', description: 'The small sender line above the address, read through the envelope window.' },
  recipient: { label: 'Recipient', description: 'The customer’s address, in the DIN 5008 window position.' },
  documentMeta: { label: 'Document data', description: 'Number, dates, customer number and the other document data.' },
  title: { label: 'Title', description: '“Rechnung” or “Gutschrift”; on later pages the continuation line.' },
  subject: { label: 'Subject', description: 'The document’s subject line (“Betreff”), written on each invoice.' },
  introText: { label: 'Intro text', description: 'The document’s opening text.' },
  outroText: { label: 'Closing text', description: 'The document’s closing text.' },
  lineTable: { label: 'Line table', description: 'The lines with quantity, unit, price, tax rate and amount.' },
  totals: { label: 'Totals', description: 'Net, tax per rate and the total.' },
  taxNote: { label: 'Tax note', description: 'The small-business or reverse-charge note, when the document has one.' },
  paymentDetails: { label: 'Payment details', description: 'Due date, payment reference and bank.' },
  paymentQr: { label: 'Payment QR code', description: 'An EPC QR code (GiroCode) for banking apps, on issued invoices.' },
  senderColumns: { label: 'Sender columns', description: 'The sender’s identity, contact, tax numbers and bank.' },
  freeText: { label: 'Text', description: 'A text of your own, with an optional heading.' },
  spacer: { label: 'Space', description: 'Empty space.' },
  divider: { label: 'Line', description: 'A horizontal rule.' },
  columns: { label: 'Columns', description: 'Two to four cells side by side (logo, text, payment details, QR code).' },
};

/** The line table's columns as the inspector names them. */
export const COLUMN_LABELS: Record<TableColumn, string> = {
  pos: 'Position',
  title: 'Description',
  quantity: 'Quantity',
  unit: 'Unit',
  unitPrice: 'Unit price',
  rate: 'Tax rate',
  amount: 'Amount',
};

/** The document data items of `documentMeta`. */
export const META_LABELS: Record<MetaItem, string> = {
  number: 'Number',
  issueDate: 'Issue date',
  serviceDate: 'Service date or period',
  customerNumber: 'Customer number',
  contract: 'Contract reference',
  recipientVatId: 'Recipient’s VAT id (reverse charge)',
  dueDate: 'Due date',
};

/** The footer columns of `senderColumns`. */
export const SENDER_COLUMN_LABELS: Record<SenderColumn, string> = {
  identity: 'Name and address',
  contact: 'Contact',
  legal: 'Tax numbers and register',
  bank: 'Bank',
};

/** The order the palette lists block types in. */
export const PALETTE_ORDER: readonly BlockType[] = [
  'freeText',
  'logo',
  'divider',
  'spacer',
  'columns',
  'paymentDetails',
  'paymentQr',
  'subject',
  'introText',
  'outroText',
  'senderLine',
  'title',
  'documentMeta',
  'recipient',
  'lineTable',
  'totals',
  'taxNote',
  'senderColumns',
];

/** The block types a `columns` cell may hold (schema.ts `cellBlockSchema`). */
export const CELL_TYPES: readonly CellBlock['type'][] = ['logo', 'freeText', 'paymentDetails', 'paymentQr', 'spacer', 'divider'];

const REQUIRED_TYPES = new Set(REQUIRED.map((r) => r.type));

/**
 * True for a block the gate requires: it moves and restyles, but cannot be
 * removed. Without a region: whether the type is required anywhere (the
 * palette's lock badge). With one: whether this block, standing there, is the
 * required one (a title is required in the body, not the page 2 header's).
 */
export function isRequired(type: BlockType, region?: RegionName): boolean {
  if (region === undefined) return REQUIRED_TYPES.has(type);
  return REQUIRED.some((r) => r.type === type && (r.region === null || r.region === region));
}

/** Why a required block has no delete action (the outline's tooltip and the inspector's note). */
export function requiredReason(type: BlockType): string {
  if (type === 'senderColumns') return 'Required: the sender’s tax number is printed here, so the sender columns stay in the footer.';
  if (type === 'recipient') return 'Required: the recipient stays in the address field so a window envelope shows it.';
  if (type === 'taxNote') return 'Required: printed whenever the document has a small-business or reverse-charge note. It can move and change style, not be removed.';
  return `Required by law on every invoice: the ${BLOCK_INFO[type].label.toLowerCase()} can move and change style, not be removed.`;
}

/** The blocks of one region (the live array, so an Immer draft can be changed through it). */
export function regionList<D extends { regions: TemplateDocumentV2['regions'] }>(doc: D, region: RegionName): Block[] {
  if (region === 'addressZone.left') return doc.regions.addressZone.left;
  if (region === 'addressZone.right') return doc.regions.addressZone.right;
  return doc.regions[region];
}

export interface BlockLocation {
  region: RegionName;
  /** Index in the region. */
  index: number;
  block: Block;
  /** Set when the block sits in a `columns` cell: the row, the cell and the index in the cell. */
  cell?: { rowId: string; cellIndex: number; index: number; block: CellBlock };
}

/** Where a block is (top level or inside a `columns` cell), or null. */
export function locate(doc: TemplateDocumentV2, blockId: string): BlockLocation | null {
  for (const region of REGIONS) {
    const list = regionList(doc, region);
    for (let index = 0; index < list.length; index++) {
      const block = list[index];
      if (block.id === blockId) return { region, index, block };
      if (block.type === 'columns') {
        for (let c = 0; c < block.cells.length; c++) {
          const i = block.cells[c].blocks.findIndex((b) => b.id === blockId);
          if (i >= 0) return { region, index, block, cell: { rowId: block.id, cellIndex: c, index: i, block: block.cells[c].blocks[i] } };
        }
      }
    }
  }
  return null;
}

/** Every block id in the document, cells included. */
export function blockIds(doc: TemplateDocumentV2): Set<string> {
  const ids = new Set<string>();
  for (const region of REGIONS) {
    for (const block of regionList(doc, region)) {
      ids.add(block.id);
      if (block.type === 'columns') for (const cell of block.cells) for (const b of cell.blocks) ids.add(b.id);
    }
  }
  return ids;
}

/** True when the document holds a block of this type anywhere (cells included). */
export function hasType(doc: TemplateDocumentV2, type: BlockType): boolean {
  return REGIONS.some((region) =>
    regionList(doc, region).some((b) => b.type === type || (b.type === 'columns' && b.cells.some((c) => c.blocks.some((x) => x.type === type)))),
  );
}

/** Every logo block of the document, cells included. */
export function logoBlockIds(doc: TemplateDocumentV2): string[] {
  return [...blockIds(doc)].filter((id) => {
    const at = locate(doc, id);
    return (at?.cell?.block ?? at?.block)?.type === 'logo';
  });
}

/** A new block, a logo taking the template's image so all logo blocks print the same one. */
function newBlockFor(doc: TemplateDocumentV2, type: BlockType, id: string): Block {
  const block = newBlock(type, id);
  if (block.type === 'logo') block.assetSha256 = templateLogo(doc)?.sha256 ?? null;
  return block;
}

/** A new id for a block of this type that no block in the document has. */
export function uniqueId(doc: TemplateDocumentV2, type: BlockType): string {
  const taken = blockIds(doc);
  if (!taken.has(type)) return type;
  for (let n = 2; ; n++) if (!taken.has(`${type}${n}`)) return `${type}${n}`;
}

/** True when a block of this type may stand in the region (the gate's ALLOWED_REGIONS). */
export function allowedIn(type: BlockType, region: RegionName): boolean {
  return ALLOWED_REGIONS[type].includes(region);
}

/** True when this block, with everything in its cells, may stand in the region. */
export function blockAllowedIn(block: Block, region: RegionName): boolean {
  if (!allowedIn(block.type, region)) return false;
  return block.type !== 'columns' || block.cells.every((c) => c.blocks.every((b) => allowedIn(b.type, region)));
}

/** The gate allows one title per region: the body's and the page 2 header's. */
function regionHasTitle(doc: TemplateDocumentV2, region: RegionName, except?: string): boolean {
  return regionList(doc, region).some((b) => b.type === 'title' && b.id !== except);
}

/** Whether a block of this type can be added to the region, and if not, why. */
export function canAdd(doc: TemplateDocumentV2, type: BlockType, region: RegionName): { ok: true } | { ok: false; reason: string } {
  if (!allowedIn(type, region)) return { ok: false, reason: `Not allowed in the ${REGION_LABELS[region].toLowerCase()}.` };
  if (SINGLETONS.has(type) && hasType(doc, type)) return { ok: false, reason: 'Already in the template.' };
  if (type === 'title' && regionHasTitle(doc, region)) return { ok: false, reason: 'This region has its title already.' };
  if (regionList(doc, region).length >= 30) return { ok: false, reason: 'This region holds the most blocks it can (30).' };
  return { ok: true };
}

/** A new block of a type with the composer's defaults. */
export function newBlock(type: BlockType, id: string): Block {
  switch (type) {
    case 'logo':
      return { id, type, style: { align: 'left' }, widthMm: 40, assetSha256: null };
    case 'senderLine':
      return { id, type, style: { sizePt: 7, color: 'muted', spaceBelowPt: 8 } };
    case 'documentMeta':
      return { id, type, style: { sizePt: 8 }, items: [...META_ITEMS] };
    case 'title':
      return { id, type, style: { sizePt: 14, bold: true, color: 'accent', spaceAbovePt: 24, spaceBelowPt: 8 } };
    case 'lineTable':
      return {
        id,
        type,
        style: {},
        headerBand: false,
        columns: {
          pos: { visible: true, width: 0 },
          title: { visible: true, width: 0 },
          quantity: { visible: true, width: 0 },
          unit: { visible: true, width: 11 },
          unitPrice: { visible: true, width: 0 },
          rate: { visible: true, width: 0 },
          amount: { visible: true, width: 0 },
        },
      };
    case 'paymentDetails':
      return { id, type, style: { spaceBelowPt: 8 }, heading: null };
    case 'paymentQr':
      return {
        id,
        type,
        style: { spaceBelowPt: 8 },
        caption: 'Scannen Sie den QR-Code in Ihrem Online-Banking, um schneller zu bezahlen.',
        sizeMm: 30,
      };
    case 'senderColumns':
      return { id, type, style: { sizePt: 6.5, color: 'muted' }, columns: [...SENDER_COLUMNS], layout: 'columns' };
    case 'freeText':
      return { id, type, style: { spaceBelowPt: 8 }, heading: null, text: 'Ihr Text', variant: 'normal' };
    case 'spacer':
      return { id, type, style: {}, heightPt: 12 };
    case 'divider':
      return { id, type, style: { spaceAbovePt: 4, spaceBelowPt: 4 }, thicknessPt: 0.5, lineColor: 'muted' };
    case 'columns':
      return {
        id,
        type,
        style: { spaceBelowPt: 8 },
        cells: [
          { width: 6, blocks: [] },
          { width: 6, blocks: [] },
        ],
      };
    case 'subject':
      return { id, type, style: { bold: true, spaceBelowPt: 6 } };
    case 'recipient':
    case 'introText':
    case 'outroText':
    case 'totals':
    case 'taxNote':
      return { id, type, style: type === 'taxNote' ? { bold: true, spaceBelowPt: 8 } : { spaceBelowPt: 8 } } as Block;
  }
}

/** Add a new block of `type` to `region` at `index` (the end when omitted). Returns its id, or null when it may not go there. */
export function addBlock(draft: TemplateDocumentV2, type: BlockType, region: RegionName, index?: number): string | null {
  if (!canAdd(draft, type, region).ok) return null;
  const id = uniqueId(draft, type);
  const list = regionList(draft, region);
  list.splice(index === undefined ? list.length : Math.max(0, Math.min(index, list.length)), 0, newBlockFor(draft, type, id));
  return id;
}

/** Add a new block to a `columns` cell. Returns its id, or null. */
export function addCellBlock(draft: TemplateDocumentV2, rowId: string, cellIndex: number, type: CellBlock['type']): string | null {
  const at = locate(draft, rowId);
  if (!at || at.cell || at.block.type !== 'columns') return null;
  const cell = at.block.cells[cellIndex];
  if (!cell || cell.blocks.length >= 6) return null;
  // A cell's blocks count as standing in the row's region (rules.ts).
  if (!allowedIn(type, at.region)) return null;
  if (SINGLETONS.has(type) && hasType(draft, type)) return null;
  const id = uniqueId(draft, type);
  cell.blocks.push(newBlockFor(draft, type, id) as CellBlock);
  return id;
}

/** Remove a block (top level or in a cell). Required blocks are never removed. Returns whether it was. */
export function removeBlock(draft: TemplateDocumentV2, blockId: string): boolean {
  const at = locate(draft, blockId);
  if (!at) return false;
  if (at.cell) {
    const row = at.block;
    if (row.type !== 'columns') return false;
    row.cells[at.cell.cellIndex].blocks.splice(at.cell.index, 1);
    return true;
  }
  if (isRequired(at.block.type, at.region)) return false;
  regionList(draft, at.region).splice(at.index, 1);
  return true;
}

/** Why a top-level block may not move to `region`, or null when it may. */
export function moveRefusal(doc: TemplateDocumentV2, blockId: string, region: RegionName): string | null {
  const at = locate(doc, blockId);
  if (!at || at.cell) return 'Only blocks outside a columns row move between regions.';
  const label = BLOCK_INFO[at.block.type].label;
  if (!blockAllowedIn(at.block, region)) return `${label} cannot stand in the ${REGION_LABELS[region].toLowerCase()}.`;
  if (region === at.region) return null;
  if (isRequired(at.block.type, at.region) && !isRequired(at.block.type, region)) {
    return `${label} is required in the ${REGION_LABELS[at.region].toLowerCase()} and stays there.`;
  }
  if (at.block.type === 'title' && regionHasTitle(doc, region)) return `The ${REGION_LABELS[region].toLowerCase()} has its title already.`;
  if (regionList(doc, region).length >= 30) return `The ${REGION_LABELS[region].toLowerCase()} holds the most blocks it can (30).`;
  return null;
}

/**
 * Move a top-level block to `region` at `index` (counted after it is taken
 * out). Returns whether it moved; a refused move or one that changes nothing
 * leaves the draft untouched (so it adds no undo step and starts no preview).
 */
export function moveBlock(draft: TemplateDocumentV2, blockId: string, region: RegionName, index: number): boolean {
  if (moveRefusal(draft, blockId, region) !== null) return false;
  const at = locate(draft, blockId)!;
  const to = regionList(draft, region);
  const target = Math.max(0, Math.min(index, region === at.region ? to.length - 1 : to.length));
  if (region === at.region && target === at.index) return false;
  const [block] = regionList(draft, at.region).splice(at.index, 1);
  to.splice(target, 0, block);
  return true;
}

/**
 * Move a block one step up or down (Alt+Up, Alt+Down). Inside its region it
 * swaps with its neighbour; at the region's edge it moves to the end or start
 * of the nearest region in that direction that allows it. A block in a cell
 * moves within its cell. Returns whether it moved.
 */
export function moveByStep(draft: TemplateDocumentV2, blockId: string, delta: -1 | 1): boolean {
  const at = locate(draft, blockId);
  if (!at) return false;
  if (at.cell) {
    const row = at.block;
    if (row.type !== 'columns') return false;
    const list = row.cells[at.cell.cellIndex].blocks;
    const to = at.cell.index + delta;
    if (to < 0 || to >= list.length) return false;
    const [b] = list.splice(at.cell.index, 1);
    list.splice(to, 0, b);
    return true;
  }
  const list = regionList(draft, at.region);
  const to = at.index + delta;
  if (to >= 0 && to < list.length) return moveBlock(draft, blockId, at.region, to);
  const order = REGIONS.indexOf(at.region);
  for (let r = order + delta; r >= 0 && r < REGIONS.length; r += delta) {
    const region = REGIONS[r];
    if (moveRefusal(draft, blockId, region) === null) return moveBlock(draft, blockId, region, delta === 1 ? 0 : regionList(draft, region).length);
  }
  return false;
}
