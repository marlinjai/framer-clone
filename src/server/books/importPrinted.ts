// src/server/books/importPrinted.ts
//
// From a PRINTED invoice to the historical-import record (importInvoices.ts):
// the one mapping both ways in use, the operator's private JSON
// (`pnpm books:import`, importCli.ts) and the model's reading of an uploaded
// PDF (the upload import, src/server/books/upload). One semantic, one
// implementation: what the real historical data taught (discounts as strings
// and as negative lines, missing unit prices and quantities, addresses that
// are not printed in full, foreign currencies, a VAT id inside an identifier
// line, a service period as text) is handled here once.
//
// Pure: no database, no file system, no network.

import { z } from 'zod';

import { isBooksError } from './errors';
import {
  HISTORICAL_VAT_RATES,
  isIsoCurrency,
  MAX_CENTS,
  parseHistoricalInvoice,
  type HistoricalInvoice,
  type HistoricalLine,
  type ImportOrigin,
} from './importInvoices';
import { addDays, berlinToday, isIsoDate } from './numbering';
import { normalizeVatId } from './repository/customers';
import { EU_MEMBER_STATES } from '../tax/germanVat';
import type { SenderBlockV1 } from './snapshots';

const nullableString = z.string().nullable().optional();


const addressBlock = z.object({
  name: z.string().trim().min(1),
  addressLines: z.array(z.string()),
});

const recipientSchema = addressBlock.extend({
  country: nullableString,
  countryInferred: nullableString,
  customerNumber: z.union([z.string(), z.number()]).nullable().optional(),
  /** Optional override of the contact kind the import would otherwise infer. */
  kind: z.enum(['person', 'organization']).optional(),
});

const senderSchema = addressBlock.extend({
  country: nullableString,
  taxNumberPresent: z.boolean().optional(),
  vatIdPresent: z.boolean().optional(),
  /** The printed tax number, when the source carries the value (an uploaded PDF read by the model). */
  taxNumber: nullableString,
  /** The printed VAT id, when the source carries the value. */
  vatId: nullableString,
});

const lineSchema = z.object({
  description: z.string(),
  /** The VAT rate printed on the line, in percent (19, 7); null when the line shows none. */
  taxRate: z.number().finite().nullable().optional(),
  /** The VAT amount printed on the line; null when the line shows none (derived from the rate and the printed tax groups). */
  taxAmount: z.number().finite().nullable().optional(),
  /** Missing on some prints (a fixed fee): the line then counts once. */
  quantity: z.number().finite().nullable().optional(),
  unit: z.string().nullable().optional(),
  /** Missing on many prints: derived from the printed line total. */
  unitPrice: z.number().finite().nullable().optional(),
  discount: z.unknown().optional(),
  lineTotal: z.number().finite(),
});

const periodSchema = z.union([
  z.object({ start: z.string(), end: z.string() }),
  z.object({ from: z.string(), to: z.string() }),
]);

/** One printed tax group ("19 % USt auf 1.000,00: 190,00"). */
const taxGroupSchema = z.object({
  /** Percent (19, 7). */
  rate: z.number().finite(),
  net: z.number().finite().nullable().optional(),
  tax: z.number().finite(),
});

/**
 * One printed invoice, as an extraction wrote it: the operator's private JSON
 * (one entry of its `invoices`) or the model's reading of an uploaded PDF.
 * Unknown keys are ignored.
 */
export const rawInvoiceSchema = z.object({
  /** The number as printed: an integer in the operator's JSON, any text from an uploaded PDF. */
  number: z.union([z.number().int().positive(), z.string()]).nullable(),
  /** The operator's JSON only: the original's path (the upload carries its bytes itself). */
  file: z.string().nullable().optional(),
  fileRole: z.string().nullable().optional(),
  otherFiles: z.array(z.string()).nullable().optional(),
  issueDate: z.string().nullable(),
  serviceDate: z.string().nullable().optional(),
  servicePeriod: z.unknown().optional(),
  recipient: recipientSchema.nullable(),
  recipientVatId: z.string().nullable().optional(),
  sender: senderSchema.nullable(),
  lines: z.array(lineSchema).nullable().optional(),
  total: z.number().finite().nullable(),
  currency: z.string().nullable(),
  taxTreatment: z.string().nullable(),
  /** The printed tax groups (regular taxation); null or empty when none is printed. */
  taxAmounts: z.array(taxGroupSchema).nullable().optional(),
  /** True when the line prices include VAT (gross); such invoices are not imported (a named problem). */
  pricesIncludeVat: z.boolean().nullable().optional(),
  /** The tax note as printed: the section 19 or the reverse-charge notice. */
  taxNote: z.string().nullable().optional(),
  /** The operator JSON's name for the section 19 note. */
  smallBusinessNote: z.string().nullable().optional(),
  paymentTerms: z.string().nullable().optional(),
  paidOn: z.string().nullable().optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
});
export type RawInvoice = z.infer<typeof rawInvoiceSchema>;


