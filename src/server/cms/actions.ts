'use server';

// src/server/cms/actions.ts
//
// The server-action surface of the full data-table `DatabaseAdapter` (40 of its
// 41 methods; `transaction` is implemented client-side in the
// cmsServerActionsAdapter, exactly as the receipt-OCR reference does). Every
// action delegates to the single CMS `PrismaAdapter` via getCmsAdapter().
//
// This is the editor grid's WRITE path. It mirrors receipt-OCR's
// server-actions-adapter pattern but adds an authorization gate the receipt app
// does not need: framer-clone admin-guards CMS writes, so every MUTATING action
// calls requireAdminAction() first (same `admin_secret` cookie +
// FRAMER_CLONE_ADMIN_SECRET contract as the /api/cms write routes). Read actions
// stay unauthenticated, matching the public read-route policy. The panel never
// touches MST; this path adds no new HTTP routes.

import type {
  Table,
  Column,
  Row,
  SelectOption,
  FileReference,
  View,
  QueryOptions,
  QueryResult,
  CellValue,
  CreateTableInput,
  UpdateTableInput,
  CreateColumnInput,
  UpdateColumnInput,
  CreateSelectOptionInput,
  UpdateSelectOptionInput,
  CreateRowInput,
  CreateRelationInput,
  CreateFileRefInput,
  CreateViewInput,
  UpdateViewInput,
} from '@marlinjai/data-table-core';
import { getCmsAdapter } from './adapterClient';
import { requireAdminAction } from '@/server/auth/adminAction';
import type { CmsStatusField } from '@/lib/cms/constants';

// --- Tables ---

export async function createTable(input: CreateTableInput): Promise<Table> {
  await requireAdminAction();
  return getCmsAdapter().createTable(input);
}

export async function getTable(tableId: string): Promise<Table | null> {
  return getCmsAdapter().getTable(tableId);
}

export async function updateTable(tableId: string, updates: UpdateTableInput): Promise<Table> {
  await requireAdminAction();
  return getCmsAdapter().updateTable(tableId, updates);
}

export async function deleteTable(tableId: string): Promise<void> {
  await requireAdminAction();
  return getCmsAdapter().deleteTable(tableId);
}

export async function listTables(workspaceId: string): Promise<Table[]> {
  return getCmsAdapter().listTables(workspaceId);
}

// --- Columns ---

export async function createColumn(input: CreateColumnInput): Promise<Column> {
  await requireAdminAction();
  return getCmsAdapter().createColumn(input);
}

export async function getColumns(tableId: string): Promise<Column[]> {
  return getCmsAdapter().getColumns(tableId);
}

export async function getColumn(columnId: string): Promise<Column | null> {
  return getCmsAdapter().getColumn(columnId);
}

export async function updateColumn(columnId: string, updates: UpdateColumnInput): Promise<Column> {
  await requireAdminAction();
  return getCmsAdapter().updateColumn(columnId, updates);
}

export async function deleteColumn(columnId: string): Promise<void> {
  await requireAdminAction();
  return getCmsAdapter().deleteColumn(columnId);
}

export async function reorderColumns(tableId: string, columnIds: string[]): Promise<void> {
  await requireAdminAction();
  return getCmsAdapter().reorderColumns(tableId, columnIds);
}

// --- Select options ---

export async function createSelectOption(input: CreateSelectOptionInput): Promise<SelectOption> {
  await requireAdminAction();
  return getCmsAdapter().createSelectOption(input);
}

export async function getSelectOptions(columnId: string): Promise<SelectOption[]> {
  return getCmsAdapter().getSelectOptions(columnId);
}

export async function updateSelectOption(
  optionId: string,
  updates: UpdateSelectOptionInput,
): Promise<SelectOption> {
  await requireAdminAction();
  return getCmsAdapter().updateSelectOption(optionId, updates);
}

export async function deleteSelectOption(optionId: string): Promise<void> {
  await requireAdminAction();
  return getCmsAdapter().deleteSelectOption(optionId);
}

export async function reorderSelectOptions(columnId: string, optionIds: string[]): Promise<void> {
  await requireAdminAction();
  return getCmsAdapter().reorderSelectOptions(columnId, optionIds);
}

// --- Rows ---

export async function createRow(input: CreateRowInput): Promise<Row> {
  await requireAdminAction();
  return getCmsAdapter().createRow(input);
}

export async function getRow(rowId: string): Promise<Row | null> {
  return getCmsAdapter().getRow(rowId);
}

export async function getRows(tableId: string, query?: QueryOptions): Promise<QueryResult<Row>> {
  return getCmsAdapter().getRows(tableId, query);
}

export async function updateRow(rowId: string, cells: Record<string, CellValue>): Promise<Row> {
  await requireAdminAction();
  return getCmsAdapter().updateRow(rowId, cells);
}

export async function deleteRow(rowId: string): Promise<void> {
  await requireAdminAction();
  return getCmsAdapter().deleteRow(rowId);
}

export async function archiveRow(rowId: string): Promise<void> {
  await requireAdminAction();
  return getCmsAdapter().archiveRow(rowId);
}

