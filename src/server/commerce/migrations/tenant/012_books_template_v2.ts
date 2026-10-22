import { randomUUID } from 'node:crypto';

import type { Migration } from '@marlinjai/tenant-db';

/**
 * Books, visual template composer phase 2, `012_books_template_v2`: document
 * templates become versioned documents of typed blocks (template model
 * version 2). Specified in docs/plans/2026-10-21-books-visual-template-composer.md,
 * decisions 3 and 4, and its build notes.
 *
 * The structural guarantees, and why each exists:
 *
 *   1. `document_template_version` holds every saved version of a template as
 *      a JSONB document (`document->>'v' = '2'`), numbered 1, 2, 3 per template
 *      (unique). It is append-only (BK012 on UPDATE, DELETE and TRUNCATE, for
 *      every role, plus the house REVOKE for the app role re-applied through
 *      APPEND_ONLY_TABLES): a version a document was issued with is never
 *      changed or removed, so "issued with Klassisch, version 4" stays true.
 *   2. Composite foreign keys, the 007 pattern: a version belongs to a template
 *      of the SAME company, and `document_template.current_version_id` points
 *      at a version of the same company AND of the same template. That key is
 *      DEFERRABLE INITIALLY DEFERRED, so a new template row and its first
 *      version are written in one transaction in either order.
 *   3. Templates are archived, never deleted, once they have a version (every
 *      template has one from here): `archived_at` hides a template from the
 *      list and the picker, and its name is free again (the unique name
 *      becomes a partial index over live templates).
 *   4. Every existing template is converted, inside this transaction, into its
 *      version 1: the built-in Klassisch layout (today's layout as blocks) with
 *      the row's accent colour and its footer blocks as small-print text at the
 *      end of the body. The conversion below is a FROZEN copy written for this
 *      migration; it never imports the live presets, so a later preset change
 *      cannot change what this deployed migration did.
 *   5. Then the columns version 2 replaces are dropped: `accent_color`,
 *      `footer_blocks` (now in the version document) and `logo_file_id` (never
 *      written; logos arrive with their own asset table in phase 5).
 *      `default_intro_text` and `default_outro_text` stay on the template row:
 *      they seed a new draft and are not layout.
 *   6. `sales_document.print_replaces_reference` (the Correct flow's optional
 *      line "Ersetzt Rechnung 62 vom 14.10.2026" on a replacement invoice, plan
 *      phase 1 decision 5): only a replacement may switch it on (CHECK); the 007
 *      guard freezes it after issue with every other column.
 *
 * House style as 007 and 008: BARE names, ids TEXT minted by the application,
 * trigger functions `SET search_path FROM CURRENT`, custom SQLSTATE BK012.
 */

/** A version 1 footer block as 007 stored it (the repository allowed at most four). */
interface FooterBlockRow {
  heading?: unknown;
  text?: unknown;
}

/**
 * FROZEN (2026-10-22): the Klassisch layout of the template model version 2
 * at the time of this migration, with a row's accent colour and footer blocks.
 */
