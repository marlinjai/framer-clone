// src/server/books/upload/service.ts
//
// The upload import's operations (docs/plans/2026-10-20-books-upload-import.md),
// called by the /api/books/imports routes:
//
//   stage    one uploaded PDF: magic bytes and size checked, hashed, stored as a
//            staging row (`uploaded`); a file already staged or imported is a
//            duplicate and is never read again (no model cost);
//   extract  read the row's PDF with the model (extract.ts) under the limits
//            (limits.ts), store the transcription with a fresh extraction id,
//            drop any correction of an earlier extraction, validate;
//   correct  store the user's corrected printed invoice, keyed to the current
//            extraction and the row's version, validate again (a correction
//            identical to what is stored changes nothing);
//   confirm  validate once more and import through the core
//            (importHistoricalInvoice, origin `upload_extracted`, counter policy
//            `raise`), marking the row imported INSIDE the import transaction;
//            a failed import leaves the row `ready` with the problem named;
//   by hand  a row the model could not read (refused, too long, unreadable)
//            gets an empty manual reading the user fills in, keyed like any
//            other reading;
//   discard  set the row aside and clear its bytes at once; the same file can
//            be staged again.
//
// Logs carry item ids, statuses, sizes and codes, never extracted values or
// file names (plan decision 9).

import { createHash, randomUUID } from 'node:crypto';

import type Anthropic from '@anthropic-ai/sdk';
import { sql } from 'kysely';

import type { AiModelKey } from '@/lib/ai/anthropicClient';

import type { ContactBook } from '../contactBook';
import { BooksError, isBooksError } from '../errors';
import { counterRaiseUnconfirmed, IMPORT_RENDERER, importHistoricalInvoice, newImportSession } from '../importInvoices';
import type { BooksScope } from '../scope';
import { readSettings } from '../settings';
import { extractPrintedInvoice } from './extract';
import { describeError } from '../http/describeError';
import { CLAIM_TIMEOUT_MS, DAILY_WINDOW_MS, EXTRACT_CALL_BUDGET_MS, type CompanySlots } from './limits';
import {
  extractionsSince,
  finishExtraction,
  getItem,
  insertItem,
  itemContent,
  listImportedItems,
  listOpenItems,
  liveItemBySha,
  startExtraction,
  updateItem,
  withoutNul,
  type ExtractionOutcome,
  type ImportItem,
  type Problem,
} from './staging';
import { stagedNumber, validateItem } from './validate';

/** The largest PDF one upload takes (plan: 10 MB). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * How many rows a company may have open (not imported, not discarded) at once,
 * and how many bytes they may hold together: the bound on what the staging
 * table keeps per company (four full uploads of 50, at most 512 MB).
 */
export const MAX_OPEN_ITEMS = 200;
export const MAX_OPEN_BYTES = 512 * 1024 * 1024;

/** How many imported rows the review table shows (the newest; the total is counted). */
export const IMPORTED_SHOWN = 100;

/** A file name as the review table shows it: the last path segment, control characters out, at most 255 characters. */
export function cleanFileName(raw: string | null | undefined): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (clean === '' ? 'invoice.pdf' : clean).slice(0, 255);
}

export type StageResult =
  | { status: 'staged'; item: ImportItem }
  | { status: 'duplicate'; item: ImportItem | null; documentId: string | null };

