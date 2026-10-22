// src/server/books/template/schema.ts
//
// The template document, version 2 (visual template composer plan, decision 3):
// a Books document template as a JSON document of typed blocks in five
// regions, validated by zod. Every object is strict (an unknown key is
// refused, never carried along), every list is bounded (a client-sent document
// in the preview route cannot burn CPU with thousands of blocks), and every
// style value comes from a fixed scale, so a template stays legible, legal and
// fast to render.
//
// This file is only the SHAPE. Which blocks are required, where they may sit,
// and the size, contrast and width rules live in rules.ts (the structural
// check of the save gate); the probe render lives in gate.ts.
//
// Phase 2 scope (Build notes): the font enum holds only DejaVu Sans, the one
// family embedded today; Noto Sans and Noto Serif widen it in phase 5. A logo
// block has no asset until phase 5 and draws nothing.

import { z } from 'zod';

/** Font sizes a block may use, in points (decision 3). */
export const SIZE_SCALE = [6.5, 7, 7.5, 8, 9, 9.5, 10, 11, 12, 14, 16, 20] as const;
/** Spacing above and below a block, in points. */
export const SPACING_SCALE = [0, 2, 4, 6, 8, 12, 16, 24, 32] as const;

const fromScale = <T extends readonly number[]>(scale: T, what: string) =>
  z.number().refine((v) => (scale as readonly number[]).includes(v), { message: `${what} must be one of ${scale.join(', ')}` });

export const sizeSchema = fromScale(SIZE_SCALE, 'size');
export const spacingSchema = fromScale(SPACING_SCALE, 'spacing');

/** A theme colour a block refers to (never a free colour per block). */
export const themeColorSchema = z.enum(['ink', 'accent', 'muted']);
export type ThemeColor = z.infer<typeof themeColorSchema>;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a colour such as #1a2b3c');

/** What every block may style: size, weight, colour, alignment and spacing (all optional, defaults per block). */
export const blockStyleSchema = z
  .object({
    sizePt: sizeSchema.optional(),
    bold: z.boolean().optional(),
    color: themeColorSchema.optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    spaceAbovePt: spacingSchema.optional(),
    spaceBelowPt: spacingSchema.optional(),
  })
  .strict();
export type BlockStyle = z.infer<typeof blockStyleSchema>;

const blockId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'a block id is 1 to 40 letters, digits, dashes or underscores');
const base = { id: blockId, style: blockStyleSchema.default({}) };

/** The document data items of `documentMeta`, in the order they print. */
export const META_ITEMS = ['number', 'issueDate', 'serviceDate', 'customerNumber', 'contract', 'recipientVatId', 'dueDate'] as const;
export type MetaItem = (typeof META_ITEMS)[number];

/** The columns of the line table. */
export const TABLE_COLUMNS = ['pos', 'title', 'quantity', 'unit', 'unitPrice', 'rate', 'amount'] as const;
export type TableColumn = (typeof TABLE_COLUMNS)[number];

/** The footer columns of `senderColumns`. */
export const SENDER_COLUMNS = ['identity', 'contact', 'legal', 'bank'] as const;
export type SenderColumn = (typeof SENDER_COLUMNS)[number];

const tableColumnSchema = z
  .object({
    visible: z.boolean(),
    /** Width in a 100-unit grid of the content width; 0 is the column's computed minimum (the title column takes what is left). */
    width: z.number().int().min(0).max(100),
  })
  .strict();

export const logoBlockSchema = z
  .object({
    ...base,
    type: z.literal('logo'),
    widthMm: z.number().int().min(15).max(80),
    /** The logo asset (phase 5); null draws nothing and takes no space. */
    assetSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  })
  .strict();
export const senderLineBlockSchema = z.object({ ...base, type: z.literal('senderLine') }).strict();
export const recipientBlockSchema = z.object({ ...base, type: z.literal('recipient') }).strict();
export const documentMetaBlockSchema = z
  .object({
    ...base,
    type: z.literal('documentMeta'),
    /** The items in print order; each at most once. Legal ones are required by rules.ts. */
    items: z.array(z.enum(META_ITEMS)).min(1).max(META_ITEMS.length),
  })
  .strict();
