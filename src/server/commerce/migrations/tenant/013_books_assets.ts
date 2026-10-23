import type { Migration } from '@marlinjai/tenant-db';

/**
 * Books visual template composer, phase 5, `013_books_assets`: the logos a
 * template prints (docs/plans/2026-10-21-books-visual-template-composer.md,
 * decision 15). Purely additive: one new table, nothing existing changes.
 *
 * Why the database and not storage-brain: the same reason as 008's documents
 * of record. This repository has no storage-brain client yet; until it has, a
 * logo lives beside the documents in the tenant group's own schema (the same
 * isolation, backup and export). Moving it later is a copy plus a column.
 *
 * The structural guarantees, and why each exists:
 *
 *   1. One row per image and company (`books_asset_tenant_id_sha256_key`): a
 *      template and an issued document name a logo by its SHA-256, so the same
 *      bytes uploaded twice are one asset (the upload answers the existing
 *      row), and a name always means exactly one image.
 *   2. Append-only (BK014 on UPDATE, DELETE and TRUNCATE, for every role, the
 *      owner included), plus the house REVOKE for the app role, re-applied
 *      after the provisioning grants through APPEND_ONLY_TABLES. An issued
 *      document's frozen snapshot names its logo by hash and re-renders from
 *      this table, so a stored logo is never changed or removed (GoBD, the
 *      German rules for keeping books and records electronically: the
 *      document must re-render as issued). Since 014_books_asset_delete a
 *      logo nothing uses may be deleted (an issued document's logo and a live
 *      template's still may not), and the app role holds DELETE.
 *   3. The content is self-describing and bounded, as the upload checked it:
 *      `kind` is 'logo', the type is PNG or JPEG, `byte_size` equals the
 *      content's length and is at most 1 MB, the pixel size is 1 to 2000 on
 *      each side, `sha256` is a lowercase hex digest (the application
 *      computes it from the content).
 *
 * House style as 007, 008 and 012: BARE names, ids TEXT minted by the
 * application, trigger functions `SET search_path FROM CURRENT`, custom
 * SQLSTATE BK014.
 */

export const booksAssets: Migration = {
  id: '013_books_assets',
  up: async (tx) => {
    await tx`
      CREATE TABLE IF NOT EXISTS "books_asset" (
          "id"           TEXT         NOT NULL,
          "tenant_id"    TEXT         NOT NULL,
          "kind"         TEXT         NOT NULL,
          "content_type" TEXT         NOT NULL,
          "byte_size"    INTEGER      NOT NULL,
          "sha256"       TEXT         NOT NULL,
          "width_px"     INTEGER      NOT NULL,
          "height_px"    INTEGER      NOT NULL,
          "content"      BYTEA        NOT NULL,
          "created_by"   TEXT,
          "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "books_asset_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "books_asset_tenant_id_check"
              CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
          CONSTRAINT "books_asset_kind_check" CHECK ("kind" = 'logo'),
          CONSTRAINT "books_asset_content_type_check" CHECK ("content_type" IN ('image/png', 'image/jpeg')),
          CONSTRAINT "books_asset_size_check"
              CHECK ("byte_size" > 0 AND "byte_size" <= 1048576 AND "byte_size" = octet_length("content")),
          CONSTRAINT "books_asset_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
          CONSTRAINT "books_asset_pixels_check"
              CHECK ("width_px" BETWEEN 1 AND 2000 AND "height_px" BETWEEN 1 AND 2000),
          CONSTRAINT "books_asset_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
          CONSTRAINT "books_asset_tenant_id_sha256_key" UNIQUE ("tenant_id", "sha256")
      )
    `;

    // Guarantee 2: a stored logo is never changed or removed.
    await tx`
      CREATE OR REPLACE FUNCTION "books_asset_guard"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      BEGIN
          RAISE EXCEPTION 'books_asset is append-only (% refused)', TG_OP
              USING ERRCODE = 'BK014';
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "books_asset_guard" ON "books_asset"`;
    await tx`
      CREATE TRIGGER "books_asset_guard"
          BEFORE UPDATE OR DELETE ON "books_asset"
          FOR EACH ROW
          EXECUTE FUNCTION "books_asset_guard"()
    `;
    await tx`DROP TRIGGER IF EXISTS "books_asset_no_truncate" ON "books_asset"`;
    await tx`
      CREATE TRIGGER "books_asset_no_truncate"
          BEFORE TRUNCATE ON "books_asset"
          FOR EACH STATEMENT
          EXECUTE FUNCTION "books_asset_guard"()
    `;

    // The house REVOKE (re-applied after the provisioning grants through
    // APPEND_ONLY_TABLES). Guarded on role existence, as in 007.
    await tx`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
          REVOKE UPDATE, DELETE, TRUNCATE ON "books_asset" FROM commerce_app;
        END IF;
      END
      $$
    `;
  },
};
