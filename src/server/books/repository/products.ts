// src/server/books/repository/products.ts
//
// The company's product and service list (invoice editor plan, phase 4;
// migration 015_books_products). An item holds what a draft line is filled
// from: kind, name (the line's title), description, unit label, unit price in
// cents with the basis it is quoted in (net or gross), tax class and a default
// discount in basis points. Lines copy these values (src/lib/books/products.ts)
// and never reference the item, so nothing here can change a draft or an
// issued document.
//
// Items are archived, never deleted: an archived item leaves the search and
// frees its name, and can be restored (unless a live item took the name
// meanwhile: DUPLICATE_PRODUCT). A name is unique among the company's live
// items, compared folded (case, accents and repeated spaces do not count);
// `name_key` and `search_text` are that fold (src/lib/books/searchKey.ts),
// recomputed on every write under a row lock so they always match the row.
//
// Every query filters on the company: another company's id answers NOT_FOUND,
// exactly like an unknown one.

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';

import { DEFAULT_PRODUCT_UNIT, productNameProblem } from '@/lib/books/products';
import { foldKey, searchWords } from '@/lib/books/searchKey';

import { BooksError, constraintName, invalid, sqlState } from '../errors';
import type { BooksScope } from '../scope';
import { MAX_AMOUNT_CENTS } from '../totals';
import { PRODUCT_COLUMNS } from './columns';

export type ProductKind = 'service' | 'product';
export type PriceBasis = 'net' | 'gross';
export type ProductTaxClass = 'standard' | 'reduced' | 'zero';

