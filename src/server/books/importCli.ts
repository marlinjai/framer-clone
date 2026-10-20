// src/server/books/importCli.ts
//
// The logic of `pnpm books:import` (scripts/books-import.ts documents the
// flags): the historical invoices of one company, read from a private JSON file
// and their original PDFs, written into the company's Books as issued
// documents with `source = 'import'` (Books plan, "Historical import build
// notes (2026-10-20)"). Kept here, beside initCompanyCli.ts, so it runs end to
// end in a test with its own argv, environment and fakes. No `server-only`
// imports: the script runs it under tsx.
//
// PRIVACY. The input holds client names, addresses and line texts. Nothing of
// it is ever logged: a report line carries the invoice number, the issue date,
// the total and a status (imported / already imported / skipped: reason /
// error: code), and the summary carries counts and yearly sums. Error codes,
// never error messages, because a message can quote a value. File paths and
// connection strings are never printed either.
//
// ORDER. Everything that fails the whole run is checked before the first
// write: the input's shape, unique positive numbers, every declared file
// readable, inside --files-dir and a PDF, the invoice counter present and above
// every number, the contacts database reachable. Then each invoice is imported
// in its own transaction (importInvoices.ts); a problem with one number is
// reported for that number and the others go on.
//
// MAPPING ONLY. This file maps each entry of the private JSON to the domain's
// historical invoice record (origin `operator_file`, the sender printed on that
// invoice) and loops; every check and write of one invoice, the recipient's
// contact and customer included, is importHistoricalInvoice in
// importInvoices.ts, the core the in-editor upload will call too.

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

import { createContactsDb, type ContactsDb } from '@marlinjai/contacts-core';
import { createNodeDb } from '@marlinjai/tenant-db/node';
import { tenantDb } from '@marlinjai/tenant-db';
import { z } from 'zod';

import type { CommerceDB } from '../commerce/db-types';
import { contactsContactBook, type ContactBook } from './contactBook';
import { constraintName, isBooksError, sqlState } from './errors';
import {
  checkImportCounter,
  existingInvoice,
  importedCancelled,
  isIsoCurrency,
  importedYearTotals,
  importHistoricalInvoice,
  MAX_CENTS,
  MAX_ORIGINAL_BYTES,
  newImportSession,
  parseHistoricalInvoice,
  previewHistoricalInvoice,
  recipientKey,
  type HistoricalInvoice,
  type HistoricalLine,
  type ImportWarning,
  type RecipientStats,
} from './importInvoices';
import { addDays, berlinToday, isIsoDate } from './numbering';
import { contactsRecipientDirectory, type RecipientDirectory } from './recipients';
import { normalizeVatId } from './repository/customers';
import { booksScope } from './scope';
import type { SenderBlockV1 } from './snapshots';

/** The environment the run reads (process.env in the script, a plain object in tests). */
export type Env = Record<string, string | undefined>;

function fail(message: string): never {
  throw new Error(`books:import: ${message}`);
}

// --- the input file ------------------------------------------------------------------

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
});

const lineSchema = z.object({
  description: z.string(),
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

/** One entry of `invoices`, as the extraction wrote it. Unknown keys are ignored. */
export const rawInvoiceSchema = z.object({
  number: z.number().int().positive(),
  file: z.string().nullable(),
  fileRole: z.string().nullable().optional(),
  otherFiles: z.array(z.string()).nullable().optional(),
  issueDate: z.string(),
  serviceDate: z.string().nullable().optional(),
  servicePeriod: z.unknown().optional(),
  recipient: recipientSchema.nullable(),
  recipientVatId: z.string().nullable().optional(),
  sender: senderSchema.nullable(),
  lines: z.array(lineSchema).nullable().optional(),
  total: z.number().finite(),
  currency: z.string(),
  taxTreatment: z.string(),
  taxAmounts: z.unknown().optional(),
  smallBusinessNote: z.string().nullable().optional(),
  paymentTerms: z.string().nullable().optional(),
  paidOn: z.string().nullable().optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
});
export type RawInvoice = z.infer<typeof rawInvoiceSchema>;

const inputFileSchema = z.object({
  meta: z.unknown().optional(),
  invoices: z.array(z.object({ number: z.number().int().positive() }).passthrough()).min(1),
});

/** Parse the input file's text. Whole-run failures say what is wrong by position and field name only. */
export function parseImportFile(text: string): Array<{ number: number; raw: unknown }> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    fail('the input is not valid JSON');
  }
  const parsed = inputFileSchema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join('.') || '(root)').slice(0, 5);
    fail(`the input does not have the expected shape (${where.join(', ')})`);
  }
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const inv of parsed.data.invoices) {
    if (seen.has(inv.number)) duplicates.add(inv.number);
    seen.add(inv.number);
  }
  if (duplicates.size > 0) fail(`invoice numbers appear more than once: ${[...duplicates].sort((a, b) => a - b).join(', ')}`);
  return parsed.data.invoices
    .map((raw) => ({ number: raw.number, raw: raw as unknown }))
    .sort((a, b) => a.number - b.number);
}

