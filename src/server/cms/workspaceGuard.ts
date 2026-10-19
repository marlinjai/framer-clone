import 'server-only';

// src/server/cms/workspaceGuard.ts
//
// The data-layer workspace-isolation guard for the CMS editor grid's server
// actions (src/server/cms/actions.ts). The auth gate (requireWorkspaceScope)
// proves the caller is an admin of SOME workspace; this proves the ENTITY being
// mutated belongs to THAT workspace. Without it, a workspace-A admin who knows a
// workspace-B row/column/table id could mutate it — the data-table adapter is
// keyed purely by entity id and performs no workspace check of its own.
//
// Why an app-layer ownership check and not a scoped adapter / SET LOCAL: the CMS
// engine is single-schema in Phase 2 (CMS_SCHEMA = 'public'); every workspace's
// rows live in the SAME tables, distinguished only by the `DtTable.workspace_id`
// column. So there is no search_path to set and the adapter exposes no
// workspace-scoped mutation; the only correct isolation today is to resolve each
// entity up to its owning table's workspace_id and reject a mismatch. Physical
// per-tenant schema isolation is MT-18.
//
// Resolution uses the ADAPTER's reads (the storage source of truth) for
// table/column/row/view — notably for rows, so this never has to guess between
// the legacy `dt_rows` model and the migrated representation. The two entities
// the adapter cannot look up by id (a select option, a file reference) are
// resolved by a single scalar-FK read of their stable owning id, then handed
// back to the adapter-based table resolver.
//
// Fail-closed: a missing entity OR a workspace mismatch both throw AuthError 403.
// An entity that does not exist is indistinguishable from one in another
// workspace, and both are a deny — we never leak existence across the boundary.

import { getPrismaClient } from '@/server/db';
import { getCmsAdapter } from './adapterClient';
import { AuthError } from '@/server/auth/requireWorkspaceScope';

function denyCrossWorkspace(): never {
  // Same 403 shape the auth gate uses; the message never names the foreign
  // workspace or whether the entity exists.
  throw new AuthError(403, 'entity is not in the active workspace');
}

/** The owning workspace of a table, or null when the table does not exist. */
async function tableWorkspaceId(tableId: string): Promise<string | null> {
  const table = await getCmsAdapter().getTable(tableId);
  return table?.workspaceId ?? null;
}

export async function assertTableInWorkspace(
  tableId: string,
  workspaceId: string,
): Promise<void> {
  if ((await tableWorkspaceId(tableId)) !== workspaceId) denyCrossWorkspace();
}

export async function assertColumnInWorkspace(
  columnId: string,
  workspaceId: string,
): Promise<void> {
  const column = await getCmsAdapter().getColumn(columnId);
  if (!column) denyCrossWorkspace();
  await assertTableInWorkspace(column.tableId, workspaceId);
}

export async function assertRowInWorkspace(
  rowId: string,
  workspaceId: string,
): Promise<void> {
  const row = await getCmsAdapter().getRow(rowId);
  if (!row) denyCrossWorkspace();
  await assertTableInWorkspace(row.tableId, workspaceId);
}

/** Assert every row id belongs to the workspace (bulk row mutations). */
export async function assertRowsInWorkspace(
  rowIds: string[],
  workspaceId: string,
): Promise<void> {
  await Promise.all(rowIds.map((id) => assertRowInWorkspace(id, workspaceId)));
}

export async function assertViewInWorkspace(
  viewId: string,
  workspaceId: string,
): Promise<void> {
  const view = await getCmsAdapter().getView(viewId);
  if (!view) denyCrossWorkspace();
  await assertTableInWorkspace(view.tableId, workspaceId);
}

export async function assertSelectOptionInWorkspace(
  optionId: string,
  workspaceId: string,
): Promise<void> {
  // The adapter has no getSelectOption(id); resolve the owning column via a
  // single scalar-FK read of the stable select_options row.
  const option = await getPrismaClient().selectOption.findUnique({
    where: { id: optionId },
    select: { columnId: true },
  });
  if (!option) denyCrossWorkspace();
  await assertColumnInWorkspace(option.columnId, workspaceId);
}

export async function assertFileReferenceInWorkspace(
  fileRefId: string,
  workspaceId: string,
): Promise<void> {
  // The adapter has no getFileReference(id); resolve the owning row via a single
  // scalar-FK read of the stable dt_files row.
  const file = await getPrismaClient().dtFile.findUnique({
    where: { id: fileRefId },
    select: { rowId: true },
  });
  if (!file) denyCrossWorkspace();
  await assertRowInWorkspace(file.rowId, workspaceId);
}

