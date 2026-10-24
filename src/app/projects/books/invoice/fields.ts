// src/app/projects/books/invoice/fields.ts
//
// The invoice page's fields (WYSIWYG invoice editor plan, decisions 1 to 4):
// for each editable field of the engine's layout map (phase 2), the value the
// inline editor starts with, the label a screen reader hears, and the request
// a typed value becomes. Pure, client-safe: the page component only wires
// these to the inputs and the API.
//
// The server owns every figure (decision 3): a value is parsed into the Books'
// integer units here (thousandths, cents, basis points, days) and sent; the
// answer carries the recomputed document. Text fields are also written into
// the local render input at once (`applyLocal`), so the page redraws while the
// user types; amounts never are.

import type { DocumentDetail, LineView } from '@/lib/books/api';
import type { RenderInputPayload } from '@/lib/books/engine';
import { moneyInput, parseMoney, parsePercent, parseQuantity, quantityInput } from '@/lib/books/units';
import type { LayoutField } from '@/server/books/render/engine';
import { normalizeRichText, richFromPlain } from '@/server/books/render/richText';

/** The tax classes a line may choose, as the page offers them. */
export const TAX_CLASS_OPTIONS = [
  { value: 'standard', label: '19 %' },
  { value: 'reduced', label: '7 %' },
  { value: 'zero', label: '0 %' },
] as const;

/** A request a field's value becomes: a draft edit, a line edit, or the customer. */
export type FieldRequest =
  | { kind: 'document'; body: Record<string, unknown> }
  | { kind: 'line'; lineId: string; body: Record<string, unknown> }
  | { kind: 'customer'; customerId: string };

export type ParsedValue = { ok: true; request: FieldRequest; local: string | null } | { ok: false; message: string };

/** The line a field belongs to, or null. */
export function lineOf(field: LayoutField, detail: DocumentDetail): LineView | null {
  return field.lineId ? (detail.lines.find((l) => l.id === field.lineId) ?? null) : null;
}

/** Basis points as the percent a person types: 1000 -> "10", 250 -> "2,5". */
export function percentInput(bp: number): string {
  const frac = String(bp % 100).padStart(2, '0').replace(/0+$/, '');
  return `${Math.floor(bp / 100)}${frac ? `,${frac}` : ''}`;
}

/** The value an inline editor starts with (the stored one, in the form a person types). */
export function editValue(field: LayoutField, detail: DocumentDetail): string {
  const doc = detail.document;
  if (field.source === 'line') {
    const line = lineOf(field, detail);
    if (!line) return '';
    switch (field.documentField) {
      case 'title':
        return line.title;
      case 'description':
        return line.description ?? '';
      case 'quantity':
        return quantityInput(line.quantity);
      case 'unitLabel':
        return line.unitLabel;
      case 'unitPrice':
        return moneyInput(line.unitPrice);
      case 'discountBp':
        return percentInput(line.discountBp);
      case 'taxClass':
        return line.taxClass ?? 'standard';
      default:
        return '';
    }
  }
  switch (field.documentField) {
    case 'serviceDate':
      return doc.serviceDate ?? '';
    case 'servicePeriod':
      return `${doc.servicePeriodStart ?? ''}/${doc.servicePeriodEnd ?? ''}`;
    case 'paymentTermsDays':
      return String(doc.paymentTermsDays);
    case 'contractReference':
      return doc.contractReference ?? '';
    case 'subject':
      return doc.subject ?? '';
    case 'introText':
      return doc.introText ?? '';
    case 'outroText':
      return doc.outroText ?? '';
    case 'customerId':
      return doc.customerId ?? '';
    default:
      return '';
  }
}

const LINE_PARTS: Record<string, string> = {
  title: 'description',
  description: 'details',
  quantity: 'quantity',
  unitLabel: 'unit',
  unitPrice: 'unit price',
  discountBp: 'discount',
  taxClass: 'tax rate',
};