const LEGAL_FORM = /(^|[\s,(])(GmbH|gGmbH|mbH|UG|AG|SE|KG|KGaA|OHG|GbR|PartG|PartGmbB|eG|e\.\s?V\.|e\.\s?K\.|Ltd\.?|LLC|LLP|PLC|plc|Inc\.?|Corp\.?|S\.A\.|SA|S\.L\.|SL|SARL|Sàrl|SAS|SASU|S\.p\.A\.|SpA|S\.r\.l\.|Srl|B\.V\.|BV|N\.V\.|NV|AB|AS|A\/S|ApS|Oy|Oyj|Sp\. z o\.o\.|s\.r\.o\.|a\.s\.|Kft\.?|d\.o\.o\.)(?=$|[\s,.)])/;

/** The contact kind: the explicit override, otherwise an organization when the name carries a legal form. */
export function inferKind(name: string, explicit?: 'person' | 'organization'): 'person' | 'organization' {
  if (explicit) return explicit;
  return LEGAL_FORM.test(name) ? 'organization' : 'person';
}

const COUNTRY_NAMES: Record<string, string> = {
  DEUTSCHLAND: 'DE',
  GERMANY: 'DE',
  ÖSTERREICH: 'AT',
  OESTERREICH: 'AT',
  AUSTRIA: 'AT',
  SCHWEIZ: 'CH',
  SWITZERLAND: 'CH',
};

/** An ISO 3166-1 alpha-2 code from a code or a common country name; null when unknown. */
export function countryCode(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = value.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(v)) return v;
  return COUNTRY_NAMES[v] ?? null;
}

/** A postal code line: optional country prefix (`D-`, `A-`), four or five digits, the city. */
const POSTAL_LINE = /^(?:[A-Z]{1,2}[- ])?(\d{4,5})\s+(\S.*)$/;

/** The snapshot's address fields from printed lines; `complete` says whether street, postal code and city were all found. */
export interface SplitAddress {
  addressLines: string[];
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string;
  city: string;
  complete: boolean;
}

/**
 * Split printed address lines into the snapshot's fields. The LAST line that
 * reads as postal code plus city gives `postalCode` and `city`; the line right
 * before it is the street (`addressLine1`, what a new contact gets as its
 * street), and any lines between the name and the street (a "c/o" or "z. Hd."
 * line, a department) are joined into `addressLine2`; a first line repeating
 * the name is dropped; lines after the postal line (a country line) are left
 * out (the country is its own field). The printed lines are kept verbatim in
 * `addressLines`. What the print does not carry stays empty and `complete` is
 * false (the import warns, it never invents an address): no postal line puts
 * the last street-like line into `addressLine1`; no lines at all leave every
 * field empty.
 */
export function splitAddress(name: string, lines: readonly string[]): SplitAddress {
  const clean = lines.map((l) => l.trim()).filter((l) => l !== '');
  let at = -1;
  for (let i = clean.length - 1; i >= 0; i -= 1) {
    if (POSTAL_LINE.test(clean[i])) {
      at = i;
      break;
    }
  }
  const street = (at < 0 ? clean : clean.slice(0, at)).slice();
  if (street.length > 0 && street[0].toLowerCase() === name.trim().toLowerCase()) street.shift();
  const m = at < 0 ? null : POSTAL_LINE.exec(clean[at]);
  return {
    addressLines: clean,
    addressLine1: street.length > 0 ? street[street.length - 1] : '',
    addressLine2: street.length > 1 ? street.slice(0, -1).join(', ') : null,
    postalCode: m ? m[1] : '',
    city: m ? m[2].trim() : '',
    complete: m !== null && street.length > 0,
  };
}

/** `x` in hundredths (cents) or thousandths, exactly; null when `x` carries finer digits. */
function scaled(x: number, factor: 100 | 1000): number | null {
  const v = Math.round(x * factor);
  return Math.abs(x * factor - v) < 1e-6 ? v : null;
}