// --- mapping one invoice (pure) ------------------------------------------------------

/** A per-invoice reason: `skipped` means something is not there yet, `error` that what is there is inconsistent. */
export type PlanIssue = { kind: 'skipped' | 'error'; reason: string };

/** What the plan holds for one number. */
export type PlannedInvoice =
  | { number: number; issueDate: string | null; total: number | null; currency: string | null; otherFiles: number; issue: PlanIssue }
  | {
      number: number;
      issueDate: string;
      total: number;
      currency: string;
      otherFiles: number;
      issue: null;
      record: HistoricalInvoice;
      pdf: Uint8Array;
    };

const LEGAL_FORM = /(^|[\s,(])(GmbH|gGmbH|mbH|UG|AG|SE|KG|KGaA|OHG|GbR|PartG|PartGmbB|eG|e\.\s?V\.|e\.\s?K\.|Ltd\.?|LLC|Inc\.?|S\.A\.|S\.L\.|B\.V\.|N\.V\.|S\.r\.l\.|Sp\. z o\.o\.)(?=$|[\s,.)])/;

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

/**
 * A service period from an object (`start`/`end` or `from`/`to`) or from text
 * naming exactly two dates ("2023-01-01 bis 2023-01-31", "01.01.2023 - 31.01.2023").
 */
export function servicePeriodOf(value: unknown): { start: string; end: string } | null {
  if (typeof value === 'string') {
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

/** The country prefixes of EU VAT ids (Greece is EL, Northern Ireland XI). */
const EU_VAT_PREFIXES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL',
  'PT', 'RO', 'SE', 'SI', 'SK', 'XI',
]);
const VAT_SHAPE = /^[A-Z]{2}[A-Z0-9+*]{2,13}$/;

/**
 * The recipient's VAT id from the printed text: the whole text when it is one
 * (spaces removed), otherwise the ONE token in it that is an EU VAT id (a
 * printed line such as "UID: CHE-123.456.789; USt-IdNr: DE123456789" holds
 * other identifiers too). null when none or more than one.
 */
