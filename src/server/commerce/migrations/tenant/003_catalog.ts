import type { Migration } from '@marlinjai/tenant-db';

/**
 * CM-04 — `003_catalog`: the typed catalog, ported 1:1 from
 * prisma/migrations/20260616140000_commerce_catalog/migration.sql with the
 * `commerce.` qualification stripped (BARE names; runner injects the path).
 *
 * Database-level guarantees reproduced per schema:
 *   - composite-FK TARGET unique product_option_value(id, option_id);
 *   - COMPOSITE FK product_variant_option(option_value_id, option_id) ->
 *     product_option_value(id, option_id) ON UPDATE RESTRICT (RESTRICT, not
 *     CASCADE: the id is immutable, and CASCADE would shift the matrix without
 *     firing the signature recompute);
 *   - trigger-maintained product_variant.option_signature, kept in sync by TWO
 *     triggers sharing one sorted-string_agg formula: a BEFORE INSERT/UPDATE
 *     trigger on product_variant (bare-variant case) and the authoritative AFTER
 *     INSERT/UPDATE/DELETE trigger on product_variant_option (matrix-derived);
 *   - 6 partial-unique indexes WHERE deleted_at IS NULL.
 *
 * ProductStatus enum is created in `000_enums`.
 *
 * Per-tenant adaptation (same as 002): both signature FUNCTIONS reference catalog
 * tables by BARE name and fire under the app role's `ext`-only search_path, so
 * they are created `SET search_path FROM CURRENT` to capture the injected
 * `<tg_id>, ext` path and resolve bare names to THIS schema at fire-time.
 */
