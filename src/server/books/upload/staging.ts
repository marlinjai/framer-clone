// src/server/books/upload/staging.ts
//
// The staging rows of the upload import (docs/plans/2026-10-20-books-upload-import.md,
// table `historical_import_item` of 010_books_upload_import): one row per
// uploaded PDF, from upload through extraction and review to import or
// discard. Every query filters `tenant_id = scope.tenantId`, like the rest of
// the Books, so another company's row reads as NOT_FOUND.
//
// What a row holds (JSONB parsed with zod on read):
//   - `extracted`: what the model read, `{ printed, confidence }`: the printed
//     invoice in the shared shape of importPrinted.ts and a confidence per
//     field it was unsure about;
//   - `corrected`: the user's corrected printed invoice, KEYED to the
//     extraction it corrects (`corrected_extraction_id`); a correction of an
//     older extraction is never used (stateful-flow standard: derived state is
//     keyed to its input);
//   - `problems`: the named problems of the last validation (codes and paths,
//     never values).
//
// No `server-only` import: the integration tests drive it directly.

import { randomUUID } from 'node:crypto';

import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';

import type { CommerceDB, HistoricalImportStatus } from '../../commerce/db-types';
import { BooksError } from '../errors';
import type { BooksScope } from '../scope';
import { toJsonb } from '../snapshots';

type Db = Kysely<CommerceDB> | Transaction<CommerceDB>;

/** How sure the model was about one field: the review table marks `medium` and `low`. */
export const confidenceSchema = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof confidenceSchema>;

/** What an extraction stored: the printed invoice and the per-field confidence (by field path). */
export const extractedSchema = z.object({
  printed: z.record(z.string(), z.unknown()),
  confidence: z.record(z.string(), confidenceSchema),
});
export type Extracted = z.infer<typeof extractedSchema>;

/** One named problem of a staged row. `blocking` problems keep it from being imported. */
export const problemSchema = z.object({
  code: z.string().min(1).max(120),
  /** The field it is about (`recipient.name`, `lines.2.lineTotal`), when it is about one. */
  path: z.string().max(200).nullable(),
  blocking: z.boolean(),
  /** A count or a number the code refers to (lines affected, the counter's new value); never a printed value. */
  count: z.number().int().nullable(),
});
export type Problem = z.infer<typeof problemSchema>;