export function extractVatId(text: string): string | null {
  const whole = normalizeVatId(text);
  if (VAT_SHAPE.test(whole) && EU_VAT_PREFIXES.has(whole.slice(0, 2)) && /\d/.test(whole)) return whole;
  const tokens = text
    .toUpperCase()
    .split(/[\s;,:()]+/)
    .filter((t) => VAT_SHAPE.test(t) && EU_VAT_PREFIXES.has(t.slice(0, 2)) && /\d/.test(t));
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

/** A decimal written either way ("10", "10.5", "10,5", "1.234,50"); null when it is not one. */
function decimal(text: string): number | null {
  const t = text.trim();
  const normalized = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  return /^\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : null;
}

/**
 * A printed discount as basis points of the line's quantity times price: a
 * percentage ("10 %", "10%", "-10 %", {percent: 10}) directly, an amount
 * ("50 EUR", "50,00 €", {amount: 50}) relative to quantity times price. null
 * when it is something else. The printed line total stays authoritative either
 * way; this only records what the print said.
 */
export function discountBp(discount: unknown, quantity: number, unitPrice: number): number | null {
  const gross = Math.round((quantity * unitPrice) / 1000);
  const fromPercent = (pct: number) => (pct >= 0 && pct <= 100 ? Math.round(pct * 100) : null);
  const fromAmount = (euros: number) => {
    const cents = Math.round(euros * 100);
    return gross > 0 && cents >= 0 && cents <= gross ? Math.round((cents * 10000) / gross) : null;
  };
  if (typeof discount === 'string') {
    const text = discount.trim().replace(/^-\s*/, '');
    const pct = /^(.+?)\s*%$/.exec(text);
    if (pct) {
      const v = decimal(pct[1]);
      return v === null ? null : fromPercent(v);
    }
    const amount = /^(?:€|EUR)?\s*(.+?)\s*(?:€|EUR)?$/i.exec(text);
    if (amount && /€|EUR/i.test(text)) {
      const v = decimal(amount[1]);
      return v === null ? null : fromAmount(v);
    }
    return null;
  }
  if (typeof discount === 'object' && discount !== null) {
    const d = discount as { percent?: unknown; amount?: unknown };
    if (typeof d.percent === 'number') return fromPercent(Math.abs(d.percent));
    if (typeof d.amount === 'number') return fromAmount(Math.abs(d.amount));
  }
  return null;
}

interface MappedLines {
  lines: HistoricalLine[];
  /** Billable lines whose unit price (and maybe quantity) was taken from the printed line total. */
  priceDerived: number;
  /** Lines with a printed discount that could not be read. */
  discountUnparsed: number;
}

function mapLines(raw: NonNullable<RawInvoice['lines']>): MappedLines | PlanIssue {
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
    if (lineTotal < 0) {
      // A printed discount line ("Rabatt 10 %" with a minus amount): stored as
      // printed, once, at its printed amount. Its discount text is the label of
      // the line, already expressed by the negative amount.
      const q = quantity ?? 1000;
      if (q === 0) return { kind: 'error', reason: 'line_quantity_invalid' };
      out.push({
        kind: 'service',
        title,
        description,
        quantity: q,
        unitLabel,
        unitPrice: unitPrice ?? Math.round((lineTotal * 1000) / q),
        discountBp: 0,
        subtotal: lineTotal,
      });
      continue;
    }
    if (unitPrice !== null && unitPrice < 0) return { kind: 'error', reason: 'line_amount_invalid' };

    // No quantity, no price and no amount (or an explicit zero quantity without amount): a text line.
    if ((quantity === null || quantity === 0) && lineTotal === 0 && (unitPrice === null || unitPrice === 0)) {
      out.push({ kind: 'text', title, description, quantity: 0, unitLabel, unitPrice: 0, discountBp: 0, subtotal: 0 });
      continue;
    }
    if (quantity === 0) return { kind: 'error', reason: 'line_quantity_invalid' };
    // A printed amount without a quantity or a unit price: imported as printed,
    // the quantity once when missing, the unit price from the line total.
    if (quantity === null) quantity = 1000;
    if (unitPrice === null) {
      unitPrice = Math.min(MAX_CENTS, Math.round((lineTotal * 1000) / quantity));
      priceDerived += 1;
    } else if (l.quantity == null) {
      priceDerived += 1;
    }
    let bp = 0;
    if (l.discount != null && l.discount !== '') {
      const parsed = discountBp(l.discount, quantity, unitPrice);
      if (parsed === null) discountUnparsed += 1;
      else bp = parsed;
    }
    // Stored as printed: the printed line total is authoritative. When it is
    // not the arithmetic of the line, the core warns (line_not_quantity_times_price).
    out.push({ kind: 'service', title, description, quantity, unitLabel, unitPrice, discountBp: bp, subtotal: lineTotal });
  }
  return { lines: out, priceDerived, discountUnparsed };
}

