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
  importedYearTotals,
  importHistoricalInvoice,
  MAX_ORIGINAL_BYTES,
  newImportSession,
  previewHistoricalInvoice,
  recipientKey,
  type HistoricalInvoice,
  type ImportWarning,
  type RecipientStats,
} from './importInvoices';
import { currencyCode, mapPrintedInvoice, rawInvoiceSchema, type PlanIssue } from './importPrinted';
import { isIsoDate } from './numbering';
import { contactsRecipientDirectory, type RecipientDirectory } from './recipients';
import { booksScope } from './scope';

/** The environment the run reads (process.env in the script, a plain object in tests). */
export type Env = Record<string, string | undefined>;

function fail(message: string): never {
  throw new Error(`books:import: ${message}`);
}

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

/**
 * Map one entry of the private JSON to the domain's historical invoice record
 * (origin `operator_file`, the sender printed on that invoice), or say why it
 * cannot be: the file first (a missing original is "not there yet"), then the
 * shared mapping of a printed invoice (importPrinted.ts), which the upload
 * import uses too.
 */
export function planInvoice(
  number: number,
  rawValue: unknown,
  file: Uint8Array | null,
  now: Date = new Date(),
): PlannedInvoice {
  const loose = (rawValue ?? {}) as { issueDate?: unknown; total?: unknown; otherFiles?: unknown; currency?: unknown; file?: unknown };
  const currency = currencyCode(loose.currency);
  const issueDate = typeof loose.issueDate === 'string' && isIsoDate(loose.issueDate) ? loose.issueDate : null;
  const totalCents = typeof loose.total === 'number' ? Math.round(loose.total * 100) : null;
  const otherFiles = Array.isArray(loose.otherFiles) ? loose.otherFiles.length : 0;
  const issue = (i: PlanIssue): PlannedInvoice => ({ number, issueDate, total: totalCents, currency, otherFiles, issue: i });
  // Missing pieces first: re-running after the input is completed imports it.
  if (loose.file === null || !file) {
    const shape = rawInvoiceSchema.safeParse(rawValue);
    if (!shape.success) return issue({ kind: 'error', reason: `invalid_field:${shape.error.issues[0]?.path.join('.') || 'entry'}` });
    return issue({ kind: 'skipped', reason: 'file_missing' });
  }
  const mapped = mapPrintedInvoice(rawValue, { origin: 'operator_file', now, otherFiles });
  if (!mapped.ok) return issue(mapped.issue);
  const r = mapped.record;
  return { number, issueDate: r.issueDate, total: r.total, currency: r.currency, otherFiles, issue: null, record: r, pdf: file };
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

