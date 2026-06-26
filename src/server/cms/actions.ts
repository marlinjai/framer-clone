'use server';

// src/server/cms/actions.ts
//
// The server-action surface of the full data-table `DatabaseAdapter` (40 of its
// 41 methods; `transaction` is implemented client-side in the
// cmsServerActionsAdapter, exactly as the receipt-OCR reference does). Every
// action delegates to the single CMS `PrismaAdapter` via getCmsAdapter().
//
// This is the editor grid's WRITE path. It mirrors receipt-OCR's
// server-actions-adapter pattern but adds a TWO-layer authorization gate the
// receipt app does not need:
//   1. requireWorkspaceScope('editSite') proves the caller is an admin of some
//      workspace and yields that workspace's TenantScope, derived ENTIRELY from
//      the SERVER-verified auth-brain session (next/headers cookie -> verify ->
//      active workspace) — never the client. No interim secret, no fallback to a
//      constant workspace.
//   2. the workspaceGuard asserts the ENTITY being mutated belongs to
//      scope.workspaceId. The data-table adapter is keyed purely by entity id
//      and performs no workspace check, so without this a workspace-A admin who
//      knows a workspace-B id could mutate it. createTable instead STAMPS the new
//      collection with scope.workspaceId (nothing to own yet).
// Physical per-tenant schema isolation (so this check becomes a search_path
// instead of an app-layer resolve) is MT-18; the CMS engine is single-schema in
// Phase 2, so the ownership resolve is the only correct isolation today.
//
// Read actions stay unauthenticated, matching the public read-route policy. The
// panel never touches MST; this path adds no new HTTP routes.

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
import { requireWorkspaceScope } from '@/server/auth/requireWorkspaceScope';
import {
  assertTableInWorkspace,
  assertColumnInWorkspace,
  assertRowInWorkspace,
  assertRowsInWorkspace,
  assertViewInWorkspace,
  assertSelectOptionInWorkspace,
  assertFileReferenceInWorkspace,
} from './workspaceGuard';
import type { CmsStatusField } from '@/lib/cms/constants';

// Distinct table ids from a batch of row-create inputs, so bulkCreateRows
// asserts each target table once rather than per row.
function distinctTableIds(inputs: CreateRowInput[]): string[] {
  return [...new Set(inputs.map((i) => i.tableId))];
}

// --- Tables ---

export async function createTable(input: CreateTableInput): Promise<Table> {
  const scope = await requireWorkspaceScope('editSite');
  // The new collection lands in the SESSION's active workspace, never a client-
  // supplied or constant workspace id. Nothing exists yet to own-check.
  return getCmsAdapter().createTable({ ...input, workspaceId: scope.workspaceId });
}

export async function getTable(tableId: string): Promise<Table | null> {
  return getCmsAdapter().getTable(tableId);
}

export async function updateTable(tableId: string, updates: UpdateTableInput): Promise<Table> {
  const scope = await requireWorkspaceScope('editSite');
  await assertTableInWorkspace(tableId, scope.workspaceId);
  return getCmsAdapter().updateTable(tableId, updates);
}

export async function deleteTable(tableId: string): Promise<void> {
  const scope = await requireWorkspaceScope('editSite');
  await assertTableInWorkspace(tableId, scope.workspaceId);
  return getCmsAdapter().deleteTable(tableId);
}

export async function listTables(workspaceId: string): Promise<Table[]> {
  return getCmsAdapter().listTables(workspaceId);
}

// --- Columns ---

export async function createColumn(input: CreateColumnInput): Promise<Column> {
  const scope = await requireWorkspaceScope('editSite');
  await assertTableInWorkspace(input.tableId, scope.workspaceId);
  return getCmsAdapter().createColumn(input);
}

export async function getColumns(tableId: string): Promise<Column[]> {
  return getCmsAdapter().getColumns(tableId);
}

export async function getColumn(columnId: string): Promise<Column | null> {
  return getCmsAdapter().getColumn(columnId);
}

export async function updateColumn(columnId: string, updates: UpdateColumnInput): Promise<Column> {
  const scope = await requireWorkspaceScope('editSite');
  await assertColumnInWorkspace(columnId, scope.workspaceId);
  return getCmsAdapter().updateColumn(columnId, updates);
}

export async function deleteColumn(columnId: string): Promise<void> {
  const scope = await requireWorkspaceScope('editSite');
  await assertColumnInWorkspace(columnId, scope.workspaceId);
  return getCmsAdapter().deleteColumn(columnId);
}

export async function reorderColumns(tableId: string, columnIds: string[]): Promise<void> {
  const scope = await requireWorkspaceScope('editSite');
  await assertTableInWorkspace(tableId, scope.workspaceId);
  return getCmsAdapter().reorderColumns(tableId, columnIds);
}

// --- Select options ---

export async function createSelectOption(input: CreateSelectOptionInput): Promise<SelectOption> {
  const scope = await requireWorkspaceScope('editSite');
  await assertColumnInWorkspace(input.columnId, scope.workspaceId);
  return getCmsAdapter().createSelectOption(input);
}

export async function getSelectOptions(columnId: string): Promise<SelectOption[]> {
  return getCmsAdapter().getSelectOptions(columnId);
}

export async function updateSelectOption(
  optionId: string,
  updates: UpdateSelectOptionInput,
): Promise<SelectOption> {
  const scope = await requireWorkspaceScope('editSite');
  await assertSelectOptionInWorkspace(optionId, scope.workspaceId);
  return getCmsAdapter().updateSelectOption(optionId, updates);
}

export async function deleteSelectOption(optionId: string): Promise<void> {
  const scope = await requireWorkspaceScope('editSite');
  await assertSelectOptionInWorkspace(optionId, scope.workspaceId);
  return getCmsAdapter().deleteSelectOption(optionId);
}

