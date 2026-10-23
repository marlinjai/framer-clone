import type { Migration } from '@marlinjai/tenant-db';

/**
 * Books visual template composer, `014_books_asset_delete`: a logo nobody uses
 * may be deleted (docs/plans/2026-10-21-books-visual-template-composer.md,
 * phase 4 decision 9). 013 made `books_asset` append-only because an issued
 * document re-renders from it. That protects more than the law asks: the
 * rules for keeping books electronically (GoBD) protect what an issued
 * document was printed with, nothing else, while the General Data Protection
 * Regulation (GDPR) right to erasure needs an uploaded image (a photo of a
 * person uploaded by mistake) to be removable. So a logo may be deleted when
 * nothing names it, and never while something does.
 *
 * The structural guarantees, and why each exists:
 *
 *   1. "In use" has one definition, `books_asset_in_use(tenant_id, sha256)`,
 *      which the guard and the logo list (repository/assets.ts) both call, so
 *      the list never offers a delete the database refuses. A logo is in use
 *      when a `sales_document` of the same company froze it
 *      (`template_snapshot -> 'logo' ->> 'sha256'`, every issued document and
 *      credit note, cancelled ones included: they re-render from it), or a
 *      live (not archived) `document_template` of the same company names it in
 *      any logo block of its CURRENT version (top level or inside a `columns`
 *      cell: the JSON path walks the whole document). Older versions do not
 *      count: a document issued from one froze the logo in its own snapshot,
 *      and a template only ever prints its current version. An archived
 *      template prints nothing. A document whose snapshot froze no logo while
 *      its layout names a hash (saved before logos existed, phase 5 decision
 *      3) draws that block empty, so it does not hold the image either.
 *   2. DELETE is refused with BK015 (ASSET_IN_USE, 409) while the logo is in
 *      use, for every role, the owner included; UPDATE and TRUNCATE stay
 *      refused (BK014) for every role. The bytes behind a hash never change,
 *      so a re-render reads exactly what was issued, and a table-wide wipe
 *      cannot skip the per-row check.
 *   3. commerce_app may DELETE `books_asset` (the house REVOKE keeps UPDATE and
 *      TRUNCATE away). Provisioning and the fleet runner re-apply exactly this
 *      split after their grants (NO_UPDATE_TABLES in provisioning/provision.ts),
 *      so the app role never holds UPDATE, and existing tenants gain DELETE
 *      when this migration rolls at boot.
 *   4. No race with an issue or a template save. The guard checks what is
 *      committed when the DELETE runs. The application closes the window
 *      around it with a lock per company and logo, held to the end of each
 *      transaction (repository/assets.ts): the issue takes it shared for the
 *      logo it freezes, a template save shared for the logos its new version
 *      names (refusing LOGO_ASSET_MISSING when one is gone), an upload shared
 *      before it answers a stored logo, and a delete takes it exclusively
 *      before it deletes. Whichever comes second waits for the first to
 *      commit: an issue or save after a delete finds the logo gone and
 *      refuses; a delete after an issue or save sees the reference (each
 *      statement of a READ COMMITTED transaction reads what committed before
 *      it) and is refused. The lock is a transaction-scoped advisory lock, not
 *      `FOR SHARE` and `FOR UPDATE` on the row: a row lock needs the UPDATE
 *      privilege, which the app role must never hold on this table. The guard
 *      takes the exclusive lock itself before it checks, so a DELETE from any
 *      path (the owner, a maintenance script) waits the same way, and at most
 *      5 seconds when its session set no lock timeout (55P03 then; a waiting
 *      delete queues every later issue, save and upload of the logo).
 *   5. The check is an index lookup on documents: `sales_document`'s frozen
 *      logo hash is indexed per company (partial, only rows that froze one),
 *      so a delete or the logo list does not read every invoice's snapshot.
 *      A company has a handful of templates; their current versions are read
 *      directly. The index is built inside the migration transaction (the
 *      runner's), not CONCURRENTLY: it holds a SHARE lock on `sales_document`
 *      while it builds, which blocks issues of that schema for the build's
 *      length at boot. The tables hold a few thousand rows at most today, so
 *      that is well under a second.
 *
 * House style as 007, 008, 012 and 013: BARE names, functions
 * `SET search_path FROM CURRENT`, custom SQLSTATE BK015 (BK014 belongs to
 * 013). Re-runnable: CREATE OR REPLACE and IF NOT EXISTS throughout.
 */

