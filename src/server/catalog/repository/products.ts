// src/server/catalog/repository/products.ts
//
// The company's products and services (catalogue design, slice 2): the table's
// list (search, filters, sort, keyset paging), one product with everything the
// side panel shows, create, per-field update, archive and unarchive, and the
// bulk actions. Every query filters on the company; another company's id
// answers NOT_FOUND, exactly like an unknown one.
//
// Kinds (020 guarantee 5): a `physical` product has variants built from up to
// three options (variants.ts); a `service` has exactly one variant, no options
// and no stock. A new physical product gets one variant with a generated SKU
// and tracked stock, so its stock can be set from the table at once; a service
// gets one untracked variant without a SKU.
//
// Status: the stored enum stays draft and published; archived is `archived_at`
// (020, "Archive is a column"). The table speaks of three statuses: setting
// `archived` stamps archived_at, setting draft or published stores it and
// clears archived_at.
//
// Text: `search_text` is the fold of title, type, tags and description
// (src/lib/books/searchKey.ts), rewritten on every write under the row lock; a
// formatted description is stored through derivePair, so the plain
// `description` is always derived from the format.

import { randomUUID } from 'node:crypto';
import { sql, type Expression, type ExpressionBuilder, type RawBuilder, type SqlBool } from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { z } from 'zod';

import { searchWords } from '@/lib/books/searchKey';
import {
  CATALOG_CURRENCY,
  type ProductDetail,
  type ProductListItem,
  type ProductListQuery,
  type ProductPage,
  type ProductStatus,
} from '@/lib/catalog/types';
import { derivePair, richFromPlain, richTextSchema, type RichText } from '@/server/books/render/richText';
import { toJsonb } from '@/server/books/snapshots';

import type { CommerceDB } from '../../commerce/db-types';
import { CatalogError, invalid, invalidField, notFound, withDbErrors } from '../errors';
import type { CatalogScope } from '../scope';
import {
  HANDLE_PATTERN,
  freeHandle,
  generatedSku,
  handleFrom,
  insertVariant,
  iso,
  liveVariant,
  lockProduct,
  productSearchText,
  setBasePrice,
  touchProduct,
  variantFigures,
} from './shared';

/** The largest amount, in cents (an INTEGER column). */
export const MAX_CENTS = 2_147_483_647;
/** The longest search a list request takes (characters). */
export const MAX_SEARCH_LENGTH = 100;
/** The most products one bulk action changes. */
export const MAX_BULK = 200;

const title = z
  .string()
  .trim()
  .min(1, 'enter a title')
  .max(300, 'at most 300 characters');
const cents = z.number().int('whole cents').min(0, 'not negative').max(MAX_CENTS);
const optionalText = (max: number) =>
  z
    .string()
    .max(max, `at most ${max} characters`)
    .nullable()
    .transform((v) => (v === null || v.trim() === '' ? null : v.trim()));
