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
//   discard  set the row aside; its bytes are cleared after 30 days (pruned
//            when the list is read), and the same file can be staged again.
//
// Logs carry item ids, statuses, sizes and codes, never extracted values or
// file names (plan decision 9).

import { createHash } from 'node:crypto';

import type Anthropic from '@anthropic-ai/sdk';

import type { AiModelKey } from '@/lib/ai/anthropicClient';

import type { ContactBook } from '../contactBook';
import { BooksError, isBooksError } from '../errors';
import { IMPORT_RENDERER, importHistoricalInvoice, newImportSession } from '../importInvoices';
import type { BooksScope } from '../scope';
import { readSettings } from '../settings';
import { extractPrintedInvoice } from './extract';
import { CLAIM_TIMEOUT_MS, DAILY_WINDOW_MS, type CompanySlots } from './limits';
import {
  extractionsSince,
  finishExtraction,
  getItem,
  insertItem,
  itemContent,
  listItems,
  liveItemBySha,
  pruneDiscarded,
  startExtraction,
  updateItem,
  type ExtractionOutcome,
  type ImportItem,
  type Problem,
} from './staging';
import { validateItem } from './validate';

/** The largest PDF one upload takes (plan: 10 MB). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** How many rows a company may have open (not imported, not discarded) at once: a bound on staged bytes. */
export const MAX_OPEN_ITEMS = 500;

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
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') {
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

  const open = await scope.db
    .selectFrom('historical_import_item')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tenant_id', '=', scope.tenantId)
    .where('status', 'not in', ['imported', 'discarded'])
    .executeTakeFirstOrThrow();
  if (Number(open.n) >= MAX_OPEN_ITEMS) {
    throw new BooksError('IMPORT_LIMIT', `IMPORT_LIMIT: at most ${MAX_OPEN_ITEMS} files can be open at once`, { limit: MAX_OPEN_ITEMS });
  }
  try {
    return { status: 'staged', item: await insertItem(scope.db, scope, { fileName: cleanFileName(file.fileName), bytes, sha256 }) };
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
  const [others, settings] = await Promise.all([listItems(scope.db, scope), readSettings(scope.db, scope)]);
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
}

/**
 * Read one staged row with the model. Refusals before any call: a row that is
 * imported or discarded (NOT_CANCELLABLE semantics: CONCURRENT_EDIT), a row
 * already being read (EXTRACTION_RUNNING, until its claim times out), the
 * company's four slots in use (EXTRACT_BUSY), the daily ceiling reached
 * (IMPORT_LIMIT). A failed or aborted call is recorded in the ledger and the
 * row says why; it can be read again.
 */
