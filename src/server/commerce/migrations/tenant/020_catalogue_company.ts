import type { Migration } from '@marlinjai/tenant-db';

/**
 * The catalogue, `020_catalogue_company`: products and services per company, sold through the shop and
 * invoiced in the Books (docs/plans/2026-10-25-catalogue-design.md, slice 1). Non-destructive: columns and
 * tables are added, existing rows are backfilled, nothing is dropped except two indexes that are recreated
 * per company.
 *
 * The structural guarantees, and why each exists:
 *
 *   1. The company column. `tenant_id` (the auth-brain company id, uuid-shaped by CHECK) on the product
 *      graph (product, product_option, product_option_value, product_variant, product_variant_option), on
 *      pricing (price_set, price) and on orders (order, order_line_item), with UNIQUE (tenant_id, id) on
 *      every parent and composite foreign keys (tenant_id, x_id) -> parent (tenant_id, id), the 007 pattern:
 *      a row can only hang under a parent of the same company, so companies of one organisation never see
 *      or reach each other's catalogue. The single-column foreign keys of 003 to 005 stay (their CASCADE
 *      semantics are unchanged); the composite ones add the company match.
 *   2. Every NEW or EDITED row names its company: `CHECK (tenant_id IS NOT NULL) NOT VALID` on each of
 *      those tables. NOT VALID enforces it on every INSERT and UPDATE but does not refuse the existing rows
 *      the backfill below could not assign; an operator assigns those with `pnpm catalogue:assign-company`
 *      and then validates the constraints. An unassigned legacy row is invisible to every company-scoped
 *      read, and cannot be edited until it is assigned.
 *   3. The backfill. Existing rows go to the schema's sole company (`catalogue_sole_company()`): the one
 *      distinct company id found across the Books tables (books_company_settings, customer, sales_document,
 *      books_product). Zero or several companies: the rows stay unassigned (guarantee 2). Parents first,
 *      then children from their parent, so a child always matches its parent.
 *   4. The Books' own list moves in. Every `books_product` row becomes a catalogue product of its company
 *      (kind `service` for a Books service, `physical` for a Books product, with stock tracking off), with
 *      one variant carrying its price in a EUR price set, the same name, description, unit, price basis,
 *      tax class, default discount and archive state, status `draft` (never on a shop until someone
 *      publishes it). `product.books_product_id` (unique per company) makes the move idempotent; the
 *      `books_product` table itself stays untouched until a later migration retires it.
 *   5. Product fields of the design: `kind` ('physical' or 'service'), `product_type`, `tags`,
 *      `seo_title`, `seo_description`, `tax_class` ('standard', 'reduced', 'zero', as the Books),
 *      `price_basis` ('net' or 'gross'), `unit_label` and `discount_bp` (what an invoice line copies),
 *      `description_format` (the formatted text, as 018; the plain `description` is derived from it),
 *      `search_text` (the folded title and description the pickers match with LIKE, written by the
 *      repository with src/lib/books/searchKey.ts), `archived_at` (archived, not deleted; the status enum
 *      stays draft and published). A service has exactly one variant, no options and no stock
 *      (`service_variant_guard`, BK017, refuses a second live variant or an option on a service).
 *      At most three options per product (BK017 too). `compare_at_amount` on `price` holds the
 *      "compare at" price.
 *   6. Handles are unique per company among live rows (`product_tenant_handle_active_key`), so two
 *      companies may both sell a "ring". SKU and barcode stay unique per tenant group, because the stock
 *      ledger is bridged to a variant by its SKU (repository/storefront.ts resolveOrderLines).
 *   7. Images. `catalog_image` holds the bytes (PNG, JPEG or WebP, at most 2 MB, one row per company and
 *      SHA-256), beside the documents in the tenant group's own schema, for the reason 008 and 013 give
 *      (no storage-brain client in this repository yet). `product_image` orders a product's images and may
 *      tie one to a variant.
 *   8. Collections. `collection` (manual, ordered) and `collection_product` (position per collection).
 *   9. Per-site visibility. `product_site_hidden` (company, product, site) switches a product off for one
 *      site; every site of the company shows every published product otherwise. `site_id` is TEXT without
 *      a foreign key: sites live in the public schema, and each tenant schema stays self-contained.
 *  10. Orders carry their company and site (`order.tenant_id`, `order.site_id`); the order number stays on
 *      the per-schema sequence (the receipt gets its own number from the company's Books series).
 *
 * House style as 007 to 019: BARE names, ids TEXT minted by the application (gen_random_uuid() only for the
 * rows this migration moves), trigger functions `SET search_path FROM CURRENT`, custom SQLSTATE BK017.
 * Re-runnable: IF NOT EXISTS and guarded constraint creation throughout.
 */