const tags = z
  .array(z.string().trim().min(1).max(50, 'a tag has at most 50 characters'))
  .max(50, 'at most 50 tags')
  .transform((list) => {
    const seen = new Set<string>();
    return list.filter((t) => {
      const key = t.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
const handle = z
  .string()
  .trim()
  .toLowerCase()
  .max(120, 'at most 120 characters')
  .regex(HANDLE_PATTERN, 'letters, digits and single hyphens between words');

const createInput = z
  .object({
    title,
    kind: z.enum(['physical', 'service']).default('physical'),
    status: z.enum(['draft', 'published']).default('draft'),
    productType: optionalText(100).optional(),
    price: cents.nullable().default(null),
    /** An exact handle (refused with DUPLICATE_HANDLE when taken); otherwise one is made from the title. */
    handle: handle.optional(),
  })
  .strict();
export type CreateProductInput = z.input<typeof createInput>;

const updateInput = z
  .object({
    title: title.optional(),
    handle: handle.optional(),
    kind: z.enum(['physical', 'service']).optional(),
    status: z.enum(['draft', 'published', 'archived']).optional(),
    productType: optionalText(100).optional(),
    tags: tags.optional(),
    description: z.string().max(4000).nullable().optional(),
    descriptionFormat: richTextSchema.nullable().optional(),
    taxClass: z.enum(['standard', 'reduced', 'zero']).optional(),
    priceBasis: z.enum(['net', 'gross']).optional(),
    unitLabel: z.string().trim().min(1, 'enter a unit').max(20).optional(),
    discountBp: z.number().int().min(0).max(10000).optional(),
    seoTitle: optionalText(120).optional(),
    seoDescription: optionalText(320).optional(),
  })
  .strict()
  .refine((v) => v.description === undefined || v.descriptionFormat === undefined, {
    message: 'send the description as text or as a format, not both',
    path: ['descriptionFormat'],
  });
export type UpdateProductInput = z.input<typeof updateInput>;

// --- one product ------------------------------------------------------------

/** The product with its options, variants, images, collections and hidden sites, or NOT_FOUND. */
export async function getProduct(scope: CatalogScope, productId: string): Promise<ProductDetail> {
  const db = scope.db;
  const p = await db
    .selectFrom('product')
    .select([
      'id',
      'title',
      'handle',
      'kind',
      'status',
      'archived_at',
      'product_type',
      'tags',
      'description',
      'description_format',
      'tax_class',
      'price_basis',
      'unit_label',
      'discount_bp',
      'seo_title',
      'seo_description',
      'created_at',
      'updated_at',
    ])
    .where('tenant_id', '=', scope.tenantId)
    .where('id', '=', productId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!p) throw notFound('product', productId);

  const [options, values, variants, matrix, images, collections, hidden] = await Promise.all([
    db
      .selectFrom('product_option')
      .select(['id', 'title'])
      .where('tenant_id', '=', scope.tenantId)
      .where('product_id', '=', productId)
      .where('deleted_at', 'is', null)
      .orderBy('created_at')
      .orderBy('id')
      .execute(),
    db
      .selectFrom('product_option_value')
      .innerJoin('product_option', (j) =>
        j.onRef('product_option.id', '=', 'product_option_value.option_id').onRef('product_option.tenant_id', '=', 'product_option_value.tenant_id'),
      )
      .select(['product_option_value.id as id', 'product_option_value.option_id as option_id', 'product_option_value.value as value'])
      .where('product_option_value.tenant_id', '=', scope.tenantId)
      .where('product_option.product_id', '=', productId)
      .where('product_option_value.deleted_at', 'is', null)
      .orderBy('product_option_value.created_at')
      .orderBy('product_option_value.id')
      .execute(),
    db
      .selectFrom('product_variant')
      .select(['id', 'title', 'sku', 'barcode', 'manage_inventory', 'allow_backorder', 'created_at'])
      .where('tenant_id', '=', scope.tenantId)
      .where('product_id', '=', productId)
      .where('deleted_at', 'is', null)
      .orderBy('created_at')
      .orderBy('id')
      .execute(),
    db
      .selectFrom('product_variant_option')
      .innerJoin('product_variant', (j) =>
        j.onRef('product_variant.id', '=', 'product_variant_option.variant_id').onRef('product_variant.tenant_id', '=', 'product_variant_option.tenant_id'),
      )
      .select(['product_variant_option.variant_id as variant_id', 'product_variant_option.option_id as option_id', 'product_variant_option.option_value_id as value_id'])
      .where('product_variant_option.tenant_id', '=', scope.tenantId)
      .where('product_variant.product_id', '=', productId)
      .where('product_variant.deleted_at', 'is', null)
      .execute(),
    db
      .selectFrom('product_image')
      .innerJoin('catalog_image', (j) => j.onRef('catalog_image.id', '=', 'product_image.image_id').onRef('catalog_image.tenant_id', '=', 'product_image.tenant_id'))
      .select([
        'product_image.id as id',
        'product_image.position as position',
        'product_image.alt as alt',
        'product_image.variant_id as variant_id',
        'catalog_image.sha256 as sha256',
        'catalog_image.width as width',
        'catalog_image.height as height',
        'catalog_image.content_type as content_type',
      ])
      .where('product_image.tenant_id', '=', scope.tenantId)
      .where('product_image.product_id', '=', productId)
      .orderBy('product_image.position')
      .execute(),
    db
      .selectFrom('collection_product')
      .innerJoin('collection', (j) => j.onRef('collection.id', '=', 'collection_product.collection_id').onRef('collection.tenant_id', '=', 'collection_product.tenant_id'))
      .select(['collection.id as id', 'collection.title as title'])
      .where('collection_product.tenant_id', '=', scope.tenantId)
      .where('collection_product.product_id', '=', productId)
      .where('collection.archived_at', 'is', null)
      .orderBy('collection.title')
      .execute(),
    db
      .selectFrom('product_site_hidden')
      .select('site_id')
      .where('tenant_id', '=', scope.tenantId)
      .where('product_id', '=', productId)
      .orderBy('site_id')
      .execute(),
  ]);

  const figures = await variantFigures(db, scope, variants);
  const optionOrder = options.map((o) => o.id);
  const valueIndex = new Map(values.map((v, i) => [v.id, i]));
  const valuesOf = new Map<string, Map<string, string>>();
  for (const m of matrix) {
    const byOption = valuesOf.get(m.variant_id) ?? new Map<string, string>();
    byOption.set(m.option_id, m.value_id);
    valuesOf.set(m.variant_id, byOption);
  }
  const imageOf = new Map<string, string>();
  for (const img of images) if (img.variant_id && !imageOf.has(img.variant_id)) imageOf.set(img.variant_id, img.id);

  const variantViews = variants.map((v) => {
    const byOption = valuesOf.get(v.id) ?? new Map<string, string>();
    const f = figures.get(v.id);
    return {
      id: v.id,
      title: v.title,
      sku: v.sku,
      barcode: v.barcode,
      price: f?.price ?? null,
      compareAt: f?.compareAt ?? null,
      manageInventory: v.manage_inventory,
      allowBackorder: v.allow_backorder,
      stock: f?.stock ?? null,
      imageId: imageOf.get(v.id) ?? null,
      values: optionOrder.flatMap((optionId) => {
        const valueId = byOption.get(optionId);
        return valueId ? [{ optionId, valueId }] : [];
      }),
    };
  });
  // In matrix order (the first option's values outermost), not in creation order.
  const rank = (v: (typeof variantViews)[number]) => optionOrder.map((o) => valueIndex.get(v.values.find((x) => x.optionId === o)?.valueId ?? '') ?? -1);
  variantViews.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return 0;
  });

  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    kind: p.kind === 'service' ? 'service' : 'physical',
    status: p.archived_at ? 'archived' : p.status,
    publishStatus: p.status,
    productType: p.product_type,
    tags: p.tags,
    description: p.description,
    descriptionFormat: (p.description_format as RichText | null) ?? null,
    taxClass: (p.tax_class as ProductDetail['taxClass'] | null) ?? 'standard',
    priceBasis: p.price_basis === 'net' ? 'net' : 'gross',
    unitLabel: p.unit_label,
    discountBp: p.discount_bp,
    seoTitle: p.seo_title,
    seoDescription: p.seo_description,
    archivedAt: p.archived_at ? iso(p.archived_at) : null,
    createdAt: iso(p.created_at),
    updatedAt: iso(p.updated_at),
    options: options.map((o) => ({ id: o.id, title: o.title, values: values.filter((v) => v.option_id === o.id).map((v) => ({ id: v.id, value: v.value })) })),
    variants: variantViews,
    images: images.map((img) => ({
      id: img.id,
      sha256: img.sha256,
      width: img.width,
      height: img.height,
      contentType: img.content_type,
      position: img.position,
      alt: img.alt,
      variantId: img.variant_id,
    })),
    collections,
    hiddenSiteIds: hidden.map((h) => h.site_id),
  };
}

// --- create -------------------------------------------------------------------

/** Add a product (physical, with one tracked variant and a generated SKU) or a service (one untracked variant). */
export async function createProduct(scope: CatalogScope, input: CreateProductInput): Promise<ProductDetail> {
  const parsed = createInput.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues);
  const args = parsed.data;
  const productType = args.productType ?? null;
  const id = randomUUID();
  await withDbErrors(() =>
    scope.db.transaction().execute(async (trx) => {
      const handleValue = args.handle ?? (await freeHandle(trx, scope, 'product', handleFrom(args.title)));
      const now = new Date();
      await trx
        .insertInto('product')
        .values({
          id,
          tenant_id: scope.tenantId,
          title: args.title,
          handle: handleValue,
          status: args.status,
          kind: args.kind,
          product_type: productType,
          tax_class: 'standard',
          search_text: productSearchText({ title: args.title, productType, tags: [], description: null }),
          created_at: now,
          updated_at: now,
        })
        .execute();
      const physical = args.kind === 'physical';
      await insertVariant(trx, scope, {
        productId: id,
        title: null,
        sku: physical ? generatedSku(handleValue) : null,
        manageInventory: physical,
        allowBackorder: false,
        price: args.price,
        compareAt: null,
      });
    }),
  );
  return getProduct(scope, id);
}

