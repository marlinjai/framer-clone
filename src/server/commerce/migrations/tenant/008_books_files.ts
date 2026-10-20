import type { Migration } from '@marlinjai/tenant-db';

/**
 * Books phase 3, `008_books_files`: the stored document of record. When an
 * invoice or a credit note is issued, its PDF is rendered once from the frozen
 * snapshots and stored here; `sales_document.rendered_pdf_file_id` points at
 * it (set once, NULL to a value, which the 007 guard trigger already allows and
 * nothing else). Specified in
 * docs/plans/2026-08-15-books-receipts-invoices-integration.md, "Phase 2 and 3
 * build notes (2026-10-20)".
 *
 * Why the database and not storage-brain: the plan names storage-brain for the
 * PDFs (amendment item 6, "connections, after the import"), but this repository
 * has no storage-brain client yet. Until that connection is built the bytes live
 * beside the document, in the tenant group's own schema (the same isolation,
 * backup and export as the document itself). Moving them later is a copy plus a
 * new id column; the composite foreign key below is dropped then.
 *
 * The structural guarantees, and why each exists:
 *
 *   1. One file per document (`sales_document_file_document_key`): the document
 *      of record is unique. A second render of the same document is identical
 *      by construction (it reads only frozen data), and the repository stores
 *      only when none exists yet.
 *   2. Composite foreign keys both ways, the 007 pattern: a file belongs to a
 *      document of the SAME company, and a document can only point at a file of
 *      its own company.
 *   3. Only a non-draft document can get a file (BK001): a draft has no number
 *      and is not a document of record; its preview is rendered on the fly and
 *      never stored.
 *   4. Append-only (BK006 on UPDATE, DELETE and TRUNCATE, for every role, the
 *      owner included), plus the house REVOKE for the app role, re-applied after
 *      the provisioning grants through APPEND_ONLY_TABLES. A stored invoice is
 *      never changed or removed (GoBD: unalterable retention).
 *   5. The content is self-describing and checked: `byte_size` equals the
 *      content's length, `sha256` is a lowercase hex digest (the application
 *      computes it; the download sends it), `content_type` is a PDF.
 *
 *   6. `sales_document.template_snapshot` (added here, while 008 is unreleased):
 *      the template's layout (accent colour, footer blocks, name) frozen at
 *      issue, so an issued document renders only from frozen data. NULL on a
 *      draft (CHECK), an object otherwise; the 007 guard freezes it after issue
 *      with every other column (it compares the whole row).
 *
 * House style as 007: BARE names, ids TEXT minted by the application, trigger
 * functions `SET search_path FROM CURRENT`.
 */

export const booksFiles: Migration = {
  id: '008_books_files',
  up: async (tx) => {
    await tx`
      CREATE TABLE IF NOT EXISTS "sales_document_file" (
          "id"           TEXT         NOT NULL,
          "tenant_id"    TEXT         NOT NULL,
          "document_id"  TEXT         NOT NULL,
          "content_type" TEXT         NOT NULL,
          "byte_size"    INTEGER      NOT NULL,
          "sha256"       TEXT         NOT NULL,
          "renderer"     TEXT         NOT NULL,
          "content"      BYTEA        NOT NULL,
          "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "sales_document_file_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "sales_document_file_tenant_id_check"
              CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
          CONSTRAINT "sales_document_file_content_type_check" CHECK ("content_type" = 'application/pdf'),
          CONSTRAINT "sales_document_file_size_check"
              CHECK ("byte_size" > 0 AND "byte_size" = octet_length("content")),
          CONSTRAINT "sales_document_file_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
          CONSTRAINT "sales_document_file_renderer_check" CHECK (length("renderer") BETWEEN 1 AND 100),
          CONSTRAINT "sales_document_file_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
          CONSTRAINT "sales_document_file_document_key" UNIQUE ("tenant_id", "document_id"),
          CONSTRAINT "sales_document_file_document_fkey"
              FOREIGN KEY ("tenant_id", "document_id") REFERENCES "sales_document" ("tenant_id", "id")
              ON DELETE RESTRICT ON UPDATE RESTRICT
      )
    `;

    // Guarantee 6: the frozen template layout.
    await tx`ALTER TABLE "sales_document" ADD COLUMN IF NOT EXISTS "template_snapshot" JSONB`;
    await tx`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'sales_document_template_snapshot_check'
             AND conrelid = 'sales_document'::regclass
        ) THEN
          ALTER TABLE "sales_document"
            ADD CONSTRAINT "sales_document_template_snapshot_check"
            CHECK (
              ("status" <> 'draft' OR "template_snapshot" IS NULL)
              AND ("template_snapshot" IS NULL OR jsonb_typeof("template_snapshot") = 'object')
            );
        END IF;
      END
      $$
    `;

    // The document points at its file of the same company (guarantee 2).
    await tx`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'sales_document_rendered_pdf_file_fkey'
             AND conrelid = 'sales_document'::regclass
        ) THEN
          ALTER TABLE "sales_document"
            ADD CONSTRAINT "sales_document_rendered_pdf_file_fkey"
            FOREIGN KEY ("tenant_id", "rendered_pdf_file_id")
            REFERENCES "sales_document_file" ("tenant_id", "id")
            ON DELETE RESTRICT ON UPDATE RESTRICT;
        END IF;
      END
      $$
    `;

    // Guarantees 3 and 4: only an issued (non-draft) document gets a file, and
    // a stored file is never changed or removed.
    await tx`
      CREATE OR REPLACE FUNCTION "sales_document_file_guard"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      DECLARE
          parent_status "SalesDocStatus";
      BEGIN
          IF TG_OP = 'INSERT' THEN
              SELECT "status" INTO parent_status
                FROM "sales_document"
               WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."document_id"
                 FOR SHARE;
              IF parent_status IS NULL OR parent_status = 'draft' THEN
                  RAISE EXCEPTION 'sales_document_file: document % is a draft or does not exist', NEW."document_id"
                      USING ERRCODE = 'BK001';
              END IF;
              RETURN NEW;
          END IF;
          RAISE EXCEPTION 'sales_document_file is append-only (% refused)', TG_OP
              USING ERRCODE = 'BK006';
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "sales_document_file_guard" ON "sales_document_file"`;
    await tx`
      CREATE TRIGGER "sales_document_file_guard"
          BEFORE INSERT OR UPDATE OR DELETE ON "sales_document_file"
          FOR EACH ROW
          EXECUTE FUNCTION "sales_document_file_guard"()
    `;
    await tx`DROP TRIGGER IF EXISTS "sales_document_file_no_truncate" ON "sales_document_file"`;
    await tx`
      CREATE TRIGGER "sales_document_file_no_truncate"
          BEFORE TRUNCATE ON "sales_document_file"
          FOR EACH STATEMENT
          EXECUTE FUNCTION "sales_document_file_guard"()
    `;

    // The house REVOKE (re-applied after the provisioning grants through
    // APPEND_ONLY_TABLES). Guarded on role existence, as in 007.
    await tx`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
          REVOKE UPDATE, DELETE, TRUNCATE ON "sales_document_file" FROM commerce_app;
        END IF;
      END
      $$
    `;
  },
};