/** A staging row as the service reads it (the bytes are read separately). */
export interface ImportItem {
  id: string;
  fileName: string;
  byteSize: number;
  sha256: string;
  status: HistoricalImportStatus;
  version: number;
  extractionId: string | null;
  extracted: Extracted | null;
  extractionError: string | null;
  /** The user's correction, only when it corrects the CURRENT extraction (else null: stale). */
  corrected: Record<string, unknown> | null;
  /** The printed number the user confirmed as right although it jumps far ahead (counts only while it is the current number). */
  numberConfirmed: string | null;
  problems: Problem[];
  model: string | null;
  claimedAt: Date | null;
  documentId: string | null;
  discardedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The printed invoice the row stands for now: the correction of the current extraction, else the extraction. */
export function effectivePrinted(item: ImportItem): Record<string, unknown> | null {
  return item.corrected ?? item.extracted?.printed ?? null;
}

const ITEM_COLUMNS = [
  'id',
  'file_name',
  'byte_size',
  'sha256',
  'status',
  'version',
  'extraction_id',
  'extracted',
  'extraction_error',
  'corrected',
  'corrected_extraction_id',
  'number_confirmed',
  'problems',
  'model',
  'claimed_at',
  'document_id',
  'discarded_at',
  'created_at',
  'updated_at',
] as const;

type ItemRow = {
  id: string;
  file_name: string;
  byte_size: number;
  sha256: string;
  status: HistoricalImportStatus;
  version: number;
  extraction_id: string | null;
  extracted: unknown;
  extraction_error: string | null;
  corrected: unknown;
  corrected_extraction_id: string | null;
  number_confirmed: string | null;
  problems: unknown;
  model: string | null;
  claimed_at: Date | null;
  document_id: string | null;
  discarded_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function mapItem(row: ItemRow): ImportItem {
  const extracted = row.extracted == null ? null : extractedSchema.safeParse(row.extracted);
  const problems = z.array(problemSchema).safeParse(row.problems);
  // The resume rule: a correction keyed to an extraction that is no longer the
  // current one is not reattached (a legacy row without the key fails the match too).
  const corrected =
    row.corrected != null && row.corrected_extraction_id !== null && row.corrected_extraction_id === row.extraction_id
      ? (row.corrected as Record<string, unknown>)
      : null;
  return {
    id: row.id,
    fileName: row.file_name,
    byteSize: row.byte_size,
    sha256: row.sha256,
    status: row.status,
    version: row.version,
    extractionId: row.extraction_id,
    extracted: extracted && extracted.success ? extracted.data : null,
    extractionError: row.extraction_error,
    corrected,
    numberConfirmed: row.number_confirmed,
    problems: problems.success ? problems.data : [],
    model: row.model,
    claimedAt: row.claimed_at,
    documentId: row.document_id,
    discardedAt: row.discarded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** One staging row of the company, optionally locked FOR UPDATE; NOT_FOUND otherwise. */
export async function getItem(db: Db, scope: BooksScope, id: string, opts: { forUpdate?: boolean } = {}): Promise<ImportItem> {
  let q = db.selectFrom('historical_import_item').select(ITEM_COLUMNS).where('tenant_id', '=', scope.tenantId).where('id', '=', id);
  if (opts.forUpdate) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw new BooksError('NOT_FOUND', 'NOT_FOUND: import item', { itemId: id });
  return mapItem(row as ItemRow);
}

/** The company's staging rows for the review table: everything but discarded rows, oldest first. */
export async function listItems(db: Db, scope: BooksScope): Promise<ImportItem[]> {
  const rows = await db
    .selectFrom('historical_import_item')
    .select(ITEM_COLUMNS)
    .where('tenant_id', '=', scope.tenantId)
    .where('status', '<>', 'discarded')
    .orderBy('created_at')
    .orderBy('id')
    .limit(1000)
    .execute();
  return rows.map((r) => mapItem(r as ItemRow));
}

/** The live (not discarded) row holding a file with this SHA-256, if any. */
export async function liveItemBySha(db: Db, scope: BooksScope, sha256: string): Promise<ImportItem | null> {
  const row = await db
    .selectFrom('historical_import_item')
    .select(ITEM_COLUMNS)
    .where('tenant_id', '=', scope.tenantId)
    .where('sha256', '=', sha256)
    .where('status', '<>', 'discarded')
    .executeTakeFirst();
  return row ? mapItem(row as ItemRow) : null;
}

/** The uploaded bytes of a row (null once imported or pruned). */
export async function itemContent(db: Db, scope: BooksScope, id: string): Promise<Uint8Array | null> {
  const row = await db
    .selectFrom('historical_import_item')
    .select('content')
    .where('tenant_id', '=', scope.tenantId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw new BooksError('NOT_FOUND', 'NOT_FOUND: import item', { itemId: id });
  return row.content ? new Uint8Array(row.content) : null;
}

/** Insert a new staging row for uploaded bytes (status `uploaded`). */
export async function insertItem(
  db: Db,
  scope: BooksScope,
  file: { fileName: string; bytes: Uint8Array; sha256: string },
): Promise<ImportItem> {
  const now = new Date();
  const row = await db
    .insertInto('historical_import_item')
    .values({
      id: randomUUID(),
      tenant_id: scope.tenantId,
      file_name: file.fileName,
      content: Buffer.from(file.bytes),
      byte_size: file.bytes.byteLength,
      sha256: file.sha256,
      updated_at: now,
    })
    .returning(ITEM_COLUMNS)
    .executeTakeFirstOrThrow();
  return mapItem(row as ItemRow);
}

/** The fields an update writes; `version` always rises by one. */
export interface ItemUpdate {
  status?: HistoricalImportStatus;
  extractionId?: string | null;
  extracted?: Extracted | null;
  extractionError?: string | null;
  corrected?: { printed: Record<string, unknown>; extractionId: string } | null;
  numberConfirmed?: string | null;
  problems?: Problem[];
  model?: string | null;
  claimedAt?: Date | null;
  documentId?: string | null;
  clearContent?: boolean;
  discardedAt?: Date | null;
}

/**
 * Update a row when it is still at `expectedVersion` (and, given, in one of
 * `whenStatus`); returns the new row, or null when it moved on meanwhile.
 */
export async function updateItem(
  db: Db,
  scope: BooksScope,
  id: string,
  change: ItemUpdate,
  cond: {
    expectedVersion?: number;
    whenStatus?: readonly HistoricalImportStatus[];
    /**
     * Only when the claim is older than this. Compared IN SQL against the same
     * kind of parameter the claim was written with: a TIMESTAMP without time
     * zone read back into JavaScript can carry the machine's offset, so a
     * comparison there could take a fresh claim for a stale one.
     */
    claimedBefore?: Date;
  } = {},
): Promise<ImportItem | null> {
  let q = db
    .updateTable('historical_import_item')
    .set((eb) => ({
      version: eb('version', '+', 1),
      updated_at: new Date(),
      ...(change.status !== undefined ? { status: change.status } : {}),
      ...(change.extractionId !== undefined ? { extraction_id: change.extractionId } : {}),
      ...(change.extracted !== undefined ? { extracted: change.extracted === null ? null : toJsonb(change.extracted) } : {}),
      ...(change.extractionError !== undefined ? { extraction_error: change.extractionError } : {}),
      ...(change.corrected !== undefined
        ? change.corrected === null
          ? { corrected: null, corrected_extraction_id: null }
          : { corrected: toJsonb(change.corrected.printed), corrected_extraction_id: change.corrected.extractionId }
        : {}),
      ...(change.problems !== undefined ? { problems: toJsonb(change.problems) } : {}),
      ...(change.numberConfirmed !== undefined ? { number_confirmed: change.numberConfirmed } : {}),
      ...(change.model !== undefined ? { model: change.model } : {}),
      ...(change.claimedAt !== undefined ? { claimed_at: change.claimedAt } : {}),
      ...(change.documentId !== undefined ? { document_id: change.documentId } : {}),
      ...(change.clearContent ? { content: null } : {}),
      ...(change.discardedAt !== undefined ? { discarded_at: change.discardedAt } : {}),
    }))
    .where('tenant_id', '=', scope.tenantId)
    .where('id', '=', id);
  if (cond.expectedVersion !== undefined) q = q.where('version', '=', cond.expectedVersion);
  if (cond.whenStatus) q = q.where('status', 'in', [...cond.whenStatus]);
  if (cond.claimedBefore) q = q.where('claimed_at', '<', cond.claimedBefore);
  const row = await q.returning(ITEM_COLUMNS).executeTakeFirst();
  return row ? mapItem(row as ItemRow) : null;
}

/** Clear the bytes of rows discarded more than `olderThanDays` ago (the plan's 30 days). Returns how many. */
export async function pruneDiscarded(db: Db, scope: BooksScope, now: Date, olderThanDays = 30): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await db
    .updateTable('historical_import_item')
    .set((eb) => ({ content: null, updated_at: now, version: eb('version', '+', 1) }))
    .where('tenant_id', '=', scope.tenantId)
    .where('status', '=', 'discarded')
    .where('discarded_at', '<', cutoff)
    .where('content', 'is not', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

// --- the extraction ledger ---------------------------------------------------------

/** Start one model call in the ledger; returns its id (the extraction id of the row). */
export async function startExtraction(db: Db, scope: BooksScope, itemId: string, model: string, now: Date): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('historical_import_extraction')
    .values({ id, tenant_id: scope.tenantId, item_id: itemId, model, started_at: now })
    .execute();
  return id;
}

export type ExtractionOutcome = 'ok' | 'refused' | 'invalid_output' | 'max_tokens' | 'error' | 'aborted';

/** Finish one model call in the ledger (once). */
export async function finishExtraction(
  db: Db,
  scope: BooksScope,
  id: string,
  outcome: ExtractionOutcome,
  usage: { inputTokens: number; outputTokens: number },
  now: Date,
): Promise<void> {
  await db
    .updateTable('historical_import_extraction')
    .set({ finished_at: now, outcome, input_tokens: usage.inputTokens, output_tokens: usage.outputTokens })
    .where('tenant_id', '=', scope.tenantId)
    .where('id', '=', id)
    .where('finished_at', 'is', null)
    .execute();
}

/** How many model calls the company started since `since` (the daily ceiling counts these). */
export async function extractionsSince(db: Db, scope: BooksScope, since: Date): Promise<number> {
  const row = await db
    .selectFrom('historical_import_extraction')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tenant_id', '=', scope.tenantId)
    .where('started_at', '>=', since)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}