export const booksAssetDelete: Migration = {
  id: '014_books_asset_delete',
  up: async (tx) => {
    // Guarantee 5: documents are found by their frozen logo without a scan.
    await tx`
      CREATE INDEX IF NOT EXISTS "sales_document_tenant_id_logo_sha256_idx"
          ON "sales_document" ("tenant_id", (("template_snapshot" -> 'logo' ->> 'sha256')))
          WHERE ("template_snapshot" -> 'logo' ->> 'sha256') IS NOT NULL
    `;

    // Guarantee 1: the one definition of "in use".
    await tx`
      CREATE OR REPLACE FUNCTION "books_asset_in_use"(p_tenant_id TEXT, p_sha256 TEXT)
      RETURNS BOOLEAN
      LANGUAGE sql
      STABLE
      SET search_path FROM CURRENT
      AS $$
          SELECT EXISTS (
                     SELECT 1
                       FROM "sales_document" d
                      WHERE d."tenant_id" = p_tenant_id
                        AND (d."template_snapshot" -> 'logo' ->> 'sha256') = p_sha256
                 )
              OR EXISTS (
                     SELECT 1
                       FROM "document_template" t
                       JOIN "document_template_version" v
                         ON v."tenant_id" = t."tenant_id"
                        AND v."id" = t."current_version_id"
                      WHERE t."tenant_id" = p_tenant_id
                        AND t."archived_at" IS NULL
                        AND jsonb_path_exists(
                                v."document",
                                'lax $.regions.** ? (@.type == "logo" && @.assetSha256 == $sha)',
                                jsonb_build_object('sha', p_sha256)
                            )
                 )
      $$
    `;

    // Guarantee 2: UPDATE and TRUNCATE refused as before, DELETE only of an unused logo.
    // The triggers of 013 stay; they call this function.
    await tx`
      CREATE OR REPLACE FUNCTION "books_asset_guard"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      BEGIN
          IF TG_OP = 'DELETE' THEN
              -- The logo's lock, exclusively (the key repository/assets.ts uses): a DELETE from
              -- any path waits for an issue or a template save naming the logo, so the check
              -- below sees what they committed. Re-entrant for deleteAsset, which holds it.
              -- A session that set no lock timeout (the owner, a maintenance script) waits at
              -- most 5 s, as the application's delete does: a waiting delete queues every later
              -- issue, save and upload of the logo behind it. Lasts to the end of its transaction.
              IF current_setting('lock_timeout') = '0' THEN
                  PERFORM set_config('lock_timeout', '5000ms', true);
              END IF;
              PERFORM pg_advisory_xact_lock(hashtextextended('books-asset:' || OLD."tenant_id" || ':' || OLD."sha256", 0));
              IF "books_asset_in_use"(OLD."tenant_id", OLD."sha256") THEN
                  RAISE EXCEPTION 'books_asset %: the logo is printed on an issued document or used by a live template', OLD."sha256"
                      USING ERRCODE = 'BK015';
              END IF;
              RETURN OLD;
          END IF;
          RAISE EXCEPTION 'books_asset rows never change (% refused)', TG_OP
              USING ERRCODE = 'BK014';
      END;
      $$
    `;

    // Guarantee 3: the app role may delete (the guard decides which rows) and
    // never update. Provisioning re-applies the same split after its grants
    // (NO_UPDATE_TABLES). Guarded on role existence, as in 007.
    await tx`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
          GRANT DELETE ON "books_asset" TO commerce_app;
          REVOKE UPDATE, TRUNCATE ON "books_asset" FROM commerce_app;
          GRANT EXECUTE ON FUNCTION "books_asset_in_use"(TEXT, TEXT) TO commerce_app;
        END IF;
      END
      $$
    `;
  },
};
