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
  importHistoricalInvoice,
  MAX_CENTS,
  MAX_ORIGINAL_BYTES,
  newImportSession,
  parseHistoricalInvoice,
  previewHistoricalInvoice,
  recipientKey,
  type HistoricalInvoice,
  type HistoricalLine,
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
  quantity: z.number().finite(),
  unit: z.string().nullable().optional(),
  unitPrice: z.number().finite(),
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
  | { number: number; issueDate: string | null; total: number | null; otherFiles: number; issue: PlanIssue }
  | { number: number; issueDate: string; total: number; otherFiles: number; issue: null; record: HistoricalInvoice; pdf: Uint8Array };

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

/**
 * Split printed address lines into the snapshot's fields. The LAST line that
 * reads as postal code plus city gives `postalCode` and `city`; the lines before
 * it are the street block (first line `addressLine1`, the rest joined into
 * `addressLine2`); a first line repeating the name is dropped; lines after it
 * (a country line) are left out (the country is its own field). Null when no
 * line reads as postal code plus city, or no street line precedes it.
 */
export function splitAddress(
  name: string,
  lines: readonly string[],
): { addressLines: string[]; addressLine1: string; addressLine2: string | null; postalCode: string; city: string } | null {
  const clean = lines.map((l) => l.trim()).filter((l) => l !== '');
  let at = -1;
  for (let i = clean.length - 1; i >= 0; i -= 1) {
    if (POSTAL_LINE.test(clean[i])) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const m = POSTAL_LINE.exec(clean[at])!;
  const street = clean.slice(0, at);
  if (street.length > 0 && street[0].toLowerCase() === name.trim().toLowerCase()) street.shift();
  if (street.length === 0) return null;
  return {
    addressLines: clean,
    addressLine1: street[0],
    addressLine2: street.length > 1 ? street.slice(1).join(', ') : null,
    postalCode: m[1],
    city: m[2].trim(),
  };
}

/** `x` in hundredths (cents) or thousandths, exactly; null when `x` carries finer digits. */
function scaled(x: number, factor: 100 | 1000): number | null {
  const v = Math.round(x * factor);
  return Math.abs(x * factor - v) < 1e-6 ? v : null;
}

/** Payment terms in days when the printed text states them ("14 Tage", "zahlbar sofort"); null otherwise. */
export function paymentTermsDays(text: string | null | undefined): number | null {
  if (!text) return null;
  const days = /(\d{1,3})\s*(?:Tage|Tagen|Tag|days?)\b/i.exec(text);
  if (days) {
    const n = Number(days[1]);
    return n <= 365 ? n : null;
  }
  if (/\bsofort\b|\bimmediately\b/i.test(text)) return 0;
  return null;
}

function servicePeriodOf(value: unknown): { start: string; end: string } | null {
  const p = periodSchema.safeParse(value);
  if (!p.success) return null;
  const start = 'start' in p.data ? p.data.start : p.data.from;
  const end = 'end' in p.data ? p.data.end : p.data.to;
  return isIsoDate(start) && isIsoDate(end) && start <= end ? { start, end } : null;
}

function mapLines(raw: NonNullable<RawInvoice['lines']>): HistoricalLine[] | PlanIssue {
  const out: HistoricalLine[] = [];
  for (const l of raw) {
    const text = l.description.trim();
    if (text === '') return { kind: 'error', reason: 'line_text_missing' };
    if (text.length > 4000) return { kind: 'error', reason: 'line_text_too_long' };
    const title = text.length <= 300 ? text : `${text.slice(0, 299)}…`;
    const description = text.length <= 300 ? null : text;
    const quantity = scaled(l.quantity, 1000);
    const unitPrice = scaled(l.unitPrice, 100);
    const lineTotal = scaled(l.lineTotal, 100);
    if (quantity === null || quantity < 0) return { kind: 'error', reason: 'line_quantity_invalid' };
    if (unitPrice === null || lineTotal === null || unitPrice < 0 || lineTotal < 0 || unitPrice > MAX_CENTS || lineTotal > MAX_CENTS) {
      return { kind: 'error', reason: 'line_amount_invalid' };
    }
    if (quantity === 0) {
      // A line without quantity is a text line, and carries no amount.
      if (unitPrice !== 0 || lineTotal !== 0) return { kind: 'error', reason: 'line_quantity_invalid' };
      out.push({ kind: 'text', title, description, quantity: 0, unitLabel: (l.unit ?? '').trim() || 'Stk', unitPrice: 0, discountBp: 0, subtotal: 0 });
      continue;
    }
    // The printed line total is the subtotal; a discount is derived from it.
    const gross = Math.round((quantity * unitPrice) / 1000);
    let discountBp = 0;
    if (Math.abs(lineTotal - gross) > 1) {
      if (lineTotal > gross) return { kind: 'error', reason: 'line_total_above_quantity_times_price' };
      discountBp = Math.round(((gross - lineTotal) * 10000) / gross);
    }
    out.push({
      kind: 'service',
      title,
      description,
      quantity,
      unitLabel: (l.unit ?? '').trim().slice(0, 40) || 'Stk',
      unitPrice,
      discountBp,
      subtotal: lineTotal,
    });
  }
  return out;
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
  const loose = (rawValue ?? {}) as { issueDate?: unknown; total?: unknown; otherFiles?: unknown };
  const issueDate = typeof loose.issueDate === 'string' && isIsoDate(loose.issueDate) ? loose.issueDate : null;
  const totalCents = typeof loose.total === 'number' ? scaled(loose.total, 100) : null;
  const otherFiles = Array.isArray(loose.otherFiles) ? loose.otherFiles.length : 0;
  const issue = (kind: PlanIssue['kind'], reason: string): PlannedInvoice => ({
    number,
    issueDate,
    total: totalCents,
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
  if (r.currency.trim().toUpperCase() !== 'EUR') return issue('error', 'currency_unsupported');
  if (r.taxTreatment !== 'small_business') return issue('error', 'tax_treatment_unsupported');
  if (r.taxAmounts != null && !(Array.isArray(r.taxAmounts) && r.taxAmounts.length === 0)) {
    return issue('error', 'tax_amounts_present');
  }
  if (totalCents === null || totalCents < 0 || totalCents > MAX_CENTS) return issue('error', 'total_invalid');

  const recipientAddress = splitAddress(r.recipient.name, r.recipient.addressLines);
  if (!recipientAddress) return issue('error', 'recipient_address_unparsed');
  const recipientCountry = countryCode(r.recipient.country ?? r.recipient.countryInferred);
  if (!recipientCountry) return issue('error', 'recipient_country_unknown');
  const senderAddress = splitAddress(r.sender.name, r.sender.addressLines);
  if (!senderAddress) return issue('error', 'sender_address_unparsed');
  const senderCountry = countryCode(r.sender.country);
  if (!senderCountry) return issue('error', 'sender_country_unknown');
  if (!r.smallBusinessNote || r.smallBusinessNote.trim() === '') return issue('error', 'small_business_note_missing');

  const lines = mapLines(r.lines);
  if (!Array.isArray(lines)) return issue(lines.kind, lines.reason);
  if (!lines.some((l) => l.kind !== 'text')) return issue('skipped', 'lines_missing');
  const sum = lines.reduce((acc, l) => acc + l.subtotal, 0);
  if (sum !== totalCents) return issue('error', 'lines_do_not_sum_to_total');

  let vatId: string | null = null;
  if (r.recipientVatId && r.recipientVatId.trim() !== '') {
    const v = normalizeVatId(r.recipientVatId);
    vatId = /^[A-Z]{2}[A-Z0-9+*]{2,13}$/.test(v) ? v : null;
  }
  const rawNumber = r.recipient.customerNumber;
  const numberText = rawNumber == null ? null : String(rawNumber).trim() || null;
  const numberInt = numberText !== null && /^\d{1,9}$/.test(numberText) ? Number(numberText) : null;

  const sender: SenderBlockV1 & { addressLines: string[] } = {
    legalName: r.sender.name.trim(),
    addressLine1: senderAddress.addressLine1,
    addressLine2: senderAddress.addressLine2,
    postalCode: senderAddress.postalCode,
    city: senderAddress.city,
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
        taxTreatment: 'small_business',
        taxNote: r.smallBusinessNote.trim(),
        provenance: {
          otherFilesSkipped: otherFiles,
          senderTaxNumberPrinted: r.sender.taxNumberPresent === true,
          senderVatIdPrinted: r.sender.vatIdPresent === true,
          serviceDateUnparsed:
            (r.serviceDate != null && serviceDate === null) || (r.servicePeriod != null && servicePeriod === null),
          paidOnPresent: r.paidOn != null && r.paidOn.trim() !== '',
          confidence: r.confidence ?? 'low',
        },
      },
      now,
    );
  } catch (err) {
    const paths = isBooksError(err) ? ((err.details?.issues as Array<{ path: string }> | undefined) ?? []).map((i) => i.path) : [];
    return issue('error', `invalid_record:${paths.join(',') || 'record'}`);
  }
  return { number, issueDate, total: totalCents, otherFiles, issue: null, record, pdf: file };
}

// --- the originals -------------------------------------------------------------------

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
  } catch {
    return 'file_unreadable';
  }
  const inside = relative(root, full);
  if (inside === '' || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) return 'file_outside_files_dir';
  let bytes: Buffer;
  try {
    if (!statSync(full).isFile()) return 'file_unreadable';
    bytes = readFileSync(full);
  } catch {
    return 'file_unreadable';
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
  /** The skip reason or the error code. */
  reason: string | null;
  otherFilesSkipped: number;
}