function convertedKlassisch(accent: string | null, footerBlocks: unknown): Record<string, unknown> {
  const blocks: FooterBlockRow[] = Array.isArray(footerBlocks) ? (footerBlocks as FooterBlockRow[]) : [];
  const smallPrint = blocks
    .filter((b) => typeof b?.text === 'string' && b.text.trim() !== '')
    .slice(0, 4)
    .map((b, i) => ({
      id: `smallPrint${i + 1}`,
      type: 'freeText',
      style: {},
      heading: typeof b.heading === 'string' && b.heading.trim() !== '' ? b.heading.trim().slice(0, 60) : null,
      text: (b.text as string).trim().slice(0, 2000),
      variant: 'smallPrint',
    }));
  return {
    v: 2,
    locale: 'de-DE',
    page: { size: 'A4', addressLayout: 'din5008-b', marginsMm: { left: 20, right: 20, bottom: 10 }, pageNumber: 'right' },
    theme: {
      fontFamily: 'dejavu-sans',
      baseSizePt: 9.5,
      ink: '#1a1a1f',
      accent: accent && /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : '#333340',
      muted: '#61616b',
    },
    regions: {
      firstPageHeader: [],
      addressZone: {
        left: [
          { id: 'senderLine', type: 'senderLine', style: { sizePt: 7, color: 'muted', spaceBelowPt: 8 } },
          { id: 'recipient', type: 'recipient', style: {} },
        ],
        right: [
          {
            id: 'documentMeta',
            type: 'documentMeta',
            style: { sizePt: 8 },
            items: ['number', 'issueDate', 'serviceDate', 'customerNumber', 'contract', 'recipientVatId'],
          },
        ],
      },
      body: [
        { id: 'title', type: 'title', style: { sizePt: 14, bold: true, color: 'accent', spaceAbovePt: 24, spaceBelowPt: 8 } },
        { id: 'introText', type: 'introText', style: { spaceBelowPt: 8 } },
        {
          id: 'lineTable',
          type: 'lineTable',
          style: {},
          headerBand: false,
          columns: {
            pos: { visible: true, width: 0 },
            title: { visible: true, width: 0 },
            quantity: { visible: true, width: 0 },
            unit: { visible: true, width: 11 },
            unitPrice: { visible: true, width: 0 },
            rate: { visible: true, width: 0 },
            amount: { visible: true, width: 0 },
          },
        },
        { id: 'totals', type: 'totals', style: { spaceAbovePt: 4, spaceBelowPt: 8 } },
        { id: 'taxNote', type: 'taxNote', style: { bold: true, spaceBelowPt: 8 } },
        { id: 'paymentDetails', type: 'paymentDetails', style: { spaceBelowPt: 8 }, heading: null },
        { id: 'outroText', type: 'outroText', style: { spaceBelowPt: 8 } },
        ...smallPrint,
      ],
      followingPageHeader: [{ id: 'continuation', type: 'title', style: { sizePt: 9, bold: false, color: 'muted', spaceBelowPt: 12 } }],
      footer: [
        { id: 'footerRule', type: 'divider', style: { spaceBelowPt: 4 }, thicknessPt: 0.4, lineColor: 'muted' },
        {
          id: 'senderColumns',
          type: 'senderColumns',
          style: { sizePt: 6.5, color: 'muted' },
          columns: ['identity', 'contact', 'legal', 'bank'],
          layout: 'columns',
        },
      ],
    },
  };
}