/** In the body: the full title (and a credit note's reference); in the following-page header: "Rechnung 62, Seite 2 von 3". */
export const titleBlockSchema = z.object({ ...base, type: z.literal('title') }).strict();
export const introTextBlockSchema = z.object({ ...base, type: z.literal('introText') }).strict();
export const outroTextBlockSchema = z.object({ ...base, type: z.literal('outroText') }).strict();
export const lineTableBlockSchema = z
  .object({
    ...base,
    type: z.literal('lineTable'),
    columns: z
      .object({
        pos: tableColumnSchema,
        title: tableColumnSchema,
        quantity: tableColumnSchema,
        unit: tableColumnSchema,
        unitPrice: tableColumnSchema,
        rate: tableColumnSchema,
        amount: tableColumnSchema,
      })
      .strict(),
    /** A light tint of the accent behind the header row. */
    headerBand: z.boolean().default(false),
  })
  .strict();
export const totalsBlockSchema = z.object({ ...base, type: z.literal('totals') }).strict();
export const taxNoteBlockSchema = z.object({ ...base, type: z.literal('taxNote') }).strict();
export const paymentDetailsBlockSchema = z
  .object({
    ...base,
    type: z.literal('paymentDetails'),
    /** An optional heading above the payment lines (editable: not a legal label). */
    heading: z.string().trim().max(60).nullable().default(null),
  })
  .strict();
export const paymentQrBlockSchema = z
  .object({
    ...base,
    type: z.literal('paymentQr'),
    /** The line printed beside the code. */
    caption: z.string().trim().max(140).default('Scannen Sie den QR-Code in Ihrem Online-Banking, um schneller zu bezahlen.'),
    /** The code's edge length; below 25 mm phone cameras struggle. */
    sizeMm: z.number().int().min(25).max(40).default(30),
  })
  .strict();
export const senderColumnsBlockSchema = z
  .object({
    ...base,
    type: z.literal('senderColumns'),
    /** The columns in print order; identity and legal are required by rules.ts. */
    columns: z.array(z.enum(SENDER_COLUMNS)).min(1).max(SENDER_COLUMNS.length),
    /** Side by side in columns, or every item on one wrapping line separated by " · ". */
    layout: z.enum(['columns', 'line']).default('columns'),
  })
  .strict();
export const freeTextBlockSchema = z
  .object({
    ...base,
    type: z.literal('freeText'),
    heading: z.string().trim().max(60).nullable().default(null),
    text: z.string().trim().min(1).max(2000),
    /** Small print (the converted footer blocks of a version 1 template) prints small and muted by default. */
    variant: z.enum(['normal', 'smallPrint']).default('normal'),
  })
  .strict();
export const spacerBlockSchema = z.object({ ...base, type: z.literal('spacer'), heightPt: spacingSchema }).strict();
export const dividerBlockSchema = z
  .object({
    ...base,
    type: z.literal('divider'),
    thicknessPt: z.number().min(0.3).max(1.5),
    lineColor: themeColorSchema.default('muted'),
  })
  .strict();

/** The blocks a `columns` cell may hold: nothing that flows across pages, no legal block, no nested columns. */
export const cellBlockSchema = z.discriminatedUnion('type', [
  logoBlockSchema,
  freeTextBlockSchema,
  paymentDetailsBlockSchema,
  paymentQrBlockSchema,
  spacerBlockSchema,
  dividerBlockSchema,
]);
export type CellBlock = z.infer<typeof cellBlockSchema>;

export const columnsBlockSchema = z
  .object({
    ...base,
    type: z.literal('columns'),
    cells: z
      .array(
        z
          .object({
            /** Width in a 12-unit grid; the cells of a row add up to at most 12. */
            width: z.number().int().min(1).max(12),
            blocks: z.array(cellBlockSchema).max(6),
          })
          .strict(),
      )
      .min(2)
      .max(4),
  })
  .strict();

export const blockSchema = z.discriminatedUnion('type', [
  logoBlockSchema,
  senderLineBlockSchema,
  recipientBlockSchema,
  documentMetaBlockSchema,
  titleBlockSchema,
  introTextBlockSchema,
  outroTextBlockSchema,
  lineTableBlockSchema,
  totalsBlockSchema,
  taxNoteBlockSchema,
  paymentDetailsBlockSchema,
  paymentQrBlockSchema,
  senderColumnsBlockSchema,
  freeTextBlockSchema,
  spacerBlockSchema,
  dividerBlockSchema,
  columnsBlockSchema,
]);
export type Block = z.infer<typeof blockSchema>;
export type BlockType = Block['type'];
export type BlockOf<T extends BlockType> = Extract<Block, { type: T }>;