/** Stage one uploaded PDF. */
export async function stageUpload(scope: BooksScope, file: { fileName: string; bytes: Uint8Array }): Promise<StageResult> {
  const bytes = file.bytes;
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new BooksError('INVALID_INPUT', `INVALID_INPUT: file (at most ${MAX_UPLOAD_BYTES} bytes)`, {
      issues: [{ path: 'file', message: `a PDF of at most ${MAX_UPLOAD_BYTES} bytes` }],
    });
  }
  if (!isPdfBytes(bytes)) {
    throw new BooksError('INVALID_INPUT', 'INVALID_INPUT: file (not a PDF)', { issues: [{ path: 'file', message: 'not a PDF' }] });
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const staged = await liveItemBySha(scope.db, scope, sha256);
  if (staged) return { status: 'duplicate', item: staged, documentId: staged.documentId };
  // A file imported before (by an earlier upload or by `pnpm books:import`).
  const imported = await scope.db
    .selectFrom('sales_document_file')
    .select('document_id')
    .where('tenant_id', '=', scope.tenantId)
    .where('sha256', '=', sha256)
    .where('renderer', '=', IMPORT_RENDERER)
    .executeTakeFirst();
  if (imported) return { status: 'duplicate', item: null, documentId: imported.document_id };

  try {
    // The open-row bounds, counted and the row inserted under one company lock (parallel uploads cannot pass them together).
    const item = await scope.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`books-import-stage:${scope.tenantId}`}, 0))`.execute(trx);
      const open = await trx
        .selectFrom('historical_import_item')
        .select((eb) => [eb.fn.countAll<string>().as('n'), eb.fn.coalesce(eb.fn.sum<string>('byte_size'), eb.lit(0)).as('bytes')])
        .where('tenant_id', '=', scope.tenantId)
        .where('status', 'not in', ['imported', 'discarded'])
        .executeTakeFirstOrThrow();
      if (Number(open.n) >= MAX_OPEN_ITEMS || Number(open.bytes) + bytes.byteLength > MAX_OPEN_BYTES) {
        throw new BooksError('IMPORT_LIMIT', `IMPORT_LIMIT: at most ${MAX_OPEN_ITEMS} files (${MAX_OPEN_BYTES} bytes) can be open at once`, {
          limit: MAX_OPEN_ITEMS,
        });
      }
      return insertItem(trx, scope, { fileName: cleanFileName(file.fileName), bytes, sha256 });
    });
    return { status: 'staged', item };
  } catch (err) {
    // Two uploads of the same file at once: the loser sees the winner's row.
    if ((err as { code?: unknown }).code === '23505') {
      const winner = await liveItemBySha(scope.db, scope, sha256);
      if (winner) return { status: 'duplicate', item: winner, documentId: winner.documentId };
    }
    throw err;
  }
}

/** Validate a row and store the outcome (when it is still at `version`); returns the row as stored. */
async function revalidate(scope: BooksScope, book: ContactBook, item: ImportItem, now: Date): Promise<ImportItem> {
  const bytes = await itemContent(scope.db, scope, item.id);
  if (!bytes) throw new BooksError('NOT_RENDERABLE', 'NOT_RENDERABLE: the uploaded file is no longer stored', { itemId: item.id });
  const [others, settings] = await Promise.all([listOpenItems(scope.db, scope), readSettings(scope.db, scope)]);
  const v = await validateItem(scope, book, item, { bytes, others, companySender: settings?.senderBlock ?? null, now });
  const stored = await updateItem(scope.db, scope, item.id, { status: v.status, problems: v.problems }, {
    expectedVersion: item.version,
    whenStatus: ['ready', 'needs_attention'],
  });
  if (!stored) throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the row changed meanwhile; reload it', { itemId: item.id });
  return stored;
}

export interface ExtractDeps {
  anthropic: Anthropic;
  modelKey: AiModelKey;
  modelId: string;
  slots: CompanySlots;
  dailyLimit: number;
  signal: AbortSignal;
  contactBook: ContactBook;
  now?: () => Date;
  /** The time budget of the whole call (tests shorten it); default EXTRACT_CALL_BUDGET_MS. */
  callBudgetMs?: number;
}

/**
 * Read one staged row with the model. Refusals before any call: a row that is
 * imported or discarded (CONCURRENT_EDIT), a row whose reading the user typed
 * by hand or corrected, unless `replace` says to read it again anyway
 * (READING_WOULD_BE_REPLACED), a row already being read (EXTRACTION_RUNNING,
 * until its claim times out), the company's four slots in use (EXTRACT_BUSY),
 * the daily ceiling reached (IMPORT_LIMIT, counted and recorded atomically, so
 * parallel calls cannot pass it together). The claim carries the extraction's
 * id: a call whose claim was taken over writes nothing. The call as a whole is
 * bounded by EXTRACT_CALL_BUDGET_MS, below the claim timeout. A failed call is
 * recorded in the ledger; a row without a reading says why, a row with one
 * keeps it (the failure noted); an aborted call puts the row back as it was.
 */
export async function extractItem(scope: BooksScope, itemId: string, deps: ExtractDeps, opts: { replace?: boolean } = {}): Promise<ImportItem> {
  const clock = deps.now ?? (() => new Date());
  const item = await getItem(scope.db, scope, itemId);
  if (item.status === 'imported' || item.status === 'discarded') {
    throw new BooksError('CONCURRENT_EDIT', `CONCURRENT_EDIT: the row is ${item.status}`, { itemId, status: item.status });
  }
  // What the user typed is never replaced by a reading nobody asked for (a queue, a resume).
  const typed = item.extractionId?.startsWith('manual:') === true || item.corrected !== null;
  if (typed && !opts.replace && (item.status === 'ready' || item.status === 'needs_attention')) {
    throw new BooksError('READING_WOULD_BE_REPLACED', 'READING_WOULD_BE_REPLACED: this row holds what you entered; read it again only if you mean to replace it', { itemId });
  }
  // What the row goes back to when the call is aborted, never made, or fails with a reading kept.
  const previous = item.status === 'extracting' ? (item.extracted ? 'needs_attention' : 'uploaded') : item.status;
  const slot = deps.slots.acquire(scope.tenantId);
  if (!slot.ok) throw new BooksError('EXTRACT_BUSY', 'EXTRACT_BUSY: four invoices are being read for this company; try again shortly', { retryAfterSec: slot.retryAfterSec });
  try {
    const started = clock();
    const claimId = randomUUID();
    // The durable claim: one extraction per file at a time; a stale claim (crash) may be taken over.
    const claimed =
      item.status === 'extracting'
        ? await updateItem(scope.db, scope, itemId, { status: 'extracting', claimedAt: started, claimId }, {
            expectedVersion: item.version,
            whenStatus: ['extracting'],
            claimedBefore: new Date(started.getTime() - CLAIM_TIMEOUT_MS),
          })
        : await updateItem(scope.db, scope, itemId, { status: 'extracting', claimedAt: started, claimId }, {
            expectedVersion: item.version,
            whenStatus: ['uploaded', 'ready', 'needs_attention'],
          });
    if (!claimed) {
      // Say what really happened: set aside or imported meanwhile, or being read.
      const now = await getItem(scope.db, scope, itemId);
      if (now.status === 'imported' || now.status === 'discarded') {
        throw new BooksError('CONCURRENT_EDIT', `CONCURRENT_EDIT: the row is ${now.status}`, { itemId, status: now.status });
      }
      if (now.status === 'extracting') throw new BooksError('EXTRACTION_RUNNING', 'EXTRACTION_RUNNING: this invoice is being read already', { itemId });
      throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the row changed meanwhile; reload it', { itemId });
    }
    // Back to what it was; a failure to do so is logged (the claim then expires) and never hides the caller's error.
    const release = async (): Promise<ImportItem | null> => {
      try {
        return await updateItem(scope.db, scope, itemId, { status: previous, claimedAt: null, claimId: null }, { whenStatus: ['extracting'], claimId });
      } catch (err) {
        console.error(`[books-import] item ${itemId}: the claim could not be released: ${describeError(err)}`);
        return null;
      }
    };
    let bytes: Uint8Array | null;
    try {
      bytes = await itemContent(scope.db, scope, itemId);
      if (!bytes) throw new BooksError('NOT_RENDERABLE', 'NOT_RENDERABLE: the uploaded file is no longer stored', { itemId });
      // The caller already left: no call, nothing counted.
      if (deps.signal.aborted) {
        await release();
        return getItem(scope.db, scope, itemId);
      }
      // The daily ceiling, counted and recorded under one company lock.
      await scope.db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`books-import-extract:${scope.tenantId}`}, 0))`.execute(trx);
        const recent = await extractionsSince(trx, scope, new Date(started.getTime() - DAILY_WINDOW_MS));
        if (recent >= deps.dailyLimit) {
          throw new BooksError('IMPORT_LIMIT', `IMPORT_LIMIT: at most ${deps.dailyLimit} invoices are read per day for a company`, { limit: deps.dailyLimit });
        }
        await startExtraction(trx, scope, claimId, itemId, deps.modelId, started);
      });
    } catch (err) {
      await release();
      throw err;
    }

    let outcome: ExtractionOutcome = 'error';
    // Accumulated by the call across its attempts, also when a later attempt throws.
    const usage = { inputTokens: 0, outputTokens: 0 };
    let read: { printed: Record<string, unknown>; confidence: Record<string, 'high' | 'medium' | 'low'> } | null = null;
    // The whole call is bounded (the SDK's timeout covers only the wait for the response headers,
    // not a stream that stalls after them): below the claim timeout, so a running call is never taken over.
    // One signal for both (composed by hand: no reliance on AbortSignal.any).
    const budget = new AbortController();
    const call = new AbortController();
    const onAbort = () => call.abort();
    deps.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      budget.abort();
      call.abort();
    }, deps.callBudgetMs ?? EXTRACT_CALL_BUDGET_MS);
    try {
      const result = await extractPrintedInvoice(deps.anthropic, bytes, { modelKey: deps.modelKey, signal: call.signal, usage });
      if (result.ok) {
        outcome = 'ok';
        read = { printed: result.printed, confidence: result.confidence };
      } else {
        outcome = result.outcome;
      }
    } catch (err) {
      outcome = deps.signal.aborted ? 'aborted' : budget.signal.aborted ? 'error' : failureOutcome(err);
      if (outcome !== 'aborted') {
        const status = (err as { status?: unknown })?.status;
        console.error(
          `[books-import] item ${itemId}: extraction failed (${typeof status === 'number' ? status : budget.signal.aborted ? 'time budget' : 'no status'}, ${outcome})`,
        );
      }
    } finally {
      clearTimeout(timer);
      deps.signal.removeEventListener('abort', onAbort);
    }
    try {
      await finishExtraction(scope.db, scope, claimId, outcome, usage, clock());
    } catch (err) {
      // The ledger row stays open (and still counts): the row itself must not stay claimed.
      console.error(`[books-import] item ${itemId}: the ledger could not be finished: ${describeError(err)}`);
    }
    const finished = clock();

    if (outcome === 'aborted') {
      // The caller left: the row is as it was before (a reading and its correction kept), free to be read again.
      return (await release()) ?? (await getItem(scope.db, scope, itemId));
    }
    // A failed call: a row without a reading says why (blocking); a row with one keeps it and its status, the failure noted.
    const failRow = async (code: ExtractionOutcome): Promise<ImportItem | null> => {
      try {
        return await updateItem(
          scope.db,
          scope,
          itemId,
          item.extracted
            ? {
                status: previous,
                claimedAt: null,
                claimId: null,
                problems: [...item.problems.filter((p) => !p.code.startsWith('reread_failed:')), { code: `reread_failed:${code}`, path: null, blocking: false, count: null }],
              }
            : {
                status: 'needs_attention',
                claimedAt: null,
                claimId: null,
                extractionError: code,
                problems: [{ code: `extraction_failed:${code}`, path: null, blocking: true, count: null }],
                model: deps.modelId,
              },
          { whenStatus: ['extracting'], claimId },
        );
      } catch (err) {
        console.error(`[books-import] item ${itemId}: the failed reading could not be recorded: ${describeError(err)}`);
        return null;
      }
    };
    if (!read) return (await failRow(outcome)) ?? (await getItem(scope.db, scope, itemId));
    // The new extraction replaces the old one; a correction of the old one is dropped (keyed).
    let stored: ImportItem | null;
    try {
      stored = await updateItem(
        scope.db,
        scope,
        itemId,
        {
          status: 'needs_attention',
          claimedAt: null,
          claimId: null,
          extractionId: claimId,
          extracted: read,
          extractionError: null,
          corrected: null,
          numberConfirmed: null,
          problems: [],
          model: deps.modelId,
        },
        { whenStatus: ['extracting'], claimId },
      );
    } catch (err) {
      // The reading could not be stored: the row says so instead of staying claimed.
      await failRow('error');
      throw err;
    }
    // Discarded, or taken over by another call, while being read: this reading is not attached.
    if (!stored) return getItem(scope.db, scope, itemId);
    return revalidate(scope, deps.contactBook, stored, finished);
  } finally {
    slot.release();
  }
}