export const catalog: Migration = {
  id: '003_catalog',
  up: async (tx) => {
    // CreateTable
    await tx`
      CREATE TABLE IF NOT EXISTS "product" (
        "id" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "handle" TEXT NOT NULL,
        "description" TEXT,
        "status" "ProductStatus" NOT NULL DEFAULT 'draft',
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,
        "deleted_at" TIMESTAMP(3),

        CONSTRAINT "product_pkey" PRIMARY KEY ("id")
      )
    `;

    // CreateTable
    await tx`
      CREATE TABLE IF NOT EXISTS "product_option" (
        "id" TEXT NOT NULL,
        "product_id" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,
        "deleted_at" TIMESTAMP(3),

        CONSTRAINT "product_option_pkey" PRIMARY KEY ("id")
      )
    `;

    // CreateTable
    await tx`
      CREATE TABLE IF NOT EXISTS "product_option_value" (
        "id" TEXT NOT NULL,
        "option_id" TEXT NOT NULL,
        "value" TEXT NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,
        "deleted_at" TIMESTAMP(3),

        CONSTRAINT "product_option_value_pkey" PRIMARY KEY ("id")
      )
    `;

    // CreateTable
    await tx`
      CREATE TABLE IF NOT EXISTS "product_variant" (
        "id" TEXT NOT NULL,
        "product_id" TEXT NOT NULL,
        "title" TEXT,
        "sku" TEXT,
        "barcode" TEXT,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,
        "deleted_at" TIMESTAMP(3),

        CONSTRAINT "product_variant_pkey" PRIMARY KEY ("id")
      )
    `;

    // CreateTable
    await tx`
      CREATE TABLE IF NOT EXISTS "product_variant_option" (
        "variant_id" TEXT NOT NULL,
        "option_id" TEXT NOT NULL,
        "option_value_id" TEXT NOT NULL,

        CONSTRAINT "product_variant_option_pkey" PRIMARY KEY ("variant_id", "option_id")
      )
    `;

    // CreateIndex: the composite-FK TARGET. id alone is the PK; this tuple-unique
    // exists solely so (option_value_id, option_id) can reference it.
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS "product_option_value_id_option_id_key" ON "product_option_value"("id", "option_id")`;

    // AddForeignKey
    await tx`ALTER TABLE "product_option" ADD CONSTRAINT "product_option_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE`;
    await tx`ALTER TABLE "product_option_value" ADD CONSTRAINT "product_option_value_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "product_option"("id") ON DELETE CASCADE ON UPDATE CASCADE`;
    await tx`ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE`;
    await tx`ALTER TABLE "product_variant_option" ADD CONSTRAINT "product_variant_option_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE`;

    // The COMPOSITE FK: a variant option's (option_value_id, option_id) must be a
    // real (id, option_id) pair in product_option_value. ON UPDATE RESTRICT keeps
    // the immutable id pinned (no cascaded stale-signature path).
    await tx`ALTER TABLE "product_variant_option" ADD CONSTRAINT "product_variant_option_option_value_id_option_id_fkey" FOREIGN KEY ("option_value_id", "option_id") REFERENCES "product_option_value"("id", "option_id") ON DELETE RESTRICT ON UPDATE RESTRICT`;

    // ====================================================================
    // Raw-SQL additions: trigger-maintained option_signature + recompute
    // triggers + the six partial-UNIQUE indexes.
    // ====================================================================

    // (A) option_signature: a TEXT column maintained EXCLUSIVELY by the triggers
    // below. Nullable on purpose: a variant with no option values has a NULL
    // signature, and NULLs are distinct under the partial-UNIQUE in (C).
    await tx`ALTER TABLE "product_variant" ADD COLUMN IF NOT EXISTS "option_signature" TEXT`;

    // (B1) BEFORE INSERT/UPDATE on product_variant: bare-variant case. Computes a
    // deterministic signature (NULL when empty) from NEW.id.
    await tx`
      CREATE OR REPLACE FUNCTION "compute_variant_option_signature"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      DECLARE
          sig TEXT;
      BEGIN
          SELECT string_agg("option_value_id", ',' ORDER BY "option_value_id")
              INTO sig
              FROM "product_variant_option"
              WHERE "variant_id" = NEW."id";
          -- string_agg over zero rows yields NULL: the "no combination yet"
          -- sentinel (NULLs are distinct under the partial-UNIQUE in (C)).
          NEW."option_signature" := sig;
          RETURN NEW;
      END;
      $$
    `;

    await tx`DROP TRIGGER IF EXISTS "product_variant_option_signature" ON "product_variant"`;
    await tx`
      CREATE TRIGGER "product_variant_option_signature"
          BEFORE INSERT OR UPDATE ON "product_variant"
          FOR EACH ROW
          EXECUTE FUNCTION "compute_variant_option_signature"()
    `;

    // (B2) AFTER INSERT/UPDATE/DELETE on product_variant_option: the
    // authoritative, matrix-derived recompute. ANY matrix writer triggers a fresh
    // signature on the affected variant. Re-enters (B1) on the variant row, which
    // recomputes the identical value (stable fixed point, no recursion). This is
    // what makes no-duplicate-combination a true DATABASE guarantee.
    await tx`
      CREATE OR REPLACE FUNCTION "refresh_variant_option_signature"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      BEGIN
          UPDATE "product_variant"
              SET "option_signature" = (
                  SELECT string_agg("option_value_id", ',' ORDER BY "option_value_id")
                      FROM "product_variant_option"
                      WHERE "variant_id" = COALESCE(NEW."variant_id", OLD."variant_id")
              )
              WHERE "id" = COALESCE(NEW."variant_id", OLD."variant_id");
          RETURN NULL;
      END;
      $$
    `;

    await tx`DROP TRIGGER IF EXISTS "product_variant_option_signature_matrix" ON "product_variant_option"`;
    await tx`
      CREATE TRIGGER "product_variant_option_signature_matrix"
          AFTER INSERT OR UPDATE OR DELETE ON "product_variant_option"
          FOR EACH ROW
          EXECUTE FUNCTION "refresh_variant_option_signature"()
    `;

    // (C) Partial-UNIQUE indexes (live rows only; each frees on soft-delete).
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "product_handle_active_key"
        ON "product" ("handle")
        WHERE "deleted_at" IS NULL
    `;
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "product_option_product_id_title_active_key"
        ON "product_option" ("product_id", "title")
        WHERE "deleted_at" IS NULL
    `;
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "product_option_value_option_id_value_active_key"
        ON "product_option_value" ("option_id", "value")
        WHERE "deleted_at" IS NULL
    `;
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "product_variant_sku_active_key"
        ON "product_variant" ("sku")
        WHERE "deleted_at" IS NULL
    `;
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "product_variant_barcode_active_key"
        ON "product_variant" ("barcode")
        WHERE "deleted_at" IS NULL
    `;
    // No two LIVE variants can share an option combination.
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "product_variant_option_signature_active_key"
        ON "product_variant" ("option_signature")
        WHERE "deleted_at" IS NULL
    `;
  },
};
