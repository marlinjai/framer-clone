-- P1b: site persistence (sites / site_pages / site_domains / site_experiments).
--
-- Makes Prisma the source of truth for the visual editor's ProjectModel/PageModel
-- MST tree. Every table carries BOTH workspace_id AND tenant_group_id, both
-- indexed: the hard isolation boundary that scopes every query to a workspace
-- and keeps the B2B2C door open. New objects live in the default `public`
-- schema (unqualified names match the init migration's `public` convention; the
-- commerce schema's objects stay qualified).
--
-- GENERATION NOTE: produced via `prisma migrate diff` (schema-to-schema, no live
-- DB), NOT `prisma migrate dev`, because the agent has no database access. It is
-- byte-equivalent to what `migrate dev` would emit for these additive tables.
-- APPLYING this migration to any environment (incl. shadow/dev) is a Marlin /
-- secrets step: run `pnpm db:migrate` (dev) or `pnpm db:deploy` (prod) under
-- Infisical-injected DATABASE_URL. The agent did NOT apply it anywhere.

-- CreateEnum
CREATE TYPE "SiteStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "DomainVerificationStatus" AS ENUM ('pending', 'active', 'failed');

-- CreateEnum
CREATE TYPE "SiteExperimentStatus" AS ENUM ('draft', 'running', 'paused', 'completed');

-- CreateTable
CREATE TABLE "sites" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "tenant_group_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "SiteStatus" NOT NULL DEFAULT 'draft',
    "analytics_project_id" TEXT,
    "ingestion_endpoint" TEXT,
    "api_key_ref" TEXT,
    "lumitra_enabled" BOOLEAN NOT NULL DEFAULT false,
    "project_created_at" TIMESTAMP(3) NOT NULL,
    "project_updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_pages" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "tenant_group_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_domains" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "tenant_group_id" TEXT NOT NULL,
    "subdomain" TEXT,
    "custom_hostname" TEXT,
    "verification_status" "DomainVerificationStatus" NOT NULL DEFAULT 'pending',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_experiments" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "tenant_group_id" TEXT NOT NULL,
    "experiment_key" TEXT NOT NULL,
    "status" "SiteExperimentStatus" NOT NULL DEFAULT 'draft',
    "config" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_experiments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sites_workspace_id_idx" ON "sites"("workspace_id");

-- CreateIndex
CREATE INDEX "sites_tenant_group_id_idx" ON "sites"("tenant_group_id");

-- CreateIndex
CREATE INDEX "site_pages_workspace_id_idx" ON "site_pages"("workspace_id");

-- CreateIndex
CREATE INDEX "site_pages_tenant_group_id_idx" ON "site_pages"("tenant_group_id");

-- CreateIndex
CREATE INDEX "site_pages_site_id_idx" ON "site_pages"("site_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_pages_site_id_page_id_key" ON "site_pages"("site_id", "page_id");

-- CreateIndex
CREATE INDEX "site_domains_workspace_id_idx" ON "site_domains"("workspace_id");

-- CreateIndex
CREATE INDEX "site_domains_tenant_group_id_idx" ON "site_domains"("tenant_group_id");

-- CreateIndex
CREATE INDEX "site_domains_site_id_idx" ON "site_domains"("site_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_domains_subdomain_key" ON "site_domains"("subdomain");

-- CreateIndex
CREATE UNIQUE INDEX "site_domains_custom_hostname_key" ON "site_domains"("custom_hostname");

-- CreateIndex
CREATE INDEX "site_experiments_workspace_id_idx" ON "site_experiments"("workspace_id");

-- CreateIndex
CREATE INDEX "site_experiments_tenant_group_id_idx" ON "site_experiments"("tenant_group_id");

-- CreateIndex
CREATE INDEX "site_experiments_site_id_idx" ON "site_experiments"("site_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_experiments_site_id_experiment_key_key" ON "site_experiments"("site_id", "experiment_key");

-- AddForeignKey
ALTER TABLE "site_pages" ADD CONSTRAINT "site_pages_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_domains" ADD CONSTRAINT "site_domains_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_experiments" ADD CONSTRAINT "site_experiments_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

