// src/server/catalog/repository/images.ts
//
// The catalogue's images (020 guarantee 7): PNG, JPEG or WebP bytes up to
// 2 MB, stored once per company and SHA-256 in `catalog_image` (beside the
// documents, as 008 and 013 do, until a storage-brain client exists here), and
// placed on products through `product_image` (ordered, optionally tied to one
// variant).
//
// Adding the same bytes again reuses the stored image (one row per company and
// hash); the type and pixel size come from the bytes (imageHeader.ts), never
// from the request. Removing an image from a product removes the placement;
// the stored bytes stay (020's RESTRICT keeps them while anything places them,
// and a later upload of the same file finds them). Every query filters on the
// company: another company's image or product reads as NOT_FOUND.

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { ProductDetail } from '@/lib/catalog/types';

import { CatalogError, invalid, notFound, withDbErrors } from '../errors';
import { readImageHeader, type ImageContentType } from '../imageHeader';
import type { CatalogScope } from '../scope';
import { getProduct } from './products';
import { lockProduct, touchProduct, type Db } from './shared';

/** The most images one product shows. */
export const MAX_IMAGES_PER_PRODUCT = 50;
/** The most images one company stores (bounds what one user can put into the schema). */
export const MAX_IMAGES_PER_COMPANY = 5000;

const SHA256 = /^[0-9a-f]{64}$/;

export interface StoredImage {
  id: string;
  sha256: string;
  contentType: ImageContentType;
  byteSize: number;
  width: number;
  height: number;
}

/** Store the bytes for the company, or answer the row already stored with the same hash. */
export async function storeImage(scope: CatalogScope, bytes: Uint8Array, db: Db = scope.db): Promise<{ image: StoredImage; created: boolean }> {
  const header = readImageHeader(bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const columns = ['id', 'sha256', 'content_type', 'byte_size', 'width', 'height'] as const;
  const view = (r: { id: string; sha256: string; content_type: string; byte_size: number; width: number; height: number }): StoredImage => ({
    id: r.id,
    sha256: r.sha256,
    contentType: r.content_type as ImageContentType,
    byteSize: r.byte_size,
    width: r.width,
    height: r.height,
  });
  const existing = await db.selectFrom('catalog_image').select(columns).where('tenant_id', '=', scope.tenantId).where('sha256', '=', sha256).executeTakeFirst();
  if (existing) return { image: view(existing), created: false };
  const { n } = await db
    .selectFrom('catalog_image')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tenant_id', '=', scope.tenantId)
    .executeTakeFirstOrThrow();
  if (Number(n) >= MAX_IMAGES_PER_COMPANY) {
    throw new CatalogError('IMAGE_LIMIT', `this company stores the most images allowed (${MAX_IMAGES_PER_COMPANY})`, { maxImages: MAX_IMAGES_PER_COMPANY });
  }
  // A concurrent upload of the same file inserts nothing here and reads the winner's row below.
  const inserted = await db
    .insertInto('catalog_image')
    .values({
      id: randomUUID(),
      tenant_id: scope.tenantId,
      sha256,
      content_type: header.contentType,
      byte_size: bytes.byteLength,
      width: header.width,
      height: header.height,
      content: Buffer.from(bytes),
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'sha256']).doNothing())
    .returning(columns)
    .executeTakeFirst();
  if (inserted) return { image: view(inserted), created: true };
  const winner = await db.selectFrom('catalog_image').select(columns).where('tenant_id', '=', scope.tenantId).where('sha256', '=', sha256).executeTakeFirstOrThrow();
  return { image: view(winner), created: false };
}

/** One stored image of the company with its bytes, or NOT_FOUND (another company's reads like an unknown one). */
export async function readImage(scope: CatalogScope, sha256: string): Promise<{ contentType: string; bytes: Uint8Array }> {
  const row = SHA256.test(sha256)
    ? await scope.db
        .selectFrom('catalog_image')
        .select(['content_type', 'content'])
        .where('tenant_id', '=', scope.tenantId)
        .where('sha256', '=', sha256)
        .executeTakeFirst()
    : undefined;
  if (!row) throw notFound('image', SHA256.test(sha256) ? sha256 : null);
  return { contentType: row.content_type, bytes: new Uint8Array(row.content) };
}

/** The content type of one stored image of the company (without its bytes), or NOT_FOUND. */
export async function readImageType(scope: CatalogScope, sha256: string): Promise<string> {
  const row = SHA256.test(sha256)
    ? await scope.db.selectFrom('catalog_image').select('content_type').where('tenant_id', '=', scope.tenantId).where('sha256', '=', sha256).executeTakeFirst()
    : undefined;
  if (!row) throw notFound('image', SHA256.test(sha256) ? sha256 : null);
  return row.content_type;
}