const DOCUMENT_PARTS: Record<string, string> = {
  serviceDate: 'Service date',
  servicePeriod: 'Service period',
  paymentTermsDays: 'Payment terms in days',
  contractReference: 'Reference',
  subject: 'Subject',
  introText: 'Intro text',
  outroText: 'Closing text',
  customerId: 'Customer',
};

/** What a field is called ("Line 2, quantity", "Intro text", "Recipient, line 1"). */
export function fieldLabel(field: LayoutField, detail: DocumentDetail): string {
  if (field.lineId) {
    const line = lineOf(field, detail);
    const n = line ? line.position : detail.lines.findIndex((l) => l.id === field.lineId) + 1;
    const part = field.documentField ? LINE_PARTS[field.documentField] : field.id.split('.').pop();
    return `Line ${n}, ${part === 'rate' ? 'tax rate' : part}`;
  }
  if (field.documentField) return DOCUMENT_PARTS[field.documentField] ?? field.id;
  if (field.id.startsWith('recipient.line.')) return `Recipient, line ${field.id.split('.').pop()}`;
  if (field.id.startsWith('totals.')) return `Totals, line ${field.id.split('.').pop()}`;
  if (field.id.startsWith('meta.')) return `Document data, ${field.id.slice(5)}`;
  if (field.id === 'taxNote') return 'Tax note';
  if (field.id.startsWith('payment.')) return `Payment, ${field.id.slice(8)}`;
  return field.id;
}

/** Why a read-only field cannot be typed in, said on hover and to a screen reader. */
export function readOnlyReason(field: LayoutField): string {
  if (field.id.startsWith('recipient.line.')) return 'From the customer’s contact. Choose another customer, or change the contact in the contacts app.';
  if (field.id === 'meta.number' || field.id === 'meta.issueDate') return 'Given when the invoice is issued.';
  if (field.id === 'meta.customerNumber' || field.id === 'meta.recipientVatId') return 'From the customer.';
  if (field.id === 'meta.dueDate' || field.id.startsWith('payment.')) return 'Follows from the payment terms.';
  if (field.id.endsWith('.amount') || field.id.startsWith('totals.') || field.id === 'taxNote') return 'Calculated from the lines.';
  if (field.id.endsWith('.rate')) return 'Set by the tax treatment of this invoice.';
  return 'Not editable here.';
}