/** The most blocks one region may hold (a bound on the work one preview can ask for). */
export const MAX_BLOCKS_PER_REGION = 30;
/** The most characters of text a template may carry itself (free texts, headings, captions). */
export const MAX_TEMPLATE_TEXT = 20_000;
const region = z.array(blockSchema).max(MAX_BLOCKS_PER_REGION);

export const templateDocumentV2Schema = z
  .object({
    v: z.literal(2),
    locale: z.literal('de-DE'),
    page: z
      .object({
        size: z.literal('A4'),
        /** DIN 5008 form B: the address field 45 mm from the top; form A: 27 mm. */
        addressLayout: z.enum(['din5008-b', 'din5008-a']),
        marginsMm: z
          .object({
            left: z.number().min(20).max(25),
            right: z.number().min(10).max(20),
            bottom: z.number().min(10).max(25),
          })
          .strict(),
        /** Where "Seite n von m" sits under the footer. */
        pageNumber: z.enum(['right', 'center']).default('right'),
      })
      .strict(),
    theme: z
      .object({
        /** Phase 2: the one embedded family; Noto Sans and Noto Serif arrive in phase 5. */
        fontFamily: z.enum(['dejavu-sans']),
        baseSizePt: z.number().min(8).max(11).refine((v) => Number.isInteger(v * 2), 'in steps of 0.5 pt'),
        ink: hexColor,
        accent: hexColor,
        muted: hexColor,
      })
      .strict(),
    regions: z
      .object({
        firstPageHeader: region,
        addressZone: z.object({ left: region, right: region }).strict(),
        body: region,
        followingPageHeader: region,
        footer: region,
      })
      .strict(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    // A bound on the text one document carries (a preview request cannot ask for megabytes of layout).
    let chars = 0;
    for (const region of REGIONS) {
      for (const block of regionBlocksOf(doc, region)) {
        for (const b of block.type === 'columns' ? [block, ...block.cells.flatMap((c) => c.blocks)] : [block]) {
          if (b.type === 'freeText') chars += b.text.length + (b.heading?.length ?? 0);
          if (b.type === 'paymentDetails') chars += b.heading?.length ?? 0;
          if (b.type === 'paymentQr') chars += b.caption.length;
        }
      }
    }
    if (chars > MAX_TEMPLATE_TEXT) {
      ctx.addIssue({ code: 'custom', path: ['regions'], message: `the template holds ${chars} characters of text, at most ${MAX_TEMPLATE_TEXT}` });
    }
  });
export type TemplateDocumentV2 = z.infer<typeof templateDocumentV2Schema>;
export type TemplateDocumentV2Input = z.input<typeof templateDocumentV2Schema>;

/** The region names, as paths in messages. */
export const REGIONS = ['firstPageHeader', 'addressZone.left', 'addressZone.right', 'body', 'followingPageHeader', 'footer'] as const;
export type RegionName = (typeof REGIONS)[number];

/** The blocks of one region of a document. */
export function regionBlocks(doc: TemplateDocumentV2, region: RegionName): Block[] {
  return regionBlocksOf(doc, region);
}

function regionBlocksOf(doc: { regions: TemplateDocumentV2['regions'] }, region: RegionName): Block[] {
  switch (region) {
    case 'addressZone.left':
      return doc.regions.addressZone.left;
    case 'addressZone.right':
      return doc.regions.addressZone.right;
    default:
      return doc.regions[region];
  }
}

/** Every block of a document with its region, columns cells included (a cell's blocks report the row's region). */
export function allBlocks(doc: TemplateDocumentV2): Array<{ region: RegionName; block: Block | CellBlock; inColumns: boolean }> {
  const out: Array<{ region: RegionName; block: Block | CellBlock; inColumns: boolean }> = [];
  for (const region of REGIONS) {
    for (const block of regionBlocks(doc, region)) {
      out.push({ region, block, inColumns: false });
      if (block.type === 'columns') for (const cell of block.cells) for (const b of cell.blocks) out.push({ region, block: b, inColumns: true });
    }
  }
  return out;
}

/** Parse a template document (throws a ZodError naming the paths). */
export function parseTemplateDocument(value: unknown): TemplateDocumentV2 {
  return templateDocumentV2Schema.parse(value);
}
