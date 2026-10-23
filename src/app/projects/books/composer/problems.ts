// src/app/projects/books/composer/problems.ts
//
// The save gate's problems in words a person can act on (visual template
// composer plan, decision 8; phase 2 decision 5: the API answers stable codes
// with English messages and the block, region, field and probe concerned, and
// the composer words them). The composer is English like the rest of the
// editor (phase 1 decision 1); the documents themselves stay German.
//
// A problem that names a block is shown with a "Show" action that selects it,
// so every message leads to the place to fix it.

import type { TemplateProblemView } from '@/lib/books/api';

import { BLOCK_INFO, COLUMN_LABELS, META_LABELS, REGION_LABELS, SENDER_COLUMN_LABELS, type BlockType, type RegionName } from './doc';

const PROBE_LABELS: Record<string, string> = {
  smallBusiness: 'a small-business invoice',
  regular: 'an invoice with two tax rates',
  reverseCharge: 'a reverse-charge invoice',
  creditNote: 'a credit note',
  longInvoice: 'a 40-line invoice over three pages',
  longRecipient: 'an invoice to a long foreign address',
  longDescription: 'a line with a very long description',
};

const LAYOUT_ISSUES: Record<string, string> = {
  HEADER_TOO_TALL: 'The letterhead is taller than the space above the address field.',
  FOOTER_TOO_TALL: 'The footer and the page 2 header leave too little room for the content.',
  BLOCK_TOO_TALL: 'A block is taller than a page.',
  BLOCK_TOO_WIDE: 'A block is wider than its place.',
  TABLE_TOO_NARROW: 'The line table’s columns do not fit the page width.',
  ADDRESS_FIELD_OVERFLOW: 'The address starts below the window of a window envelope. Make the return line smaller or shorter.',
  ADDRESS_ZONE_TOO_TALL: 'The address field and what stands beside it run into the footer.',
  PAGE_LIMIT: 'The document would run past the page limit.',
};

function blockName(type: string | undefined): string {
  return type && type in BLOCK_INFO ? BLOCK_INFO[type as BlockType].label : 'block';
}

function regionName(region: string | undefined): string {
  return region && region in REGION_LABELS ? REGION_LABELS[region as RegionName].toLowerCase() : 'template';
}

/** One problem as a sentence. */
export function problemText(p: TemplateProblemView): string {
  const f = p.field;
  switch (p.code) {
    case 'REQUIRED_BLOCK_MISSING':
      return `The ${blockName(f).toLowerCase()} is required on every document. Add it again from the blocks list${p.region ? ` (in the ${regionName(p.region)})` : ''}.`;
    case 'BLOCK_DUPLICATED':
      return `The template may hold only one ${blockName(f).toLowerCase()}${p.region ? ` in the ${regionName(p.region)}` : ''}. Remove the extra one.`;
    case 'BLOCK_NOT_ALLOWED_HERE':
      return `This block cannot stand in the ${regionName(p.region)}. Move it to another region.`;
    case 'DUPLICATE_BLOCK_ID':
      return 'Two blocks share an id. Remove one of them and add it again.';
    case 'LEGAL_ITEM_MISSING':
      return `The document data must show the ${f && f in META_LABELS ? META_LABELS[f as keyof typeof META_LABELS].toLowerCase() : f}: it is required by law.`;
    case 'ITEM_DUPLICATED':
      return 'An item is listed twice. Remove the second one.';
    case 'LEGAL_COLUMN_HIDDEN':
      return `The ${f && f in COLUMN_LABELS ? COLUMN_LABELS[f as keyof typeof COLUMN_LABELS].toLowerCase() : f} column cannot be hidden: the quantity, unit, description and amount of every line are required by law.`;
    case 'COLUMN_TOO_NARROW':
      return `The ${f && f in COLUMN_LABELS ? COLUMN_LABELS[f as keyof typeof COLUMN_LABELS].toLowerCase() : f} column is too narrow for the largest amount. Widen it, or set it to Auto.`;
    case 'TITLE_COLUMN_TOO_NARROW':
      return 'The other columns leave the description column too little room. Narrow them or hide the position or unit price column.';
    case 'SENDER_COLUMN_MISSING':
      return `The sender columns must show ${f && f in SENDER_COLUMN_LABELS ? SENDER_COLUMN_LABELS[f as keyof typeof SENDER_COLUMN_LABELS].toLowerCase() : f}: the sender’s name, address and tax number are required by law, and they are printed there.`;
    case 'TOTALS_BEFORE_TABLE':
      return 'The totals must come after the line table.';
    case 'TAX_NOTE_NOT_AFTER_TOTALS':
      return 'The tax note must come directly after the totals, so the two always share a page.';
    case 'ADDRESS_ORDER':
      return 'The return line must stand above the address.';
    case 'SIZE_TOO_SMALL':
      return `This text is too small to be read reliably. ${p.message.replace(/^a \w+ block is set at/, 'It is set at')}.`;
    case 'CONTRAST_TOO_LOW':
      return f === 'headerBand'
        ? 'The table header text is too faint on the accent band. Pick a darker accent colour or switch the band off.'
        : `The ${f?.replace('theme.', '') ?? ''} colour is too light to read on white paper (at least 4.5:1 contrast is needed). Pick a darker one.`;
    case 'CELLS_TOO_WIDE':
      return 'The cells of this columns row are wider than the page together (12 units at most).';
    case 'LOGO_ASSET_MISSING':
      return 'This logo is not stored for this company. Upload it again in the logo block.';
    case 'LOGO_ASSETS_DIFFER':
      return 'The logo blocks show different images; a document prints one logo. Choose the same image in each, or remove one.';
    case 'UNDRAWABLE_TEXT':
      return `The ${f ?? 'text'} holds characters the document font cannot print. ${capitalize(p.message.split(': ').slice(1).join(': '))}`.trim();
    case 'LAYOUT_PROBLEM':
      return `${LAYOUT_ISSUES[f ?? ''] ?? 'The layout does not fit the page.'}${p.probe ? ` (Seen with ${PROBE_LABELS[p.probe] ?? p.probe}.)` : ''}`;
    case 'PROBE_INCOMPLETE':
      return `With this layout, ${PROBE_LABELS[p.probe ?? ''] ?? 'a test document'} would lack a required field (${f}). Check that no required block is hidden or squeezed out.`;
    default:
      return capitalize(p.message);
  }
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
