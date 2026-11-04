-- The editor's save is idempotent per attempt (docs/plans/2026-11-04-editor-autosave.md): the
-- client names each attempt with a key and reuses it when it retries the same content after a
-- lost answer (a proxy 502 or 504, a dropped connection after the commit). The site row keeps the
-- key of its last write only, so it is scoped to one project and lives exactly until the next
-- write of that site. A repeated key whose write is still the latest returns that write's version
-- instead of a false 409. Additive: one nullable column. Rewrites no row.

-- No lock timeout here: adding a nullable column without a default only changes the catalogue
-- (no row is rewritten, the ACCESS EXCLUSIVE lock is held for an instant), and a migration that
-- fails on a timeout is marked failed by Prisma (P3009), which blocks every later deploy until it
-- is resolved by hand. Rollback: deploy/README.md, "Migration rollbacks".

-- AlterTable
ALTER TABLE "public"."sites" ADD COLUMN     "last_write_key" TEXT;
