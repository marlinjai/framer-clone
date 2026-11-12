-- Stored 3D models of a site (docs/plans/2026-11-02-3d-scene-primitive.md, "Storage", slice S2): the metadata of each
-- re-encoded model whose bytes live in object storage. ADDITIVE: one new table, no existing table or row touched.
-- Nothing reads or writes it until the (separately gated) upload route exists. Rollback: rollback.sql beside this file.

-- CreateTable
CREATE TABLE "public"."site_models" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "tenant_group_id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "triangles" INTEGER NOT NULL,
    "material_count" INTEGER NOT NULL,
    "node_count" INTEGER NOT NULL,
    "clip_count" INTEGER NOT NULL,
    "texture_count" INTEGER NOT NULL DEFAULT 0,
    "extensions" TEXT[],
    "material_names" JSONB NOT NULL DEFAULT '[]',
    "node_names" JSONB NOT NULL DEFAULT '[]',
    "original_sha256" TEXT NOT NULL,
    "original_bytes" INTEGER NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_models_pkey" PRIMARY KEY ("id"),
    -- The backstops for the upload checks (src/server/models/uploadModel.ts): a hash, at most 8 MB, the decoded caps,
    -- the kept original at most the 50 MB read cap, names as JSON arrays.
    CONSTRAINT "site_models_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "site_models_original_sha256_check" CHECK ("original_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "site_models_byte_size_check" CHECK ("byte_size" BETWEEN 1 AND 8388608),
    CONSTRAINT "site_models_original_bytes_check" CHECK ("original_bytes" BETWEEN 1 AND 52428800),
    CONSTRAINT "site_models_counts_check" CHECK (
        "triangles" BETWEEN 0 AND 500000 AND "material_count" BETWEEN 0 AND 64 AND "node_count" BETWEEN 0 AND 1000
        AND "clip_count" BETWEEN 0 AND 32 AND "texture_count" BETWEEN 0 AND 16
    ),
    CONSTRAINT "site_models_names_check" CHECK (jsonb_typeof("material_names") = 'array' AND jsonb_typeof("node_names") = 'array'),
    CONSTRAINT "site_models_dates_check" CHECK ("last_used_at" >= "created_at")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_models_site_id_sha256_key" ON "public"."site_models"("site_id", "sha256");

-- CreateIndex
CREATE INDEX "site_models_workspace_id_idx" ON "public"."site_models"("workspace_id");

-- CreateIndex
CREATE INDEX "site_models_tenant_group_id_idx" ON "public"."site_models"("tenant_group_id");

-- CreateIndex
CREATE INDEX "site_models_sha256_idx" ON "public"."site_models"("sha256");

-- CreateIndex
CREATE INDEX "site_models_original_sha256_idx" ON "public"."site_models"("original_sha256");

-- AddForeignKey
ALTER TABLE "public"."site_models" ADD CONSTRAINT "site_models_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