/**
 * How a thrown provider error ends a call: `unreadable` only when the API
 * refused the PDF itself (a 413, or a 400 about the document), which reading
 * again cannot change; any other error (a 400 about the account or the
 * request, a 5xx, the network) stays `error`, which may be read again.
 */
export function failureOutcome(err: unknown): ExtractionOutcome {
  const status = (err as { status?: unknown })?.status;
  if (status === 413) return 'unreadable';
  if (status !== 400) return 'error';
  const e = err as { error?: { error?: { message?: unknown } }; message?: unknown };
  const message = typeof e.error?.error?.message === 'string' ? e.error.error.message : typeof e.message === 'string' ? e.message : '';
  return /\b(pdf|document)\b/i.test(message) && !/credit|billing|balance|api key/i.test(message) ? 'unreadable' : 'error';
}

/** The printed invoice a manual reading starts from: the shared shape, nothing filled in. */
export function emptyPrinted(): Record<string, unknown> {
  return {
    number: null,
    issueDate: null,
    serviceDate: null,
    servicePeriod: null,
    recipient: null,
    recipientVatId: null,
    sender: null,
    lines: [],
    total: null,
    currency: 'EUR',
    taxTreatment: null,
    taxAmounts: [],
    pricesIncludeVat: false,
    taxNote: null,
    paymentTerms: null,
  };
}