/** Payment terms in days when the printed text states exactly one ("14 Tage", "zahlbar sofort"); null otherwise. */
export function paymentTermsDays(text: string | null | undefined): number | null {
  if (!text) return null;
  const all = [...text.matchAll(/(\d{1,3})\s*(?:Tage|Tagen|Tag|days?)\b/gi)];
  // Two day counts ("2 % Skonto innerhalb 7 Tagen, netto 30 Tage") cannot be told apart: not read.
  if (all.length > 1) return null;
  if (all.length === 1) {
    const n = Number(all[0][1]);
    return n <= 365 ? n : null;
  }
  if (/\bsofort\b|\bimmediately\b/i.test(text)) return 0;
  return null;
}

/** `DD.MM.YYYY` or `YYYY-MM-DD` to `YYYY-MM-DD`; null when neither. */
function isoOf(value: string): string | null {
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
  const iso = de ? `${de[3]}-${de[2].padStart(2, '0')}-${de[1].padStart(2, '0')}` : value;
  return isIsoDate(iso) ? iso : null;
}

/** Month names (German and English, with their usual abbreviations) and their numbers. */
const MONTHS: Record<string, number> = {
  januar: 1, jan: 1, january: 1, jänner: 1,
  februar: 2, feb: 2, february: 2,
  märz: 3, maerz: 3, mär: 3, mar: 3, march: 3,
  april: 4, apr: 4,
  mai: 5, may: 5,
  juni: 6, jun: 6, june: 6,
  juli: 7, jul: 7, july: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, oct: 10, october: 10,
  november: 11, nov: 11,
  dezember: 12, dez: 12, dec: 12, december: 12,
};

