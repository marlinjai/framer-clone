-- Scheduled re-check of live custom domains (plan
-- docs/plans/2026-06-25-framer-custom-domains.md, security review 2026-10-20).
-- Additive: a failure counter (existing rows start at 0) and an index for
-- "live claims, least recently checked first".

-- AlterTable
ALTER TABLE "site_domains" ADD COLUMN     "consecutive_failures" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "site_domains_custom_hostname_last_checked_at_idx" ON "site_domains"("custom_hostname", "last_checked_at");
