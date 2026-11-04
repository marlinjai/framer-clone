-- The editor's save is idempotent per attempt (docs/plans/2026-11-04-editor-autosave.md): the
-- client names each attempt with a key and reuses it when it retries the same content after a
-- lost answer (a proxy 502 or 504, a dropped connection after the commit). The site row keeps the
-- key of its last write only, so it is scoped to one project and lives exactly until the next
-- write of that site. A repeated key whose write is still the latest returns that write's version
-- instead of a false 409. Additive: one nullable column. Rewrites no row.

-- ADD COLUMN takes an ACCESS EXCLUSIVE lock on "sites", which every read of a site waits behind.
-- Behind a long transaction it would wait, and every query on the table would queue behind it:
-- give up after 5 s instead (the deploy's migration step fails loudly and the next run retries),
-- as the tenant migrations do. Adding a nullable column without a default is metadata only, so
-- once the lock is held the change itself is instant.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "public"."sites" ADD COLUMN     "last_write_key" TEXT;