// --- update -------------------------------------------------------------------

/**
 * Change any subset of a product's own fields (one field per save from the
 * panel, several from a script). An archived product can be corrected too.
 * Kind: a service becomes physical freely; a physical product becomes a service
 * only while it has no options and one variant (KIND_LOCKED otherwise), and its
 * variant then stops tracking stock.
 */
export async function updateProduct(scope: CatalogScope, productId: string, input: UpdateProductInput): Promise<ProductDetail> {
  const parsed = updateInput.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues);
  const args = parsed.data;
  await withDbErrors(() =>
    scope.db.transaction().execute(async (trx) => {
      await lockProduct(trx, scope, productId);
      const current = await trx
        .selectFrom('product')
        .select(['title', 'product_type', 'tags', 'description', 'kind'])
        .where('tenant_id', '=', scope.tenantId)
        .where('id', '=', productId)
        .executeTakeFirstOrThrow();

      let description: { text: string | null; format: RichText | null } | undefined;
      if (args.descriptionFormat !== undefined) {
        description = args.descriptionFormat === null ? { text: null, format: null } : derivePair(args.descriptionFormat as RichText);
      } else if (args.description !== undefined) {
        description = args.description === null ? { text: null, format: null } : derivePair(richFromPlain(args.description));
      }

      if (args.kind !== undefined && args.kind !== current.kind) {
        if (args.kind === 'service') {
          const [{ n: optionCount }] = await trx
            .selectFrom('product_option')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('tenant_id', '=', scope.tenantId)
            .where('product_id', '=', productId)
            .where('deleted_at', 'is', null)
            .execute();
          const [{ n: variantCount }] = await trx
            .selectFrom('product_variant')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('tenant_id', '=', scope.tenantId)
            .where('product_id', '=', productId)
            .where('deleted_at', 'is', null)
            .execute();
          if (Number(optionCount) > 0 || Number(variantCount) > 1) {
            throw new CatalogError('KIND_LOCKED', 'a product with options or several variants cannot become a service; remove its options first', {
              field: 'kind',
            });
          }
          await trx
            .updateTable('product_variant')
            .set({ manage_inventory: false, allow_backorder: false, updated_at: new Date() })
            .where('tenant_id', '=', scope.tenantId)
            .where('product_id', '=', productId)
            .where('deleted_at', 'is', null)
            .execute();
        }
      }

      const next = {
        title: args.title ?? current.title,
        productType: args.productType !== undefined ? args.productType : current.product_type,
        tags: args.tags ?? current.tags,
        description: description ? description.text : current.description,
      };
      let status: { status?: 'draft' | 'published'; archived_at?: Date | null } = {};
      if (args.status === 'archived') status = { archived_at: new Date() };
      else if (args.status) status = { status: args.status, archived_at: null };

      await trx
        .updateTable('product')
        .set({
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.handle !== undefined ? { handle: args.handle } : {}),
          ...(args.kind !== undefined ? { kind: args.kind } : {}),
          ...status,
          ...(args.productType !== undefined ? { product_type: args.productType } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(description
            ? { description: description.text, description_format: description.format ? toJsonb(description.format) : null }
            : {}),
          ...(args.taxClass !== undefined ? { tax_class: args.taxClass } : {}),
          ...(args.priceBasis !== undefined ? { price_basis: args.priceBasis } : {}),
          ...(args.unitLabel !== undefined ? { unit_label: args.unitLabel } : {}),
          ...(args.discountBp !== undefined ? { discount_bp: args.discountBp } : {}),
          ...(args.seoTitle !== undefined ? { seo_title: args.seoTitle } : {}),
          ...(args.seoDescription !== undefined ? { seo_description: args.seoDescription } : {}),
          search_text: productSearchText(next),
          updated_at: new Date(),
        })
        .where('tenant_id', '=', scope.tenantId)
        .where('id', '=', productId)
        .execute();
    }),
  );
  return getProduct(scope, productId);
}