/**
 * Fill in a row by hand when the model has no reading of it (refused, too
 * long, unreadable, or the daily ceiling reached): the row gets an empty
 * manual reading (`manual:<id>`, no model call, nothing in the ledger) that the
 * user corrects like any other; reading it with the model later replaces it.
 */
export async function enterByHand(
  scope: BooksScope,
  book: ContactBook,
  itemId: string,
  input: { expectedVersion: number },
  now: Date = new Date(),
): Promise<ImportItem> {
  const item = await getItem(scope.db, scope, itemId);
  if ((item.status !== 'uploaded' && item.status !== 'needs_attention') || item.extracted !== null) {
    throw new BooksError('CONCURRENT_EDIT', `CONCURRENT_EDIT: the row is ${item.status}${item.extracted ? ' and has a reading' : ''}`, {
      itemId,
      status: item.status,
    });
  }
  const stored = await updateItem(
    scope.db,
    scope,
    itemId,
    {
      status: 'needs_attention',
      extractionId: `manual:${randomUUID()}`,
      extracted: { printed: emptyPrinted(), confidence: {} },
      extractionError: null,
      corrected: null,
      numberConfirmed: null,
      problems: [],
    },
    { expectedVersion: input.expectedVersion, whenStatus: ['uploaded', 'needs_attention'] },
  );
  if (!stored) throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the row changed meanwhile; reload it', { itemId });
  return revalidate(scope, book, stored, now);
}

