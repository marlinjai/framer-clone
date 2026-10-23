// src/server/books/repository/assets.ts
//
// The company's logos (visual template composer plan, decision 15; migrations
// 013_books_assets and 014_books_asset_delete): uploaded PNG or JPEG bytes,
// stored in the tenant schema and never changed, named by their SHA-256. A
// template's logo block names one, the issue snapshot freezes that name, and
// every render (the save gate's probe render, the template preview, a draft's
// preview, the document of record and its re-render) reads the bytes through
// `templateAssets` by that name, so an issued document re-renders with exactly
// the image it was issued with.
//
// Uploading the same bytes again answers the stored row (`created: false`);
// two uploads of the same file at once both answer it (uploads of one company
// run one at a time, under a transaction lock). A company stores at most
// MAX_ASSETS_PER_COMPANY logos (ASSET_LIMIT, 409), so one user cannot fill the
// schema. Both answers are given before the decode too, so an upload that
// cannot be stored costs no decode. Every query filters on the company: an
// asset of another company reads as ASSET_NOT_FOUND, and a template can never
// name one (the gate checks the company's own assets).
//
// A logo nobody uses may be deleted (phase 4 decision 9, migration 014): not
// while an issued document froze it, nor while a live template's current
// version names it (ASSET_IN_USE, 409). The database decides (the 014 guard,
// BK015) with the one definition of "in use" that `listAssets` reports too.
// Deleting cannot race an issue or a template save: the delete takes the
// logo's lock exclusively before it deletes, while the issue and the save take
// it shared (`lockLogos`) inside their transactions, so whichever comes second
// waits and then sees the first: the delete is refused, or the issue or save
// finds the logo gone and refuses with LOGO_ASSET_MISSING. (The lock is a
// transaction-scoped advisory lock per company and hash, not FOR SHARE and FOR
// UPDATE: row locks need the UPDATE privilege, which the app role never holds
// on this table.) The
// same bytes uploaded again after a delete are the same hash, so a template
// that named the deleted logo works again.

import { createHash, randomUUID } from 'node:crypto';

import { tenantSchema } from '@marlinjai/tenant-db';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { CommerceDB } from '../../commerce/db-types';
import { BooksError, sqlState, withDbErrors } from '../errors';
import { assertRenderableTemplate, type EngineImage } from '../render/engine';
import { checkLogoImage, type LogoContentType } from '../render/logoImage';
import type { BooksScope } from '../scope';
import { logoBlocks, type TemplateDocumentV2 } from '../template/schema';

type Db = Kysely<CommerceDB> | Transaction<CommerceDB>;