/**
 * Map one entry of the private JSON to the domain's historical invoice record
 * (origin `operator_file`, the sender printed on THIS invoice), or say why it
 * cannot be. `file` is the original's bytes when the entry names one (read by
 * the caller). The order of checks puts what is merely missing (skipped)
 * before what is inconsistent (error), so an incomplete entry reads as "not
 * there yet". The mapped record is parsed by the domain's own schema here, so
 * a dry run refuses exactly what the import would.
 */
export function planInvoice(
  number: number,
  rawValue: unknown,
  file: Uint8Array | null,
  now: Date = new Date(),
): PlannedInvoice {
  const parsed = rawInvoiceSchema.safeParse(rawValue);
  const loose = (rawValue ?? {}) as { issueDate?: unknown; total?: unknown; otherFiles?: unknown; currency?: unknown };
  const currency = currencyCode(loose.currency);
  const issueDate = typeof loose.issueDate === 'string' && isIsoDate(loose.issueDate) ? loose.issueDate : null;
  const totalCents = typeof loose.total === 'number' ? scaled(loose.total, 100) : null;
  const otherFiles = Array.isArray(loose.otherFiles) ? loose.otherFiles.length : 0;
  const issue = (kind: PlanIssue['kind'], reason: string): PlannedInvoice => ({
    number,
    issueDate,
    total: totalCents,
    currency,
    otherFiles,
    issue: { kind, reason },
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') || 'entry';
    return issue('error', `invalid_field:${field}`);
  }
  const r = parsed.data;

  // Missing pieces first: re-running after the input is completed imports it.
  if (r.file === null) return issue('skipped', 'file_missing');
  if (!file) return issue('skipped', 'file_missing');
  if (r.recipient === null) return issue('skipped', 'recipient_missing');
  if (r.sender === null) return issue('skipped', 'sender_missing');
  if (!r.lines || r.lines.length === 0) return issue('skipped', 'lines_missing');

  // Then consistency.
  if (!issueDate) return issue('error', 'issue_date_invalid');
  if (issueDate > berlinToday(now)) return issue('error', 'issue_date_in_future');
  // Kept as printed, never converted (an imported invoice keeps its currency).
  if (!currency) return issue('error', 'currency_invalid');
  if (r.taxTreatment !== 'small_business') return issue('error', 'tax_treatment_unsupported');
  if (r.taxAmounts != null && !(Array.isArray(r.taxAmounts) && r.taxAmounts.length === 0)) {
    return issue('error', 'tax_amounts_present');
  }
  if (totalCents === null || totalCents < 0 || totalCents > MAX_CENTS) return issue('error', 'total_invalid');

  const recipientAddress = splitAddress(r.recipient.name, r.recipient.addressLines);
  const blank = (v: string | null | undefined) => v == null || v.trim() === '';
  // The printed country, else the extraction's inference, else DE assumed (flagged, warned).
  const countryInferred = blank(r.recipient.country);
  const countryAssumed = countryInferred && blank(r.recipient.countryInferred);
  const recipientCountry = countryAssumed ? 'DE' : countryCode(countryInferred ? r.recipient.countryInferred : r.recipient.country);
  if (!recipientCountry) return issue('error', 'recipient_country_unknown');
  const senderAddress = splitAddress(r.sender.name, r.sender.addressLines);
  // Section 19 UStG is German law: an issuer without a printed country is in Germany (flagged).
  const senderCountryInferred = blank(r.sender.country);
  const senderCountry = senderCountryInferred ? 'DE' : countryCode(r.sender.country);
  if (!senderCountry) return issue('error', 'sender_country_unknown');
  if (!r.smallBusinessNote || r.smallBusinessNote.trim() === '') return issue('error', 'small_business_note_missing');

  const mapped = mapLines(r.lines);
  if ('reason' in mapped) return issue(mapped.kind, mapped.reason);
  const lines = mapped.lines;
  if (!lines.some((l) => l.kind !== 'text')) return issue('skipped', 'lines_missing');
  const sum = lines.reduce((acc, l) => acc + l.subtotal, 0);
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
    // The input says only whether these were printed; the original is the record of their values.
    taxNumber: null,
    vatId: null,
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

  let record: HistoricalInvoice;
  try {
    record = parseHistoricalInvoice(
      {
        origin: 'operator_file',
        numberValue: number,
        issueDate,
        serviceDate,
        servicePeriod,
        paymentTermsDays: terms ?? 0,
        dueDate: terms === null ? null : addDays(issueDate, terms),
        recipient: {
          kind: inferKind(r.recipient.name, r.recipient.kind),
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
        taxTreatment: 'small_business',
        taxNote: r.smallBusinessNote.trim(),
        provenance: {
          otherFilesSkipped: otherFiles,
          senderTaxNumberPrinted: r.sender.taxNumberPresent === true,
          senderVatIdPrinted: r.sender.vatIdPresent === true,
          serviceDateUnparsed:
            (r.serviceDate != null && serviceDate === null) || (r.servicePeriod != null && servicePeriod === null),
          paidOnPresent: r.paidOn != null && r.paidOn.trim() !== '',
          paymentTermsUnparsed: terms === null,
          recipientVatIdUnparsed: vatIdUnparsed,
          recipientCountryInferred: countryInferred && !countryAssumed,
          recipientCountryAssumed: countryAssumed,
          senderCountryInferred,
          linesPriceDerived: mapped.priceDerived,
          linesDiscountUnparsed: mapped.discountUnparsed,
          confidence: r.confidence ?? 'low',
        },
      },
      now,
    );
  } catch (err) {
    const paths = isBooksError(err) ? ((err.details?.issues as Array<{ path: string }> | undefined) ?? []).map((i) => i.path) : [];
    return issue('error', `invalid_record:${paths.join(',') || 'record'}`);
  }
  return { number, issueDate, total: totalCents, currency, otherFiles, issue: null, record, pdf: file };
}

// --- the originals -------------------------------------------------------------------

/** `file_unreadable` with the system's error code (ENOENT, EACCES), which names no path. */
function unreadable(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' && /^E[A-Z]+$/.test(code) ? `file_unreadable:${code}` : 'file_unreadable';
}

/**
 * Read one original from under `filesDir`. Refuses (whole run) a path that
 * leaves the directory (also through a symbolic link), a file that cannot be
 * read, an empty or oversized file, and anything that is not a PDF.
 */
export function readOriginal(filesDir: string, rel: string): Uint8Array | string {
  if (isAbsolute(rel)) return 'file_path_absolute';
  let root: string;
  let full: string;
  try {
    root = realpathSync(filesDir);
    full = realpathSync(resolve(root, rel));
  } catch (err) {
    return unreadable(err);
  }
  const inside = relative(root, full);
  if (inside === '' || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) return 'file_outside_files_dir';
  let bytes: Buffer;
  try {
    if (!statSync(full).isFile()) return 'file_unreadable:not_a_file';
    bytes = readFileSync(full);
  } catch (err) {
    return unreadable(err);
  }
  if (bytes.byteLength === 0) return 'file_empty';
  if (bytes.byteLength > MAX_ORIGINAL_BYTES) return 'file_too_large';
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return 'file_not_pdf';
  return new Uint8Array(bytes);
}

// --- the run -------------------------------------------------------------------------

export type RowStatus = 'imported' | 'already_imported' | 'would_import' | 'skipped' | 'error';

export interface ReportRow {
  number: number;
  issueDate: string | null;
  /** Cents. */
  total: number | null;
  status: RowStatus;
  /** The skip reason, the error code, or for an already imported number `differs` when its stored data no longer matches the input. */
  reason: string | null;
  otherFilesSkipped: number;
  /** What was imported (or would be) as printed but is reported: never values, codes and counts only. */
  warnings: ImportWarning[];
  /** ISO 4217 of `total`; null when the entry carries none. */
  currency: string | null;
}

export interface ImportReport {
  dryRun: boolean;
  rows: ReportRow[];
  counts: Record<RowStatus, number>;
  /** Already imported numbers whose stored total or issue date differs from the input. */
  differing: number;
  /** Per issue year, what the import holds in the books after this run (read from the books; in a dry run, plus what it would import). */
  years: Array<{ year: string; currency: string; count: number; total: number }>;
  recipients: RecipientStats;
  paidOnPresent: number;
  counterNextValue: number;
}

/** Dependencies a test replaces. */
export interface ImportDeps {
  contactBook?: ContactBook;
  recipients?: RecipientDirectory;
  now?: Date;
}

/** An amount from cents with its currency, `1234.50 EUR`, `500.00 CHF`; nothing locale-dependent. */
export function amount(cents: number | null, currency: string | null = 'EUR'): string {
  if (cents === null) return '?';
  return `${decimalAmount(cents)} ${currency ?? '???'}`;
}

/** Cents as a plain decimal, `1234.50`. */
export function decimalAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** The report line of one number: number, date, total, status. Nothing else. */
export function reportLine(row: ReportRow): string {
  const status =
    row.status === 'skipped'
      ? `skipped: ${row.reason}`
      : row.status === 'error'
        ? `error: ${row.reason}`
        : row.status === 'already_imported'
          ? row.reason === 'differs'
            ? 'already imported, BUT the stored total or issue date differs from the input (nothing was changed)'
            : 'already imported'
          : row.status === 'would_import'
            ? 'would import'
            : 'imported';
  const other = row.otherFilesSkipped > 0 ? ` (${row.otherFilesSkipped} other file(s) not stored)` : '';
  const warned = row.warnings.map((w) => ` [warning: ${w.code}${'count' in w ? ` x${w.count}` : ''}]`);
  return `invoice ${String(row.number).padStart(4)}  ${row.issueDate ?? '????-??-??'}  ${amount(row.total, row.currency).padStart(14)}  ${status}${other}${warned.join('')}`;
}

/** An error's code for the report: a BooksError's code, else the SQLSTATE and constraint, never a message. */
export function errorCode(err: unknown): string {
  if (isBooksError(err, 'IMPORT_FAILED')) {
    const d = err.details as { sqlState?: string | null; constraint?: string | null } | undefined;
    return `IMPORT_FAILED:SQLSTATE_${d?.sqlState ?? 'unknown'}${d?.constraint ? `:${d.constraint}` : ''}`;
  }
  if (isBooksError(err)) return err.code;
  const state = sqlState(err);
  if (state) return `SQLSTATE_${state}${constraintName(err) ? `:${constraintName(err)}` : ''}`;
  return err instanceof Error ? `UNEXPECTED:${err.name}` : 'UNEXPECTED';
}

/**
 * Run the import for the given argv and environment. Returns the report;
 * `log` receives report lines and the summary, never input values.
 */
export async function runBooksImport(
  argv: string[],
  env: Env,
  log: (line: string) => void,
  deps: ImportDeps = {},
): Promise<ImportReport> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'tenant-group': { type: 'string' },
      tenant: { type: 'string' },
      input: { type: 'string' },
      'files-dir': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const tenantGroupId = values['tenant-group'] ?? fail('--tenant-group is required');
  const tenantId = values.tenant ?? fail('--tenant is required');
  const inputPath = values.input ?? fail('--input is required');
  const filesDir = values['files-dir'] ?? fail('--files-dir is required');
  const dryRun = values['dry-run'] === true;
  const now = deps.now ?? new Date();

  // 1. The input and every original, before any connection.
  let text: string;
  try {
    text = readFileSync(inputPath, 'utf8');
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    fail(`the input file cannot be read${typeof code === 'string' && /^E[A-Z]+$/.test(code) ? ` (${code})` : ''}`);
  }
  const entries = parseImportFile(text);
  const fileProblems: string[] = [];
  const plans: PlannedInvoice[] = entries.map(({ number, raw }) => {
    const rel = (raw as { file?: unknown }).file;
    let file: Uint8Array | null = null;
    if (typeof rel === 'string' && rel.trim() !== '') {
      const read = readOriginal(filesDir, rel);
      if (typeof read === 'string') fileProblems.push(`${number} (${read})`);
      else file = read;
    }
    return planInvoice(number, raw, file, now);
  });
  if (fileProblems.length > 0) fail(`originals that cannot be used, by invoice number: ${fileProblems.join(', ')}`);
  // One original, one number: the same bytes named by two entries would store one revenue twice.
  const byDigest = new Map<string, number[]>();
  for (const p of plans) {
    if (p.issue !== null) continue;
    const digest = createHash('sha256').update(p.pdf).digest('hex');
    byDigest.set(digest, [...(byDigest.get(digest) ?? []), p.number]);
  }
  const shared = [...byDigest.values()].filter((ns) => ns.length > 1);
  if (shared.length > 0) fail(`the same original is named by more than one invoice number: ${shared.map((ns) => ns.join(' and ')).join(', ')}`);

  // 2. The database: the counter above every number (nothing written yet).
  const connectionString = env.COMMERCE_APP_DATABASE_URL ?? fail('COMMERCE_APP_DATABASE_URL is not set');
  if (!deps.contactBook && !env.CONTACTS_DATABASE_URL) fail('CONTACTS_DATABASE_URL is not set');
  let contactsHandle: ContactsDb | null = null;
  const contactsOf = (): ContactsDb => {
    if (!contactsHandle) {
      const url = env.CONTACTS_DATABASE_URL ?? fail('CONTACTS_DATABASE_URL is not set');
      contactsHandle = createContactsDb(url, { applicationName: 'books' });
    }
    return contactsHandle;
  };
  const book = deps.contactBook ?? contactsContactBook(contactsOf);
  const directory = deps.recipients ?? contactsRecipientDirectory(contactsOf);

  const base = createNodeDb<CommerceDB>({ connectionString, max: 1 });
  try {
    const scope = booksScope(tenantDb(base, tenantGroupId), tenantGroupId, tenantId, { recipients: directory });
    const counter = await checkImportCounter(scope.db, scope, entries.map((e) => e.number));

    // 3. The contacts database answers (a real query, not only a configured handle).
    await book.search(tenantId, { limit: 1 });

    // 4. Each number in turn. A client's new contact gets the data of its highest-numbered invoice.
    const session = newImportSession();
    for (const p of plans) {
      if (p.issue === null) session.newContactData.set(recipientKey(p.record.recipient), p.record.recipient);
    }
    const stats: RecipientStats = session.stats;
    const rows: ReportRow[] = [];
    const wouldImport: Array<{ issueDate: string; currency: string; total: number }> = [];
    let paidOnPresent = 0;

    for (const p of plans) {
      const row: ReportRow = {
        number: p.number,
        issueDate: p.issueDate,
        total: p.total,
        status: 'error',
        reason: null,
        otherFilesSkipped: p.otherFiles,
        warnings: [],
        currency: p.currency,
      };
      if (p.issue !== null) {
        row.status = p.issue.kind;
        row.reason = p.issue.reason;
        // A number this run cannot import may already be in the books from an earlier run.
        const existing = await existingInvoice(scope.db, scope, p.number);
        if (existing.state !== 'absent' && p.issue.kind === 'skipped') row.reason = `${p.issue.reason} (number ${p.number} is already in the books)`;
      } else {
        try {
          const result = dryRun
            ? await previewHistoricalInvoice(scope, book, p.record, p.pdf, session, { now })
            : await importHistoricalInvoice(scope, book, p.record, p.pdf, session, { now });
          row.status = result.status;
          if (result.status === 'already_imported' && result.differs) row.reason = 'differs';
          if (result.status !== 'already_imported') row.warnings = result.warnings;
          if (result.status === 'would_import') wouldImport.push({ issueDate: p.record.issueDate, currency: p.record.currency, total: p.record.total });
          if (p.record.provenance.paidOnPresent) paidOnPresent += 1;
        } catch (err) {
          row.status = 'error';
          row.reason = errorCode(err);
        }
      }
      rows.push(row);
      log(reportLine(row));
    }

    const counts: Record<RowStatus, number> = { imported: 0, already_imported: 0, would_import: 0, skipped: 0, error: 0 };
    for (const r of rows) counts[r.status] += 1;
    // The yearly figures are read from the books (what the import holds there,
    // whatever this run did), plus in a dry run what it would add.
    // Per year and currency: amounts of different currencies are never added up.
    const byYear = new Map<string, { year: string; currency: string; count: number; total: number }>();
    for (const y of await importedYearTotals(scope.db, scope)) byYear.set(`${y.year}|${y.currency}`, { ...y });
    for (const r of wouldImport) {
      const key = `${r.issueDate.slice(0, 4)}|${r.currency}`;
      const acc = byYear.get(key) ?? { year: r.issueDate.slice(0, 4), currency: r.currency, count: 0, total: 0 };
      acc.count += 1;
      acc.total += r.total;
      byYear.set(key, acc);
    }
    const years = [...byYear.values()].sort((a, b) => a.year.localeCompare(b.year) || a.currency.localeCompare(b.currency));

    log('');
    log(dryRun ? 'Dry run: nothing was written.' : 'Summary:');
    log(
      `  ${dryRun ? `${counts.would_import} would import` : `${counts.imported} imported`}, ${counts.already_imported} already imported, ${counts.skipped} skipped, ${counts.error} error(s), of ${rows.length} in the input`,
    );
    const differing = rows.filter((r) => r.reason === 'differs').length;
    const warned = rows.filter((r) => r.warnings.length > 0).length;
    if (warned > 0) log(`  warnings on ${warned} invoice(s) (listed above): imported as printed, check them against the originals`);
    if (differing > 0) {
      log(`  ATTENTION: ${differing} already imported invoice(s) differ from the input in total or issue date (listed above); the books were not changed`);
    }
    log(`  invoice counter stays at ${counter.nextValue} (never moved by the import)`);
    log(
      dryRun
        ? `  recipients: ${stats.contactsCreated} contact(s) would be created, ${stats.contactsReused} would be reused (${stats.addressDiffers} with a different current address, the printed one is frozen)`
        : `  recipients: ${stats.contactsCreated} contact(s) created, ${stats.contactsReused} reused (${stats.addressDiffers} with a different current address, the printed one is frozen), ${stats.customersCreated} customer(s) created`,
    );
    log(`  payment day present on ${paidOnPresent} of them; payment state stays in receipt-ocr-app (not stored in the Books)`);
    log(dryRun ? '  yearly totals the import would hold, by issue year:' : '  yearly totals of the imported invoices in the books, by issue year:');
    for (const year of [...new Set(years.map((y) => y.year))]) {
      const parts = years.filter((y) => y.year === year).map((y) => `${y.currency} ${decimalAmount(y.total)} (${y.count} invoice(s))`);
      log(`    ${year}: ${parts.join(', ')}`);
    }
    for (const c of await importedCancelled(scope.db, scope)) {
      log(`  not in these totals: ${c.count} imported invoice(s) in ${c.currency} cancelled since by a credit note, ${amount(c.total, c.currency)}`);
    }

    return { dryRun, rows, counts, differing, years, recipients: stats, paidOnPresent, counterNextValue: counter.nextValue };
  } finally {
    await base.destroy();
    if (contactsHandle) await (contactsHandle as ContactsDb).close();
  }
}

/** The process exit code for a report: 1 when any number ended in an error or differs from the books. */
export function exitCodeFor(report: ImportReport): number {
  return report.counts.error > 0 || report.differing > 0 ? 1 : 0;
}

/** Whole-run refusals of the Books whose messages are built from numbers only. */
const SAFE_MESSAGES = new Set(['COUNTER_MISSING', 'IMPORT_COUNTER_TOO_LOW']);

/**
 * The one line the script prints when the whole run is refused: our own
 * refusals (built from numbers, codes and field names), the two counter
 * refusals, and otherwise a code or an error class only, never a message that
 * could quote a value or a connection string.
 */
export function scriptErrorLine(err: unknown): string {
  if (err instanceof Error && err.message.startsWith('books:import:')) return err.message;
  if (isBooksError(err) && SAFE_MESSAGES.has(err.code)) return `books:import: ${err.message}`;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return `books:import: refused (${code})`;
  return `books:import: failed (${err instanceof Error ? err.name : 'unknown error'})`;
}