/**
 * Store the user's corrected printed invoice for the row's CURRENT extraction
 * (`extractionId`) at `expectedVersion`, and validate again. A correction of an
 * extraction that is no longer current is STALE_EXTRACTION; a correction equal
 * to what is stored changes nothing (no gratuitous version bump).
 */
export async function correctItem(
  scope: BooksScope,
  book: ContactBook,
  itemId: string,
  input: { printed: Record<string, unknown>; extractionId: string; expectedVersion: number },
  now: Date = new Date(),
): Promise<ImportItem> {
  const printed = withoutNul(input.printed);
  const item = await getItem(scope.db, scope, itemId);
  if (item.status !== 'ready' && item.status !== 'needs_attention') {
    throw new BooksError('CONCURRENT_EDIT', `CONCURRENT_EDIT: the row is ${item.status}`, { itemId, status: item.status });
  }
  if (item.extractionId === null || item.extractionId !== input.extractionId) {
    throw new BooksError('STALE_EXTRACTION', 'STALE_EXTRACTION: the invoice was read again since; reload it', { itemId });
  }
  if (item.version !== input.expectedVersion) {
    throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the row changed meanwhile; reload it', { itemId });
  }
  const current = item.corrected ?? item.extracted?.printed ?? null;
  if (JSON.stringify(current) === JSON.stringify(printed)) return item;
  const stored = await updateItem(scope.db, scope, itemId, { corrected: { printed, extractionId: input.extractionId } }, {
    expectedVersion: input.expectedVersion,
    whenStatus: ['ready', 'needs_attention'],
  });
  if (!stored) throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the row changed meanwhile; reload it', { itemId });
  return revalidate(scope, book, stored, now);
}

/** Validate a row again without changing it (after the contacts database came back, or the counter moved). */
export async function recheckItem(scope: BooksScope, book: ContactBook, itemId: string, now: Date = new Date()): Promise<ImportItem> {
  const item = await getItem(scope.db, scope, itemId);
  if (item.status !== 'ready' && item.status !== 'needs_attention') return item;
  return revalidate(scope, book, item, now);
}

