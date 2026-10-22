// src/server/books/render/drawable.ts
//
// Which printed fields contain characters the embedded fonts cannot draw
// (fonts.ts). A document of record must print every name, address and line as
// written, so issue refuses (UNDRAWABLE_TEXT) and names the fields; nothing is
// ever transliterated or replaced on an issued document. Only the draft preview
// replaces such characters with "?" (`previewSafe`), and says so by being a draft.

import { BooksError } from '../errors';
import { templateTexts } from '../template/rules';
import type { Block, CellBlock, TemplateDocumentV2 } from '../template/schema';
import { undrawable } from './fonts';
import type { RenderInput, RenderModel } from './model';

/** Every printed text of a render input, by field name. */
function printedFields(input: RenderInput): Array<[string, string | null | undefined]> {
  const s = input.sender;
  const r = input.recipient;
  const d = input.document;
  const fields: Array<[string, string | null | undefined]> = [];
  if (s) {
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === 'string') fields.push([`sender.${k}`, v]);
    }
  }
  if (r) {
    fields.push(
      ['recipient.name', r.name],
      ['recipient.companyOrRole', r.companyOrRole],
      ['recipient.legalForm', r.legalForm],
      ['recipient.addressLine1', r.addressLine1],
      ['recipient.addressLine2', r.addressLine2],
      ['recipient.postalCode', r.postalCode],
      ['recipient.city', r.city],
      ['recipient.vatId', r.vatId],
    );
  }
  for (const l of input.lines) {
    fields.push([`line${l.position}.title`, l.title], [`line${l.position}.description`, l.description], [`line${l.position}.unitLabel`, l.unitLabel]);
  }
  fields.push(
    ['introText', d.introText],
    ['outroText', d.outroText],
    ['contractReference', d.contractReference],
    ['taxNote', d.taxNote],
  );
  (input.template?.footerBlocks ?? []).forEach((b, i) => {
    fields.push([`template.footerBlocks.${i}.heading`, b.heading], [`template.footerBlocks.${i}.text`, b.text]);
  });
  return fields;
}

/** The fields with undrawable characters (names only, never the values), the template's own texts included. */
export function undrawableFields(input: RenderInput, template?: TemplateDocumentV2 | null): string[] {
  const own: Array<[string, string]> = template ? templateTexts(template).map((t) => [`template.${t.blockId}.${t.field}`, t.text]) : [];
  return [...printedFields(input), ...own]
    .filter(([, v]) => typeof v === 'string' && undrawable(v).length > 0)
    .map(([f]) => f);
}

/** Refuse a document of record that would not print as written. */
export function assertDrawable(input: RenderInput, template?: TemplateDocumentV2 | null): void {
  const fields = undrawableFields(input, template);
  if (fields.length > 0) {
    throw new BooksError(
      'UNDRAWABLE_TEXT',
      `UNDRAWABLE_TEXT: characters the document font cannot print in ${fields.join(', ')}`,
      { fields },
    );
  }
}

function replaceUndrawable(text: string): string {
  const bad = new Set(undrawable(text));
  if (bad.size === 0) return text;
  return [...text].map((ch) => (bad.has(ch) ? '?' : ch)).join('');
}

/** A draft preview's model with undrawable characters shown as "?" (never for a document of record). */
export function previewSafe(model: RenderModel): RenderModel {
  const t = replaceUndrawable;
  return {
    ...model,
    senderLine: t(model.senderLine),
    recipientBlock: model.recipientBlock.map(t),
    meta: model.meta.map((m) => ({ label: m.label, value: t(m.value) })),
    reference: model.reference && t(model.reference),
    intro: model.intro && t(model.intro),
    lines: model.lines.map((l) => ({ ...l, title: t(l.title), details: l.details.map(t), unit: t(l.unit) })),
    notes: model.notes.map(t),
    payment: model.payment.map(t),
    outro: model.outro && t(model.outro),
    smallPrint: model.smallPrint.map((b) => ({ heading: b.heading && t(b.heading), text: t(b.text) })),
    footer: model.footer.map((col) => col.map(t)),
    shortTitle: t(model.shortTitle),
    metaItems: Object.fromEntries(
      Object.entries(model.metaItems).map(([k, v]) => [k, v ? { label: v.label, value: t(v.value) } : null]),
    ) as RenderModel['metaItems'],
    senderColumns: {
      identity: model.senderColumns.identity.map(t),
      contact: model.senderColumns.contact.map(t),
      legal: model.senderColumns.legal.map(t),
      bank: model.senderColumns.bank.map(t),
    },
  };
}

/** A preview's template with undrawable characters in its own texts shown as "?" (never for a document of record). */
export function previewSafeTemplate(doc: TemplateDocumentV2): TemplateDocumentV2 {
  const t = replaceUndrawable;
  const fix = <B extends Block | CellBlock>(b: B): B => {
    if (b.type === 'freeText') return { ...b, heading: b.heading && t(b.heading), text: t(b.text) };
    if (b.type === 'paymentDetails') return { ...b, heading: b.heading && t(b.heading) };
    if (b.type === 'paymentQr') return { ...b, caption: t(b.caption) };
    if (b.type === 'columns') return { ...b, cells: b.cells.map((c) => ({ ...c, blocks: c.blocks.map(fix) })) };
    return b;
  };
  const r = doc.regions;
  return {
    ...doc,
    regions: {
      firstPageHeader: r.firstPageHeader.map(fix),
      addressZone: { left: r.addressZone.left.map(fix), right: r.addressZone.right.map(fix) },
      body: r.body.map(fix),
      followingPageHeader: r.followingPageHeader.map(fix),
      footer: r.footer.map(fix),
    },
  };
}
