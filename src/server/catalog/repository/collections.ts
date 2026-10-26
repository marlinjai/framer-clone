// src/server/catalog/repository/collections.ts
//
// The company's manual collections (020 guarantee 8; the catalogue design's
// "Collections" tab): a title, a URL handle unique among the company's live
// collections, a formatted description, an image, and an ordered list of
// products. Archived, never deleted; an archived collection frees its handle
// and leaves the product table's collection column and filter. A product's
// collections are set from its panel (setProductCollections), a collection's
// products and their order from the collection's panel (setCollectionProducts).
// Every query filters on the company.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { CollectionDetail, CollectionView, ProductDetail } from '@/lib/catalog/types';
import { derivePair, richFromPlain, richTextSchema, type RichText } from '@/server/books/render/richText';
import { toJsonb } from '@/server/books/snapshots';

import { invalid, notFound, withDbErrors } from '../errors';
import type { CatalogScope } from '../scope';
import { imageIdByHash } from './images';
import { getProduct } from './products';
import { HANDLE_PATTERN, freeHandle, handleFrom, iso, lockProduct, touchProduct, type Db } from './shared';

/** The most products one collection lists. */
export const MAX_COLLECTION_PRODUCTS = 1000;

const title = z.string().trim().min(1, 'enter a title').max(200, 'at most 200 characters');

const createInput = z.object({ title }).strict();
const updateInput = z
  .object({
    title: title.optional(),
    handle: z.string().trim().toLowerCase().max(120).regex(HANDLE_PATTERN, 'letters, digits and single hyphens between words').optional(),
    description: z.string().max(4000).nullable().optional(),
    descriptionFormat: richTextSchema.nullable().optional(),
    /** The SHA-256 of one of the company's stored images, or null for none. */
    imageSha256: z.string().nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export type UpdateCollectionInput = z.input<typeof updateInput>;

async function collectionViews(db: Db, scope: CatalogScope, ids?: string[]): Promise<CollectionView[]> {
  let q = db
    .selectFrom('collection')
    .leftJoin('catalog_image', (j) => j.onRef('catalog_image.id', '=', 'collection.image_id').onRef('catalog_image.tenant_id', '=', 'collection.tenant_id'))
    .select((eb) => [
      'collection.id as id',
      'collection.title as title',
      'collection.handle as handle',
      'collection.description as description',
      'collection.description_format as description_format',
      'collection.archived_at as archived_at',
      'collection.updated_at as updated_at',
      'catalog_image.sha256 as sha256',
      'catalog_image.width as width',
      'catalog_image.height as height',
      eb
        .selectFrom('collection_product as cp')
        .innerJoin('product as p', (j) => j.onRef('p.id', '=', 'cp.product_id').onRef('p.tenant_id', '=', 'cp.tenant_id'))
        .whereRef('cp.collection_id', '=', 'collection.id')
        .whereRef('cp.tenant_id', '=', 'collection.tenant_id')
        .where('p.deleted_at', 'is', null)
        .select((e) => e.fn.countAll<string>().as('n'))
        .as('product_count'),
    ])
    .where('collection.tenant_id', '=', scope.tenantId);
  if (ids) q = q.where('collection.id', 'in', ids);
  const rows = await q.orderBy((eb) => eb.fn('lower', ['collection.title'])).orderBy('collection.id').execute();
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    handle: r.handle,
    description: r.description,
    descriptionFormat: (r.description_format as RichText | null) ?? null,
    image: r.sha256 && r.width && r.height ? { sha256: r.sha256, width: r.width, height: r.height } : null,
    archivedAt: r.archived_at ? iso(r.archived_at) : null,
    productCount: Number(r.product_count ?? 0),
    updatedAt: iso(r.updated_at),
  }));
}

/** The company's collections by title; archived ones only with `includeArchived`. */
export async function listCollections(scope: CatalogScope, opts: { includeArchived?: boolean } = {}): Promise<CollectionView[]> {
  const all = await collectionViews(scope.db, scope);
  return opts.includeArchived ? all : all.filter((c) => c.archivedAt === null);
}