// =============================================================================
// Stored-id ownership: ids a write persists INSIDE an owned entity
// =============================================================================
//
// Owning the entity being written is not enough: a write also stores ids that
// point at OTHER entities (a parent row, a select option, a relation's column
// and target row, the children of a reorder). The adapter persists those ids
// verbatim, so each must be checked to belong where it is being stored, or a
// workspace-A editor could link, reorder or tag with workspace-B entities. The
// same fail-closed deny applies: a foreign id and a missing id both refuse the
// WHOLE call, before anything is written.

function denyForeignReference(): never {
  throw new AuthError(403, 'a referenced id does not belong here');
}

/**
 * Refuse unless every id in `ids` is one of `allowed` (a reorder may only name
 * the parent's own children; a foreign or unknown id refuses the whole call).
 */
export function assertIdsAmong(ids: readonly string[], allowed: readonly string[]): void {
  const own = new Set(allowed);
  for (const id of ids) {
    if (!own.has(id)) denyForeignReference();
  }
}

/**
 * Refuse unless every select / multi_select cell value is an option id of THAT
 * cell's column. Cells for columns that are not in `tableId` are ignored by the
 * adapter (it writes only the table's own columns), so they are not checked
 * here; a null value clears the cell and is always allowed.
 */
export async function assertCellOptionsBelongToColumns(
  tableId: string,
  cells: Record<string, unknown> | undefined,
): Promise<void> {
  if (!cells) return;
  const adapter = getCmsAdapter();
  const columns = await adapter.getColumns(tableId);
  const byId = new Map(columns.map((c) => [c.id, c]));
  for (const [columnId, value] of Object.entries(cells)) {
    const column = byId.get(columnId);
    if (!column || (column.type !== 'select' && column.type !== 'multi_select')) continue;
    if (value === null || value === undefined) continue;
    const values = column.type === 'multi_select' ? value : [value];
    if (!Array.isArray(values) || values.some((v) => typeof v !== 'string')) {
      denyForeignReference();
    }
    const optionIds = (await adapter.getSelectOptions(column.id)).map((o) => o.id);
    assertIdsAmong(values as string[], optionIds);
  }
}

/**
 * A row create: the table must be in the workspace, a parent row must be a row
 * of the SAME table, and select / multi_select cells must name that column's
 * own options.
 */
export async function assertRowCreateInWorkspace(
  input: { tableId: string; parentRowId?: string; cells?: Record<string, unknown> },
  workspaceId: string,
): Promise<void> {
  await assertTableInWorkspace(input.tableId, workspaceId);
  if (input.parentRowId !== undefined && input.parentRowId !== null) {
    const parent = await getCmsAdapter().getRow(input.parentRowId);
    if (!parent || parent.tableId !== input.tableId) denyForeignReference();
  }
  await assertCellOptionsBelongToColumns(input.tableId, input.cells);
}

/**
 * A row update: the row must be in the workspace and its select / multi_select
 * cells must name that column's own options.
 */
export async function assertRowUpdateInWorkspace(
  rowId: string,
  cells: Record<string, unknown>,
  workspaceId: string,
): Promise<void> {
  const row = await getCmsAdapter().getRow(rowId);
  if (!row) denyCrossWorkspace();
  await assertTableInWorkspace(row.tableId, workspaceId);
  await assertCellOptionsBelongToColumns(row.tableId, cells);
}

/**
 * A relation create / delete: both rows in the workspace, the column a
 * `relation` column of the SOURCE row's table, and (when the column names a
 * target table) the target row a row of that table.
 */
export async function assertRelationInWorkspace(
  sourceRowId: string,
  sourceColumnId: string,
  targetRowId: string,
  workspaceId: string,
): Promise<void> {
  const adapter = getCmsAdapter();
  const source = await adapter.getRow(sourceRowId);
  if (!source) denyCrossWorkspace();
  await assertTableInWorkspace(source.tableId, workspaceId);
  const target = await adapter.getRow(targetRowId);
  if (!target) denyCrossWorkspace();
  await assertTableInWorkspace(target.tableId, workspaceId);

  const column = await adapter.getColumn(sourceColumnId);
  if (!column || column.tableId !== source.tableId || column.type !== 'relation') {
    denyForeignReference();
  }
  const targetTableId = (column.config as { targetTableId?: unknown } | undefined)?.targetTableId;
  if (typeof targetTableId === 'string' && targetTableId.length > 0 && target.tableId !== targetTableId) {
    denyForeignReference();
  }
}

/** A file reference: the row in the workspace and the column one of the row's table. */
export async function assertFileColumnOfRow(
  rowId: string,
  columnId: string,
  workspaceId: string,
): Promise<void> {
  const adapter = getCmsAdapter();
  const row = await adapter.getRow(rowId);
  if (!row) denyCrossWorkspace();
  await assertTableInWorkspace(row.tableId, workspaceId);
  const column = await adapter.getColumn(columnId);
  if (!column || column.tableId !== row.tableId) denyForeignReference();
}