/**
 * The user confirms that a number jumping far ahead (`number_jump`) is right,
 * for exactly the row's current printed number and version; changing the
 * number afterwards makes the problem return. Validated again.
 */
export async function confirmNumber(
  scope: BooksScope,
  book: ContactBook,
  itemId: string,
  input: { documentNumber: string; expectedVersion: number },
  now: Date = new Date(),
): Promise<ImportItem> {
  const item = await getItem(scope.db, scope, itemId);
  if (item.status !== 'ready' && item.status !== 'needs_attention') {
    throw new BooksError('CONCURRENT_EDIT', `CONCURRENT_EDIT: the row is ${item.status}`, { itemId, status: item.status });
  }
  const current = stagedNumber(item);
  if (item.version !== input.expectedVersion || current === null || current !== input.documentNumber.trim()) {
    throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the number changed meanwhile; check it again', { itemId });
  }
  const stored = await updateItem(scope.db, scope, itemId, { numberConfirmed: current }, {
    expectedVersion: input.expectedVersion,
    whenStatus: ['ready', 'needs_attention'],
  });
  if (!stored) throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the row changed meanwhile; reload it', { itemId });
  return revalidate(scope, book, stored, now);
}

export interface ConfirmResult {
  item: ImportItem;
  documentId: string | null;
  /** The counter's new next value when this import raised it. */
  counterRaisedTo: number | null;
}

/**
 * Import one row at `expectedVersion`. It is validated again first (a row with
 * a blocking problem is refused with IMPORT_NOT_READY and stays as it is).
 * When importing it raises the invoice counter, the caller must name the new
 * next value it showed the user (`confirmCounterRaiseTo`): a missing or other
 * value is COUNTER_RAISE_UNCONFIRMED and nothing is imported (the raise cannot
 * be undone), and the core refuses any raise but that one in its transaction;
 * then the core imports it and, in the same transaction, the row becomes
 * `imported` with its bytes cleared (they live on in sales_document_file). A
 * failed import leaves the row `ready` with the failure named.
 */
export async function confirmItem(
  scope: BooksScope,
  book: ContactBook,
  itemId: string,
  input: { expectedVersion: number; confirmCounterRaiseTo?: number | null },
  now: Date = new Date(),
): Promise<ConfirmResult> {
  const item = await getItem(scope.db, scope, itemId);
  if (item.status === 'imported') return { item, documentId: item.documentId, counterRaisedTo: null };
  if (item.status !== 'ready' && item.status !== 'needs_attention') {
    throw new BooksError('CONCURRENT_EDIT', `CONCURRENT_EDIT: the row is ${item.status}`, { itemId, status: item.status });
  }
  if (item.version !== input.expectedVersion) {
    throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the row changed meanwhile; reload it', { itemId });
  }
  const bytes = await itemContent(scope.db, scope, itemId);
  if (!bytes) throw new BooksError('NOT_RENDERABLE', 'NOT_RENDERABLE: the uploaded file is no longer stored', { itemId });
  const [others, settings] = await Promise.all([listOpenItems(scope.db, scope), readSettings(scope.db, scope)]);
  const v = await validateItem(scope, book, item, { bytes, others, companySender: settings?.senderBlock ?? null, now });
  const checked = await updateItem(scope.db, scope, itemId, { status: v.status, problems: v.problems }, {
    expectedVersion: item.version,
    whenStatus: ['ready', 'needs_attention'],
  });
  if (!checked) throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the row changed meanwhile; reload it', { itemId });
  if (v.status !== 'ready' || !v.record) {
    throw new BooksError('IMPORT_NOT_READY', 'IMPORT_NOT_READY: the row has a problem to fix first', {
      itemId,
      problems: v.problems.filter((p) => p.blocking).map((p) => p.code),
    });
  }
  const raiseTo = v.problems.find((p) => p.code === 'counter_raised')?.count ?? null;
  const confirmed = input.confirmCounterRaiseTo ?? null;
  if (raiseTo !== null && confirmed !== raiseTo) throw counterRaiseUnconfirmed(raiseTo, confirmed);
  try {
    const result = await importHistoricalInvoice(scope, book, v.record, bytes, newImportSession(), {
      now,
      counterPolicy: 'raise',
      // Only the raise the user confirmed (or none): a counter moved meanwhile is refused, not followed.
      confirmedCounterRaiseTo: raiseTo,
      inTransaction: async (trx, documentId) => {
        const marked = await updateItem(trx, scope, itemId, { status: 'imported', documentId, clearContent: true, problems: [], claimedAt: null }, {
          expectedVersion: checked.version,
          whenStatus: ['ready'],
        });
        if (!marked) throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the row changed meanwhile; nothing was imported', { itemId });
      },
    });
    if (result.status === 'already_imported') {
      // The same number with these exact bytes is in the books already (imported before).
      const marked = await updateItem(scope.db, scope, itemId, { status: 'imported', documentId: result.documentId, clearContent: true, problems: [] }, {
        expectedVersion: checked.version,
        whenStatus: ['ready'],
      });
      return { item: marked ?? (await getItem(scope.db, scope, itemId)), documentId: result.documentId, counterRaisedTo: null };
    }
    return { item: await getItem(scope.db, scope, itemId), documentId: result.documentId, counterRaisedTo: result.counterRaisedTo };
  } catch (err) {
    if (!isBooksError(err) || err.code === 'CONCURRENT_EDIT' || err.code === 'COUNTER_RAISE_UNCONFIRMED') throw err;
    // The row stays `ready`, with the failure named; nothing was written by the import.
    const named: Problem = { code: `import_failed:${err.code.toLowerCase()}`, path: null, blocking: false, count: null };
    await updateItem(scope.db, scope, itemId, { problems: [...v.problems.filter((p) => !p.code.startsWith('import_failed:')), named] }, {
      expectedVersion: checked.version,
      whenStatus: ['ready'],
    });
    throw err;
  }
}