export async function reorderSelectOptions(columnId: string, optionIds: string[]): Promise<void> {
  const scope = await requireWorkspaceScope('editSite');
  await assertColumnInWorkspace(columnId, scope.workspaceId);
  return getCmsAdapter().reorderSelectOptions(columnId, optionIds);
}

// --- Rows ---

export async function createRow(input: CreateRowInput): Promise<Row> {
  const scope = await requireWorkspaceScope('editSite');
  await assertTableInWorkspace(input.tableId, scope.workspaceId);
  return getCmsAdapter().createRow(input);
}

export async function getRow(rowId: string): Promise<Row | null> {
  return getCmsAdapter().getRow(rowId);
}

export async function getRows(tableId: string, query?: QueryOptions): Promise<QueryResult<Row>> {
  return getCmsAdapter().getRows(tableId, query);
}

export async function updateRow(rowId: string, cells: Record<string, CellValue>): Promise<Row> {
  const scope = await requireWorkspaceScope('editSite');
  await assertRowInWorkspace(rowId, scope.workspaceId);
  return getCmsAdapter().updateRow(rowId, cells);
}

export async function deleteRow(rowId: string): Promise<void> {
  const scope = await requireWorkspaceScope('editSite');
  await assertRowInWorkspace(rowId, scope.workspaceId);
  return getCmsAdapter().deleteRow(rowId);
}

export async function archiveRow(rowId: string): Promise<void> {
  const scope = await requireWorkspaceScope('editSite');
  await assertRowInWorkspace(rowId, scope.workspaceId);
  return getCmsAdapter().archiveRow(rowId);
}

export async function unarchiveRow(rowId: string): Promise<void> {
  const scope = await requireWorkspaceScope('editSite');
  await assertRowInWorkspace(rowId, scope.workspaceId);
  return getCmsAdapter().unarchiveRow(rowId);
}

export async function bulkCreateRows(inputs: CreateRowInput[]): Promise<Row[]> {
  const scope = await requireWorkspaceScope('editSite');
  await Promise.all(
    distinctTableIds(inputs).map((id) => assertTableInWorkspace(id, scope.workspaceId)),
  );
  return getCmsAdapter().bulkCreateRows(inputs);
}

export async function bulkDeleteRows(rowIds: string[]): Promise<void> {
  const scope = await requireWorkspaceScope('editSite');
  await assertRowsInWorkspace(rowIds, scope.workspaceId);
  return getCmsAdapter().bulkDeleteRows(rowIds);
}

export async function bulkArchiveRows(rowIds: string[]): Promise<void> {
  const scope = await requireWorkspaceScope('editSite');
  await assertRowsInWorkspace(rowIds, scope.workspaceId);
  return getCmsAdapter().bulkArchiveRows(rowIds);
}

// --- Relations ---

export async function createRelation(input: CreateRelationInput): Promise<void> {
  const scope = await requireWorkspaceScope('editSite');
  // Both endpoints must live in the active workspace, so a relation can never
  // bridge across the isolation boundary.
  await assertRowsInWorkspace([input.sourceRowId, input.targetRowId], scope.workspaceId);
  return getCmsAdapter().createRelation(input);
}

export async function deleteRelation(
  sourceRowId: string,
  columnId: string,
  targetRowId: string,
): Promise<void> {
  const scope = await requireWorkspaceScope('editSite');
  await assertRowsInWorkspace([sourceRowId, targetRowId], scope.workspaceId);
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
  const scope = await requireWorkspaceScope('editSite');
  await assertRowInWorkspace(input.rowId, scope.workspaceId);
  return getCmsAdapter().addFileReference(input);
}

export async function removeFileReference(fileRefId: string): Promise<void> {
  const scope = await requireWorkspaceScope('editSite');
  await assertFileReferenceInWorkspace(fileRefId, scope.workspaceId);
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
  const scope = await requireWorkspaceScope('editSite');
  await assertRowInWorkspace(rowId, scope.workspaceId);
  return getCmsAdapter().reorderFileReferences(rowId, columnId, fileRefIds);
}

// --- Views ---

export async function createView(input: CreateViewInput): Promise<View> {
  const scope = await requireWorkspaceScope('editSite');
  await assertTableInWorkspace(input.tableId, scope.workspaceId);
  return getCmsAdapter().createView(input);
}

export async function getViews(tableId: string): Promise<View[]> {
  return getCmsAdapter().getViews(tableId);
}

export async function getView(viewId: string): Promise<View | null> {
  return getCmsAdapter().getView(viewId);
}

export async function updateView(viewId: string, updates: UpdateViewInput): Promise<View> {
  const scope = await requireWorkspaceScope('editSite');
  await assertViewInWorkspace(viewId, scope.workspaceId);
  return getCmsAdapter().updateView(viewId, updates);
}

export async function deleteView(viewId: string): Promise<void> {
  const scope = await requireWorkspaceScope('editSite');
  await assertViewInWorkspace(viewId, scope.workspaceId);
  return getCmsAdapter().deleteView(viewId);
}

export async function reorderViews(tableId: string, viewIds: string[]): Promise<void> {
  const scope = await requireWorkspaceScope('editSite');
  await assertTableInWorkspace(tableId, scope.workspaceId);
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
 * grid can default new items to Draft. Admin-guarded AND workspace-owned (it may
 * create a column on `tableId`); safe to call on every grid open (a no-op once
 * the field exists).
 */
export async function ensureStatusField(tableId: string): Promise<CmsStatusField> {
  const scope = await requireWorkspaceScope('editSite');
  await assertTableInWorkspace(tableId, scope.workspaceId);
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
