import type { Migration } from '@marlinjai/tenant-db';

/**
 * Books invoice editor, phase 4, `015_books_products`: the company's list of
 * products and services (docs/plans/2026-10-23-books-wysiwyg-invoice-editor.md,
 * "Decided by the owner", item 3). Purely additive: one new table, nothing
 * existing changes.
 *
 * An item is what a draft line is filled from: a name (the line's title), an
 * optional description, a unit label, a unit price in integer cents with the
 * basis it is quoted in (net or gross), a tax class, an optional default
 * discount in basis points, and whether it is a service or a product.
 *
 * The structural guarantees, and why each exists:
 *
 *   1. Lines COPY, they never reference. A line picked from the list receives
 *      the item's values at that moment (src/lib/books/products.ts,
 *      `lineFromProduct`) and keeps no id of the item: there is no foreign key
 *      from `sales_document_line` to this table, and none is ever added. So
 *      editing, renaming or archiving an item never changes an existing draft,
 *      and can never change an issued document (which the line guard of 007
 *      freezes anyway). That is also why this is a normal mutable table and not
 *      append-only: nothing printed depends on its rows.
 *   2. Archived, not deleted. An item that is no longer offered gets
 *      `archived_at`; the application never deletes a row, so an id a client
 *      still holds (an open page, the line search of another window) answers
 *      the archived item instead of vanishing, and the item can be restored.
 *   3. A name is unique among the company's LIVE items
 *      (`books_product_tenant_id_name_key_live_key`, partial on
 *      `archived_at IS NULL`), so the search never offers two items under one
 *      name, while an archived item's name is free for a new one. `name_key` is
 *      the name folded for comparison by the application's one function
 *      (src/lib/books/searchKey.ts: lower case, accents removed, `ß` as `ss`,
 *      whitespace collapsed), so "Beratung", "beratung" and "Beratúng" are one
 *      name. `search_text` is the same fold of name and description, which the
 *      list search matches with LIKE. The fold can grow a name (one ligature
 *      such as U+FDFA becomes 18 letters), so `name_key` is bounded to 600
 *      characters, well inside what a btree index entry holds; the repository
 *      refuses a longer one as invalid input. Both are written by the repository on
 *      every insert and update (repository/products.ts); the database has no
 *      accent folding without an extension, and none is installed.
 *   4. Every value is one a line accepts, checked with the same bounds as
 *      `sales_document_line` (007): name 1 to 300 characters (a line title),
 *      description at most 4000, unit label 1 to 20, unit price at least 0
 *      cents (never negative, as a line), discount 0 to 10000 basis points,
 *      tax class one of 'standard', 'reduced', 'zero', kind 'service' or
 *      'product' (a text line is not a list item). A copied item can therefore
 *      never be refused by the line's own checks.
 *
 * House style as 007, 008, 012, 013 and 014: BARE names, ids TEXT minted by the
 * application, the tenant id check, `(tenant_id, id)` unique for scoped joins.
 * No trigger and no custom SQLSTATE: nothing here needs refusing beyond the
 * CHECKs and the unique index. No REVOKE: commerce_app reads, inserts and
 * updates this table through the provisioning and fleet grants like any
 * mutable table. Re-runnable: IF NOT EXISTS throughout.
 */

export const booksProducts: Migration = {
  id: '015_books_products',
  up: async (tx) => {
    await tx`
      CREATE TABLE IF NOT EXISTS "books_product" (
          "id"           TEXT         NOT NULL,
          "tenant_id"    TEXT         NOT NULL,
          "kind"         TEXT         NOT NULL DEFAULT 'service',
          "name"         TEXT         NOT NULL,
          "name_key"     TEXT         NOT NULL,
          "description"  TEXT,
          "search_text"  TEXT         NOT NULL,
          "unit_label"   TEXT         NOT NULL DEFAULT 'Stk',
          "unit_price"   INTEGER      NOT NULL,
          "price_basis"  TEXT         NOT NULL DEFAULT 'net',
          "tax_class"    TEXT         NOT NULL DEFAULT 'standard',
          "discount_bp"  INTEGER      NOT NULL DEFAULT 0,
          "archived_at"  TIMESTAMP(3),
          "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at"   TIMESTAMP(3) NOT NULL,
          CONSTRAINT "books_product_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "books_product_tenant_id_check"
              CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
          CONSTRAINT "books_product_kind_check" CHECK ("kind" IN ('service', 'product')),
          CONSTRAINT "books_product_name_check"
              CHECK (length("name") BETWEEN 1 AND 300 AND "name" = btrim("name")),
          CONSTRAINT "books_product_name_key_check" CHECK (length("name_key") BETWEEN 1 AND 600),
          CONSTRAINT "books_product_description_check"
              CHECK ("description" IS NULL OR length("description") <= 4000),
          CONSTRAINT "books_product_unit_label_check"
              CHECK (length("unit_label") BETWEEN 1 AND 20 AND "unit_label" = btrim("unit_label")),
          CONSTRAINT "books_product_unit_price_check" CHECK ("unit_price" >= 0),
          CONSTRAINT "books_product_price_basis_check" CHECK ("price_basis" IN ('net', 'gross')),
          CONSTRAINT "books_product_tax_class_check" CHECK ("tax_class" IN ('standard', 'reduced', 'zero')),
          CONSTRAINT "books_product_discount_check" CHECK ("discount_bp" BETWEEN 0 AND 10000),
          CONSTRAINT "books_product_tenant_id_id_key" UNIQUE ("tenant_id", "id")
      )
    `;

    // Guarantee 3: one live item per folded name and company.
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "books_product_tenant_id_name_key_live_key"
          ON "books_product" ("tenant_id", "name_key")
          WHERE "archived_at" IS NULL
    `;
    // The list's order (live first, then by folded name and id) per company.
    await tx`
      CREATE INDEX IF NOT EXISTS "books_product_tenant_id_order_idx"
          ON "books_product" ("tenant_id", (("archived_at" IS NOT NULL)), "name_key", "id")
    `;
  },
};