/**
 * Set a row aside (any status but imported). Its bytes are cleared at once
 * (the customer's invoice is not kept for a row nobody imports); the same file
 * can be staged again.
 */
export async function discardItem(scope: BooksScope, itemId: string, now: Date = new Date()): Promise<ImportItem> {
  const item = await getItem(scope.db, scope, itemId);
  if (item.status === 'imported') {
    throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: an imported row cannot be discarded', { itemId, status: item.status });
  }
  if (item.status === 'discarded') return item;
  const stored = await updateItem(scope.db, scope, itemId, { status: 'discarded', discardedAt: now, claimedAt: null, claimId: null, clearContent: true }, {
    whenStatus: ['uploaded', 'extracting', 'ready', 'needs_attention'],
  });
  return stored ?? (await getItem(scope.db, scope, itemId));
}

/** The review table: every open row (oldest first), then the newest imported ones, and how many are imported in all. */
export async function listImportItems(scope: BooksScope): Promise<{ items: ImportItem[]; importedTotal: number }> {
  const [open, imported] = await Promise.all([listOpenItems(scope.db, scope), listImportedItems(scope.db, scope, IMPORTED_SHOWN)]);
  return { items: [...open, ...imported.items], importedTotal: imported.total };
}

/** Whether bytes start like a PDF (`%PDF-`), the check every upload passed. */
export function isPdfBytes(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';
}

/**
 * The PDF of a row: the uploaded bytes, or, once imported, the stored original
 * of its document. Served on the editor's origin, so bytes that do not start
 * like a PDF are never served (checked again here, not only at upload): a file
 * that is really HTML or SVG must never render as a page of the editor.
 */
export async function itemPdf(scope: BooksScope, itemId: string): Promise<{ bytes: Uint8Array }> {
  const item = await getItem(scope.db, scope, itemId);
  const pdf = (bytes: Uint8Array) => {
    if (!isPdfBytes(bytes)) throw new BooksError('NOT_RENDERABLE', 'NOT_RENDERABLE: the stored file is not a PDF', { itemId });
    return { bytes };
  };
  const staged = await itemContent(scope.db, scope, itemId);
  if (staged) return pdf(staged);
  if (item.documentId) {
    const file = await scope.db
      .selectFrom('sales_document_file')
      .select('content')
      .where('tenant_id', '=', scope.tenantId)
      .where('document_id', '=', item.documentId)
      .executeTakeFirst();
    if (file) return pdf(new Uint8Array(file.content));
  }
  throw new BooksError('NOT_FOUND', 'NOT_FOUND: the file of this row is no longer stored', { itemId });
}