/** Parse what was typed into the request it becomes (null keeps the field empty where the API allows it). */
export function parseValue(field: LayoutField, raw: string): ParsedValue {
  const key = field.documentField;
  if (!key || !field.source) return { ok: false, message: readOnlyReason(field) };
  const text = raw.replace(/\r\n/g, '\n');
  const trimmed = text.trim();
  const lineReq = (body: Record<string, unknown>, local: string | null): ParsedValue =>
    field.lineId ? { ok: true, request: { kind: 'line', lineId: field.lineId, body }, local } : { ok: false, message: 'This line is gone.' };
  const docReq = (body: Record<string, unknown>, local: string | null): ParsedValue => ({ ok: true, request: { kind: 'document', body }, local });

  if (field.source === 'line') {
    switch (key) {
      case 'title':
        if (trimmed === '') return { ok: false, message: 'A line needs a description.' };
        return lineReq({ title: trimmed }, trimmed);
      case 'description':
        return lineReq({ description: trimmed === '' ? null : trimmed }, trimmed);
      case 'unitLabel':
        return lineReq({ unitLabel: trimmed || 'Stk' }, trimmed || 'Stk');
      case 'quantity': {
        const q = parseQuantity(trimmed);
        if (q === null || q <= 0) return { ok: false, message: 'Enter a quantity above 0, for example 1,5.' };
        return lineReq({ quantity: q }, null);
      }
      case 'unitPrice': {
        const p = parseMoney(trimmed);
        if (p === null || p < 0) return { ok: false, message: 'Enter a price in euros, for example 80,00.' };
        return lineReq({ unitPrice: p }, null);
      }
      case 'discountBp': {
        const d = trimmed === '' ? 0 : parsePercent(trimmed);
        if (d === null || d < 0 || d > 10000) return { ok: false, message: 'Enter a discount between 0 and 100 %.' };
        return lineReq({ discountBp: d }, null);
      }
      case 'taxClass':
        if (!TAX_CLASS_OPTIONS.some((o) => o.value === trimmed)) return { ok: false, message: 'Choose a tax rate.' };
        return lineReq({ taxClass: trimmed }, null);
      default:
        return { ok: false, message: 'Not editable here.' };
    }
  }
  switch (key) {
    case 'customerId':
      if (trimmed === '') return { ok: false, message: 'Choose a customer.' };
      return { ok: true, request: { kind: 'customer', customerId: trimmed }, local: null };
    case 'serviceDate':
      if (trimmed !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { ok: false, message: 'Enter a date.' };
      return docReq({ serviceDate: trimmed === '' ? null : trimmed }, null);
    case 'servicePeriod': {
      const [start = '', end = ''] = trimmed.split('/');
      if (start === '' && end === '') return docReq({ servicePeriod: null }, null);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return { ok: false, message: 'Enter the first and the last day.' };
      if (end < start) return { ok: false, message: 'The period ends before it starts.' };
      return docReq({ servicePeriod: { start, end } }, null);
    }
    case 'paymentTermsDays': {
      if (!/^\d{1,3}$/.test(trimmed)) return { ok: false, message: 'Enter the days to pay, for example 14.' };
      return docReq({ paymentTermsDays: Number(trimmed) }, null);
    }
    case 'contractReference':
      return docReq({ contractReference: trimmed === '' ? null : trimmed }, trimmed);
    case 'subject':
      if (trimmed.length > 200) return { ok: false, message: 'Keep the subject to one line of at most 200 characters.' };
      return docReq({ subject: trimmed === '' ? null : trimmed }, trimmed);
    case 'introText':
    case 'outroText':
      return docReq({ [key]: trimmed === '' ? null : text.trimEnd() }, text.trimEnd());
    default:
      return { ok: false, message: 'Not editable here.' };
  }
}

/**
 * The render input with a text field's typed value written in, for the redraw
 * while typing (amounts are never computed here: only fields whose `local`
 * value `parseValue` returned). Returns the same payload when nothing applies.
 */
export function applyLocal(payload: RenderInputPayload, field: LayoutField, local: string): RenderInputPayload {
  const key = field.documentField;
  if (field.source === 'line' && field.lineId) {
    if (key !== 'title' && key !== 'description' && key !== 'unitLabel') return payload;
    const value = key === 'description' ? (local === '' ? null : local) : local;
    return {
      ...payload,
      input: { ...payload.input, lines: payload.input.lines.map((l) => (l.id === field.lineId ? { ...l, [key]: value } : l)) },
    };
  }
  if (key === 'introText' || key === 'outroText') {
    // The typed plain text replaces the stored format too (the engine draws a format before the plain text), with
    // paragraphs for its line breaks, as the server stores it.
    const formatKey = key === 'introText' ? 'introFormat' : 'outroFormat';
    const format = /\r?\n/.test(local) ? normalizeRichText(richFromPlain(local)) : null;
    return { ...payload, input: { ...payload.input, document: { ...payload.input.document, [key]: local === '' ? null : local, [formatKey]: format } } };
  }
  if (key === 'contractReference' || key === 'subject') {
    return { ...payload, input: { ...payload.input, document: { ...payload.input.document, [key]: local === '' ? null : local } } };
  }
  return payload;
}

/** The field the page should focus after a change, found again by id in the new map. */
export function sameField(fields: LayoutField[], id: string): LayoutField | null {
  return fields.find((f) => f.id === id) ?? null;
}