/** One collection with its products in order, or NOT_FOUND. */
export async function getCollection(scope: CatalogScope, id: string): Promise<CollectionDetail> {
  const [view] = await collectionViews(scope.db, scope, [id]);
  if (!view) throw notFound('collection', id);
  const products = await scope.db
    .selectFrom('collection_product')
    .innerJoin('product', (j) => j.onRef('product.id', '=', 'collection_product.product_id').onRef('product.tenant_id', '=', 'collection_product.tenant_id'))
    .select((eb) => [
      'product.id as id',
      'product.title as title',
      'product.status as status',
      'product.archived_at as archived_at',
      eb
        .selectFrom('product_image as pi')
        .innerJoin('catalog_image as ci', (j) => j.onRef('ci.id', '=', 'pi.image_id').onRef('ci.tenant_id', '=', 'pi.tenant_id'))
        .whereRef('pi.product_id', '=', 'product.id')
        .whereRef('pi.tenant_id', '=', 'product.tenant_id')
        .orderBy('pi.position')
        .limit(1)
        .select('ci.sha256')
        .as('sha256'),
    ])
    .where('collection_product.tenant_id', '=', scope.tenantId)
    .where('collection_product.collection_id', '=', id)
    .where('product.deleted_at', 'is', null)
    .orderBy('collection_product.position')
    .execute();
  const shas = products.map((p) => p.sha256).filter((s): s is string => Boolean(s));
  const sizes = shas.length
    ? await scope.db.selectFrom('catalog_image').select(['sha256', 'width', 'height']).where('tenant_id', '=', scope.tenantId).where('sha256', 'in', shas).execute()
    : [];
  const sizeOf = new Map(sizes.map((s) => [s.sha256, s]));
  return {
    ...view,
    products: products.map((p) => {
      const size = p.sha256 ? sizeOf.get(p.sha256) : undefined;
      return {
        id: p.id,
        title: p.title,
        status: p.archived_at ? 'archived' : p.status,
        image: size ? { sha256: size.sha256, width: size.width, height: size.height } : null,
      };
    }),
  };
}

/** Add a collection (its handle from the title, free among the company's live collections). */
export async function createCollection(scope: CatalogScope, input: z.input<typeof createInput>): Promise<CollectionDetail> {
  const parsed = createInput.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues);
  const id = randomUUID();
  await withDbErrors(() =>
    scope.db.transaction().execute(async (trx) => {
      const handle = await freeHandle(trx, scope, 'collection', handleFrom(parsed.data.title));
      await trx
        .insertInto('collection')
        .values({ id, tenant_id: scope.tenantId, title: parsed.data.title, handle, updated_at: new Date() })
        .execute();
    }),
  );
  return getCollection(scope, id);
}

/** Change a collection's fields, archive or unarchive it (an unarchive whose handle a live collection took answers DUPLICATE_COLLECTION). */
export async function updateCollection(scope: CatalogScope, id: string, input: UpdateCollectionInput): Promise<CollectionDetail> {
  const parsed = updateInput.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues);
  const args = parsed.data;
  if (args.description !== undefined && args.descriptionFormat !== undefined) {
    throw invalid([{ path: ['descriptionFormat'], message: 'send the description as text or as a format, not both' }]);
  }
  await withDbErrors(() =>
    scope.db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom('collection').select('id').where('tenant_id', '=', scope.tenantId).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!current) throw notFound('collection', id);
      let description: { text: string | null; format: RichText | null } | undefined;
      if (args.descriptionFormat !== undefined) {
        description = args.descriptionFormat === null ? { text: null, format: null } : derivePair(args.descriptionFormat as RichText);
      } else if (args.description !== undefined) {
        description = args.description === null ? { text: null, format: null } : derivePair(richFromPlain(args.description));
      }
      const imageId = args.imageSha256 === undefined ? undefined : args.imageSha256 === null ? null : await imageIdByHash(trx, scope, args.imageSha256);
      await trx
        .updateTable('collection')
        .set({
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.handle !== undefined ? { handle: args.handle } : {}),
          ...(description ? { description: description.text, description_format: description.format ? toJsonb(description.format) : null } : {}),
          ...(imageId !== undefined ? { image_id: imageId } : {}),
          ...(args.archived !== undefined ? { archived_at: args.archived ? new Date() : null } : {}),
          updated_at: new Date(),
        })
        .where('tenant_id', '=', scope.tenantId)
        .where('id', '=', id)
        .execute();
    }),
  );
  return getCollection(scope, id);
}

const idList = (max: number) =>
  z
    .array(z.string().min(1))
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, 'an id is listed twice');