export interface Product {
  id: string;
  kind: ProductKind;
  name: string;
  description: string | null;
  unitLabel: string;
  /** Cents, in `priceBasis`. */
  unitPrice: number;
  priceBasis: PriceBasis;
  taxClass: ProductTaxClass;
  /** Basis points. */
  discountBp: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ProductRow {
  id: string;
  kind: ProductKind;
  name: string;
  description: string | null;
  unit_label: string;
  unit_price: number;
  price_basis: PriceBasis;
  tax_class: ProductTaxClass;
  discount_bp: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapProduct(row: ProductRow): Product {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    unitLabel: row.unit_label,
    unitPrice: row.unit_price,
    priceBasis: row.price_basis,
    taxClass: row.tax_class,
    discountBp: row.discount_bp,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The unique index of 015 (guarantee 3): one live item per folded name and company. */
const LIVE_NAME_INDEX = 'books_product_tenant_id_name_key_live_key';

/** The longest search a list request takes (characters). */
export const MAX_SEARCH_LENGTH = 100;

// The same bounds as a draft line (lines.ts), so a copied item is always a valid line.
const fields = {
  kind: z.enum(['service', 'product']),
  // The form's rule (src/lib/books/products.ts): 1 to 300 characters, a letter or digit, a bounded fold.
  name: z
    .string()
    .trim()
    .superRefine((v, ctx) => {
      const problem = productNameProblem(v);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
  // Whitespace only is no description.
  description: z
    .string()
    .max(4000)
    .nullable()
    .transform((v) => (v === null || v.trim() === '' ? null : v)),
  unitLabel: z.string().trim().min(1).max(20),
  unitPrice: z.number().int().min(0).max(MAX_AMOUNT_CENTS),
  priceBasis: z.enum(['net', 'gross']),
  taxClass: z.enum(['standard', 'reduced', 'zero']),
  discountBp: z.number().int().min(0).max(10000),
};

const createInput = z
  .object({
    kind: fields.kind.default('service'),
    name: fields.name,
    description: fields.description.optional(),
    unitLabel: fields.unitLabel.default(DEFAULT_PRODUCT_UNIT),
    unitPrice: fields.unitPrice,
    priceBasis: fields.priceBasis.default('net'),
    taxClass: fields.taxClass.default('standard'),
    discountBp: fields.discountBp.default(0),
  })
  .strict();
export type CreateProductInput = z.input<typeof createInput>;

const updateInput = z
  .object({
    kind: fields.kind.optional(),
    name: fields.name.optional(),
    description: fields.description.optional(),
    unitLabel: fields.unitLabel.optional(),
    unitPrice: fields.unitPrice.optional(),
    priceBasis: fields.priceBasis.optional(),
    taxClass: fields.taxClass.optional(),
    discountBp: fields.discountBp.optional(),
  })
  .strict();
export type UpdateProductInput = z.input<typeof updateInput>;

/** The two folded columns of a row with this name and description. */
function folded(name: string, description: string | null): { name_key: string; search_text: string } {
  return { name_key: foldKey(name), search_text: foldKey(`${name} ${description ?? ''}`) };
}

/** Run a write and turn the live-name index's violation into DUPLICATE_PRODUCT. */
async function uniqueName<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (sqlState(err) === '23505' && constraintName(err) === LIVE_NAME_INDEX) {
      throw new BooksError('DUPLICATE_PRODUCT', 'DUPLICATE_PRODUCT: a live item has this name', { field: 'name' });
    }
    throw err;
  }
}

function notFound(id: string): BooksError {
  return new BooksError('NOT_FOUND', 'NOT_FOUND: product', { productId: id });
}

/** Add an item to the company's list. */
export async function createProduct(scope: BooksScope, input: CreateProductInput): Promise<Product> {
  const parsed = createInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;
  const description = args.description ?? null;
  const row = await uniqueName(() =>
    scope.db
      .insertInto('books_product')
      .values({
        id: randomUUID(),
        tenant_id: scope.tenantId,
        kind: args.kind,
        name: args.name,
        description,
        ...folded(args.name, description),
        unit_label: args.unitLabel,
        unit_price: args.unitPrice,
        price_basis: args.priceBasis,
        tax_class: args.taxClass,
        discount_bp: args.discountBp,
        updated_at: new Date(),
      })
      .returning(PRODUCT_COLUMNS)
      .executeTakeFirstOrThrow(),
  );
  return mapProduct(row);
}

/**
 * Change an item (any subset of its fields; an archived item too, so it can be
 * corrected before it is restored). Drafts that copied it keep their values.
 */
export async function updateProduct(scope: BooksScope, id: string, input: UpdateProductInput): Promise<Product> {
  const parsed = updateInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;
  const name = args.name;
  return scope.db.transaction().execute(async (trx) => {
    // Locked, so the folded columns are computed from the row as it is written
    // (two windows changing the name and the description cannot leave a stale search text).
    const current = await trx
      .selectFrom('books_product')
      .select(['name', 'description'])
      .where('tenant_id', '=', scope.tenantId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw notFound(id);
    const nextName = name ?? current.name;
    const nextDescription = args.description !== undefined ? args.description : current.description;
    const row = await uniqueName(() =>
      trx
        .updateTable('books_product')
        .set({
          ...(args.kind !== undefined ? { kind: args.kind } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...folded(nextName, nextDescription),
          ...(args.unitLabel !== undefined ? { unit_label: args.unitLabel } : {}),
          ...(args.unitPrice !== undefined ? { unit_price: args.unitPrice } : {}),
          ...(args.priceBasis !== undefined ? { price_basis: args.priceBasis } : {}),
          ...(args.taxClass !== undefined ? { tax_class: args.taxClass } : {}),
          ...(args.discountBp !== undefined ? { discount_bp: args.discountBp } : {}),
          updated_at: new Date(),
        })
        .where('tenant_id', '=', scope.tenantId)
        .where('id', '=', id)
        .returning(PRODUCT_COLUMNS)
        .executeTakeFirstOrThrow(),
    );
    return mapProduct(row);
  });
}

/** Archive an item: it leaves the search and its name is free again. Idempotent (an archived item is left as it is). */
export async function archiveProduct(scope: BooksScope, id: string): Promise<Product> {
  const now = new Date();
  const row = await scope.db
    .updateTable('books_product')
    .set({ archived_at: now, updated_at: now })
    .where('tenant_id', '=', scope.tenantId)
    .where('id', '=', id)
    .where('archived_at', 'is', null)
    .returning(PRODUCT_COLUMNS)
    .executeTakeFirst();
  return row ? mapProduct(row) : getProduct(scope, id);
}

/**
 * Restore an archived item; DUPLICATE_PRODUCT when a live item has its name
 * now. Idempotent. The folded columns are written again under the row lock, so
 * a restored item is compared and found by today's fold.
 */
export async function unarchiveProduct(scope: BooksScope, id: string): Promise<Product> {
  return scope.db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('books_product')
      .select(PRODUCT_COLUMNS)
      .where('tenant_id', '=', scope.tenantId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw notFound(id);
    if (current.archived_at === null) return mapProduct(current);
    const row = await uniqueName(() =>
      trx
        .updateTable('books_product')
        .set({ archived_at: null, ...folded(current.name, current.description), updated_at: new Date() })
        .where('tenant_id', '=', scope.tenantId)
        .where('id', '=', id)
        .returning(PRODUCT_COLUMNS)
        .executeTakeFirstOrThrow(),
    );
    return mapProduct(row);
  });
}

export async function getProduct(scope: BooksScope, id: string): Promise<Product> {
  const row = await scope.db
    .selectFrom('books_product')
    .select(PRODUCT_COLUMNS)
    .where('tenant_id', '=', scope.tenantId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound(id);
  return mapProduct(row);
}

/**
 * The list's keyset cursor: the sort key of the last row of a page (archived,
 * folded name, id), so a page continues where the last one ended even when
 * that row was renamed or archived since. Opaque to the client.
 */
interface ListCursor {
  archived: boolean;
  key: string;
  id: string;
}

function encodeCursor(c: ListCursor): string {
  return Buffer.from(JSON.stringify([c.archived ? 1 : 0, c.key, c.id]), 'utf8').toString('base64url');
}

function decodeCursor(text: string): ListCursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      (value[0] === 0 || value[0] === 1) &&
      typeof value[1] === 'string' &&
      typeof value[2] === 'string'
    ) {
      return { archived: value[0] === 1, key: value[1], id: value[2] };
    }
  } catch {
    // reported below
  }
  throw invalid('INVALID_INPUT', [{ path: ['cursor'], message: 'not a cursor of this list' }]);
}

const listInput = z.object({
  q: z.string().max(MAX_SEARCH_LENGTH).default(''),
  includeArchived: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(4000).optional(),
});
export type ListProductsInput = z.input<typeof listInput>;

/** LIKE pattern for a folded word, its metacharacters escaped. */
function containsPattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The company's items, live first, then by folded name. `q` matches name and
 * description, case and accents ignored; with several words, every word must
 * occur. Archived items only with `includeArchived`.
 */
export async function listProducts(
  scope: BooksScope,
  input: ListProductsInput = {},
): Promise<{ items: Product[]; nextCursor: string | null; total: number }> {
  const parsed = listInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;
  const cursor = args.cursor ? decodeCursor(args.cursor) : null;
  const words = searchWords(args.q);

  let q = scope.db
    .selectFrom('books_product')
    .select([...PRODUCT_COLUMNS, 'name_key'])
    .where('tenant_id', '=', scope.tenantId);
  let count = scope.db
    .selectFrom('books_product')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tenant_id', '=', scope.tenantId);
  if (!args.includeArchived) {
    q = q.where('archived_at', 'is', null);
    count = count.where('archived_at', 'is', null);
  }
  for (const word of words) {
    q = q.where('search_text', 'like', containsPattern(word));
    count = count.where('search_text', 'like', containsPattern(word));
  }
  if (cursor) {
    q = q.where(
      sql<boolean>`(("archived_at" IS NOT NULL), "name_key", "id") > (${cursor.archived}::boolean, ${cursor.key}::text, ${cursor.id}::text)`,
    );
  }
  const [rows, counted] = await Promise.all([
    q
      .orderBy(sql`"archived_at" IS NOT NULL`)
      .orderBy('name_key')
      .orderBy('id')
      .limit(args.limit + 1)
      .execute(),
    count.executeTakeFirstOrThrow(),
  ]);
  const page = rows.slice(0, args.limit);
  const last = page[page.length - 1];
  return {
    total: Number(counted.n),
    items: page.map(mapProduct),
    nextCursor:
      rows.length > args.limit && last
        ? encodeCursor({ archived: last.archived_at !== null, key: last.name_key, id: last.id })
        : null,
  };
}
