-- Uploaded site images: the favicon and the sharing image of a site (docs/plans/2026-10-23-published-site-essentials.md,
-- "Uploaded favicon and sharing image"). Additive: one new table. Rewrites no row.

-- CreateTable
CREATE TABLE "public"."site_images" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "tenant_group_id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_images_pkey" PRIMARY KEY ("id"),
    -- The backstop for the upload check (src/lib/site/siteImages.ts): a hash, a known type, at most 2 MB, 1 to 8000 px.
    CONSTRAINT "site_images_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "site_images_content_type_check" CHECK ("content_type" IN ('image/png', 'image/jpeg', 'image/webp', 'image/x-icon')),
    CONSTRAINT "site_images_byte_size_check" CHECK ("byte_size" BETWEEN 1 AND 2097152 AND "byte_size" = octet_length("content")),
    CONSTRAINT "site_images_size_check" CHECK ("width" BETWEEN 1 AND 8000 AND "height" BETWEEN 1 AND 8000)
);

-- CreateIndex
CREATE UNIQUE INDEX "site_images_site_id_sha256_key" ON "public"."site_images"("site_id", "sha256");

-- CreateIndex
CREATE INDEX "site_images_workspace_id_idx" ON "public"."site_images"("workspace_id");

-- CreateIndex
CREATE INDEX "site_images_tenant_group_id_idx" ON "public"."site_images"("tenant_group_id");

-- AddForeignKey
ALTER TABLE "public"."site_images" ADD CONSTRAINT "site_images_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