/** Archive or unarchive one product (idempotent). */
export async function setArchived(scope: CatalogScope, productId: string, archived: boolean): Promise<ProductDetail> {
  const done = await scope.db
    .updateTable('product')
    .set(archived ? { archived_at: new Date(), updated_at: new Date() } : { archived_at: null, updated_at: new Date() })
    .where('tenant_id', '=', scope.tenantId)
    .where('id', '=', productId)
    .where('deleted_at', 'is', null)
    .where('archived_at', archived ? 'is' : 'is not', null)
    .executeTakeFirst();
  if (Number(done.numUpdatedRows) === 0) await getProduct(scope, productId); // NOT_FOUND, or already as asked
  return getProduct(scope, productId);
}

// --- inline edits of a single-variant product ----------------------------------

/** The table's inline price edit: the one variant's price (KIND rules: only a product with exactly one variant). */
export async function setSinglePrice(scope: CatalogScope, productId: string, price: number | null): Promise<ProductDetail> {
  const parsed = cents.nullable().safeParse(price);
  if (!parsed.success) throw invalid(parsed.error.issues.map((i) => ({ ...i, path: ['price'] })));
  await withDbErrors(() =>
    scope.db.transaction().execute(async (trx) => {
      await lockProduct(trx, scope, productId);
      const variants = await trx
        .selectFrom('product_variant')
        .select('id')
        .where('tenant_id', '=', scope.tenantId)
        .where('product_id', '=', productId)
        .where('deleted_at', 'is', null)
        .execute();
      if (variants.length !== 1) throw invalidField('price', 'this product has several variants; set their prices in the panel');
      const variant = await liveVariant(trx, scope, productId, variants[0].id);
      const current = await variantFigures(trx, scope, [variant]);
      const compareAt = price === null ? null : (current.get(variant.id)?.compareAt ?? null);
      await setBasePrice(trx, scope, variant.id, parsed.data, compareAt);
      await touchProduct(trx, scope, productId);
    }),
  );
  return getProduct(scope, productId);
}

