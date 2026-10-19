'use server';

// src/server/cms/actions.ts
//
// The server-action surface of the full data-table `DatabaseAdapter` (40 of its
// 41 methods; `transaction` is implemented client-side in the
// cmsServerActionsAdapter, exactly as the receipt-OCR reference does). Every
// action delegates to the single CMS `PrismaAdapter` via getCmsAdapter().
//
// This is the editor grid's READ and WRITE path. It mirrors receipt-OCR's
// server-actions-adapter pattern but adds a TWO-layer authorization gate the
// receipt app does not need:
//   1. requireCmsEditorScope (src/server/cms/editorScope.ts) refuses every
//      action off the EDITOR host (a server action dispatches on any host, and a
//      published site's script must never act with its visitor's apex session,
//      decision D2), then requireWorkspaceScope proves the caller holds the
//      action's permission ('editSite' for writes, 'viewSite' for reads) on the
//      active workspace and yields that workspace's TenantScope, derived
//      ENTIRELY from the SERVER-verified auth-brain session (next/headers cookie
//      -> verify -> active workspace), never the client. No interim secret, no
//      fallback to a constant workspace.
//   2. the workspaceGuard asserts the ENTITY being mutated belongs to
//      scope.workspaceId; a READ resolves the same ownership and answers the
//      not-found shape (null, [] or an empty page) for an entity of another
//      workspace, exactly as for a missing one, so existence never leaks. The data-table adapter is keyed purely by entity id
//      and performs no workspace check, so without this a workspace-A admin who
//      knows a workspace-B id could mutate it. createTable instead STAMPS the new
//      collection with scope.workspaceId (nothing to own yet).
// Physical per-tenant schema isolation (so this check becomes a search_path
// instead of an app-layer resolve) is MT-18; the CMS engine is single-schema in
// Phase 2, so the ownership resolve is the only correct isolation today.
//
// Every guarded action returns a CmsActionResult (src/lib/cms/actionResult.ts):
// an auth or permission failure is `{ ok: false, code, message }` instead of a
// throw, so the grid can show a readable message in production (where Next.js
// strips thrown server-action messages); unexpected errors still throw.
//
// Read actions are guarded the same way (they used to be unauthenticated, so any
// host could read any workspace's collections by id, reviewer finding of
// 2026-10-19). The panel never touches MST; this path adds no new HTTP routes.

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
import { requireCmsEditorScope } from './editorScope';
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
import type { CmsActionErrorCode, CmsActionResult } from '@/lib/cms/actionResult';
import { cmsActionErrorMessage } from '@/lib/cms/actionResult';
import { AuthError } from '@/server/auth/requireWorkspaceScope';

// Run a guarded action body and return its result. An AuthError (no session,
// no active workspace, a denied permission, an entity outside the workspace,
// auth-brain or OpenFGA unable to answer) is an EXPECTED failure and comes back
// as `{ ok: false, code, message }`, because production Next.js would replace a
// thrown message with an opaque digest and the grid could not tell an outage
// from a deny. Anything else (a database failure, a bug) still throws.
// Not exported: a 'use server' file may only export async actions.
async function guarded<T>(body: () => Promise<T>): Promise<CmsActionResult<T>> {
  try {
    return { ok: true, value: await body() };
  } catch (err) {
    if (err instanceof AuthError) {
      const code: CmsActionErrorCode = err.code;
      return { ok: false, code, message: cmsActionErrorMessage(code) };
    }
    throw err;
  }
}

// --- Read-side ownership (foreign == missing) ---
//
// The data-table adapter reads purely by id, with no workspace check. These
// resolve an entity up to its owning table's workspace and treat one outside
// the bound workspace exactly like one that does not exist.

const EMPTY_PAGE: QueryResult<Row> = { items: [], total: 0, hasMore: false };

async function tableIsOwned(tableId: string, workspaceId: string): Promise<boolean> {
  const table = await getCmsAdapter().getTable(tableId);
  return table?.workspaceId === workspaceId;
}

async function ownedRow(rowId: string, workspaceId: string): Promise<Row | null> {
  const row = await getCmsAdapter().getRow(rowId);
  return row && (await tableIsOwned(row.tableId, workspaceId)) ? row : null;
}

async function ownedColumn(columnId: string, workspaceId: string): Promise<Column | null> {
  const column = await getCmsAdapter().getColumn(columnId);
  return column && (await tableIsOwned(column.tableId, workspaceId)) ? column : null;
}

// Distinct table ids from a batch of row-create inputs, so bulkCreateRows
// asserts each target table once rather than per row.
function distinctTableIds(inputs: CreateRowInput[]): string[] {
  return [...new Set(inputs.map((i) => i.tableId))];
}

// --- Tables ---

export async function createTable(input: CreateTableInput): Promise<CmsActionResult<Table>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    // The new collection lands in the request's active workspace, never a client-
    // supplied or constant workspace id. Nothing exists yet to own-check.
    return getCmsAdapter().createTable({ ...input, workspaceId: scope.workspaceId });
  });
}

export async function getTable(tableId: string): Promise<CmsActionResult<Table | null>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('viewSite');
    const table = await getCmsAdapter().getTable(tableId);
    return table?.workspaceId === scope.workspaceId ? table : null;
  });
}