/** Add an uploaded image to the end of a product's images (a file already on the product is not added twice). */
export async function addProductImage(scope: CatalogScope, productId: string, bytes: Uint8Array): Promise<ProductDetail> {
  await withDbErrors(() =>
    scope.db.transaction().execute(async (trx) => {
      await lockProduct(trx, scope, productId);
      const { image } = await storeImage(scope, bytes, trx);
      const placed = await trx
        .selectFrom('product_image')
        .select(['image_id', 'position'])
        .where('tenant_id', '=', scope.tenantId)
        .where('product_id', '=', productId)
        .execute();
      if (placed.some((p) => p.image_id === image.id)) return;
      if (placed.length >= MAX_IMAGES_PER_PRODUCT) {
        throw new CatalogError('IMAGE_LIMIT', `a product shows at most ${MAX_IMAGES_PER_PRODUCT} images`, { maxImages: MAX_IMAGES_PER_PRODUCT });
      }
      await trx
        .insertInto('product_image')
        .values({
          id: randomUUID(),
          tenant_id: scope.tenantId,
          product_id: productId,
          image_id: image.id,
          position: placed.reduce((max, p) => Math.max(max, p.position), 0) + 1,
        })
        .execute();
      await touchProduct(trx, scope, productId);
    }),
  );
  return getProduct(scope, productId);
}

const orderInput = z.array(z.string().min(1)).max(MAX_IMAGES_PER_PRODUCT);

/** Put the product's images in this order (every image of the product, each once). */
export async function reorderProductImages(scope: CatalogScope, productId: string, imageIds: string[]): Promise<ProductDetail> {
  const parsed = orderInput.safeParse(imageIds);
  if (!parsed.success) throw invalid(parsed.error.issues.map((i) => ({ ...i, path: ['imageIds', ...i.path] })));
  await withDbErrors(() =>
    scope.db.transaction().execute(async (trx) => {
      await lockProduct(trx, scope, productId);
      const placed = await trx.selectFrom('product_image').select('id').where('tenant_id', '=', scope.tenantId).where('product_id', '=', productId).execute();
      const have = new Set(placed.map((p) => p.id));
      const sent = new Set(parsed.data);
      if (sent.size !== parsed.data.length || sent.size !== have.size || parsed.data.some((id) => !have.has(id))) {
        throw invalid([{ path: ['imageIds'], message: 'send every image of the product exactly once (reload the product)' }]);
      }
      // The position unique is DEFERRABLE INITIALLY DEFERRED (020): the swaps are checked at commit.
      for (const [i, id] of parsed.data.entries()) {
        await trx.updateTable('product_image').set({ position: i + 1 }).where('tenant_id', '=', scope.tenantId).where('id', '=', id).execute();
      }
      await touchProduct(trx, scope, productId);
    }),
  );
  return getProduct(scope, productId);
}

/** Change an image's alternative text (what a screen reader says on the shop). */
export async function setImageAlt(scope: CatalogScope, productId: string, imageId: string, alt: string | null): Promise<ProductDetail> {
  const parsed = z.string().trim().max(300, 'at most 300 characters').nullable().safeParse(alt);
  if (!parsed.success) throw invalid(parsed.error.issues.map((i) => ({ ...i, path: ['alt'] })));
  const value = parsed.data === '' ? null : parsed.data;
  await withDbErrors(() =>
    scope.db.transaction().execute(async (trx) => {
      await lockProduct(trx, scope, productId);
      const r = await trx
        .updateTable('product_image')
        .set({ alt: value })
        .where('tenant_id', '=', scope.tenantId)
        .where('product_id', '=', productId)
        .where('id', '=', imageId)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw notFound('image', imageId);
      await touchProduct(trx, scope, productId);
    }),
  );
  return getProduct(scope, productId);
}

/** Take an image off the product (the positions close up; the stored bytes stay). */
export async function removeProductImage(scope: CatalogScope, productId: string, imageId: string): Promise<ProductDetail> {
  await withDbErrors(() =>
    scope.db.transaction().execute(async (trx) => {
      await lockProduct(trx, scope, productId);
      const r = await trx
        .deleteFrom('product_image')
        .where('tenant_id', '=', scope.tenantId)
        .where('product_id', '=', productId)
        .where('id', '=', imageId)
        .executeTakeFirst();
      if (Number(r.numDeletedRows) === 0) throw notFound('image', imageId);
      const rest = await trx
        .selectFrom('product_image')
        .select('id')
        .where('tenant_id', '=', scope.tenantId)
        .where('product_id', '=', productId)
        .orderBy('position')
        .execute();
      for (const [i, row] of rest.entries()) {
        await trx.updateTable('product_image').set({ position: i + 1 }).where('tenant_id', '=', scope.tenantId).where('id', '=', row.id).execute();
      }
      await touchProduct(trx, scope, productId);
    }),
  );
  return getProduct(scope, productId);
}

/** A stored image id of the company by hash, or NOT_FOUND (for a collection's image). */
export async function imageIdByHash(db: Db, scope: CatalogScope, sha256: string): Promise<string> {
  const row = SHA256.test(sha256)
    ? await db.selectFrom('catalog_image').select('id').where('tenant_id', '=', scope.tenantId).where('sha256', '=', sha256).executeTakeFirst()
    : undefined;
  if (!row) throw notFound('image', SHA256.test(sha256) ? sha256 : null);
  return row.id;
}