export const booksTemplateV2: Migration = {
  id: '012_books_template_v2',
  up: async (tx) => {
    // Guarantee 1 and 2: the version table.
    await tx`
      CREATE TABLE IF NOT EXISTS "document_template_version" (
          "id"          TEXT         NOT NULL,
          "tenant_id"   TEXT         NOT NULL,
          "template_id" TEXT         NOT NULL,
          "version"     INTEGER      NOT NULL,
          "document"    JSONB        NOT NULL,
          "created_by"  TEXT,
          "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "document_template_version_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "document_template_version_tenant_id_check"
              CHECK ("tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
          CONSTRAINT "document_template_version_version_check" CHECK ("version" >= 1),
          CONSTRAINT "document_template_version_document_check"
              CHECK (jsonb_typeof("document") = 'object' AND "document"->>'v' = '2'),
          CONSTRAINT "document_template_version_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
          CONSTRAINT "document_template_version_template_version_key" UNIQUE ("tenant_id", "template_id", "version"),
          CONSTRAINT "document_template_version_template_id_key" UNIQUE ("tenant_id", "template_id", "id"),
          CONSTRAINT "document_template_version_template_fkey"
              FOREIGN KEY ("tenant_id", "template_id") REFERENCES "document_template" ("tenant_id", "id")
              ON DELETE RESTRICT ON UPDATE RESTRICT
      )
    `;

    await tx`
      CREATE OR REPLACE FUNCTION "document_template_version_guard"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      BEGIN
          RAISE EXCEPTION 'document_template_version is append-only (% refused)', TG_OP
              USING ERRCODE = 'BK012';
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "document_template_version_guard" ON "document_template_version"`;
    await tx`
      CREATE TRIGGER "document_template_version_guard"
          BEFORE UPDATE OR DELETE ON "document_template_version"
          FOR EACH ROW
          EXECUTE FUNCTION "document_template_version_guard"()
    `;
    await tx`DROP TRIGGER IF EXISTS "document_template_version_no_truncate" ON "document_template_version"`;
    await tx`
      CREATE TRIGGER "document_template_version_no_truncate"
          BEFORE TRUNCATE ON "document_template_version"
          FOR EACH STATEMENT
          EXECUTE FUNCTION "document_template_version_guard"()
    `;
    await tx`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
          REVOKE UPDATE, DELETE, TRUNCATE ON "document_template_version" FROM commerce_app;
        END IF;
      END
      $$
    `;

    // Guarantee 3: archiving, and a unique name among live templates only.
    await tx`ALTER TABLE "document_template" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMP(3)`;
    await tx`ALTER TABLE "document_template" ADD COLUMN IF NOT EXISTS "current_version_id" TEXT`;
    await tx`ALTER TABLE "document_template" DROP CONSTRAINT IF EXISTS "document_template_tenant_id_name_key"`;
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "document_template_tenant_id_name_key"
        ON "document_template" ("tenant_id", "name")
        WHERE "archived_at" IS NULL
    `;
    await tx`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'document_template_archived_default_check'
             AND conrelid = 'document_template'::regclass
        ) THEN
          ALTER TABLE "document_template"
            ADD CONSTRAINT "document_template_archived_default_check"
            CHECK ("archived_at" IS NULL OR NOT "is_default");
        END IF;
      END
      $$
    `;

    // Guarantee 4: every existing template becomes its version 1.
    const hasOldColumns = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'document_template' AND column_name = 'footer_blocks'
    `;
    if (hasOldColumns[0].n > 0) {
      const rows = await tx<{ id: string; tenant_id: string; accent_color: string | null; footer_blocks: unknown }[]>`
        SELECT "id", "tenant_id", "accent_color", "footer_blocks"
          FROM "document_template"
         WHERE "current_version_id" IS NULL
         ORDER BY "tenant_id", "id"
      `;
      for (const row of rows) {
        const versionId = randomUUID();
        await tx`
          INSERT INTO "document_template_version" ("id", "tenant_id", "template_id", "version", "document")
          VALUES (${versionId}, ${row.tenant_id}, ${row.id}, 1, ${tx.json(convertedKlassisch(row.accent_color, row.footer_blocks) as never)})
        `;
        await tx`
          UPDATE "document_template" SET "current_version_id" = ${versionId}
           WHERE "tenant_id" = ${row.tenant_id} AND "id" = ${row.id}
        `;
      }
    }

    // Guarantee 2: the current version is one of the template's own.
    await tx`ALTER TABLE "document_template" ALTER COLUMN "current_version_id" SET NOT NULL`;
    await tx`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'document_template_current_version_fkey'
             AND conrelid = 'document_template'::regclass
        ) THEN
          ALTER TABLE "document_template"
            ADD CONSTRAINT "document_template_current_version_fkey"
            FOREIGN KEY ("tenant_id", "id", "current_version_id")
            REFERENCES "document_template_version" ("tenant_id", "template_id", "id")
            ON DELETE RESTRICT ON UPDATE RESTRICT
            DEFERRABLE INITIALLY DEFERRED;
        END IF;
      END
      $$
    `;

    // Guarantee 6: the replacement's optional reference line.
    await tx`ALTER TABLE "sales_document" ADD COLUMN IF NOT EXISTS "print_replaces_reference" BOOLEAN NOT NULL DEFAULT false`;
    await tx`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'sales_document_print_replaces_check'
             AND conrelid = 'sales_document'::regclass
        ) THEN
          ALTER TABLE "sales_document"
            ADD CONSTRAINT "sales_document_print_replaces_check"
            CHECK (NOT "print_replaces_reference" OR "replaces_document_id" IS NOT NULL);
        END IF;
      END
      $$
    `;

    // Guarantee 5: the columns version 2 replaces.
    await tx`ALTER TABLE "document_template" DROP COLUMN IF EXISTS "accent_color"`;
    await tx`ALTER TABLE "document_template" DROP COLUMN IF EXISTS "footer_blocks"`;
    // Never written by any code path (logos arrive in phase 5); refuse rather than drop a value set by hand.
    await tx`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'document_template' AND column_name = 'logo_file_id'
        ) AND EXISTS (SELECT 1 FROM "document_template" WHERE "logo_file_id" IS NOT NULL) THEN
          RAISE EXCEPTION 'document_template.logo_file_id holds values; move them before 012 drops the column'
              USING ERRCODE = 'BK012';
        END IF;
      END
      $$
    `;
    await tx`ALTER TABLE "document_template" DROP COLUMN IF EXISTS "logo_file_id"`;
  },
};
