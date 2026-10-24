// src/server/books/template/presets.ts
//
// The three built-in starting points of a template (visual template composer
// plan, decision 3), neutral by the owner's decision of 2026-10-22 (no logo,
// no brand colour; a company adds its own):
//
//   klassisch  today's layout expressed as blocks: sender line and recipient in
//              the address window, the document data on the right, title,
//              intro, line table, totals, tax note, payment, outro, small
//              print, and the sender footer in four columns;
//   modern     a logo place top right, the table header on a light accent band,
//              the title in the accent colour;
//   kompakt    smaller type and a one-line footer, for documents that should
//              stay on one page.
//
// A preset is a pure function returning a fresh document (never shared, the
// caller may edit it). A document without a template is rendered with
// `klassisch()`. Migration 012 does NOT import this file: it carries its own
// frozen copy of the conversion, so a later preset edit cannot change what a
// deployed migration does.

import type { Block, TemplateDocumentV2 } from './schema';

export const PRESETS = ['klassisch', 'modern', 'kompakt'] as const;
export type PresetName = (typeof PRESETS)[number];

/** The small print of a version 1 template, carried into a preset (converted footer blocks). */
export interface SmallPrintInput {
  heading: string | null;
  text: string;
}

export interface PresetOptions {
  /** The accent colour (a version 1 template's accent, or the preset's own). */
  accent?: string;
  /** Small print blocks, printed at the end of the body. */
  smallPrint?: SmallPrintInput[];
}

/**
 * The line table of a preset: widths in a 100-unit grid of the content width;
 * 0 means the column's computed minimum (the widest value it can print), and
 * the title takes the rest.
 */
function lineTable(opts: { headerBand: boolean; sizePt?: Block['style']['sizePt'] }): Block {
  return {
    id: 'lineTable',
    type: 'lineTable',
    style: opts.sizePt ? { sizePt: opts.sizePt } : {},
    headerBand: opts.headerBand,
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
}

function smallPrintBlocks(items: SmallPrintInput[] = []): Block[] {
  return items.map((b, i) => ({
    id: `smallPrint${i + 1}`,
    type: 'freeText',
    style: {},
    heading: b.heading,
    text: b.text,
    variant: 'smallPrint',
  }));
}

const META: Extract<Block, { type: 'documentMeta' }>['items'] = ['number', 'issueDate', 'serviceDate', 'customerNumber', 'contract', 'recipientVatId'];

/** Today's layout as blocks. */
export function klassisch(opts: PresetOptions = {}): TemplateDocumentV2 {
  return {
    v: 2,
    locale: 'de-DE',
    page: { size: 'A4', addressLayout: 'din5008-b', marginsMm: { left: 20, right: 20, bottom: 10 }, pageNumber: 'right' },
    theme: { fontFamily: 'dejavu-sans', baseSizePt: 9.5, ink: '#1a1a1f', accent: opts.accent ?? '#333340', muted: '#61616b' },
    regions: {
      firstPageHeader: [],
      addressZone: {
        left: [
          { id: 'senderLine', type: 'senderLine', style: { sizePt: 7, color: 'muted', spaceBelowPt: 8 } },
          { id: 'recipient', type: 'recipient', style: {} },
        ],
        right: [{ id: 'documentMeta', type: 'documentMeta', style: { sizePt: 8 }, items: [...META] }],
      },
      body: [
        { id: 'title', type: 'title', style: { sizePt: 14, bold: true, color: 'accent', spaceAbovePt: 24, spaceBelowPt: 8 } },
        { id: 'subject', type: 'subject', style: { bold: true, spaceBelowPt: 6 } },
        { id: 'introText', type: 'introText', style: { spaceBelowPt: 8 } },
        lineTable({ headerBand: false }),
        { id: 'totals', type: 'totals', style: { spaceAbovePt: 4, spaceBelowPt: 8 } },
        { id: 'taxNote', type: 'taxNote', style: { bold: true, spaceBelowPt: 8 } },
        { id: 'paymentDetails', type: 'paymentDetails', style: { spaceBelowPt: 8 }, heading: null },
        { id: 'outroText', type: 'outroText', style: { spaceBelowPt: 8 } },
        ...smallPrintBlocks(opts.smallPrint),
      ],
      followingPageHeader: [
        { id: 'continuation', type: 'title', style: { sizePt: 9, bold: false, color: 'muted', spaceBelowPt: 12 } },
      ],
      footer: [
        { id: 'footerRule', type: 'divider', style: { spaceBelowPt: 4 }, thicknessPt: 0.4, lineColor: 'muted' },
        {
          id: 'senderColumns',
          type: 'senderColumns',
          style: { sizePt: 6.5, color: 'muted' },
          columns: ['identity', 'contact', 'legal', 'bank'],
          layout: 'columns',
        },
      ],
    },
  };
}

/** A logo place top right, the table header on an accent band, the title in the accent colour. */
export function modern(opts: PresetOptions = {}): TemplateDocumentV2 {
  const doc = klassisch({ ...opts, accent: opts.accent ?? '#2f5d8a' });
  doc.regions.firstPageHeader = [
    { id: 'logo', type: 'logo', style: { align: 'right' }, widthMm: 40, assetSha256: null },
  ];
  doc.regions.body = doc.regions.body.map((b) => (b.type === 'lineTable' ? lineTable({ headerBand: true }) : b));
  doc.regions.footer = doc.regions.footer.map((b) => (b.type === 'divider' ? { ...b, thicknessPt: 0.5, lineColor: 'accent' as const } : b));
  return doc;
}

/** Smaller type and a one-line footer. */
export function kompakt(opts: PresetOptions = {}): TemplateDocumentV2 {
  const doc = klassisch(opts);
  doc.theme.baseSizePt = 8.5;
  doc.regions.body = doc.regions.body.map((b) => {
    if (b.type === 'title') return { ...b, style: { ...b.style, sizePt: 12, spaceAbovePt: 16, spaceBelowPt: 6 } };
    if (b.type === 'lineTable') return lineTable({ headerBand: false, sizePt: 8 });
    return b;
  });
  doc.regions.footer = [
    { id: 'footerRule', type: 'divider', style: { spaceBelowPt: 4 }, thicknessPt: 0.4, lineColor: 'muted' },
    {
      id: 'senderColumns',
      type: 'senderColumns',
      style: { sizePt: 6.5, color: 'muted' },
      columns: ['identity', 'legal', 'bank', 'contact'],
      layout: 'line',
    },
  ];
  return doc;
}

/** A preset by name. */
export function preset(name: PresetName, opts: PresetOptions = {}): TemplateDocumentV2 {
  return name === 'modern' ? modern(opts) : name === 'kompakt' ? kompakt(opts) : klassisch(opts);
}
