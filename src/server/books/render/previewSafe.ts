// src/server/books/render/previewSafe.ts
//
// What a draft preview does with characters its font family cannot draw: it
// shows "?" in their place (a document of record never does: issue refuses
// with UNDRAWABLE_TEXT, drawable.ts). The coverage is passed in as `canDraw`,
// so the one body below serves both renderers of a draft: the server's
// (drawable.ts, coverage from the font files on disk, fonts.ts) and the
// browser's (src/lib/books/engine, coverage from the font files it fetched and
// verified against the same pins). Pure, no Node imports (WYSIWYG invoice
// editor plan, phase 1: the engine runs in a browser worker).

import type { Block, CellBlock, TemplateDocumentV2 } from '../template/schema';
import type { RenderModel } from './model';

/** True when BOTH faces of the family can draw the code point (a field may be set in either). */
export type CanDraw = (codePoint: number) => boolean;

/** The characters of `text` the coverage cannot draw (each once, in order). */
export function undrawableWith(text: string, canDraw: CanDraw): string[] {
  const out: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // Variation selectors and joiners are invisible modifiers; they draw nothing.
    if (cp === 0xfe0f || cp === 0xfe0e || cp === 0x200d) continue;
    if (!canDraw(cp) && !out.includes(ch)) out.push(ch);
  }
  return out;
}

function replaceUndrawable(text: string, canDraw: CanDraw): string {
  const bad = new Set(undrawableWith(text, canDraw));
  if (bad.size === 0) return text;
  return [...text].map((ch) => (bad.has(ch) ? '?' : ch)).join('');
}

/** A draft preview's model with the characters the coverage cannot draw shown as "?" (never for a document of record). */
export function previewSafeWith(model: RenderModel, canDraw: CanDraw): RenderModel {
  const t = (text: string) => replaceUndrawable(text, canDraw);
  return {
    ...model,
    senderLine: t(model.senderLine),
    recipientBlock: model.recipientBlock.map(t),
    meta: model.meta.map((m) => ({ label: m.label, value: t(m.value) })),
    reference: model.reference && t(model.reference),
    subject: model.subject && t(model.subject),
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
export function previewSafeTemplateWith(doc: TemplateDocumentV2, canDraw: CanDraw): TemplateDocumentV2 {
  const t = (text: string) => replaceUndrawable(text, canDraw);
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