export async function unarchiveRow(rowId: string): Promise<void> {
  await requireAdminAction();
  return getCmsAdapter().unarchiveRow(rowId);
}

export async function bulkCreateRows(inputs: CreateRowInput[]): Promise<Row[]> {
  await requireAdminAction();
  return getCmsAdapter().bulkCreateRows(inputs);
}

export async function bulkDeleteRows(rowIds: string[]): Promise<void> {
  await requireAdminAction();
  return getCmsAdapter().bulkDeleteRows(rowIds);
}

export async function bulkArchiveRows(rowIds: string[]): Promise<void> {
  await requireAdminAction();
  return getCmsAdapter().bulkArchiveRows(rowIds);
}

// --- Relations ---

export async function createRelation(input: CreateRelationInput): Promise<void> {
  await requireAdminAction();
  return getCmsAdapter().createRelation(input);
}

export async function deleteRelation(
  sourceRowId: string,
  columnId: string,
  targetRowId: string,
): Promise<void> {
  await requireAdminAction();
  return getCmsAdapter().deleteRelation(sourceRowId, columnId, targetRowId);
}

export async function getRelatedRows(rowId: string, columnId: string): Promise<Row[]> {
  return getCmsAdapter().getRelatedRows(rowId, columnId);
}

export async function getRelationsForRow(
  rowId: string,
): Promise<Array<{ columnId: string; targetRowId: string }>> {
  return getCmsAdapter().getRelationsForRow(rowId);
}

// --- File references ---

export async function addFileReference(input: CreateFileRefInput): Promise<FileReference> {
  await requireAdminAction();
  return getCmsAdapter().addFileReference(input);
}

export async function removeFileReference(fileRefId: string): Promise<void> {
  await requireAdminAction();
  return getCmsAdapter().removeFileReference(fileRefId);
}

export async function getFileReferences(rowId: string, columnId: string): Promise<FileReference[]> {
  return getCmsAdapter().getFileReferences(rowId, columnId);
}

export async function reorderFileReferences(
  rowId: string,
  columnId: string,
  fileRefIds: string[],
): Promise<void> {
  await requireAdminAction();
  return getCmsAdapter().reorderFileReferences(rowId, columnId, fileRefIds);
}

// --- Views ---

export async function createView(input: CreateViewInput): Promise<View> {
  await requireAdminAction();
  return getCmsAdapter().createView(input);
}

export async function getViews(tableId: string): Promise<View[]> {
  return getCmsAdapter().getViews(tableId);
}

export async function getView(viewId: string): Promise<View | null> {
  return getCmsAdapter().getView(viewId);
}

export async function updateView(viewId: string, updates: UpdateViewInput): Promise<View> {
  await requireAdminAction();
  return getCmsAdapter().updateView(viewId, updates);
}

export async function deleteView(viewId: string): Promise<void> {
  await requireAdminAction();
  return getCmsAdapter().deleteView(viewId);
}

export async function reorderViews(tableId: string, viewIds: string[]): Promise<void> {
  await requireAdminAction();
  return getCmsAdapter().reorderViews(tableId, viewIds);
}

// --- CMS publish state (reserved "Status" field) ---

// The reserved status field name + its option colors. Colors are keys of the
// data-table engine's fixed 9-name tag palette (NOT hex), so they render with
// the engine's own --dt-tag-* tokens. Module-level const (not exported: a
// 'use server' file may only export async functions).
const STATUS_FIELD_NAME = 'Status';
const STATUS_OPTIONS = [
  { key: 'draft', name: 'Draft', color: 'orange' },
  { key: 'published', name: 'Published', color: 'green' },
  { key: 'scheduled', name: 'Scheduled', color: 'blue' },
] as const;

/**
 * Idempotently ensure a collection has the reserved "Status" select field with
 * Draft / Published / Scheduled options, returning the column + option ids so the
 * grid can default new items to Draft. Admin-guarded (it may create a column);
 * safe to call on every grid open (a no-op once the field exists).
 */
export async function ensureStatusField(tableId: string): Promise<CmsStatusField> {
  await requireAdminAction();
  const adapter = getCmsAdapter();

  const columns = await adapter.getColumns(tableId);
  let statusColumn = columns.find(
    (c) => c.type === 'select' && c.name.trim().toLowerCase() === STATUS_FIELD_NAME.toLowerCase(),
  );
  if (!statusColumn) {
    statusColumn = await adapter.createColumn({
      tableId,
      name: STATUS_FIELD_NAME,
      type: 'select',
    });
  }

  const existing = await adapter.getSelectOptions(statusColumn.id);
  const ids: Record<string, string> = {};
  for (const opt of STATUS_OPTIONS) {
    const found = existing.find((o) => o.name.trim().toLowerCase() === opt.name.toLowerCase());
    ids[opt.key] = found
      ? found.id
      : (
          await adapter.createSelectOption({
            columnId: statusColumn.id,
            name: opt.name,
            color: opt.color,
          })
        ).id;
  }

  return {
    columnId: statusColumn.id,
    options: { draft: ids.draft, published: ids.published, scheduled: ids.scheduled },
  };
}
