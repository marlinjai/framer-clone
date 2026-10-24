// src/server/books/render/drawable.ts
//
// Which printed fields contain characters the document's font family cannot
// draw (fonts.ts, decision 6: the coverage of the family the document is
// actually set in, the template's `theme.fontFamily`; DejaVu Sans for a
// version 1 layout). A document of record must print every name, address and
// line as written, so issue refuses (UNDRAWABLE_TEXT) and names the fields;
// nothing is ever transliterated or replaced on an issued document. Only the
// draft preview replaces such characters with "?" (`previewSafe`, the server's
// coverage over the one body in previewSafe.ts that the browser's draft render
// shares), and says so by being a draft.

import { BooksError } from '../errors';
import { printsSubject, templateTexts } from '../template/rules';
import type { FontFamily, TemplateDocumentV2 } from '../template/schema';
import { canDraw, undrawable } from './fonts';
import type { RenderInput, RenderModel } from './model';
import { previewSafeTemplateWith, previewSafeWith } from './previewSafe';

/** Every printed text of a render input, by field name. */
function printedFields(input: RenderInput, template: TemplateDocumentV2 | null): Array<[string, string | null | undefined]> {
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
    // Only where the template prints it: a subject no block draws cannot hold up an issue.
    ...(printsSubject(template) ? [['subject', d.subject] as [string, string | null]] : []),
    ['taxNote', d.taxNote],
  );
  (input.template?.footerBlocks ?? []).forEach((b, i) => {
    fields.push([`template.footerBlocks.${i}.heading`, b.heading], [`template.footerBlocks.${i}.text`, b.text]);
  });
  return fields;
}

/** The family a document is set in: its template's, or DejaVu Sans (the version 1 renderer's only font). */
export function familyOf(template: TemplateDocumentV2 | null): FontFamily {
  return template ? template.theme.fontFamily : 'dejavu-sans';
}

/** The fields with undrawable characters in the template's family (names only, never the values), the template's own texts included. */
export function undrawableFields(input: RenderInput, template: TemplateDocumentV2 | null): string[] {
  const family = familyOf(template);
  const own: Array<[string, string]> = template ? templateTexts(template).map((t) => [`template.${t.blockId}.${t.field}`, t.text]) : [];
  return [...printedFields(input, template), ...own]
    .filter(([, v]) => typeof v === 'string' && undrawable(v, family).length > 0)
    .map(([f]) => f);
}

/** Refuse a document of record that would not print as written. */
export function assertDrawable(input: RenderInput, template: TemplateDocumentV2 | null): void {
  const fields = undrawableFields(input, template);
  if (fields.length > 0) {
    throw new BooksError(
      'UNDRAWABLE_TEXT',
      `UNDRAWABLE_TEXT: characters the document font cannot print in ${fields.join(', ')}`,
      { fields },
    );
  }
}

/** A draft preview's model with the characters `family` cannot draw shown as "?" (never for a document of record). */
export function previewSafe(model: RenderModel, family: FontFamily): RenderModel {
  return previewSafeWith(model, (cp) => canDraw(cp, family));
}

/** A preview's template with undrawable characters in its own texts (in its own family) shown as "?" (never for a document of record). */
export function previewSafeTemplate(doc: TemplateDocumentV2): TemplateDocumentV2 {
  return previewSafeTemplateWith(doc, (cp) => canDraw(cp, doc.theme.fontFamily));
}