export async function updateTable(tableId: string, updates: UpdateTableInput): Promise<CmsActionResult<Table>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertTableInWorkspace(tableId, scope.workspaceId);
    return getCmsAdapter().updateTable(tableId, updates);
  });
}

export async function deleteTable(tableId: string): Promise<CmsActionResult<void>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertTableInWorkspace(tableId, scope.workspaceId);
    return getCmsAdapter().deleteTable(tableId);
  });
}

// The client-sent workspace id is IGNORED: the list is always the request's
// active workspace (the grid passes a constant id it does not control).
export async function listTables(_workspaceId: string): Promise<CmsActionResult<Table[]>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('viewSite');
    return getCmsAdapter().listTables(scope.workspaceId);
  });
}

// --- Columns ---

export async function createColumn(input: CreateColumnInput): Promise<CmsActionResult<Column>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertTableInWorkspace(input.tableId, scope.workspaceId);
    return getCmsAdapter().createColumn(input);
  });
}

export async function getColumns(tableId: string): Promise<CmsActionResult<Column[]>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('viewSite');
    if (!(await tableIsOwned(tableId, scope.workspaceId))) return [];
    return getCmsAdapter().getColumns(tableId);
  });
}

export async function getColumn(columnId: string): Promise<CmsActionResult<Column | null>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('viewSite');
    return ownedColumn(columnId, scope.workspaceId);
  });
}

export async function updateColumn(columnId: string, updates: UpdateColumnInput): Promise<CmsActionResult<Column>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertColumnInWorkspace(columnId, scope.workspaceId);
    return getCmsAdapter().updateColumn(columnId, updates);
  });
}

export async function deleteColumn(columnId: string): Promise<CmsActionResult<void>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertColumnInWorkspace(columnId, scope.workspaceId);
    return getCmsAdapter().deleteColumn(columnId);
  });
}

export async function reorderColumns(tableId: string, columnIds: string[]): Promise<CmsActionResult<void>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertTableInWorkspace(tableId, scope.workspaceId);
    return getCmsAdapter().reorderColumns(tableId, columnIds);
  });
}

// --- Select options ---

export async function createSelectOption(input: CreateSelectOptionInput): Promise<CmsActionResult<SelectOption>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertColumnInWorkspace(input.columnId, scope.workspaceId);
    return getCmsAdapter().createSelectOption(input);
  });
}

export async function getSelectOptions(columnId: string): Promise<CmsActionResult<SelectOption[]>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('viewSite');
    if (!(await ownedColumn(columnId, scope.workspaceId))) return [];
    return getCmsAdapter().getSelectOptions(columnId);
  });
}

export async function updateSelectOption(
  optionId: string,
  updates: UpdateSelectOptionInput,
): Promise<CmsActionResult<SelectOption>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertSelectOptionInWorkspace(optionId, scope.workspaceId);
    return getCmsAdapter().updateSelectOption(optionId, updates);
  });
}

export async function deleteSelectOption(optionId: string): Promise<CmsActionResult<void>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertSelectOptionInWorkspace(optionId, scope.workspaceId);
    return getCmsAdapter().deleteSelectOption(optionId);
  });
}

export async function reorderSelectOptions(columnId: string, optionIds: string[]): Promise<CmsActionResult<void>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertColumnInWorkspace(columnId, scope.workspaceId);
    return getCmsAdapter().reorderSelectOptions(columnId, optionIds);
  });
}

// --- Rows ---

export async function createRow(input: CreateRowInput): Promise<CmsActionResult<Row>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertTableInWorkspace(input.tableId, scope.workspaceId);
    return getCmsAdapter().createRow(input);
  });
}

export async function getRow(rowId: string): Promise<CmsActionResult<Row | null>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('viewSite');
    return ownedRow(rowId, scope.workspaceId);
  });
}

export async function getRows(
  tableId: string,
  query?: QueryOptions,
): Promise<CmsActionResult<QueryResult<Row>>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('viewSite');
    if (!(await tableIsOwned(tableId, scope.workspaceId))) return EMPTY_PAGE;
    return getCmsAdapter().getRows(tableId, query);
  });
}

export async function updateRow(rowId: string, cells: Record<string, CellValue>): Promise<CmsActionResult<Row>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertRowInWorkspace(rowId, scope.workspaceId);
    return getCmsAdapter().updateRow(rowId, cells);
  });
}

export async function deleteRow(rowId: string): Promise<CmsActionResult<void>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertRowInWorkspace(rowId, scope.workspaceId);
    return getCmsAdapter().deleteRow(rowId);
  });
}

export async function archiveRow(rowId: string): Promise<CmsActionResult<void>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertRowInWorkspace(rowId, scope.workspaceId);
    return getCmsAdapter().archiveRow(rowId);
  });
}

export async function unarchiveRow(rowId: string): Promise<CmsActionResult<void>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertRowInWorkspace(rowId, scope.workspaceId);
    return getCmsAdapter().unarchiveRow(rowId);
  });
}

