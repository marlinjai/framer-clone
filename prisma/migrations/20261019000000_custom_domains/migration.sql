-- Custom domains for published sites (plan docs/plans/2026-06-25-framer-custom-domains.md).
--
-- Additive only: one enum value and nullable columns on site_domains, plus
-- three indexes. Existing rows (the platform subdomain rows) keep every new
-- column NULL and their status `active`. Public-schema objects use
-- unqualified names, matching the earlier site migrations.
--
-- `verified` is added with ADD VALUE, which Postgres allows inside the
-- migration transaction; nothing in this migration uses the new value, so the
-- "new enum value cannot be used in the same transaction" rule does not bite.

-- AlterEnum
ALTER TYPE "DomainVerificationStatus" ADD VALUE 'verified';

-- AlterTable
ALTER TABLE "site_domains" ADD COLUMN     "activated_at" TIMESTAMP(3),
ADD COLUMN     "hostname" TEXT,
ADD COLUMN     "last_checked_at" TIMESTAMP(3),
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "last_error_code" TEXT,
ADD COLUMN     "verification_token" TEXT,
ADD COLUMN     "verified_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "site_domains_hostname_idx" ON "site_domains"("hostname");

-- CreateIndex
CREATE UNIQUE INDEX "site_domains_verification_token_key" ON "site_domains"("verification_token");

-- CreateIndex
CREATE UNIQUE INDEX "site_domains_site_id_hostname_key" ON "site_domains"("site_id", "hostname");