export async function extractItem(scope: BooksScope, itemId: string, deps: ExtractDeps): Promise<ImportItem> {
  const clock = deps.now ?? (() => new Date());
  const item = await getItem(scope.db, scope, itemId);
  if (item.status === 'imported' || item.status === 'discarded') {
    throw new BooksError('CONCURRENT_EDIT', `CONCURRENT_EDIT: the row is ${item.status}`, { itemId, status: item.status });
  }
  const slot = deps.slots.acquire(scope.tenantId);
  if (!slot.ok) throw new BooksError('EXTRACT_BUSY', 'EXTRACT_BUSY: four invoices are being read for this company; try again shortly', { retryAfterSec: slot.retryAfterSec });
  try {
    const started = clock();
    const recent = await extractionsSince(scope.db, scope, new Date(started.getTime() - DAILY_WINDOW_MS));
    if (recent >= deps.dailyLimit) {
      throw new BooksError('IMPORT_LIMIT', `IMPORT_LIMIT: at most ${deps.dailyLimit} invoices are read per day for a company`, { limit: deps.dailyLimit });
    }
    // The durable claim: one extraction per file at a time; a stale claim (crash) may be taken over.
    const stale = new Date(started.getTime() - CLAIM_TIMEOUT_MS);
    const claimed =
      (await updateItem(scope.db, scope, itemId, { status: 'extracting', claimedAt: started }, {
        expectedVersion: item.version,
        whenStatus: ['uploaded', 'ready', 'needs_attention'],
      })) ??
      (item.status === 'extracting' && item.claimedAt !== null && item.claimedAt < stale
        ? await updateItem(scope.db, scope, itemId, { status: 'extracting', claimedAt: started }, {
            expectedVersion: item.version,
            whenStatus: ['extracting'],
          })
        : null);
    if (!claimed) {
      throw new BooksError('EXTRACTION_RUNNING', 'EXTRACTION_RUNNING: this invoice is being read already', { itemId });
    }
    const bytes = await itemContent(scope.db, scope, itemId);
    if (!bytes) throw new BooksError('NOT_RENDERABLE', 'NOT_RENDERABLE: the uploaded file is no longer stored', { itemId });
    const ledgerId = await startExtraction(scope.db, scope, itemId, deps.modelId, started);

    let outcome: ExtractionOutcome = 'error';
    let usage = { inputTokens: 0, outputTokens: 0 };
    let read: { printed: Record<string, unknown>; confidence: Record<string, 'high' | 'medium' | 'low'> } | null = null;
    try {
      const result = await extractPrintedInvoice(deps.anthropic, bytes, { modelKey: deps.modelKey, signal: deps.signal });
      usage = result.usage;
      if (result.ok) {
        outcome = 'ok';
        read = { printed: result.printed, confidence: result.confidence };
      } else {
        outcome = result.outcome;
      }
    } catch (err) {
      const name = (err as { name?: unknown })?.name;
      outcome = name === 'AbortError' || name === 'APIUserAbortError' || deps.signal.aborted ? 'aborted' : 'error';
      if (outcome === 'error') {
        const status = (err as { status?: unknown })?.status;
        console.error(`[books-import] item ${itemId}: extraction failed (${typeof status === 'number' ? status : 'no status'})`);
      }
    }
    const finished = clock();
    await finishExtraction(scope.db, scope, ledgerId, outcome, usage, finished);

    if (outcome === 'aborted') {
      // The caller left: the row is free to be read again (resume), nothing lost.
      const back = await updateItem(scope.db, scope, itemId, { status: 'uploaded', claimedAt: null }, { whenStatus: ['extracting'] });
      return back ?? (await getItem(scope.db, scope, itemId));
    }
    if (!read) {
      const failed = await updateItem(
        scope.db,
        scope,
        itemId,
        {
          status: 'needs_attention',
          claimedAt: null,
          extractionError: outcome,
          problems: [{ code: `extraction_failed:${outcome}`, path: null, blocking: true, count: null }],
          model: deps.modelId,
        },
        { whenStatus: ['extracting'] },
      );
      return failed ?? (await getItem(scope.db, scope, itemId));
    }
    // The new extraction replaces the old one; a correction of the old one is dropped (keyed).
    const stored = await updateItem(
      scope.db,
      scope,
      itemId,
      {
        status: 'needs_attention',
        claimedAt: null,
        extractionId: ledgerId,
        extracted: read,
        extractionError: null,
        corrected: null,
        problems: [],
        model: deps.modelId,
      },
      { whenStatus: ['extracting'] },
    );
    // Discarded while being read: the transcription is not attached.
    if (!stored) return getItem(scope.db, scope, itemId);
    return revalidate(scope, deps.contactBook, stored, finished);
  } finally {
    slot.release();
  }
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
  if (JSON.stringify(current) === JSON.stringify(input.printed)) return item;
  const stored = await updateItem(scope.db, scope, itemId, { corrected: { printed: input.printed, extractionId: input.extractionId } }, {
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

export interface ConfirmResult {
  item: ImportItem;
  documentId: string | null;
  /** The counter's new next value when this import raised it. */
  counterRaisedTo: number | null;
}

/**
 * Import one row at `expectedVersion`. It is validated again first (a row with
 * a blocking problem is refused with IMPORT_NOT_READY and stays as it is);
 * then the core imports it and, in the same transaction, the row becomes
 * `imported` with its bytes cleared (they live on in sales_document_file). A
 * failed import leaves the row `ready` with the failure named.
 */
export async function confirmItem(
  scope: BooksScope,
  book: ContactBook,
  itemId: string,
  input: { expectedVersion: number },
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
  const [others, settings] = await Promise.all([listItems(scope.db, scope), readSettings(scope.db, scope)]);
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
  try {
    const result = await importHistoricalInvoice(scope, book, v.record, bytes, newImportSession(), {
      now,
      counterPolicy: 'raise',
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
    if (!isBooksError(err) || err.code === 'CONCURRENT_EDIT') throw err;
    // The row stays `ready`, with the failure named; nothing was written by the import.
    const named: Problem = { code: `import_failed:${err.code.toLowerCase()}`, path: null, blocking: false, count: null };
    await updateItem(scope.db, scope, itemId, { problems: [...v.problems.filter((p) => !p.code.startsWith('import_failed:')), named] }, {
      expectedVersion: checked.version,
      whenStatus: ['ready'],
    });
    throw err;
  }
}

/** Set a row aside (any status but imported). Its bytes are cleared after 30 days; the file can be staged again. */
export async function discardItem(scope: BooksScope, itemId: string, now: Date = new Date()): Promise<ImportItem> {
  const item = await getItem(scope.db, scope, itemId);
  if (item.status === 'imported') {
    throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: an imported row cannot be discarded', { itemId, status: item.status });
  }
  if (item.status === 'discarded') return item;
  const stored = await updateItem(scope.db, scope, itemId, { status: 'discarded', discardedAt: now, claimedAt: null }, {
    whenStatus: ['uploaded', 'extracting', 'ready', 'needs_attention'],
  });
  return stored ?? (await getItem(scope.db, scope, itemId));
}

/** The review table: the company's rows (discarded ones left out), after pruning discarded bytes older than 30 days. */
export async function listImportItems(scope: BooksScope, now: Date = new Date()): Promise<ImportItem[]> {
  await pruneDiscarded(scope.db, scope, now);
  return listItems(scope.db, scope);
}

/** The PDF of a row: the uploaded bytes, or, once imported, the stored original of its document. */
export async function itemPdf(scope: BooksScope, itemId: string): Promise<{ bytes: Uint8Array; fileName: string }> {
  const item = await getItem(scope.db, scope, itemId);
  const staged = await itemContent(scope.db, scope, itemId);
  if (staged) return { bytes: staged, fileName: item.fileName };
  if (item.documentId) {
    const file = await scope.db
      .selectFrom('sales_document_file')
      .select('content')
      .where('tenant_id', '=', scope.tenantId)
      .where('document_id', '=', item.documentId)
      .executeTakeFirst();
    if (file) return { bytes: new Uint8Array(file.content), fileName: item.fileName };
  }
  throw new BooksError('NOT_FOUND', 'NOT_FOUND: the file of this row is no longer stored', { itemId });
}