/** What the API answers for an asset (never its bytes). */
export interface AssetView {
  sha256: string;
  contentType: LogoContentType;
  byteSize: number;
  widthPx: number;
  heightPx: number;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** A stored logo as the composer's logo list shows it. */
export interface LogoAssetListItem extends AssetView {
  createdAt: Date;
  /** An issued document froze it, or a live template's current version names it: it cannot be deleted. */
  inUse: boolean;
}

/**
 * The most logos one company stores: a bound keeps one user with editBooks
 * from filling the schema (a logo in use is never deleted); a company uses one
 * or two.
 */
export const MAX_ASSETS_PER_COMPANY = 100;

const VIEW_COLUMNS = ['sha256', 'content_type', 'byte_size', 'width_px', 'height_px'] as const;

function view(row: { sha256: string; content_type: string; byte_size: number; width_px: number; height_px: number }): AssetView {
  return {
    sha256: row.sha256,
    contentType: row.content_type as LogoContentType,
    byteSize: row.byte_size,
    widthPx: row.width_px,
    heightPx: row.height_px,
  };
}

/** The stored asset with this hash, or null; ASSET_LIMIT when the company may store no other. */
async function storedOrLimit(db: Db, scope: BooksScope, sha256: string): Promise<AssetView | null> {
  const existing = await db
    .selectFrom('books_asset')
    .select(VIEW_COLUMNS)
    .where('tenant_id', '=', scope.tenantId)
    .where('sha256', '=', sha256)
    .executeTakeFirst();
  if (existing) return view(existing);
  const { n } = await db
    .selectFrom('books_asset')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tenant_id', '=', scope.tenantId)
    .executeTakeFirstOrThrow();
  if (Number(n) >= MAX_ASSETS_PER_COMPANY) {
    throw new BooksError('ASSET_LIMIT', `this company stores the most logos allowed (${MAX_ASSETS_PER_COMPANY}); choose one of them, or delete one nobody uses`, {
      maxAssets: MAX_ASSETS_PER_COMPANY,
    });
  }
  return null;
}

/**
 * Check and store a logo (render/logoImage.ts: type, size, pixels, decode,
 * embed). Answers the stored asset and whether this call created it.
 */
export async function storeLogo(
  scope: BooksScope,
  bytes: Uint8Array,
  declaredType: string,
  actor: { userId?: string | null } = {},
): Promise<{ asset: AssetView; created: boolean }> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // The cheap answers first (an upload already stored, a company at its limit), before the
  // decode; both are asked again under the lock below.
  const early = await withDbErrors(() => storedOrLimit(scope.db, scope, sha256));
  let checked = early ? null : await checkLogoImage(bytes, declaredType);
  return withDbErrors(() =>
    scope.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        // One upload of a company at a time: the cap counts what is there, and a stored row is
        // answered as it is (under the logo's shared lock, so a delete in progress is waited for
        // and a logo it removes is never answered as stored).
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`books-assets:${scope.tenantId}`}, 0))`.execute(trx);
        await lockLogoKeys(trx, scope, [sha256], 'shared');
        const existing = await storedOrLimit(trx, scope, sha256);
        if (existing) return { asset: existing, created: false };
        // Stored before the lock but deleted since (a delete committed in between): check it now.
        checked ??= await checkLogoImage(bytes, declaredType);
        const inserted = await trx
          .insertInto('books_asset')
          .values({
            id: randomUUID(),
            tenant_id: scope.tenantId,
            kind: 'logo',
            content_type: checked.contentType,
            byte_size: bytes.byteLength,
            sha256,
            width_px: checked.widthPx,
            height_px: checked.heightPx,
            content: Buffer.from(bytes),
            created_by: actor.userId ?? null,
          })
          .returning(VIEW_COLUMNS)
          .executeTakeFirstOrThrow();
        return { asset: view(inserted), created: true };
      }),
  );
}

/** One asset of the company without its bytes (a revalidation needs only this), or ASSET_NOT_FOUND. */
export async function readAssetView(scope: BooksScope, sha256: string): Promise<AssetView> {
  const row = SHA256.test(sha256)
    ? await scope.db.selectFrom('books_asset').select(VIEW_COLUMNS).where('tenant_id', '=', scope.tenantId).where('sha256', '=', sha256).executeTakeFirst()
    : undefined;
  if (!row) throw new BooksError('ASSET_NOT_FOUND', 'ASSET_NOT_FOUND', { sha256: SHA256.test(sha256) ? sha256 : null });
  return view(row);
}

/** One asset of the company with its bytes, or ASSET_NOT_FOUND (another company's reads exactly like an unknown one). */
export async function readAsset(scope: BooksScope, sha256: string): Promise<{ asset: AssetView; bytes: Uint8Array }> {
  const row = SHA256.test(sha256)
    ? await scope.db
        .selectFrom('books_asset')
        .select([...VIEW_COLUMNS, 'content'])
        .where('tenant_id', '=', scope.tenantId)
        .where('sha256', '=', sha256)
        .executeTakeFirst()
    : undefined;
  if (!row) throw new BooksError('ASSET_NOT_FOUND', 'ASSET_NOT_FOUND', { sha256: SHA256.test(sha256) ? sha256 : null });
  return { asset: view(row), bytes: new Uint8Array(row.content) };
}

/**
 * The company's assets a template document's logo blocks name, by SHA-256,
 * ready for the engine. A name the company does not have is simply absent:
 * the gate reports it (LOGO_ASSET_MISSING), the engine flags it as a layout
 * issue, and issue refuses (store.ts). Reads through the caller's handle, so
 * it runs inside the issue transaction.
 */
export async function templateAssets(db: Db, scope: BooksScope, doc: TemplateDocumentV2): Promise<Map<string, EngineImage>> {
  // A stored document is read with a shape check only: a malformed one fails here, naming the path.
  assertRenderableTemplate(doc);
  const wanted = [...new Set(logoBlocks(doc).map((l) => l.block.assetSha256).filter((s): s is string => s !== null && SHA256.test(s)))];
  const out = new Map<string, EngineImage>();
  if (wanted.length === 0) return out;
  const rows = await db
    .selectFrom('books_asset')
    .select(['sha256', 'content_type', 'content'])
    .where('tenant_id', '=', scope.tenantId)
    .where('sha256', 'in', wanted)
    .execute();
  for (const r of rows) out.set(r.sha256, { contentType: r.content_type as LogoContentType, bytes: new Uint8Array(r.content) });
  return out;
}

/** The schema-qualified `books_asset_in_use` (014): the scoped handle qualifies tables, never a function call. */
function inUseFn(scope: BooksScope) {
  return sql.id(tenantSchema(scope.tgId), 'books_asset_in_use');
}

/**
 * The company's logos, newest first, each with whether it is in use (the 014
 * definition the delete guard applies, so the list never offers a delete the
 * database refuses, short of a race the delete then answers with ASSET_IN_USE).
 */
export async function listAssets(scope: BooksScope): Promise<LogoAssetListItem[]> {
  const rows = await withDbErrors(() =>
    scope.db
      .selectFrom('books_asset')
      .select([...VIEW_COLUMNS, 'created_at', sql<boolean>`${inUseFn(scope)}(tenant_id, sha256)`.as('in_use')])
      .where('tenant_id', '=', scope.tenantId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute(),
  );
  return rows.map((r) => ({
    ...view(r),
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    inUse: r.in_use === true,
  }));
}

/**
 * How long a delete waits for an issue or a template save holding the logo
 * before it gives up with ASSET_BUSY (409): an issue or a save takes well
 * under a second, and the user can simply try again.
 */
export const DELETE_LOCK_TIMEOUT_MS = 5000;

/** Test seams of {@link deleteAsset}. */
export interface DeleteAssetHooks {
  /** Runs inside the delete transaction after the DELETE, before the commit (the race tests hold it here). */
  beforeCommit?: () => Promise<void>;
}

/**
 * Take the logo locks of these hashes for the rest of the caller's
 * transaction: 'shared' for a writer that will name a logo (an issue freezing
 * it, a template save, an upload answering a stored one), 'exclusive' for a
 * delete. Shared locks never wait on each other; a delete waits for every
 * holder, and every later holder waits for a delete. Transaction-scoped
 * advisory locks, keyed by company and hash, rather than row locks: a row lock
 * (FOR SHARE, FOR UPDATE) needs the UPDATE privilege, and commerce_app must
 * never hold UPDATE on books_asset (014). Taken in hash order, so two callers
 * never wait on each other in a circle; a hash collision of two keys only
 * makes one wait a little longer.
 */
async function lockLogoKeys(trx: Transaction<CommerceDB>, scope: BooksScope, hashes: readonly string[], mode: 'shared' | 'exclusive'): Promise<void> {
  for (const sha256 of [...new Set(hashes)].sort()) {
    const key = sql`hashtextextended(${`books-asset:${scope.tenantId}:${sha256}`}, 0)`;
    await (mode === 'shared' ? sql`SELECT pg_advisory_xact_lock_shared(${key})` : sql`SELECT pg_advisory_xact_lock(${key})`).execute(trx);
  }
}

/**
 * Delete one logo of the company that nothing uses. ASSET_NOT_FOUND for an
 * unknown or malformed hash and for another company's (existence never
 * leaks); ASSET_IN_USE (409) while an issued document froze it or a live
 * template's current version names it; ASSET_BUSY (409) when an issue or a
 * save holds it longer than DELETE_LOCK_TIMEOUT_MS. The logo's lock is taken exclusively
 * first, so a delete waits for an issue or a template save holding it and then
 * sees what that committed (each statement of a READ COMMITTED transaction
 * reads what committed before it); the 014 guard checks every reference on the
 * DELETE itself.
 */
export async function deleteAsset(scope: BooksScope, sha256: string, hooks: DeleteAssetHooks = {}): Promise<void> {
  if (!SHA256.test(sha256)) throw new BooksError('ASSET_NOT_FOUND', 'ASSET_NOT_FOUND', { sha256: null });
  await withDbErrors(() =>
    scope.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        // Waiting behind an issue or a save is bounded: while a delete waits, every later issue,
        // save and upload naming this logo queues behind it, so a long wait gives up instead.
        await sql`SET LOCAL lock_timeout = ${sql.lit(`${DELETE_LOCK_TIMEOUT_MS}ms`)}`.execute(trx);
        try {
          await lockLogoKeys(trx, scope, [sha256], 'exclusive');
        } catch (err) {
          if (sqlState(err) === '55P03') {
            throw new BooksError('ASSET_BUSY', 'ASSET_BUSY: the logo is being used by an issue or a template save', { sha256 }, { cause: err });
          }
          throw err;
        }
        // The bound is for that wait only: the rest of the delete runs under the usual settings.
        await sql`SET LOCAL lock_timeout TO DEFAULT`.execute(trx);
        const row = await trx
          .selectFrom('books_asset')
          .select('id')
          .where('tenant_id', '=', scope.tenantId)
          .where('sha256', '=', sha256)
          .executeTakeFirst();
        if (!row) throw new BooksError('ASSET_NOT_FOUND', 'ASSET_NOT_FOUND', { sha256 });
        try {
          await trx.deleteFrom('books_asset').where('tenant_id', '=', scope.tenantId).where('id', '=', row.id).execute();
        } catch (err) {
          if (sqlState(err) === 'BK015') {
            throw new BooksError(
              'ASSET_IN_USE',
              'ASSET_IN_USE: the logo is printed on an issued document or used by a live template',
              { sha256 },
              { cause: err },
            );
          }
          throw err;
        }
        if (hooks.beforeCommit) await hooks.beforeCommit();
      }),
  );
}

/**
 * Hold the company's logos with these hashes for the rest of the caller's
 * transaction (an issue freezing its logo, a template save writing a version
 * that names them; the shared logo lock) and answer the hashes that are
 * stored, read after the lock. A lock held here makes a concurrent delete wait
 * until the caller commits and then refuse (the reference is committed by
 * then); a logo a delete removed first is absent, and the caller refuses with
 * LOGO_ASSET_MISSING.
 */
export async function lockLogos(trx: Transaction<CommerceDB>, scope: BooksScope, hashes: Iterable<string>): Promise<Set<string>> {
  const wanted = [...new Set(hashes)].filter((s) => SHA256.test(s));
  if (wanted.length === 0) return new Set();
  await lockLogoKeys(trx, scope, wanted, 'shared');
  const rows = await trx.selectFrom('books_asset').select('sha256').where('tenant_id', '=', scope.tenantId).where('sha256', 'in', wanted).execute();
  return new Set(rows.map((r) => r.sha256));
}
