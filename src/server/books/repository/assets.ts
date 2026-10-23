// src/server/books/repository/assets.ts
//
// The company's logos (visual template composer plan, decision 15; migration
// 013_books_assets): uploaded PNG or JPEG bytes, stored append-only in the
// tenant schema, named by their SHA-256. A template's logo block names one, the
// issue snapshot freezes that name, and every render (the save gate's probe
// render, the template preview, a draft's preview, the document of record and
// its re-render) reads the bytes through `templateAssets` by that name, so an
// issued document re-renders with exactly the image it was issued with.
//
// Uploading the same bytes again answers the stored row (`created: false`);
// two uploads of the same file at once both answer it (the unique key decides,
// the loser reads the winner's row). Every query filters on the company: an
// asset of another company reads as ASSET_NOT_FOUND, and a template can never
// name one (the gate checks the company's own assets).

import { createHash, randomUUID } from 'node:crypto';

import type { Kysely, Transaction } from 'kysely';

import type { CommerceDB } from '../../commerce/db-types';
import { BooksError, withDbErrors } from '../errors';
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
  const checked = await checkLogoImage(bytes, declaredType);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return withDbErrors(async () => {
    const inserted = await scope.db
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
      // The same bytes again (or a concurrent upload of them) keep the stored row; the append-only table is never updated.
      .onConflict((oc) => oc.columns(['tenant_id', 'sha256']).doNothing())
      .returning(VIEW_COLUMNS)
      .executeTakeFirst();
    if (inserted) return { asset: view(inserted), created: true };
    const existing = await scope.db
      .selectFrom('books_asset')
      .select(VIEW_COLUMNS)
      .where('tenant_id', '=', scope.tenantId)
      .where('sha256', '=', sha256)
      .executeTakeFirstOrThrow();
    return { asset: view(existing), created: false };
  });
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