// --- bulk ---------------------------------------------------------------------

const bulkInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), ids: z.array(z.string().min(1)).min(1).max(MAX_BULK), status: z.enum(['draft', 'published']) }).strict(),
  z.object({ action: z.literal('archive'), ids: z.array(z.string().min(1)).min(1).max(MAX_BULK) }).strict(),
  z.object({ action: z.literal('unarchive'), ids: z.array(z.string().min(1)).min(1).max(MAX_BULK) }).strict(),
  z.object({ action: z.literal('addToCollection'), ids: z.array(z.string().min(1)).min(1).max(MAX_BULK), collectionId: z.string().min(1) }).strict(),
]);
export type BulkInput = z.input<typeof bulkInput>;

/**
 * One action on several products of the company, all or nothing: an id that is
 * not the company's live product refuses the whole action with NOT_FOUND (it
 * names the first such id), so a stale selection never half-applies. Status
 * draft or published also clears an archive; adding to a collection appends the
 * products not yet in it, in the order given.
 */
export async function bulkProducts(scope: CatalogScope, input: BulkInput): Promise<{ changed: number }> {
  const parsed = bulkInput.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues);
  const args = parsed.data;
  const ids = [...new Set(args.ids)];
  return withDbErrors(() =>
    scope.db.transaction().execute(async (trx) => {
      const found = await trx
        .selectFrom('product')
        .select('id')
        .where('tenant_id', '=', scope.tenantId)
        .where('id', 'in', ids)
        .where('deleted_at', 'is', null)
        .orderBy('id')
        .forUpdate()
        .execute();
      const have = new Set(found.map((r) => r.id));
      const missing = ids.find((id) => !have.has(id));
      if (missing) throw notFound('product', missing);
      const now = new Date();
      if (args.action === 'status') {
        await trx.updateTable('product').set({ status: args.status, archived_at: null, updated_at: now }).where('tenant_id', '=', scope.tenantId).where('id', 'in', ids).execute();
        return { changed: ids.length };
      }
      if (args.action === 'archive' || args.action === 'unarchive') {
        const r = await trx
          .updateTable('product')
          .set({ archived_at: args.action === 'archive' ? now : null, updated_at: now })
          .where('tenant_id', '=', scope.tenantId)
          .where('id', 'in', ids)
          .where('archived_at', args.action === 'archive' ? 'is' : 'is not', null)
          .executeTakeFirst();
        return { changed: Number(r.numUpdatedRows) };
      }
      const collection = await trx
        .selectFrom('collection')
        .select('id')
        .where('tenant_id', '=', scope.tenantId)
        .where('id', '=', args.collectionId)
        .forUpdate()
        .executeTakeFirst();
      if (!collection) throw notFound('collection', args.collectionId);
      const members = await trx
        .selectFrom('collection_product')
        .select(['product_id', 'position'])
        .where('tenant_id', '=', scope.tenantId)
        .where('collection_id', '=', collection.id)
        .execute();
      const inside = new Set(members.map((m) => m.product_id));
      let position = members.reduce((max, m) => Math.max(max, m.position), 0);
      const added = ids.filter((id) => !inside.has(id));
      if (added.length > 0) {
        await trx
          .insertInto('collection_product')
          .values(added.map((productId) => ({ tenant_id: scope.tenantId, collection_id: collection.id, product_id: productId, position: (position += 1) })))
          .execute();
        await trx.updateTable('collection').set({ updated_at: now }).where('tenant_id', '=', scope.tenantId).where('id', '=', collection.id).execute();
        await trx.updateTable('product').set({ updated_at: now }).where('tenant_id', '=', scope.tenantId).where('id', 'in', added).execute();
      }
      return { changed: added.length };
    }),
  );
}