const UUID = `'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;

/** The tables that gain the company column, parents before children. */
const COMPANY_TABLES = [
  'product',
  'product_option',
  'product_option_value',
  'product_variant',
  'product_variant_option',
  'price_set',
  'price',
  'order',
  'order_line_item',
] as const;

/** Composite foreign keys: [table, constraint, child column, parent table]. */
const COMPANY_FKS = [
  ['product_option', 'product_option_tenant_product_fkey', 'product_id', 'product'],
  ['product_option_value', 'product_option_value_tenant_option_fkey', 'option_id', 'product_option'],
  ['product_variant', 'product_variant_tenant_product_fkey', 'product_id', 'product'],
  ['product_variant_option', 'product_variant_option_tenant_variant_fkey', 'variant_id', 'product_variant'],
  ['price_set', 'price_set_tenant_variant_fkey', 'variant_id', 'product_variant'],
  ['price', 'price_tenant_price_set_fkey', 'price_set_id', 'price_set'],
  ['order_line_item', 'order_line_item_tenant_order_fkey', 'order_id', 'order'],
] as const;

export const catalogueCompany: Migration = {
  id: '020_catalogue_company',
  up: async (tx) => {
    // Guarantee 1 and 2: the column, its shape, the scoped unique, the NOT VALID presence check.
    for (const table of COMPANY_TABLES) {
      await tx`ALTER TABLE ${tx(table)} ADD COLUMN IF NOT EXISTS "tenant_id" TEXT`;
      await tx.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${table}_tenant_id_check' AND conrelid = '"${table}"'::regclass) THEN
            ALTER TABLE "${table}" ADD CONSTRAINT "${table}_tenant_id_check" CHECK ("tenant_id" IS NULL OR "tenant_id" ~ ${UUID});
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${table}_tenant_id_present' AND conrelid = '"${table}"'::regclass) THEN
            ALTER TABLE "${table}" ADD CONSTRAINT "${table}_tenant_id_present" CHECK ("tenant_id" IS NOT NULL) NOT VALID;
          END IF;
          IF '${table}' <> 'product_variant_option'
             AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${table}_tenant_id_id_key' AND conrelid = '"${table}"'::regclass) THEN
            ALTER TABLE "${table}" ADD CONSTRAINT "${table}_tenant_id_id_key" UNIQUE ("tenant_id", "id");
          END IF;
        END
        $$
      `);
    }
    // product_variant_option has no id (its key is variant and option); it only references, so no unique.
    await tx`CREATE INDEX IF NOT EXISTS "product_variant_option_tenant_idx" ON "product_variant_option" ("tenant_id", "variant_id")`;

    // Guarantee 3: the sole company of this schema, or NULL.
    await tx`
      CREATE OR REPLACE FUNCTION "catalogue_sole_company"()
      RETURNS TEXT
      LANGUAGE sql
      STABLE
      SET search_path FROM CURRENT
      AS $$
          SELECT CASE WHEN count(*) = 1 THEN min(t) END
            FROM (
                SELECT "tenant_id" AS t FROM "books_company_settings"
                UNION SELECT "tenant_id" FROM "customer"
                UNION SELECT "tenant_id" FROM "sales_document"
                UNION SELECT "tenant_id" FROM "books_product"
            ) companies
      $$
    `;
    await tx`
      DO $$
      DECLARE
          sole TEXT := "catalogue_sole_company"();
      BEGIN
          IF sole IS NOT NULL THEN
              UPDATE "product" SET "tenant_id" = sole WHERE "tenant_id" IS NULL;
              UPDATE "order" SET "tenant_id" = sole WHERE "tenant_id" IS NULL;
          END IF;
      END
      $$
    `;
    // Children follow their parent (also when the parent was assigned by an earlier run or by hand).
    await tx`UPDATE "product_option" o SET "tenant_id" = p."tenant_id" FROM "product" p WHERE o."product_id" = p."id" AND o."tenant_id" IS NULL AND p."tenant_id" IS NOT NULL`;
    await tx`UPDATE "product_option_value" v SET "tenant_id" = o."tenant_id" FROM "product_option" o WHERE v."option_id" = o."id" AND v."tenant_id" IS NULL AND o."tenant_id" IS NOT NULL`;
    await tx`UPDATE "product_variant" v SET "tenant_id" = p."tenant_id" FROM "product" p WHERE v."product_id" = p."id" AND v."tenant_id" IS NULL AND p."tenant_id" IS NOT NULL`;
    await tx`UPDATE "product_variant_option" m SET "tenant_id" = v."tenant_id" FROM "product_variant" v WHERE m."variant_id" = v."id" AND m."tenant_id" IS NULL AND v."tenant_id" IS NOT NULL`;
    await tx`UPDATE "price_set" s SET "tenant_id" = v."tenant_id" FROM "product_variant" v WHERE s."variant_id" = v."id" AND s."tenant_id" IS NULL AND v."tenant_id" IS NOT NULL`;
    await tx`UPDATE "price" pr SET "tenant_id" = s."tenant_id" FROM "price_set" s WHERE pr."price_set_id" = s."id" AND pr."tenant_id" IS NULL AND s."tenant_id" IS NOT NULL`;
    await tx`UPDATE "order_line_item" l SET "tenant_id" = o."tenant_id" FROM "order" o WHERE l."order_id" = o."id" AND l."tenant_id" IS NULL AND o."tenant_id" IS NOT NULL`;

    // Guarantee 1: the composite foreign keys.
    for (const [table, name, column, parent] of COMPANY_FKS) {
      await tx.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}' AND conrelid = '"${table}"'::regclass) THEN
            ALTER TABLE "${table}" ADD CONSTRAINT "${name}"
              FOREIGN KEY ("tenant_id", "${column}") REFERENCES "${parent}" ("tenant_id", "id")
              ON DELETE CASCADE ON UPDATE RESTRICT;
          END IF;
        END
        $$
      `);
    }

    // Guarantee 5: the product fields.
    await tx`ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'physical'`;
    await tx`ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "product_type" TEXT`;
    await tx`ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT '{}'`;
    await tx`ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "seo_title" TEXT`;
    await tx`ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "seo_description" TEXT`;
    await tx`ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "price_basis" TEXT NOT NULL DEFAULT 'gross'`;
    await tx`ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "unit_label" TEXT NOT NULL DEFAULT 'Stk'`;
    await tx`ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "discount_bp" INTEGER NOT NULL DEFAULT 0`;
    await tx`ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "description_format" JSONB`;
    await tx`ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "search_text" TEXT`;
    await tx`ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMP(3)`;
    await tx`ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "books_product_id" TEXT`;
    await tx`ALTER TABLE "price" ADD COLUMN IF NOT EXISTS "compare_at_amount" INTEGER`;
    await tx`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_kind_check' AND conrelid = 'product'::regclass) THEN
          ALTER TABLE "product" ADD CONSTRAINT "product_kind_check" CHECK ("kind" IN ('physical', 'service'));
          ALTER TABLE "product" ADD CONSTRAINT "product_price_basis_check" CHECK ("price_basis" IN ('net', 'gross'));
          -- NOT VALID: 004 left tax_class free text, so an existing row may carry another value; new and edited
          -- rows use the Books' three classes.
          ALTER TABLE "product" ADD CONSTRAINT "product_tax_class_check"
            CHECK ("tax_class" IS NULL OR "tax_class" IN ('standard', 'reduced', 'zero')) NOT VALID;
          ALTER TABLE "product" ADD CONSTRAINT "product_title_check"
            CHECK (length("title") BETWEEN 1 AND 300 AND "title" = btrim("title")) NOT VALID;
          ALTER TABLE "product" ADD CONSTRAINT "product_description_check"
            CHECK ("description" IS NULL OR length("description") <= 4000) NOT VALID;
          ALTER TABLE "product" ADD CONSTRAINT "product_description_format_check"
            CHECK ("description_format" IS NULL OR jsonb_typeof("description_format") = 'object');
          ALTER TABLE "product" ADD CONSTRAINT "product_unit_label_check"
            CHECK (length("unit_label") BETWEEN 1 AND 20 AND "unit_label" = btrim("unit_label"));
          ALTER TABLE "product" ADD CONSTRAINT "product_discount_check" CHECK ("discount_bp" BETWEEN 0 AND 10000);
          ALTER TABLE "product" ADD CONSTRAINT "product_product_type_check"
            CHECK ("product_type" IS NULL OR length("product_type") BETWEEN 1 AND 100);
          ALTER TABLE "product" ADD CONSTRAINT "product_tags_check" CHECK (cardinality("tags") <= 50);
          ALTER TABLE "product" ADD CONSTRAINT "product_seo_title_check"
            CHECK ("seo_title" IS NULL OR length("seo_title") <= 120);
          ALTER TABLE "product" ADD CONSTRAINT "product_seo_description_check"
            CHECK ("seo_description" IS NULL OR length("seo_description") <= 320);
          ALTER TABLE "product" ADD CONSTRAINT "product_handle_check"
            CHECK ("handle" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("handle") <= 120) NOT VALID;
          ALTER TABLE "price" ADD CONSTRAINT "price_compare_at_check"
            CHECK ("compare_at_amount" IS NULL OR "compare_at_amount" >= 0);
        END IF;
      END
      $$
    `;
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS "product_tenant_books_product_key" ON "product" ("tenant_id", "books_product_id")`;
    await tx`CREATE INDEX IF NOT EXISTS "product_tenant_list_idx" ON "product" ("tenant_id", (("archived_at" IS NOT NULL)), "updated_at" DESC, "id")`;

    // Guarantee 6: handles per company.
    await tx`DROP INDEX IF EXISTS "product_handle_active_key"`;
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "product_tenant_handle_active_key"
        ON "product" ("tenant_id", "handle")
        WHERE "deleted_at" IS NULL
    `;

    // Guarantee 5: a service has one variant and no options; a product at most three options.
    await tx`
      CREATE OR REPLACE FUNCTION "catalogue_shape_guard"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      DECLARE
          product_kind TEXT;
      BEGIN
          IF NEW."deleted_at" IS NOT NULL THEN
              RETURN NEW;
          END IF;
          SELECT "kind" INTO product_kind FROM "product" WHERE "id" = NEW."product_id" FOR SHARE;
          IF TG_TABLE_NAME = 'product_option' THEN
              IF product_kind = 'service' THEN
                  RAISE EXCEPTION 'product %: a service has no options', NEW."product_id" USING ERRCODE = 'BK017';
              END IF;
              IF (SELECT count(*) FROM "product_option"
                   WHERE "product_id" = NEW."product_id" AND "deleted_at" IS NULL AND "id" <> NEW."id") >= 3 THEN
                  RAISE EXCEPTION 'product %: at most three options', NEW."product_id" USING ERRCODE = 'BK017';
              END IF;
          ELSIF product_kind = 'service' THEN
              IF EXISTS (SELECT 1 FROM "product_variant"
                          WHERE "product_id" = NEW."product_id" AND "deleted_at" IS NULL AND "id" <> NEW."id") THEN
                  RAISE EXCEPTION 'product %: a service has exactly one variant', NEW."product_id" USING ERRCODE = 'BK017';
              END IF;
          END IF;
          RETURN NEW;
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "product_option_shape_guard" ON "product_option"`;
    await tx`
      CREATE TRIGGER "product_option_shape_guard"
          BEFORE INSERT OR UPDATE ON "product_option"
          FOR EACH ROW EXECUTE FUNCTION "catalogue_shape_guard"()
    `;
    await tx`DROP TRIGGER IF EXISTS "product_variant_shape_guard" ON "product_variant"`;
    await tx`
      CREATE TRIGGER "product_variant_shape_guard"
          BEFORE INSERT OR UPDATE ON "product_variant"
          FOR EACH ROW EXECUTE FUNCTION "catalogue_shape_guard"()
    `;

    // Guarantee 7: images.
    await tx`
      CREATE TABLE IF NOT EXISTS "catalog_image" (
          "id"           TEXT         NOT NULL,
          "tenant_id"    TEXT         NOT NULL,
          "sha256"       TEXT         NOT NULL,
          "content_type" TEXT         NOT NULL,
          "byte_size"    INTEGER      NOT NULL,
          "width"        INTEGER      NOT NULL,
          "height"       INTEGER      NOT NULL,
          "content"      BYTEA        NOT NULL,
          "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "catalog_image_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "catalog_image_tenant_id_check" CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
          CONSTRAINT "catalog_image_type_check" CHECK ("content_type" IN ('image/png', 'image/jpeg', 'image/webp')),
          CONSTRAINT "catalog_image_size_check"
              CHECK ("byte_size" > 0 AND "byte_size" <= 2097152 AND "byte_size" = octet_length("content")),
          CONSTRAINT "catalog_image_pixels_check" CHECK ("width" BETWEEN 1 AND 8000 AND "height" BETWEEN 1 AND 8000),
          CONSTRAINT "catalog_image_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
          CONSTRAINT "catalog_image_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
          CONSTRAINT "catalog_image_tenant_id_sha256_key" UNIQUE ("tenant_id", "sha256")
      )
    `;
    await tx`
      CREATE TABLE IF NOT EXISTS "product_image" (
          "id"          TEXT         NOT NULL,
          "tenant_id"   TEXT         NOT NULL,
          "product_id"  TEXT         NOT NULL,
          "image_id"    TEXT         NOT NULL,
          "variant_id"  TEXT,
          "position"    INTEGER      NOT NULL,
          "alt"         TEXT,
          "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "product_image_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "product_image_tenant_id_check" CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
          CONSTRAINT "product_image_position_check" CHECK ("position" >= 1),
          CONSTRAINT "product_image_alt_check" CHECK ("alt" IS NULL OR length("alt") <= 300),
          CONSTRAINT "product_image_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
          CONSTRAINT "product_image_position_key" UNIQUE ("tenant_id", "product_id", "position") DEFERRABLE INITIALLY DEFERRED,
          CONSTRAINT "product_image_product_fkey" FOREIGN KEY ("tenant_id", "product_id")
              REFERENCES "product" ("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
          CONSTRAINT "product_image_image_fkey" FOREIGN KEY ("tenant_id", "image_id")
              REFERENCES "catalog_image" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
          CONSTRAINT "product_image_variant_fkey" FOREIGN KEY ("tenant_id", "variant_id")
              REFERENCES "product_variant" ("tenant_id", "id") ON DELETE SET NULL ("variant_id") ON UPDATE RESTRICT
      )
    `;

    // Guarantee 8: collections.
    await tx`
      CREATE TABLE IF NOT EXISTS "collection" (
          "id"                  TEXT         NOT NULL,
          "tenant_id"           TEXT         NOT NULL,
          "title"               TEXT         NOT NULL,
          "handle"              TEXT         NOT NULL,
          "description"         TEXT,
          "description_format"  JSONB,
          "image_id"            TEXT,
          "archived_at"         TIMESTAMP(3),
          "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at"          TIMESTAMP(3) NOT NULL,
          CONSTRAINT "collection_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "collection_tenant_id_check" CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
          CONSTRAINT "collection_title_check" CHECK (length("title") BETWEEN 1 AND 200 AND "title" = btrim("title")),
          CONSTRAINT "collection_handle_check" CHECK ("handle" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("handle") <= 120),
          CONSTRAINT "collection_description_check" CHECK ("description" IS NULL OR length("description") <= 4000),
          CONSTRAINT "collection_description_format_check"
              CHECK ("description_format" IS NULL OR jsonb_typeof("description_format") = 'object'),
          CONSTRAINT "collection_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
          CONSTRAINT "collection_image_fkey" FOREIGN KEY ("tenant_id", "image_id")
              REFERENCES "catalog_image" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
      )
    `;
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "collection_tenant_handle_live_key"
        ON "collection" ("tenant_id", "handle")
        WHERE "archived_at" IS NULL
    `;
    await tx`
      CREATE TABLE IF NOT EXISTS "collection_product" (
          "tenant_id"      TEXT    NOT NULL,
          "collection_id"  TEXT    NOT NULL,
          "product_id"     TEXT    NOT NULL,
          "position"       INTEGER NOT NULL,
          CONSTRAINT "collection_product_pkey" PRIMARY KEY ("tenant_id", "collection_id", "product_id"),
          CONSTRAINT "collection_product_position_check" CHECK ("position" >= 1),
          CONSTRAINT "collection_product_position_key"
              UNIQUE ("tenant_id", "collection_id", "position") DEFERRABLE INITIALLY DEFERRED,
          CONSTRAINT "collection_product_collection_fkey" FOREIGN KEY ("tenant_id", "collection_id")
              REFERENCES "collection" ("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
          CONSTRAINT "collection_product_product_fkey" FOREIGN KEY ("tenant_id", "product_id")
              REFERENCES "product" ("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT
      )
    `;
    await tx`CREATE INDEX IF NOT EXISTS "collection_product_product_idx" ON "collection_product" ("tenant_id", "product_id")`;

    // Guarantee 9: per-site visibility.
    await tx`
      CREATE TABLE IF NOT EXISTS "product_site_hidden" (
          "tenant_id"   TEXT         NOT NULL,
          "product_id"  TEXT         NOT NULL,
          "site_id"     TEXT         NOT NULL,
          "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "product_site_hidden_pkey" PRIMARY KEY ("tenant_id", "product_id", "site_id"),
          CONSTRAINT "product_site_hidden_site_check" CHECK (length("site_id") BETWEEN 1 AND 100),
          CONSTRAINT "product_site_hidden_product_fkey" FOREIGN KEY ("tenant_id", "product_id")
              REFERENCES "product" ("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT
      )
    `;
    await tx`CREATE INDEX IF NOT EXISTS "product_site_hidden_site_idx" ON "product_site_hidden" ("tenant_id", "site_id")`;

    // Guarantee 10: the order's site.
    await tx`ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "site_id" TEXT`;
    await tx`CREATE INDEX IF NOT EXISTS "order_tenant_created_idx" ON "order" ("tenant_id", "created_at")`;

    // Guarantee 4: the Books' list moves in (idempotent through books_product_id).
    await tx`
      INSERT INTO "product" (
          "id", "tenant_id", "title", "handle", "description", "status", "kind", "price_basis", "tax_class",
          "unit_label", "discount_bp", "search_text", "archived_at", "books_product_id", "created_at", "updated_at"
      )
      SELECT gen_random_uuid()::text, bp."tenant_id", bp."name",
             COALESCE(NULLIF(left(trim(BOTH '-' FROM regexp_replace(lower(bp."name"), '[^a-z0-9]+', '-', 'g')), 100), ''), 'item')
               || '-' || left(md5(bp."id"), 6),
             bp."description", 'draft',
             CASE bp."kind" WHEN 'product' THEN 'physical' ELSE 'service' END,
             bp."price_basis", bp."tax_class", bp."unit_label", bp."discount_bp", bp."search_text",
             bp."archived_at", bp."id", bp."created_at", bp."updated_at"
        FROM "books_product" bp
       WHERE NOT EXISTS (
           SELECT 1 FROM "product" p WHERE p."tenant_id" = bp."tenant_id" AND p."books_product_id" = bp."id"
       )
    `;
    await tx`
      INSERT INTO "product_variant" (
          "id", "tenant_id", "product_id", "title", "manage_inventory", "allow_backorder", "created_at", "updated_at"
      )
      SELECT gen_random_uuid()::text, p."tenant_id", p."id", NULL, false, false, p."created_at", p."updated_at"
        FROM "product" p
       WHERE p."books_product_id" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "product_variant" v WHERE v."product_id" = p."id")
    `;
    await tx`
      INSERT INTO "price_set" ("id", "tenant_id", "variant_id", "created_at", "updated_at")
      SELECT gen_random_uuid()::text, v."tenant_id", v."id", v."created_at", v."updated_at"
        FROM "product_variant" v
        JOIN "product" p ON p."id" = v."product_id" AND p."books_product_id" IS NOT NULL
       WHERE NOT EXISTS (SELECT 1 FROM "price_set" s WHERE s."variant_id" = v."id")
    `;
    await tx`
      INSERT INTO "price" ("id", "tenant_id", "price_set_id", "currency_code", "amount", "created_at", "updated_at")
      SELECT gen_random_uuid()::text, s."tenant_id", s."id", 'EUR', bp."unit_price", s."created_at", s."updated_at"
        FROM "price_set" s
        JOIN "product_variant" v ON v."id" = s."variant_id"
        JOIN "product" p ON p."id" = v."product_id"
        JOIN "books_product" bp ON bp."tenant_id" = p."tenant_id" AND bp."id" = p."books_product_id"
       WHERE NOT EXISTS (SELECT 1 FROM "price" pr WHERE pr."price_set_id" = s."id")
    `;

    await tx`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
          GRANT EXECUTE ON FUNCTION "catalogue_sole_company"() TO commerce_app;
        END IF;
      END
      $$
    `;
  },
};