export interface ImportReport {
  dryRun: boolean;
  rows: ReportRow[];
  counts: Record<RowStatus, number>;
  /** Per issue year, what the import has in the books after this run (imported now plus already imported; in a dry run, plus would import). */
  years: Array<{ year: string; count: number; total: number }>;
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

/** Euro amount from cents, `1234.50 EUR`; nothing locale-dependent. */
export function euros(cents: number | null): string {
  if (cents === null) return '?';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')} EUR`;
}

/** The report line of one number: number, date, total, status. Nothing else. */
export function reportLine(row: ReportRow): string {
  const status =
    row.status === 'skipped'
      ? `skipped: ${row.reason}`
      : row.status === 'error'
        ? `error: ${row.reason}`
        : row.status === 'already_imported'
          ? 'already imported'
          : row.status === 'would_import'
            ? 'would import'
            : 'imported';
  const other = row.otherFilesSkipped > 0 ? ` (${row.otherFilesSkipped} other file(s) not stored)` : '';
  return `invoice ${String(row.number).padStart(4)}  ${row.issueDate ?? '????-??-??'}  ${euros(row.total).padStart(14)}  ${status}${other}`;
}

/** An error's code for the report: a BooksError's code, else the SQLSTATE and constraint, never a message. */
export function errorCode(err: unknown): string {
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
  } catch {
    fail('the input file cannot be read');
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

  // 2. The database: the counter above every number (nothing written yet).
  const connectionString = env.COMMERCE_APP_DATABASE_URL ?? fail('COMMERCE_APP_DATABASE_URL is not set');
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

    // 4. Each number in turn. A client's new contact gets its most recent invoice's data.
    const session = newImportSession();
    for (const p of plans) {
      if (p.issue === null) session.newContactData.set(recipientKey(p.record.recipient), p.record.recipient);
    }
    const stats: RecipientStats = session.stats;
    const rows: ReportRow[] = [];
    const inBooks: Array<{ issueDate: string; total: number }> = [];
    let paidOnPresent = 0;

    for (const p of plans) {
      const row: ReportRow = {
        number: p.number,
        issueDate: p.issueDate,
        total: p.total,
        status: 'error',
        reason: null,
        otherFilesSkipped: p.otherFiles,
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
          inBooks.push({ issueDate: p.record.issueDate, total: p.record.total });
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
    const byYear = new Map<string, { count: number; total: number }>();
    for (const r of inBooks) {
      const y = r.issueDate.slice(0, 4);
      const acc = byYear.get(y) ?? { count: 0, total: 0 };
      acc.count += 1;
      acc.total += r.total;
      byYear.set(y, acc);
    }
    const years = [...byYear.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([year, v]) => ({ year, ...v }));

    log('');
    log(dryRun ? 'Dry run: nothing was written.' : 'Summary:');
    log(
      `  ${dryRun ? `${counts.would_import} would import` : `${counts.imported} imported`}, ${counts.already_imported} already imported, ${counts.skipped} skipped, ${counts.error} error(s), of ${rows.length} in the input`,
    );
    log(`  invoice counter stays at ${counter.nextValue} (never moved by the import)`);
    log(
      dryRun
        ? `  recipients: ${stats.contactsCreated} contact(s) would be created, ${stats.contactsReused} would be reused (${stats.addressDiffers} with a different current address, the printed one is frozen)`
        : `  recipients: ${stats.contactsCreated} contact(s) created, ${stats.contactsReused} reused (${stats.addressDiffers} with a different current address, the printed one is frozen), ${stats.customersCreated} customer(s) created`,
    );
    log(`  payment day present on ${paidOnPresent} of them; payment state stays in receipt-ocr-app (not stored in the Books)`);
    log(dryRun ? '  yearly totals the import would hold, by issue year:' : '  yearly totals of the imported invoices in the books, by issue year:');
    for (const y of years) log(`    ${y.year}: ${String(y.count).padStart(3)} invoice(s), ${euros(y.total)}`);

    return { dryRun, rows, counts, years, recipients: stats, paidOnPresent, counterNextValue: counter.nextValue };
  } finally {
    await base.destroy();
    if (contactsHandle) await (contactsHandle as ContactsDb).close();
  }
}

/** The process exit code for a report: 1 when any number ended in an error. */
export function exitCodeFor(report: ImportReport): number {
  return report.counts.error > 0 ? 1 : 0;
}

