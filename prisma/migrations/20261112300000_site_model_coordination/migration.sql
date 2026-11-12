-- Coordination of 3D model uploads and blob cleanup (docs/plans/2026-11-02-3d-scene-primitive.md, "Coordinating uploads
-- and blob cleanup", approved 2026-11-12). ADDITIVE: three nullable-or-defaulted columns on the (empty, unread)
-- site_models table and one new empty table. Existing rows (none in production) default to 'ready'. Nothing reads or
-- writes either until the separately gated upload and cleanup routes exist. Rollback: rollback.sql beside this file.

-- AlterTable: an upload's row is PENDING (with the attempt that owns it and a deadline) until its blobs are written.
ALTER TABLE "public"."site_models"
    ADD COLUMN "state" TEXT NOT NULL DEFAULT 'ready',
    ADD COLUMN "pending_until" TIMESTAMP(3),
    ADD COLUMN "attempt" TEXT;

-- A ready row carries no attempt or deadline; a pending row carries both.
ALTER TABLE "public"."site_models" ADD CONSTRAINT "site_models_state_check" CHECK (
    ("state" = 'ready' AND "pending_until" IS NULL AND "attempt" IS NULL)
    OR ("state" = 'pending' AND "pending_until" IS NOT NULL AND "attempt" IS NOT NULL)
);

-- CreateIndex: the reaper finds expired pending rows.
CREATE INDEX "site_models_pending_until_idx" ON "public"."site_models"("pending_until") WHERE "state" = 'pending';

-- CreateTable: one row per blob key a cleanup is deleting (the tombstone). Global by content hash, like the blobs.
CREATE TABLE "public"."model_blob_tombstones" (
    "key" TEXT NOT NULL,
    "attempt" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_blob_tombstones_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "model_blob_tombstones_key_check" CHECK ("key" ~ '^(served|original)/[0-9a-f]{64}$')
);

-- CreateIndex: the reconciler finds expired tombstones.
CREATE INDEX "model_blob_tombstones_expires_at_idx" ON "public"."model_blob_tombstones"("expires_at");