// --- the list -----------------------------------------------------------------

const listInput = z
  .object({
    q: z.string().max(MAX_SEARCH_LENGTH).default(''),
    status: z.enum(['draft', 'published', 'archived', 'all']).optional(),
    type: z.string().max(100).optional(),
    collection: z.string().max(100).optional(),
    stock: z.enum(['in_stock', 'out_of_stock', 'untracked']).optional(),
    sort: z.enum(['updated', 'title', 'created', 'price', 'stock']).default('updated'),
    dir: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2000).optional(),
  })
  .strict();

type ProductEb = ExpressionBuilder<CommerceDB, 'product'>;

/** The live variants of the row's product (a correlated subquery). */
function liveVariantsOf(eb: ProductEb) {
  return eb
    .selectFrom('product_variant as v')
    .whereRef('v.product_id', '=', 'product.id')
    .whereRef('v.tenant_id', '=', 'product.tenant_id')
    .where('v.deleted_at', 'is', null);
}

/** min or max of the live variants' base EUR prices. */
function priceOf(eb: ProductEb, fn: 'min' | 'max'): RawBuilder<number | null> {
  const sub = eb
    .selectFrom('price as pr')
    .innerJoin('price_set as ps', (j) => j.onRef('ps.id', '=', 'pr.price_set_id').onRef('ps.tenant_id', '=', 'pr.tenant_id'))
    .innerJoin('product_variant as v', (j) => j.onRef('v.id', '=', 'ps.variant_id').onRef('v.tenant_id', '=', 'ps.tenant_id'))
    .whereRef('v.product_id', '=', 'product.id')
    .whereRef('v.tenant_id', '=', 'product.tenant_id')
    .where('v.deleted_at', 'is', null)
    .where('pr.currency_code', '=', CATALOG_CURRENCY)
    .where('pr.price_list_id', 'is', null)
    .where('pr.min_quantity', 'is', null)
    .where('pr.max_quantity', 'is', null)
    .select((e) => (fn === 'min' ? e.fn.min<number | null>('pr.amount') : e.fn.max<number | null>('pr.amount')).as('amount'));
  return sql<number | null>`(${sub})`;
}

/** Available units over the tracked variants (through the SKU bridge), null when none is tracked. */
function stockOf(eb: ProductEb): RawBuilder<string | null> {
  const tracked = liveVariantsOf(eb).where('v.manage_inventory', '=', true).select((e) => e.fn.countAll<string>().as('n'));
  const sum = eb
    .selectFrom('product_variant as v')
    .innerJoin('inventory_item as ii', (j) => j.onRef('ii.sku', '=', 'v.sku'))
    .innerJoin('inventory_level as il', 'il.inventory_item_id', 'ii.id')
    .whereRef('v.product_id', '=', 'product.id')
    .whereRef('v.tenant_id', '=', 'product.tenant_id')
    .where('v.deleted_at', 'is', null)
    .where('v.manage_inventory', '=', true)
    .where('ii.deleted_at', 'is', null)
    .select((e) => e.fn.sum<string | null>('il.available_quantity').as('n'));
  return sql<string | null>`CASE WHEN (${tracked}) > 0 THEN COALESCE((${sum}), 0) END`;
}

interface SortSpec {
  expr: (eb: ProductEb) => Expression<unknown>;
  cast: 'timestamp(3)' | 'text' | 'bigint';
  defaultDir: 'asc' | 'desc';
}

const SORTS: Record<z.infer<typeof listInput>['sort'], SortSpec> = {
  updated: { expr: (eb) => eb.ref('product.updated_at'), cast: 'timestamp(3)', defaultDir: 'desc' },
  created: { expr: (eb) => eb.ref('product.created_at'), cast: 'timestamp(3)', defaultDir: 'desc' },
  title: { expr: (eb) => sql`lower(${eb.ref('product.title')})`, cast: 'text', defaultDir: 'asc' },
  // Products without a price, or without tracked stock, sort as the lowest.
  price: { expr: (eb) => sql`COALESCE((${priceOf(eb, 'min')}), -1)`, cast: 'bigint', defaultDir: 'asc' },
  stock: { expr: (eb) => sql`COALESCE((${stockOf(eb)}), -2147483648)`, cast: 'bigint', defaultDir: 'asc' },
};

