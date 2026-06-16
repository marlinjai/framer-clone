-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "dt_tables" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "migrated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dt_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dt_columns" (
    "id" TEXT NOT NULL,
    "table_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 200,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB,
    "alignment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dt_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "select_options" (
    "id" TEXT NOT NULL,
    "column_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "position" INTEGER NOT NULL,

    CONSTRAINT "select_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dt_row_select_values" (
    "id" TEXT NOT NULL,
    "row_id" TEXT NOT NULL,
    "column_id" TEXT NOT NULL,
    "option_id" TEXT NOT NULL,

    CONSTRAINT "dt_row_select_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dt_relations" (
    "id" TEXT NOT NULL,
    "source_row_id" TEXT NOT NULL,
    "source_column_id" TEXT NOT NULL,
    "target_row_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dt_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dt_files" (
    "id" TEXT NOT NULL,
    "row_id" TEXT NOT NULL,
    "column_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "file_url" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,

    CONSTRAINT "dt_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dt_views" (
    "id" TEXT NOT NULL,
    "table_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'table',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dt_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dt_rows" (
    "id" TEXT NOT NULL,
    "table_id" TEXT NOT NULL,
    "cells" JSONB,
    "computed" JSONB,
    "_title" TEXT,
    "_archived" INTEGER NOT NULL DEFAULT 0,
    "_created_at" TEXT NOT NULL,
    "_updated_at" TEXT NOT NULL,

    CONSTRAINT "dt_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dt_row_select_values_row_id_column_id_option_id_key" ON "dt_row_select_values"("row_id", "column_id", "option_id");

-- CreateIndex
CREATE UNIQUE INDEX "dt_relations_source_row_id_source_column_id_target_row_id_key" ON "dt_relations"("source_row_id", "source_column_id", "target_row_id");

-- AddForeignKey
ALTER TABLE "dt_columns" ADD CONSTRAINT "dt_columns_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "dt_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dt_views" ADD CONSTRAINT "dt_views_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "dt_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