/** A service period printed as one month ("Februar 2023", "02/2023", "2023-02"): its first and last day. */
export function monthPeriodOf(text: string): { start: string; end: string } | null {
  const t = text.trim().toLowerCase().replace(/^(leistungszeitraum|zeitraum|service period|period)\s*:?\s*/, '');
  let year: number | null = null;
  let month: number | null = null;
  let m = /^([a-zäöü]+)\.?\s+(\d{4})$/.exec(t);
  if (m && MONTHS[m[1]] !== undefined) [month, year] = [MONTHS[m[1]], Number(m[2])];
  m = month === null ? /^(\d{1,2})\s*[/.]\s*(\d{4})$/.exec(t) : null;
  if (m) [month, year] = [Number(m[1]), Number(m[2])];
  m = month === null ? /^(\d{4})-(\d{1,2})$/.exec(t) : null;
  if (m) [year, month] = [Number(m[1]), Number(m[2])];
  if (year === null || month === null || month < 1 || month > 12 || year < 1990 || year > 2100) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(last).padStart(2, '0')}` };
}

/**
 * A service period from an object (`start`/`end` or `from`/`to`), from text
 * naming exactly two dates ("2023-01-01 bis 2023-01-31", "01.01.2023 - 31.01.2023"),
 * or from text naming one month ("Februar 2023": its first and last day).
 */
export function servicePeriodOf(value: unknown): { start: string; end: string } | null {
  if (typeof value === 'string') {
    const month = monthPeriodOf(value);
    if (month) return month;
    const dates = [...value.matchAll(/\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4}/g)].map((m) => isoOf(m[0]));
    if (dates.length !== 2 || dates.some((d) => d === null)) return null;
    const [start, end] = dates as string[];
    return start <= end ? { start, end } : null;
  }
  const p = periodSchema.safeParse(value);
  if (!p.success) return null;
  const start = 'start' in p.data ? p.data.start : p.data.from;
  const end = 'end' in p.data ? p.data.end : p.data.to;
  return isIsoDate(start) && isIsoDate(end) && start <= end ? { start, end } : null;
}

/** The printed currency as an ISO 4217 code ("EUR", "chf", "€" for EUR); null when it is none. */
export function currencyCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toUpperCase();
  const code = v === '€' ? 'EUR' : v;
  return isIsoCurrency(code) ? code : null;
}

const VAT_SHAPE = /^[A-Z]{2}[A-Z0-9+*]{2,13}$/;

/** The number part of an EU VAT id per country (the VIES formats), so a stray token is not taken for one. */
const VAT_NUMBER: Record<string, RegExp> = {
  AT: /^U\d{8}$/, BE: /^[01]\d{9}$/, BG: /^\d{9,10}$/, CY: /^\d{8}[A-Z]$/, CZ: /^\d{8,10}$/, DE: /^\d{9}$/, DK: /^\d{8}$/,
  EE: /^\d{9}$/, EL: /^\d{9}$/, ES: /^[0-9A-Z]\d{7}[0-9A-Z]$/, FI: /^\d{8}$/, FR: /^[0-9A-Z]{2}\d{9}$/, HR: /^\d{11}$/,
  HU: /^\d{8}$/, IE: /^(\d{7}[A-W][A-I]?|\d[A-Z+*]\d{5}[A-W])$/, IT: /^\d{11}$/, LT: /^(\d{9}|\d{12})$/, LU: /^\d{8}$/,
  LV: /^\d{11}$/, MT: /^\d{8}$/, NL: /^\d{9}B\d{2}$/, PL: /^\d{10}$/, PT: /^\d{9}$/, RO: /^\d{2,10}$/, SE: /^\d{12}$/,
  SI: /^\d{8}$/, SK: /^\d{10}$/, XI: /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
};

function isEuVatId(value: string): boolean {
  const pattern = VAT_NUMBER[value.slice(0, 2)];
  return VAT_SHAPE.test(value) && pattern !== undefined && pattern.test(value.slice(2));
}

/**
 * The recipient's VAT id from the printed text: the whole text when it is one
 * (spaces removed), otherwise the ONE token in it that is an EU VAT id (a
 * printed line such as "UID: CHE-123.456.789; USt-IdNr: DE123456789" holds
 * other identifiers too). null when none or more than one.
 */
export function extractVatId(text: string): string | null {
  const whole = normalizeVatId(text);
  if (isEuVatId(whole)) return whole;
  const tokens = text
    .toUpperCase()
    .split(/[\s;,:()]+/)
    .filter(isEuVatId);
  return new Set(tokens).size === 1 ? tokens[0] : null;
}

/** The longest prefix of whole code points within `max` UTF-16 units: an emoji is never cut in half. */
export function cutWhole(value: string, max: number): string {
  let out = '';
  for (const ch of value) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/**
 * A decimal in one unambiguous writing: "10", "10.5", "10,50", or German
 * grouping "1.234,50"; null for anything else, also for what reads two ways
 * ("1.234" could be 1234 or 1.234, "1,234.50" is English grouping), so a
 * misread can never become a stored figure.
 */
function decimal(text: string): number | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (/^\d+[.,]\d{1,2}$/.test(t)) return Number(t.replace(',', '.'));
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(t)) return Number(t.replace(/\./g, '').replace(',', '.'));
  return null;
}

/** Half away from zero, the same for negative amounts as for positive ones. */
function roundHalfAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/** What a printed discount says: a percentage in basis points, or an amount in cents of the document's currency. */
export type PrintedDiscount = { kind: 'percent'; bp: number } | { kind: 'amount'; cents: number };

/**
 * Read a printed discount: a percentage ("10 %", "-10%", {percent: 10}) or an
 * amount in the document's currency ("50,00 €", "EUR 50", "50 CHF" on a CHF
 * invoice, {amount: 50}); null when it is something else (warned by the caller).
 */
export function parseDiscount(discount: unknown, currency: string): PrintedDiscount | null {
  const percent = (v: number | null): PrintedDiscount | null =>
    v !== null && v >= 0 && v <= 100 ? { kind: 'percent', bp: Math.round(v * 100) } : null;
  const amount = (v: number | null): PrintedDiscount | null => (v !== null && v >= 0 ? { kind: 'amount', cents: Math.round(v * 100) } : null);
  if (typeof discount === 'string') {
    const text = discount.trim().replace(/^-\s*/, '');
    const pct = /^(.+?)\s*%$/.exec(text);
    if (pct) return percent(decimal(pct[1]));
    const marks = currency === 'EUR' ? '€|EUR' : `${currency}`;
    const m = new RegExp(`^(?:(?:${marks})\\s*)?(.+?)(?:\\s*(?:${marks}))?$`, 'i').exec(text);
    if (m && new RegExp(`(${marks})`, 'i').test(text)) return amount(decimal(m[1]));
    return null;
  }
  if (typeof discount === 'object' && discount !== null) {
    const d = discount as { percent?: unknown; amount?: unknown };
    if (typeof d.percent === 'number') return percent(Math.abs(d.percent));
    if (typeof d.amount === 'number') return amount(Math.abs(d.amount));
  }
  return null;
}

/** A printed discount as basis points of quantity times price (null when unread or not applicable to that line). */
export function discountBp(discount: unknown, quantity: number, unitPrice: number, currency = 'EUR'): number | null {
  const parsed = parseDiscount(discount, currency);
  if (!parsed) return null;
  if (parsed.kind === 'percent') return parsed.bp;
  const gross = Math.round((quantity * unitPrice) / 1000);
  return gross > 0 && parsed.cents <= gross ? Math.round((parsed.cents * 10000) / gross) : null;
}

interface MappedLines {
  lines: HistoricalLine[];
  /** Billable lines whose unit price (and maybe quantity) was taken from the printed line total. */
  priceDerived: number;
  /** Lines with a printed discount that could not be read. */
  discountUnparsed: number;
}

function mapLines(raw: NonNullable<RawInvoice['lines']>, currency: string): MappedLines | PlanIssue {
  const out: HistoricalLine[] = [];
  let priceDerived = 0;
  let discountUnparsed = 0;
  for (const l of raw) {
    const text = l.description.trim();
    if (text === '') return { kind: 'error', reason: 'line_text_missing' };
    if (text.length > 4000) return { kind: 'error', reason: 'line_text_too_long' };
    const title = text.length <= 300 ? text : `${cutWhole(text, 299)}…`;
    const description = text.length <= 300 ? null : text;
    const unitLabel = cutWhole((l.unit ?? '').trim(), 40) || 'Stk';
    const lineTotal = scaled(l.lineTotal, 100);
    if (lineTotal === null || Math.abs(lineTotal) > MAX_CENTS) return { kind: 'error', reason: 'line_amount_invalid' };
    let quantity = l.quantity == null ? null : scaled(l.quantity, 1000);
    let unitPrice = l.unitPrice == null ? null : scaled(l.unitPrice, 100);
    if (l.quantity != null && (quantity === null || quantity < 0)) return { kind: 'error', reason: 'line_quantity_invalid' };
    if (l.unitPrice != null && (unitPrice === null || Math.abs(unitPrice) > MAX_CENTS)) return { kind: 'error', reason: 'line_amount_invalid' };

    // No quantity, no price and no amount (or an explicit zero quantity without amount): a text line.
    if ((quantity === null || quantity === 0) && lineTotal === 0 && (unitPrice === null || unitPrice === 0)) {
      out.push({ kind: 'text', title, description, quantity: 0, unitLabel, unitPrice: 0, discountBp: 0, subtotal: 0, taxRate: 0, taxAmount: 0 });
      continue;
    }
    if (quantity === 0) return { kind: 'error', reason: 'line_quantity_invalid' };
    // A printed price and total of opposite signs cannot both be right.
    if (unitPrice !== null && unitPrice !== 0 && lineTotal !== 0 && Math.sign(unitPrice) !== Math.sign(lineTotal)) {
      return { kind: 'error', reason: 'line_sign_mismatch' };
    }
    if (quantity === null || unitPrice === null) priceDerived += 1;
    if (quantity === null) quantity = 1000;

    if (lineTotal < 0) {
      // A printed discount line ("Rabatt 10 %" with a minus amount): stored as
      // printed at its amount. Its discount text is the line's label, already
      // expressed by the negative amount, so it is not read as a discount.
      const price = unitPrice ?? roundHalfAway((lineTotal * 1000) / quantity);
      if (Math.abs(price) > MAX_CENTS) return { kind: 'error', reason: 'line_amount_invalid' };
      out.push({ kind: 'service', title, description, quantity, unitLabel, unitPrice: price, discountBp: 0, subtotal: lineTotal, taxRate: 0, taxAmount: 0 });
      continue;
    }

    let bp = 0;
    const printed = l.discount != null && l.discount !== '' ? parseDiscount(l.discount, currency) : null;
    if (l.discount != null && l.discount !== '' && printed === null) discountUnparsed += 1;
    if (unitPrice === null) {
      // The price is derived from the printed total, which is AFTER the discount,
      // so the discount is put back in: the stored line then reads consistently.
      let gross = lineTotal;
      if (printed?.kind === 'percent' && printed.bp < 10000) {
        bp = printed.bp;
        gross = (lineTotal * 10000) / (10000 - bp);
      } else if (printed?.kind === 'amount') {
        gross = lineTotal + printed.cents;
        bp = gross > 0 ? Math.round((printed.cents * 10000) / gross) : 0;
      } else if (printed) {
        discountUnparsed += 1;
      }
      unitPrice = roundHalfAway((gross * 1000) / quantity);
    } else if (printed) {
      const read = discountBp(l.discount, quantity, unitPrice, currency);
      if (read === null) discountUnparsed += 1;
      else bp = read;
    }
    if (unitPrice > MAX_CENTS) return { kind: 'error', reason: 'line_amount_invalid' };
    // Stored as printed: the printed line total is authoritative. When it is
    // not the arithmetic of the line, the core warns (line_not_quantity_times_price).
    out.push({ kind: 'service', title, description, quantity, unitLabel, unitPrice, discountBp: bp, subtotal: lineTotal, taxRate: 0, taxAmount: 0 });
  }
  return { lines: out, priceDerived, discountUnparsed };
}


/** A per-invoice reason: `skipped` means something is not there yet, `error` that what is there is inconsistent. */
export type PlanIssue = { kind: 'skipped' | 'error'; reason: string };

/** The mapped record, or why there is none. */
export type MappedPrinted =
  | { ok: true; record: HistoricalInvoice }
  | { ok: false; issue: PlanIssue };

/**
 * The VAT of the lines under regular taxation, as printed: each billable
 * line's rate (printed, or the invoice's only printed rate), its printed tax
 * or, when the line shows none, its net times the rate; when the invoice
 * prints its tax per rate, the derived line taxes of a rate are adjusted (on
 * the largest line) so that their sum is the printed group tax. Counts the
 * lines whose tax was derived.
 */
function taxLines(
  lines: HistoricalLine[],
  raw: NonNullable<RawInvoice['lines']>,
  groups: NonNullable<RawInvoice['taxAmounts']>,
): { lines: HistoricalLine[]; derived: number } | PlanIssue {
  const groupRates = [...new Set(groups.map((g) => Math.round(g.rate * 100)))];
  const out = lines.map((l) => ({ ...l }));
  const printedTax = new Set<number>();
  for (const [i, l] of out.entries()) {
    if (l.kind === 'text') continue;
    const rawRate = raw[i]?.taxRate;
    const rate = rawRate != null ? Math.round(rawRate * 100) : groupRates.length === 1 ? groupRates[0] : null;
    if (rate === null) return { kind: 'error', reason: 'line_tax_rate_missing' };
    if (!HISTORICAL_VAT_RATES.has(rate)) return { kind: 'error', reason: 'line_tax_rate_unsupported' };
    l.taxRate = rate;
    const rawTax = raw[i]?.taxAmount;
    if (rawTax != null) {
      const cents = Math.round(rawTax * 100);
      if (Math.abs(rawTax * 100 - cents) > 1e-6) return { kind: 'error', reason: 'line_amount_invalid' };
      // A 0 % line carries no VAT: a printed amount there is a misreading, never stored.
      if (rate === 0 && cents !== 0) return { kind: 'error', reason: 'line_tax_on_zero_rate' };
      l.taxAmount = cents;
      printedTax.add(i);
    } else {
      l.taxAmount = roundHalfAway((l.subtotal * rate) / 10000);
    }
  }
  for (const g of groups) {
    const rate = Math.round(g.rate * 100);
    const members = out.map((l, i) => ({ l, i })).filter(({ l }) => l.kind !== 'text' && l.taxRate === rate);
    const derivedMembers = members.filter(({ i }) => !printedTax.has(i));
    if (derivedMembers.length === 0) continue;
    const want = Math.round(g.tax * 100);
    const have = members.reduce((acc, { l }) => acc + l.taxAmount, 0);
    if (want !== have) {
      // Only a rounding difference (a cent per derived line) is put on a line; anything more
      // means the summary and the lines disagree, which is named, never absorbed. A 0 % group
      // has nothing to round.
      if (rate === 0 || Math.abs(want - have) > derivedMembers.length) return { kind: 'error', reason: 'tax_summary_mismatch' };
      const largest = derivedMembers.reduce((a, b) => (Math.abs(b.l.subtotal) > Math.abs(a.l.subtotal) ? b : a));
      largest.l.taxAmount += want - have;
    }
  }
  return { lines: out, derived: out.filter((l, i) => l.kind !== 'text' && !printedTax.has(i)).length };
}

/**
 * Map one printed invoice to the historical-import record, or say why it
 * cannot be. The order of checks puts what is merely missing (skipped) before
 * what is inconsistent (error), so an incomplete entry reads as "not there
 * yet". The record is parsed by the domain's own schema here, so a preview
 * refuses exactly what the import would.
 */
export function mapPrintedInvoice(
  rawValue: unknown,
  opts: { origin: ImportOrigin; now?: Date; otherFiles?: number },
): MappedPrinted {
  const now = opts.now ?? new Date();
  const issue = (kind: PlanIssue['kind'], reason: string): MappedPrinted => ({ ok: false, issue: { kind, reason } });
  const parsed = rawInvoiceSchema.safeParse(rawValue);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') || 'entry';
    return issue('error', `invalid_field:${field}`);
  }
  const r = parsed.data;
  const documentNumber = r.number === null ? '' : String(r.number).trim();
  const currency = currencyCode(r.currency);
  const issueDate = r.issueDate !== null && isIsoDate(r.issueDate) ? r.issueDate : null;
  const totalCents = r.total === null ? null : scaled(r.total, 100);

  // Missing pieces first.
  if (documentNumber === '') return issue('skipped', 'number_missing');
  if (r.recipient === null) return issue('skipped', 'recipient_missing');
  if (r.sender === null) return issue('skipped', 'sender_missing');
  if (!r.lines || r.lines.length === 0) return issue('skipped', 'lines_missing');

  // Then consistency.
  if (!issueDate) return issue('error', 'issue_date_invalid');
  if (issueDate > berlinToday(now)) return issue('error', 'issue_date_in_future');
  // Kept as printed, never converted (an imported invoice keeps its currency).
  if (!currency) return issue('error', 'currency_invalid');
  const treatment =
    r.taxTreatment === 'small_business' || r.taxTreatment === 'regular' || r.taxTreatment === 'reverse_charge'
      ? r.taxTreatment
      : null;
  if (!treatment) return issue('error', 'tax_treatment_unsupported');
  if (treatment === 'regular' && r.pricesIncludeVat === true) return issue('error', 'gross_priced_lines');
  const groups = r.taxAmounts ?? [];
  if (treatment !== 'regular' && (groups.some((g) => g.tax !== 0) || r.lines.some((l) => (l.taxAmount ?? 0) !== 0 || (l.taxRate ?? 0) !== 0))) {
    return issue('error', 'tax_on_untaxed_invoice');
  }
  if (totalCents === null || totalCents < 0 || totalCents > MAX_CENTS) return issue('error', 'total_invalid');

  const recipientAddress = splitAddress(r.recipient.name, r.recipient.addressLines);
  const blank = (v: string | null | undefined) => v == null || v.trim() === '';
  // The printed country, else the extraction's inference, else DE assumed (flagged, warned).
  const countryInferred = blank(r.recipient.country);
  const countryAssumed = countryInferred && blank(r.recipient.countryInferred);
  // DE is assumed only for a EUR invoice; an invoice in another currency without any country is not guessed.
  if (countryAssumed && currency !== 'EUR') return issue('error', 'recipient_country_unknown');
  const recipientCountry = countryAssumed ? 'DE' : countryCode(countryInferred ? r.recipient.countryInferred : r.recipient.country);
  if (!recipientCountry) return issue('error', 'recipient_country_unknown');
  const senderAddress = splitAddress(r.sender.name, r.sender.addressLines);
  // An issuer the Books import for is a German company: no printed country means Germany (flagged).
  const senderCountryInferred = blank(r.sender.country);
  const senderCountry = senderCountryInferred ? 'DE' : countryCode(r.sender.country);
  if (!senderCountry) return issue('error', 'sender_country_unknown');
  // Reverse charge as the Books know it (section 13b UStG for an EU business abroad): a domestic
  // section 13b case or a customer outside the EU is not that, and is never stored as it. Each
  // case is named for its own way forward.
  if (treatment === 'reverse_charge' && (recipientCountry === 'DE' || !EU_MEMBER_STATES.has(recipientCountry))) {
    if (countryAssumed || countryInferred) return issue('error', 'reverse_charge_country_unknown');
    return issue('error', recipientCountry === 'DE' ? 'reverse_charge_domestic' : 'reverse_charge_outside_eu');
  }
  const taxNoteText = (r.taxNote ?? r.smallBusinessNote ?? '').trim();

  const mapped = mapLines(r.lines, currency);
  if ('reason' in mapped) return issue(mapped.kind, mapped.reason);
  let lines = mapped.lines;
  if (!lines.some((l) => l.kind !== 'text')) return issue('skipped', 'lines_missing');
  let taxDerived = 0;
  if (treatment === 'regular') {
    const taxed = taxLines(lines, r.lines, groups);
    if ('reason' in taxed) return issue(taxed.kind, taxed.reason);
    lines = taxed.lines;
    taxDerived = taxed.derived;
  }
  const sum = lines.reduce((acc, l) => acc + l.subtotal + l.taxAmount, 0);
  if (sum !== totalCents) return issue('error', 'lines_do_not_sum_to_total');

  let vatId: string | null = null;
  // A printed VAT id that is not a valid one is not frozen, but recorded as such (never silently dropped).
  let vatIdUnparsed = false;
  if (r.recipientVatId && r.recipientVatId.trim() !== '') {
    vatId = extractVatId(r.recipientVatId);
    vatIdUnparsed = vatId === null;
  }
  const rawNumber = r.recipient.customerNumber;
  const numberText = rawNumber == null ? null : String(rawNumber).trim() || null;
  const numberInt = numberText !== null && /^\d{1,9}$/.test(numberText) ? Number(numberText) : null;

  const sender: SenderBlockV1 & { addressLines: string[] } = {
    legalName: r.sender.name.trim(),
    // What the extraction did not carry stays empty (warned), never invented.
    addressLine1: senderAddress.addressLine1 || null,
    addressLine2: senderAddress.addressLine2,
    postalCode: senderAddress.postalCode || null,
    city: senderAddress.city || null,
    countryCode: senderCountry,
    // The operator's JSON says only whether these were printed (the original is the
    // record of their values); a model reading the PDF carries the values themselves.
    taxNumber: blank(r.sender.taxNumber) ? null : r.sender.taxNumber!.trim().slice(0, 64),
    vatId: blank(r.sender.vatId) ? null : (extractVatId(r.sender.vatId!) ?? null),
    smallBusinessId: null,
    email: null,
    phone: null,
    website: null,
    bankName: null,
    iban: null,
    bic: null,
    registerCourt: null,
    registerNumber: null,
    managingDirector: null,
    addressLines: senderAddress.addressLines,
  };
  const serviceDate = r.serviceDate && isIsoDate(r.serviceDate) ? r.serviceDate : null;
  const servicePeriod = r.servicePeriod == null ? null : servicePeriodOf(r.servicePeriod);
  const terms = paymentTermsDays(r.paymentTerms);

  try {
    const record = parseHistoricalInvoice(
      {
        origin: opts.origin,
        documentNumber,
        issueDate,
        serviceDate,
        servicePeriod,
        paymentTermsDays: terms ?? 0,
        dueDate: terms === null ? null : addDays(issueDate, terms),
        recipient: {
          // A recipient with a VAT id is a business (only businesses have one).
          kind: inferKind(r.recipient.name, r.recipient.kind ?? (vatId !== null ? 'organization' : undefined)),
          name: r.recipient.name.trim(),
          addressLines: recipientAddress.addressLines,
          addressLine1: recipientAddress.addressLine1,
          addressLine2: recipientAddress.addressLine2,
          postalCode: recipientAddress.postalCode,
          city: recipientAddress.city,
          country: recipientCountry,
          customerNumber: numberInt,
          customerNumberText: numberInt === null ? numberText : null,
          vatId,
        },
        sender,
        lines,
        total: totalCents,
        currency,
        taxTreatment: treatment,
        taxNote: taxNoteText === '' ? null : taxNoteText,
        provenance: {
          otherFilesSkipped: opts.otherFiles ?? 0,
          // What the PDF showed: the reading says so explicitly (a value filled in from the company's
          // settings is not printed); the operator's file has only the flags or the values.
          senderTaxNumberPrinted: typeof r.sender.taxNumberPresent === 'boolean' ? r.sender.taxNumberPresent : !blank(r.sender.taxNumber),
          senderVatIdPrinted: typeof r.sender.vatIdPresent === 'boolean' ? r.sender.vatIdPresent : !blank(r.sender.vatId),
          serviceDateUnparsed:
            (r.serviceDate != null && serviceDate === null) || (r.servicePeriod != null && servicePeriod === null),
          paidOnPresent: r.paidOn != null && r.paidOn.trim() !== '',
          paymentTermsUnparsed: terms === null && !blank(r.paymentTerms),
          recipientVatIdUnparsed: vatIdUnparsed,
          recipientCountryInferred: countryInferred && !countryAssumed,
          recipientCountryAssumed: countryAssumed,
          senderCountryInferred,
          linesPriceDerived: mapped.priceDerived,
          linesDiscountUnparsed: mapped.discountUnparsed,
          linesTaxDerived: taxDerived,
          confidence: r.confidence ?? 'low',
        },
      },
      now,
    );
    return { ok: true, record };
  } catch (err) {
    if (!isBooksError(err)) throw err;
    const paths = ((err.details?.issues as Array<{ path: string }> | undefined) ?? []).map((i) => i.path);
    return issue('error', `invalid_record:${paths.join(',') || 'record'}`);
  }
}