export async function bulkCreateRows(inputs: CreateRowInput[]): Promise<CmsActionResult<Row[]>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await Promise.all(
      distinctTableIds(inputs).map((id) => assertTableInWorkspace(id, scope.workspaceId)),
    );
    return getCmsAdapter().bulkCreateRows(inputs);
  });
}

export async function bulkDeleteRows(rowIds: string[]): Promise<CmsActionResult<void>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertRowsInWorkspace(rowIds, scope.workspaceId);
    return getCmsAdapter().bulkDeleteRows(rowIds);
  });
}

export async function bulkArchiveRows(rowIds: string[]): Promise<CmsActionResult<void>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertRowsInWorkspace(rowIds, scope.workspaceId);
    return getCmsAdapter().bulkArchiveRows(rowIds);
  });
}

// --- Relations ---

export async function createRelation(input: CreateRelationInput): Promise<CmsActionResult<void>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    // Both endpoints must live in the active workspace, so a relation can never
    // bridge across the isolation boundary.
    await assertRowsInWorkspace([input.sourceRowId, input.targetRowId], scope.workspaceId);
    return getCmsAdapter().createRelation(input);
  });
}

export async function deleteRelation(
  sourceRowId: string,
  columnId: string,
  targetRowId: string,
): Promise<CmsActionResult<void>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertRowsInWorkspace([sourceRowId, targetRowId], scope.workspaceId);
    return getCmsAdapter().deleteRelation(sourceRowId, columnId, targetRowId);
  });
}

export async function getRelatedRows(
  rowId: string,
  columnId: string,
): Promise<CmsActionResult<Row[]>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('viewSite');
    if (!(await ownedRow(rowId, scope.workspaceId))) return [];
    const related = await getCmsAdapter().getRelatedRows(rowId, columnId);
    // createRelation keeps both ends in one workspace, but a target row is only
    // returned after its own table is checked too (one lookup per distinct table).
    const owned = new Map<string, boolean>();
    for (const tableId of new Set(related.map((r) => r.tableId))) {
      owned.set(tableId, await tableIsOwned(tableId, scope.workspaceId));
    }
    return related.filter((r) => owned.get(r.tableId) === true);
  });
}

export async function getRelationsForRow(
  rowId: string,
): Promise<CmsActionResult<Array<{ columnId: string; targetRowId: string }>>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('viewSite');
    if (!(await ownedRow(rowId, scope.workspaceId))) return [];
    return getCmsAdapter().getRelationsForRow(rowId);
  });
}

// --- File references ---

export async function addFileReference(input: CreateFileRefInput): Promise<CmsActionResult<FileReference>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertRowInWorkspace(input.rowId, scope.workspaceId);
    return getCmsAdapter().addFileReference(input);
  });
}

export async function removeFileReference(fileRefId: string): Promise<CmsActionResult<void>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertFileReferenceInWorkspace(fileRefId, scope.workspaceId);
    return getCmsAdapter().removeFileReference(fileRefId);
  });
}

export async function getFileReferences(
  rowId: string,
  columnId: string,
): Promise<CmsActionResult<FileReference[]>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('viewSite');
    if (!(await ownedRow(rowId, scope.workspaceId))) return [];
    return getCmsAdapter().getFileReferences(rowId, columnId);
  });
}

export async function reorderFileReferences(
  rowId: string,
  columnId: string,
  fileRefIds: string[],
): Promise<CmsActionResult<void>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertRowInWorkspace(rowId, scope.workspaceId);
    return getCmsAdapter().reorderFileReferences(rowId, columnId, fileRefIds);
  });
}

// --- Views ---

export async function createView(input: CreateViewInput): Promise<CmsActionResult<View>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertTableInWorkspace(input.tableId, scope.workspaceId);
    return getCmsAdapter().createView(input);
  });
}

export async function getViews(tableId: string): Promise<CmsActionResult<View[]>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('viewSite');
    if (!(await tableIsOwned(tableId, scope.workspaceId))) return [];
    return getCmsAdapter().getViews(tableId);
  });
}

export async function getView(viewId: string): Promise<CmsActionResult<View | null>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('viewSite');
    const view = await getCmsAdapter().getView(viewId);
    return view && (await tableIsOwned(view.tableId, scope.workspaceId)) ? view : null;
  });
}

export async function updateView(viewId: string, updates: UpdateViewInput): Promise<CmsActionResult<View>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertViewInWorkspace(viewId, scope.workspaceId);
    return getCmsAdapter().updateView(viewId, updates);
  });
}

export async function deleteView(viewId: string): Promise<CmsActionResult<void>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertViewInWorkspace(viewId, scope.workspaceId);
    return getCmsAdapter().deleteView(viewId);
  });
}

export async function reorderViews(tableId: string, viewIds: string[]): Promise<CmsActionResult<void>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
    await assertTableInWorkspace(tableId, scope.workspaceId);
    return getCmsAdapter().reorderViews(tableId, viewIds);
  });
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
export async function ensureStatusField(tableId: string): Promise<CmsActionResult<CmsStatusField>> {
  return guarded(async () => {
    const scope = await requireCmsEditorScope('editSite');
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
  });
}