/** The keyset cursor: the sort, its direction, the last row's sort value as text, and its id. Opaque to the client. */
interface ListCursor {
  sort: string;
  dir: string;
  value: string;
  id: string;
}

function encodeCursor(c: ListCursor): string {
  return Buffer.from(JSON.stringify([c.sort, c.dir, c.value, c.id]), 'utf8').toString('base64url');
}

function decodeCursor(text: string, sort: string, dir: string): ListCursor {
  try {
    const v: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'string') && v[0] === sort && v[1] === dir) {
      return { sort: v[0], dir: v[1], value: v[2], id: v[3] };
    }
  } catch {
    // reported below
  }
  throw invalidField('cursor', 'not a cursor of this list and sort; start from the first page');
}

/** LIKE pattern for a folded word, its metacharacters escaped. */
function containsPattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * One page of the company's products for the table. Without a status filter the
 * live (unarchived) products are listed; `all` lists archived ones too. `q`
 * matches title, type, tags and description (folded) and the variants' SKUs;
 * with several words every word must occur. Filters: type (exact), collection,
 * stock state (in stock: tracked with more than nothing available; out of
 * stock: tracked with nothing; untracked). Sorted by the given column, ties by
 * id; paged by a keyset cursor bound to the sort.
 */
export async function listProducts(scope: CatalogScope, query: ProductListQuery = {}): Promise<ProductPage> {
  const parsed = listInput.safeParse(query);
  if (!parsed.success) throw invalid(parsed.error.issues);
  const args = parsed.data;
  const spec = SORTS[args.sort];
  const dir = args.dir ?? spec.defaultDir;
  const cursor = args.cursor ? decodeCursor(args.cursor, args.sort, dir) : null;
  const words = searchWords(args.q);

  const filters = (eb: ProductEb): Expression<SqlBool> => {
    const conds: Expression<SqlBool>[] = [eb('product.tenant_id', '=', scope.tenantId), eb('product.deleted_at', 'is', null)];
    if (args.status === undefined) conds.push(eb('product.archived_at', 'is', null));
    else if (args.status === 'archived') conds.push(eb('product.archived_at', 'is not', null));
    else if (args.status !== 'all') conds.push(eb.and([eb('product.archived_at', 'is', null), eb('product.status', '=', args.status)]));
    if (args.type) conds.push(eb('product.product_type', '=', args.type));
    if (args.collection) {
      conds.push(
        eb.exists(
          eb
            .selectFrom('collection_product as cp')
            .whereRef('cp.product_id', '=', 'product.id')
            .whereRef('cp.tenant_id', '=', 'product.tenant_id')
            .where('cp.collection_id', '=', args.collection)
            .select('cp.product_id'),
        ),
      );
    }
    if (args.stock === 'untracked') conds.push(sql<SqlBool>`(${stockOf(eb)}) IS NULL`);
    if (args.stock === 'in_stock') conds.push(sql<SqlBool>`(${stockOf(eb)}) > 0`);
    if (args.stock === 'out_of_stock') conds.push(sql<SqlBool>`(${stockOf(eb)}) <= 0`);
    for (const word of words) {
      const pattern = containsPattern(word);
      conds.push(
        eb.or([
          eb(eb.fn.coalesce('product.search_text', sql.lit('')), 'like', pattern),
          eb.exists(liveVariantsOf(eb).where((ve) => ve(sql<string>`lower(${ve.ref('v.sku')})`, 'like', pattern)).select('v.id')),
        ]),
      );
    }
    return eb.and(conds);
  };

  let q = scope.db
    .selectFrom('product')
    .select((eb) => [
      'product.id as id',
      'product.title as title',
      'product.handle as handle',
      'product.kind as kind',
      'product.status as status',
      'product.archived_at as archived_at',
      'product.product_type as product_type',
      'product.updated_at as updated_at',
      liveVariantsOf(eb).select((e) => e.fn.countAll<string>().as('n')).as('variant_count'),
      priceOf(eb, 'min').as('price_min'),
      priceOf(eb, 'max').as('price_max'),
      stockOf(eb).as('stock'),
      sql<string>`(${spec.expr(eb)})::text`.as('sort_value'),
      jsonObjectFrom(
        eb
          .selectFrom('product_image as pi')
          .innerJoin('catalog_image as ci', (j) => j.onRef('ci.id', '=', 'pi.image_id').onRef('ci.tenant_id', '=', 'pi.tenant_id'))
          .whereRef('pi.product_id', '=', 'product.id')
          .whereRef('pi.tenant_id', '=', 'product.tenant_id')
          .orderBy('pi.position')
          .limit(1)
          .select(['ci.sha256 as sha256', 'ci.width as width', 'ci.height as height']),
      ).as('image'),
      jsonArrayFrom(
        eb
          .selectFrom('collection_product as cp')
          .innerJoin('collection as c', (j) => j.onRef('c.id', '=', 'cp.collection_id').onRef('c.tenant_id', '=', 'cp.tenant_id'))
          .whereRef('cp.product_id', '=', 'product.id')
          .whereRef('cp.tenant_id', '=', 'product.tenant_id')
          .where('c.archived_at', 'is', null)
          .orderBy('c.title')
          .select(['c.id as id', 'c.title as title']),
      ).as('collections'),
    ])
    .where(filters);
  if (cursor) {
    const castValue =
      spec.cast === 'text'
        ? sql`CAST(${cursor.value} AS text)`
        : spec.cast === 'bigint'
          ? sql`CAST(${cursor.value} AS bigint)`
          : sql`CAST(${cursor.value} AS timestamp(3))`;
    q = q.where((eb) => {
      const expr = spec.expr(eb);
      return dir === 'asc'
        ? sql<SqlBool>`((${expr}) > ${castValue} OR ((${expr}) = ${castValue} AND ${eb.ref('product.id')} > ${cursor.id}))`
        : sql<SqlBool>`((${expr}) < ${castValue} OR ((${expr}) = ${castValue} AND ${eb.ref('product.id')} > ${cursor.id}))`;
    });
  }
  const count = scope.db
    .selectFrom('product')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where(filters);

  const [rows, counted] = await Promise.all([
    q
      .orderBy((eb) => spec.expr(eb) as Expression<string>, dir)
      .orderBy('product.id', 'asc')
      .limit(args.limit + 1)
      .execute(),
    count.executeTakeFirstOrThrow(),
  ]);
  const page = rows.slice(0, args.limit);

  // The single variant of each one-variant product, for the inline edits.
  const singleIds = page.filter((r) => Number(r.variant_count) === 1).map((r) => r.id);
  const singles = singleIds.length
    ? await scope.db
        .selectFrom('product_variant')
        .select(['id', 'product_id', 'sku', 'manage_inventory'])
        .where('tenant_id', '=', scope.tenantId)
        .where('product_id', 'in', singleIds)
        .where('deleted_at', 'is', null)
        .execute()
    : [];
  const figures = await variantFigures(scope.db, scope, singles);
  const singleOf = new Map(singles.map((v) => [v.product_id, v]));

  const items: ProductListItem[] = page.map((r) => {
    const single = singleOf.get(r.id);
    const f = single ? figures.get(single.id) : undefined;
    const status: ProductStatus = r.archived_at ? 'archived' : r.status;
    return {
      id: r.id,
      title: r.title,
      handle: r.handle,
      kind: r.kind === 'service' ? 'service' : 'physical',
      status,
      productType: r.product_type,
      variantCount: Number(r.variant_count),
      priceMin: r.price_min === null ? null : Number(r.price_min),
      priceMax: r.price_max === null ? null : Number(r.price_max),
      stock: r.stock === null ? null : Number(r.stock),
      image: r.image ? { sha256: r.image.sha256, width: r.image.width, height: r.image.height } : null,
      collections: r.collections,
      single: single
        ? { id: single.id, sku: single.sku, price: f?.price ?? null, manageInventory: single.manage_inventory, stock: f?.stock ?? null }
        : null,
      updatedAt: iso(r.updated_at),
    };
  });
  const last = page[page.length - 1];
  return {
    items,
    total: Number(counted.n),
    nextCursor: rows.length > args.limit && last ? encodeCursor({ sort: args.sort, dir, value: last.sort_value, id: last.id }) : null,
  };
}

/** The product types the company uses (for the type filter and the type field's suggestions). */
export async function listProductTypes(scope: CatalogScope): Promise<string[]> {
  const rows = await scope.db
    .selectFrom('product')
    .select('product_type')
    .distinct()
    .where('tenant_id', '=', scope.tenantId)
    .where('deleted_at', 'is', null)
    .where('product_type', 'is not', null)
    .orderBy('product_type')
    .limit(200)
    .execute();
  return rows.map((r) => r.product_type as string);
}