/** Make the collection list exactly these products, in this order. */
export async function setCollectionProducts(scope: CatalogScope, id: string, productIds: string[]): Promise<CollectionDetail> {
  const parsed = idList(MAX_COLLECTION_PRODUCTS).safeParse(productIds);
  if (!parsed.success) throw invalid(parsed.error.issues.map((i) => ({ ...i, path: ['productIds', ...i.path] })));
  const ids = parsed.data;
  await withDbErrors(() =>
    scope.db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom('collection').select('id').where('tenant_id', '=', scope.tenantId).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!current) throw notFound('collection', id);
      if (ids.length > 0) {
        const found = await trx.selectFrom('product').select('id').where('tenant_id', '=', scope.tenantId).where('id', 'in', ids).where('deleted_at', 'is', null).execute();
        const have = new Set(found.map((r) => r.id));
        const missing = ids.find((p) => !have.has(p));
        if (missing) throw notFound('product', missing);
      }
      const before = await trx.selectFrom('collection_product').select('product_id').where('tenant_id', '=', scope.tenantId).where('collection_id', '=', id).execute();
      await trx.deleteFrom('collection_product').where('tenant_id', '=', scope.tenantId).where('collection_id', '=', id).execute();
      if (ids.length > 0) {
        await trx
          .insertInto('collection_product')
          .values(ids.map((productId, i) => ({ tenant_id: scope.tenantId, collection_id: id, product_id: productId, position: i + 1 })))
          .execute();
      }
      const changed = new Set([...before.map((b) => b.product_id), ...ids]);
      if (changed.size > 0) {
        await trx.updateTable('product').set({ updated_at: new Date() }).where('tenant_id', '=', scope.tenantId).where('id', 'in', [...changed]).execute();
      }
      await trx.updateTable('collection').set({ updated_at: new Date() }).where('tenant_id', '=', scope.tenantId).where('id', '=', id).execute();
    }),
  );
  return getCollection(scope, id);
}

/**
 * Put a product into exactly these collections (from its panel): it leaves the
 * ones not listed, keeps its place in the ones it stays in, and is appended to
 * the end of the ones it joins.
 */
export async function setProductCollections(scope: CatalogScope, productId: string, collectionIds: string[]): Promise<ProductDetail> {
  const parsed = idList(200).safeParse(collectionIds);
  if (!parsed.success) throw invalid(parsed.error.issues.map((i) => ({ ...i, path: ['collectionIds', ...i.path] })));
  const wanted = parsed.data;
  await withDbErrors(() =>
    scope.db.transaction().execute(async (trx) => {
      await lockProduct(trx, scope, productId);
      if (wanted.length > 0) {
        const found = await trx
          .selectFrom('collection')
          .select('id')
          .where('tenant_id', '=', scope.tenantId)
          .where('id', 'in', wanted)
          .orderBy('id')
          .forUpdate()
          .execute();
        const have = new Set(found.map((r) => r.id));
        const missing = wanted.find((c) => !have.has(c));
        if (missing) throw notFound('collection', missing);
      }
      const current = await trx
        .selectFrom('collection_product')
        .select('collection_id')
        .where('tenant_id', '=', scope.tenantId)
        .where('product_id', '=', productId)
        .execute();
      const inside = new Set(current.map((c) => c.collection_id));
      const leave = [...inside].filter((c) => !wanted.includes(c));
      if (leave.length > 0) {
        await trx
          .deleteFrom('collection_product')
          .where('tenant_id', '=', scope.tenantId)
          .where('product_id', '=', productId)
          .where('collection_id', 'in', leave)
          .execute();
        // Close the gap the product left (positions stay 1..n).
        for (const c of leave) {
          const rest = await trx
            .selectFrom('collection_product')
            .select('product_id')
            .where('tenant_id', '=', scope.tenantId)
            .where('collection_id', '=', c)
            .orderBy('position')
            .execute();
          for (const [i, r] of rest.entries()) {
            await trx
              .updateTable('collection_product')
              .set({ position: i + 1 })
              .where('tenant_id', '=', scope.tenantId)
              .where('collection_id', '=', c)
              .where('product_id', '=', r.product_id)
              .execute();
          }
        }
      }
      for (const c of wanted.filter((c) => !inside.has(c))) {
        const { max } = await trx
          .selectFrom('collection_product')
          .select((eb) => eb.fn.max<number | null>('position').as('max'))
          .where('tenant_id', '=', scope.tenantId)
          .where('collection_id', '=', c)
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('collection_product')
          .values({ tenant_id: scope.tenantId, collection_id: c, product_id: productId, position: Number(max ?? 0) + 1 })
          .execute();
      }
      await touchProduct(trx, scope, productId);
    }),
  );
  return getProduct(scope, productId);
}
